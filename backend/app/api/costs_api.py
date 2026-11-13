"""비용 — 판정 모델별·기간별 추정 비용(실행마다 기록한 토큰 × 판정 모델 단가)."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import iso
from app.db import get_db
from app.models import GenerationJob, JudgeModel, Run, utcnow

router = APIRouter(tags=["costs"])

Period = Literal["7d", "30d", "90d", "month", "all"]
DAYS = {"7d": 7, "30d": 30, "90d": 90}


def _range(period: str, now: datetime, first: datetime | None) -> tuple[datetime, datetime | None]:
    """(시작, 이전 기간 시작). 이전 기간은 같은 길이의 바로 앞 구간."""
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "month":
        start = today.replace(day=1)
        prev = (start - timedelta(days=1)).replace(day=1)
        return start, prev
    if period == "all":
        return (first or today).replace(hour=0, minute=0, second=0, microsecond=0), None
    days = DAYS[period]
    start = today - timedelta(days=days - 1)
    return start, start - timedelta(days=days)


def _key(r: Run | GenerationJob) -> str:
    if isinstance(r, GenerationJob):
        return f"id:{r.judge_model_id}" if r.judge_model_id else f"name:{(r.params or {}).get('model_name') or '(삭제된 모델)'}"
    snap = (r.snapshot or {}).get("judge_model") or {}
    return f"id:{r.judge_model_id}" if r.judge_model_id else f"name:{snap.get('name') or '(삭제된 모델)'}"


@router.get("/costs")
def costs(period: Period = Query("30d"), db: Session = Depends(get_db)) -> dict[str, Any]:
    now = utcnow()
    runs = db.scalars(select(Run).order_by(Run.created_at)).all()
    models = {m.id: m for m in db.scalars(select(JudgeModel).order_by(JudgeModel.id))}
    first = runs[0].created_at if runs else None
    start, prev_start = _range(period, now, first)

    in_period = [r for r in runs if r.created_at >= start]
    prev = [r for r in runs if prev_start and prev_start <= r.created_at < start]
    jobs = db.scalars(select(GenerationJob).order_by(GenerationJob.created_at)).all()
    jobs_in = [j for j in jobs if j.created_at >= start]
    jobs_prev = [j for j in jobs if prev_start and prev_start <= j.created_at < start]

    # 판정 모델별 집계(등록된 모델은 사용이 없어도 보여 준다)
    rows: dict[str, dict[str, Any]] = {}
    for m in models.values():
        rows[f"id:{m.id}"] = {
            "key": f"id:{m.id}", "id": m.id, "name": m.name, "provider": m.provider, "model": m.model, "exists": True,
            "is_default": m.is_default, "price_input_per_mtok": m.price_input_per_mtok,
            "price_output_per_mtok": m.price_output_per_mtok,
        }
    for r in [*in_period, *jobs_in]:
        k = _key(r)
        if k not in rows:
            snap = ((r.snapshot or {}).get("judge_model") or {}) if isinstance(r, Run) else {"name": (r.params or {}).get("model_name")}
            rows[k] = {"key": k, "id": None, "name": snap.get("name") or "(삭제된 모델)", "provider": snap.get("provider", ""),
                       "model": snap.get("model", ""), "exists": False, "is_default": False,
                       "price_input_per_mtok": None, "price_output_per_mtok": None}
    for row in rows.values():
        row.update({"runs": 0, "generations": 0, "cost_generation": 0.0, "cases": 0, "judge_calls": 0, "tokens_input": 0, "tokens_output": 0, "cost": 0.0,
                    "cost_input": 0.0, "cost_output": 0.0, "last_used_at": None})
    for r in in_period:
        row = rows[_key(r)]
        row["runs"] += 1
        row["cases"] += r.completed + r.failed
        row["judge_calls"] += r.judge_calls
        row["tokens_input"] += r.tokens_input
        row["tokens_output"] += r.tokens_output
        row["cost"] += r.cost_estimate
        row["last_used_at"] = iso(r.created_at)
    for j in jobs_in:
        row = rows[_key(j)]
        row["generations"] += 1
        row["judge_calls"] += j.judge_calls
        row["tokens_input"] += j.tokens_input
        row["tokens_output"] += j.tokens_output
        row["cost"] += j.cost_estimate
        row["cost_generation"] += j.cost_estimate
        if not row["last_used_at"] or iso(j.created_at) > row["last_used_at"]:
            row["last_used_at"] = iso(j.created_at)
    gen_cost = sum(j.cost_estimate for j in jobs_in)
    total_cost = sum(r.cost_estimate for r in in_period) + gen_cost
    for row in rows.values():
        pi, po = row["price_input_per_mtok"] or 0, row["price_output_per_mtok"] or 0
        wi, wo = row["tokens_input"] * pi, row["tokens_output"] * po
        row["cost_input"] = row["cost"] * wi / (wi + wo) if wi + wo else 0.0
        row["cost_output"] = row["cost"] - row["cost_input"] if wi + wo else 0.0
        row["share"] = row["cost"] / total_cost if total_cost else 0.0
        row["avg_cost_per_case"] = (row["cost"] - row["cost_generation"]) / row["cases"] if row["cases"] else None
        row["priced"] = bool(pi or po)
    model_rows = sorted(rows.values(), key=lambda x: (-x["cost"], -x["judge_calls"], x["name"]))

    # 날짜별(모델별로 쌓기)
    names = {k: v["name"] for k, v in rows.items()}
    daily_map: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for r in [*in_period, *jobs_in]:
        daily_map[r.created_at.date().isoformat()][names[_key(r)]] += r.cost_estimate
    days = max(1, (now.date() - start.date()).days + 1)
    daily = []
    for i in range(min(days, 366)):
        d = (start.date() + timedelta(days=i)).isoformat()
        by = dict(daily_map.get(d, {}))
        daily.append({"date": d, "total": sum(by.values()), "by_model": by})

    prev_cost = (sum(r.cost_estimate for r in prev) + sum(j.cost_estimate for j in jobs_prev)) if prev_start else None
    cases = sum(r.completed + r.failed for r in in_period)
    top = sorted(in_period, key=lambda r: -r.cost_estimate)[:8]
    return {
        "period": period,
        "since": iso(start),
        "until": iso(now),
        "totals": {
            "cost": total_cost,
            "runs": len(in_period),
            "cases": cases,
            "judge_calls": sum(r.judge_calls for r in in_period) + sum(j.judge_calls for j in jobs_in),
            "tokens_input": sum(r.tokens_input for r in in_period) + sum(j.tokens_input for j in jobs_in),
            "tokens_output": sum(r.tokens_output for r in in_period) + sum(j.tokens_output for j in jobs_in),
            "generations": len(jobs_in),
            "by_purpose": {"evaluation": total_cost - gen_cost, "generation": gen_cost},
            "avg_cost_per_run": (total_cost - gen_cost) / len(in_period) if in_period else None,
            "avg_cost_per_case": (total_cost - gen_cost) / cases if cases else None,
            "prev_cost": prev_cost,
            "change": (total_cost - prev_cost) / prev_cost if prev_cost else None,
        },
        "all_time_cost": sum(r.cost_estimate for r in runs) + sum(j.cost_estimate for j in jobs),
        "models": model_rows,
        "series": [m["name"] for m in model_rows if m["cost"] > 0],
        "daily": daily,
        "top_runs": [
            {"id": r.id, "name": r.name, "status": r.status, "model": names[_key(r)], "cases": r.completed + r.failed,
             "judge_calls": r.judge_calls, "cost": r.cost_estimate, "created_at": iso(r.created_at)}
            for r in top if r.cost_estimate > 0
        ],
        "unpriced": [m["name"] for m in model_rows if m["exists"] and not m["priced"] and (m["tokens_input"] or m["tokens_output"])],
    }
