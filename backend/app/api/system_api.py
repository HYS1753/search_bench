"""인증·시스템 정보·개요·프리셋·설정 내보내기/가져오기."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import __version__
from app.api.common import bad_request, criteria_out, run_out, suite_out, target_out
from app.config import get_settings
from app.db import get_db
from app.judges import PROVIDERS, env_secret_source
from app.models import Criteria, Dataset, GenerationJob, JudgeModel, Run, Suite, SuiteTarget, Target, utcnow
from app.runs import ACTIVE

router = APIRouter()


# ── 인증 ─────────────────────────────────────────────────────


# ── 시스템 ───────────────────────────────────────────────────


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@router.get("/system/info")
def system_info(db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_settings()
    db_size = s.db_path.stat().st_size if s.db_path.exists() else 0
    return {
        "version": __version__,
        "data_dir": str(s.DATA_DIR),
        "db_size_bytes": db_size,
        "login_required": bool(s.APP_PASSWORD),
        "secret_key_source": "APP_SECRET_KEY" if s.APP_SECRET_KEY else "data/secret.key (자동 생성)",
        "env_keys": {p: env_secret_source(p) for p in PROVIDERS},
        "target_defaults": {"timeout_seconds": s.TARGET_TIMEOUT_SECONDS, "verify_ssl": s.TARGET_VERIFY_SSL},
        "run_defaults": {"concurrency": s.RUN_CASE_CONCURRENCY, "judge_timeout_seconds": s.JUDGE_TIMEOUT_SECONDS,
                         "judge_max_retries": s.JUDGE_MAX_RETRIES},
        "counts": {
            "judge_models": db.scalar(select(func.count(JudgeModel.id))) or 0,
            "targets": db.scalar(select(func.count(Target.id))) or 0,
            "suites": db.scalar(select(func.count(Suite.id))) or 0,
            "criteria": db.scalar(select(func.count(Criteria.id))) or 0,
            "datasets": db.scalar(select(func.count(Dataset.id))) or 0,
            "runs": db.scalar(select(func.count(Run.id))) or 0,
        },
    }


@router.get("/overview")
def overview(db: Session = Depends(get_db)) -> dict[str, Any]:
    counts = system_info(db)["counts"]
    has_default = db.scalar(select(func.count(JudgeModel.id)).where(JudgeModel.is_default.is_(True))) or 0
    tested = db.scalar(select(func.count(JudgeModel.id)).where(JudgeModel.last_test_ok.is_(True))) or 0
    month_start = utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    recent = db.scalars(select(Run).order_by(Run.id.desc()).limit(6)).all()
    finished = db.scalars(
        select(Run).where(Run.status == "done", Run.finished_at.is_not(None)).order_by(Run.id.desc()).limit(30)
    ).all()
    trend = []
    for r in reversed(finished):
        cmp = ((r.summary or {}).get("comparisons") or [None])[0]
        if cmp and cmp.get("ndcg_diff") is not None:
            trend.append({"id": r.id, "name": r.name, "suite": (r.snapshot or {}).get("suite", {}).get("name"),
                          "finished_at": r.finished_at.isoformat() + "Z", "ndcg_diff": cmp["ndcg_diff"],
                          "win_rate": cmp.get("win_rate")})
    return {
        "counts": counts,
        "onboarding": [
            {"key": "judge_model", "title": "판정 모델 연결", "done": bool(has_default and tested),
             "hint": "LLM 공급자와 모델을 등록하고 연결 테스트를 통과하세요.", "to": "/settings/models"},
            {"key": "targets", "title": "검색 API 연결 (2개 이상)", "done": counts["targets"] >= 2,
             "hint": "비교할 API 의 예시 주소를 붙여넣고 응답에서 쓸 부분을 고르세요.", "to": "/settings/targets"},
            {"key": "criteria", "title": "평가 기준 만들기", "done": counts["criteria"] >= 1,
             "hint": "무엇을 좋은 결과로 볼지 고릅니다.", "to": "/settings/criteria"},
            {"key": "suite", "title": "비교 세트 구성", "done": counts["suites"] >= 1,
             "hint": "기준 API 와 후보 API 를 묶고, 후보마다 평가 기준을 고르세요.", "to": "/settings/suites"},
            {"key": "dataset", "title": "테스트 데이터 준비 (선택)", "done": counts["datasets"] >= 1,
             "hint": "평가에서 바로 붙여넣어도 됩니다.", "to": "/datasets"},
            {"key": "run", "title": "첫 평가 실행", "done": counts["runs"] >= 1,
             "hint": "여러 입력을 한꺼번에 보내 어느 쪽이 나은지 판정합니다.", "to": "/runs/new"},
        ],
        "active": [{"id": r.id, "name": r.name, "status": r.status, "total": r.total, "completed": r.completed}
                   for r in db.scalars(select(Run).where(Run.status.in_(ACTIVE)))],
        "recent": [run_out(r, with_summary=False) for r in recent],
        "trend": trend,
        "month": {
            "runs": db.scalar(select(func.count(Run.id)).where(Run.created_at >= month_start)) or 0,
            # 비용 화면과 같은 숫자가 되도록 테스트 데이터 생성 호출도 포함
            "cost": (db.scalar(select(func.coalesce(func.sum(Run.cost_estimate), 0.0)).where(Run.created_at >= month_start)) or 0.0)
            + (db.scalar(select(func.coalesce(func.sum(GenerationJob.cost_estimate), 0.0)).where(GenerationJob.created_at >= month_start)) or 0.0),
            "judge_calls": (db.scalar(select(func.coalesce(func.sum(Run.judge_calls), 0)).where(Run.created_at >= month_start)) or 0)
            + (db.scalar(select(func.coalesce(func.sum(GenerationJob.judge_calls), 0)).where(GenerationJob.created_at >= month_start)) or 0),
        },
        "week_ago": (utcnow() - timedelta(days=7)).isoformat() + "Z",
    }


# ── 설정 내보내기/가져오기 (키 제외) ───────────────────────────


@router.get("/system/export-config")
def export_config(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {
        "format": "llm-as-a-judge/config@1",
        "exported_at": utcnow().isoformat() + "Z",
        "judge_models": [
            {k: getattr(m, k) for k in ("name", "provider", "model", "base_url", "project", "location", "params",
                                          "price_input_per_mtok", "price_output_per_mtok", "is_default")}
            for m in db.scalars(select(JudgeModel))
        ],
        "targets": [{k: v for k, v in target_out(t).items() if k not in ("has_secret", "secret_hint", "created_at", "updated_at")}
                    for t in db.scalars(select(Target))],
        "criteria": [{k: v for k, v in criteria_out(c).items() if k not in ("created_at", "updated_at")}
                     for c in db.scalars(select(Criteria))],
        "suites": [{k: v for k, v in suite_out(s).items() if k not in ("created_at", "updated_at")}
                   for s in db.scalars(select(Suite))],
    }


@router.post("/system/import-config")
def import_config(payload: dict[str, Any], db: Session = Depends(get_db)) -> dict[str, Any]:
    if payload.get("format") != "llm-as-a-judge/config@1":
        raise bad_request("이 도구에서 내보낸 설정 파일이 아닙니다.")
    created = {"judge_models": 0, "targets": 0, "criteria": 0, "suites": 0}
    target_ids: dict[int, int] = {}
    criteria_ids: dict[int, int] = {}
    for m in payload.get("judge_models", []):
        db.add(JudgeModel(**{k: m.get(k) for k in ("name", "provider", "model", "base_url", "project", "location",
                                                    "params", "price_input_per_mtok", "price_output_per_mtok")},
                          is_default=False))
        created["judge_models"] += 1
    for t in payload.get("targets", []):
        row = Target(**{k: t.get(k) for k in ("name", "description", "method", "base_url", "path", "headers", "auth",
                                               "params", "response_mapping", "timeout_seconds")},
                     verify_ssl=t.get("verify_ssl", True))
        db.add(row)
        db.flush()
        target_ids[t["id"]] = row.id
        created["targets"] += 1
    for c in payload.get("criteria", []):
        row = Criteria(**{k: c.get(k) for k in ("name", "description", "task_context", "user_requirements", "k",
                                                 "relevant_threshold", "pairwise_enabled")},
                       **{k: c.get(k) or "" for k in ("system_prompt", "item_template", "pairwise_template")})
        db.add(row)
        db.flush()
        criteria_ids[c["id"]] = row.id
        created["criteria"] += 1
    for s in payload.get("suites", []):
        suite = Suite(name=s["name"], description=s.get("description", ""), input_fields=s.get("input_fields", []),
                      match_mode=s.get("match_mode", "id"),
                      default_criteria_id=criteria_ids.get(s.get("default_criteria_id") or -1))
        for m in s.get("members", []):
            if m["target_id"] in target_ids:
                suite.members.append(SuiteTarget(target_id=target_ids[m["target_id"]], label=m["label"],
                                                 position=m.get("position", 0), is_baseline=m.get("is_baseline", False),
                                                 input_bindings=m.get("input_bindings") or {}, match=m.get("match") or {},
                                                 criteria_id=criteria_ids.get(m.get("criteria_id") or -1)))
        db.add(suite)
        created["suites"] += 1
    if not db.scalar(select(JudgeModel).where(JudgeModel.is_default.is_(True))):
        first = db.scalar(select(JudgeModel).order_by(JudgeModel.id))
        if first:
            first.is_default = True
    return {"created": created, "note": "API 키는 내보내지 않으므로 판정 모델·검색 API 의 키를 다시 입력하세요."}
