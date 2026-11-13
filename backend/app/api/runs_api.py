"""배치 실행 API — 생성·조회·취소·이어서 실행·SSE·내보내기."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.common import bad_request, criteria_out, dataset_out, get_or_404, iso, run_out, target_snapshot
from app.api.data_api import resolve_judge_setup
from app.validation import members_spec, row_inputs, validate_rows
from app.db import get_db, session_scope
from app.exports import to_csv, to_json, to_xlsx
from app.report_html import to_html
from app.models import Criteria, Dataset, DatasetRow, JudgeModel, Run, RunCase, Suite, utcnow
from app.runs import ACTIVE, compute_summary, hub, manager, run_progress

router = APIRouter()


class MappingIn(BaseModel):
    fields: dict[str, str] = Field(default_factory=dict)
    case_key: str = ""
    category: str = ""
    expected: str = ""


class RunIn(BaseModel):
    name: str = ""
    suite_id: int
    dataset_id: int
    # 모든 후보에 같은 기준(이전 방식). criteria_by_member 가 있으면 그쪽이 우선
    criteria_id: int | None = None
    # 후보 라벨 → 평가 기준 id
    criteria_by_member: dict[str, int] = Field(default_factory=dict)
    judge_model_id: int | None = None
    mapping: MappingIn
    concurrency: int = Field(default=4, ge=1, le=32)
    # 한 번의 판정 호출에 넣는 항목 수(1 = 항목마다 따로, UMBRELA 방식)
    judge_batch_size: int = Field(default=12, ge=1, le=50)
    # 이 실행의 비용 상한(USD). 닿으면 남은 케이스를 멈춘다(이어서 실행 가능)
    max_cost: float | None = Field(default=None, gt=0)
    case_limit: int | None = Field(default=None, ge=1)
    # 검증에 실패한 행은 빼고 실행
    skip_invalid: bool = False
    # 이번 실행만 API 주소·헤더를 바꾼다(CI 의 미리보기 배포 등): {"TOBE": {"base_url": "..."}}
    target_overrides: dict[str, dict[str, str]] = Field(default_factory=dict)


class ValidateIn(BaseModel):
    suite_id: int
    dataset_id: int
    mapping: MappingIn
    case_limit: int | None = Field(default=None, ge=1)


def _rows_for(db: Session, dataset_id: int, case_limit: int | None) -> list[DatasetRow]:
    rows = db.scalars(select(DatasetRow).where(DatasetRow.dataset_id == dataset_id).order_by(DatasetRow.row_index)).all()
    return list(rows[:case_limit] if case_limit else rows)


@router.post("/runs/validate")
def validate_run(body: ValidateIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """실행 전 검증: 행마다 입력을 만들고, 각 API 가 꼭 받아야 하는 값이 있는지 확인한다."""
    suite = get_or_404(db, Suite, body.suite_id, "비교 세트")
    get_or_404(db, Dataset, body.dataset_id, "데이터셋")
    rows = _rows_for(db, body.dataset_id, body.case_limit)
    report = validate_rows(suite.input_fields or [], members_spec(suite.members),
                           [(r.row_index, r.data) for r in rows], body.mapping.fields)
    report.pop("valid_rows")
    return report


@router.post("/runs")
async def create_run(body: RunIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    suite = get_or_404(db, Suite, body.suite_id, "비교 세트")
    dataset = get_or_404(db, Dataset, body.dataset_id, "데이터셋")
    crit, model = resolve_judge_setup(db, suite, body.criteria_id, body.judge_model_id)
    if crit is None:
        raise bad_request("평가 기준이 없습니다. 설정 > 평가 기준에서 만들어 주세요.")
    # 후보마다 평가 기준: 요청 값 > (요청 공통 기준) > 세트에 저장한 후보 기준 > 세트 기본
    by_member: dict[str, Criteria] = {}
    for m in suite.members:
        if m.is_baseline:
            continue
        cid = body.criteria_by_member.get(m.label) or body.criteria_id or m.criteria_id
        c = db.get(Criteria, cid) if cid else None
        if cid and c is None:
            raise bad_request(f"{m.label} 의 평가 기준 #{cid} 가 없습니다.")
        by_member[m.label] = c or crit
    if by_member:
        crit = next(iter(by_member.values()))  # 대표 기준 = 첫 번째 후보의 기준
    if model is None:
        raise bad_request("판정 모델이 없습니다. 설정 > 판정 모델에서 등록해 주세요.")
    fields = suite.input_fields or []
    columns = set(dataset.columns or [])
    for f in fields:
        col = body.mapping.fields.get(f["key"], "")
        if col and col not in columns:
            raise bad_request(f"'{f.get('label') or f['key']}' 에 연결한 컬럼 '{col}' 이 데이터셋에 없습니다.")
        if f.get("required") and not col:
            raise bad_request(f"필수 입력 '{f.get('label') or f['key']}' 에 연결할 컬럼을 선택하세요.")

    rows = _rows_for(db, dataset.id, body.case_limit)
    if not rows:
        raise bad_request("데이터셋에 행이 없습니다.")
    report = validate_rows(fields, members_spec(suite.members), [(r.row_index, r.data) for r in rows], body.mapping.fields)
    if report["invalid"] and not body.skip_invalid:
        lines = [f"{e['row']}행: {' / '.join(e['messages'])}" for e in report["errors"][:10]]
        more = f"\n외 {report['invalid'] - len(lines)}건" if report["invalid"] > len(lines) else ""
        raise bad_request(f"검증에 실패한 행이 {report['invalid']}개 있습니다.\n" + "\n".join(lines) + more)
    keep = set(report["valid_rows"])
    cases = []
    for r in rows:
        if r.row_index not in keep:
            continue
        inputs, _ = row_inputs(fields, r.data, body.mapping.fields)
        cases.append(RunCase(
            row_index=r.row_index,
            case_key=str(r.data.get(body.mapping.case_key, "") if body.mapping.case_key else "") or f"#{r.row_index + 1}",
            category=str(r.data.get(body.mapping.category, "") if body.mapping.category else ""),
            expected=str(r.data.get(body.mapping.expected, "") if body.mapping.expected else ""),
            inputs=inputs,
        ))
    if not cases:
        raise bad_request("실행할 수 있는 행이 없습니다.")

    def _target(m: Any) -> dict[str, Any]:
        t = target_snapshot(m.target)
        ov = body.target_overrides.get(m.label) or {}
        if ov.get("base_url"):
            t["base_url"] = ov["base_url"].rstrip("/")
        if ov.get("path"):
            t["path"] = ov["path"]
        return t

    members = [
        {"label": m.label, "is_baseline": m.is_baseline, "position": m.position, "target": _target(m),
         "input_bindings": m.input_bindings or {}, "match": m.match or {}}
        for m in suite.members
    ]
    run = Run(
        name=body.name.strip() or f"{suite.name} · {dataset.name}",
        suite_id=suite.id, dataset_id=dataset.id, judge_model_id=model.id,
        snapshot={
            "suite": {"id": suite.id, "name": suite.name, "input_fields": fields, "match_mode": suite.match_mode or "id"},
            "dataset": {"id": dataset.id, "name": dataset.name, "version": dataset.version or 0},
            "members": members,
            "criteria": criteria_out(crit),
            "criteria_by_member": {label: criteria_out(c) for label, c in by_member.items()},
            "judge_model": {"id": model.id, "name": model.name, "provider": model.provider, "model": model.model},
            "mapping": body.mapping.model_dump(),
            "target_overrides": body.target_overrides,
        },
        options={"concurrency": body.concurrency, "judge_batch_size": body.judge_batch_size, "max_cost": body.max_cost,
                 "fetch_limit": max([crit.k, 1, *(c.k for c in by_member.values())])},
        status="queued", total=len(cases), cases=cases,
    )
    db.add(run)
    # 이 데이터가 이 비교 세트에 쓰였음을 기억 — 다음 평가부터 연결을 다시 맞추지 않는다
    if dataset.suite_id in (None, suite.id):
        dataset.suite_id = suite.id
        dataset.mapping = body.mapping.model_dump()
    db.flush()
    run_id = run.id
    db.commit()
    manager.start(run_id)
    return run_out(run)


@router.get("/runs")
def list_runs(
    status: str | None = None, suite_id: int | None = None, q: str | None = None,
    offset: int = 0, limit: int = Query(default=50, le=200), db: Session = Depends(get_db),
) -> dict[str, Any]:
    stmt = select(Run)
    if status:
        stmt = stmt.where(Run.status.in_(status.split(",")))
    if suite_id:
        stmt = stmt.where(Run.suite_id == suite_id)
    if q:
        stmt = stmt.where(Run.name.contains(q))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    runs = db.scalars(stmt.order_by(Run.id.desc()).offset(offset).limit(limit)).all()
    return {"total": total, "items": [run_out(r, with_summary=False) for r in runs]}


@router.get("/runs/active")
def active_runs(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    runs = db.scalars(select(Run).where(Run.status.in_(ACTIVE)).order_by(Run.id)).all()
    return [{**run_progress(r), "name": r.name} for r in runs]


@router.get("/runs/compare")
def compare_runs(ids: str, candidate: str | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    """실행 2~6개를 나란히 비교한다(같은 후보 라벨 기준). 같은 테스트 데이터로 2개를 비교하면 케이스별 변화도 준다."""
    id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()][:6]
    if len(id_list) < 2:
        raise bad_request("비교할 실행을 2개 이상 고르세요.")
    runs = [get_or_404(db, Run, i, "실행") for i in id_list]
    labels = [[m["label"] for m in r.snapshot.get("members", []) if not m.get("is_baseline")] for r in runs]
    cand = candidate or next((c for c in labels[0] if all(c in ls for ls in labels)), labels[0][0] if labels[0] else "")

    def top1_avg(r: Run, label: str) -> float | None:
        t = ((r.summary or {}).get("grade_distribution") or {}).get(label, {}).get("top1") or {}
        n = sum(t.get(g, 0) for g in ("0", "1", "2", "3"))
        return sum(int(g) * t.get(g, 0) for g in ("0", "1", "2", "3")) / n if n else None

    items = []
    for r, ls in zip(runs, labels, strict=True):
        snap, summ = r.snapshot or {}, r.summary or {}
        c = cand if cand in ls else (ls[0] if ls else "")
        base = next((m["label"] for m in snap.get("members", []) if m.get("is_baseline")), "")
        cmp = next((x for x in summ.get("comparisons", []) if x["candidate"] == c), None)
        targets = {t["label"]: t for t in summ.get("targets", [])}
        crit = (snap.get("criteria_by_member") or {}).get(c) or snap.get("criteria") or {}
        items.append({
            "id": r.id, "name": r.name, "status": r.status, "created_at": iso(r.created_at), "finished_at": iso(r.finished_at),
            "suite_id": r.suite_id, "suite_name": snap.get("suite", {}).get("name"),
            "dataset_id": r.dataset_id or snap.get("dataset", {}).get("id"), "dataset_name": snap.get("dataset", {}).get("name"),
            "dataset_version": snap.get("dataset", {}).get("version"),
            "judge_model": (snap.get("judge_model") or {}).get("name"), "judge_model_id_str": (snap.get("judge_model") or {}).get("model"),
            "criteria": {"id": crit.get("id"), "name": crit.get("name"), "k": crit.get("k"), "relevant_threshold": crit.get("relevant_threshold"),
                         "custom_prompt": bool(crit.get("item_template") or crit.get("system_prompt") or crit.get("pairwise_template"))},
            "batch_size": (r.options or {}).get("judge_batch_size", 12),
            "baseline": base, "candidate": c, "candidate_target": next((m["target"].get("name") for m in snap.get("members", []) if m["label"] == c), None),
            "baseline_target": next((m["target"].get("name") for m in snap.get("members", []) if m["label"] == base), None),
            "cases": summ.get("cases", 0), "total": r.total, "cost": r.cost_estimate, "judge_calls": r.judge_calls,
            "comparison": cmp, "base_metrics": targets.get(base), "cand_metrics": targets.get(c),
            "base_top1": top1_avg(r, base), "cand_top1": top1_avg(r, c),
            "review": summ.get("review"), "agreement": (summ.get("agreement") or {}).get("kappa_quadratic"),
        })

    # 조건이 다른 항목(직접 비교할 때 주의)
    diff_keys = {
        "suite_name": "비교 세트", "dataset_name": "테스트 데이터", "dataset_version": "테스트 데이터 버전", "judge_model": "판정 모델", "batch_size": "판정 묶음 크기",
        "candidate_target": "후보 API", "baseline_target": "기준 API",
    }
    differs = [label for k, label in diff_keys.items() if len({str(x[k]) for x in items}) > 1]
    if len({(x["criteria"]["id"], x["criteria"]["k"], x["criteria"]["custom_prompt"]) for x in items}) > 1:
        differs.append("평가 기준")

    # 같은 테스트 데이터로 만든 실행 2개 → 케이스별 변화(후보 nDCG − 기준 nDCG 가 실행 사이에 어떻게 바뀌었나)
    case_diff = None
    # 데이터셋이 지워졌어도 실행 사본에 남은 데이터셋 id 로 비교한다
    ds_ids = [r.dataset_id or (r.snapshot or {}).get("dataset", {}).get("id") for r in runs]
    if len(runs) == 2 and ds_ids[0] and ds_ids[0] == ds_ids[1]:
        a_run, b_run = runs
        fields = a_run.snapshot.get("suite", {}).get("input_fields", [])
        first = next((f["key"] for f in fields if f.get("type", "text") == "text"), fields[0]["key"] if fields else None)

        def per_case(r: Run, c: str, base: str) -> dict[int, dict[str, Any]]:
            out = {}
            for rc in db.scalars(select(RunCase).where(RunCase.run_id == r.id, RunCase.status == "done")):
                mm = rc.metrics or {}
                a, b = mm.get(c, {}), mm.get(f"{base}@{c}") or mm.get(base, {})
                d = a["ndcg"] - b["ndcg"] if a.get("ndcg") is not None and b.get("ndcg") is not None else None
                out[rc.row_index] = {"case_id": rc.id, "case_key": rc.case_key, "category": rc.category, "diff": d,
                                     "cand_ndcg": a.get("ndcg"), "winner": ((rc.pairwise or {}).get(c) or {}).get("winner"),
                                     "query": rc.inputs.get(first) if first else None}
            return out

        pa = per_case(a_run, items[0]["candidate"], items[0]["baseline"])
        pb = per_case(b_run, items[1]["candidate"], items[1]["baseline"])
        rows = []
        for idx in sorted(set(pa) & set(pb)):
            x, y = pa[idx], pb[idx]
            delta = (y["diff"] - x["diff"]) if x["diff"] is not None and y["diff"] is not None else None
            rows.append({"row_index": idx, "case_key": x["case_key"], "category": x["category"], "query": x["query"],
                         "a": x, "b": y, "delta": delta})
        rows.sort(key=lambda r: -abs(r["delta"] or 0))
        eps = 1e-9
        case_diff = {
            "matched": len(rows),
            "better": sum(1 for r in rows if (r["delta"] or 0) > eps),
            "worse": sum(1 for r in rows if (r["delta"] or 0) < -eps),
            "same": sum(1 for r in rows if r["delta"] is not None and abs(r["delta"]) <= eps),
            "flipped": sum(1 for r in rows if r["a"]["winner"] and r["b"]["winner"] and r["a"]["winner"] != r["b"]["winner"]),
            "rows": rows[:200],
        }
    return {"candidate": cand, "candidates": sorted({c for ls in labels for c in ls}), "runs": items, "differs": differs, "case_diff": case_diff}


@router.get("/runs/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = get_or_404(db, Run, run_id, "실행")
    out = run_out(run)
    if run.status in ACTIVE:
        out["summary"] = compute_summary(db, run)  # 진행 중에는 완료된 케이스로 실시간 집계
    elif run.summary and "grade_distribution" not in run.summary:
        run.summary = compute_summary(db, run)  # 이전 버전에서 만든 요약 보강
        out["summary"] = run.summary
    out["is_live"] = manager.is_running(run.id)
    return out


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.patch("/runs/{run_id}")
def rename_run(run_id: int, body: RenameIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = get_or_404(db, Run, run_id, "실행")
    run.name = body.name.strip()
    return run_out(run, with_summary=False)


@router.get("/runs/{run_id}/cases")
def list_cases(
    run_id: int,
    status: str | None = None,
    category: str | None = None,
    outcome: Literal["win", "loss", "tie", "inconsistent"] | None = None,
    candidate: str | None = None,
    q: str | None = None,
    sort: Literal["row", "ndcg_diff", "ndcg_diff_desc"] = "row",
    offset: int = 0,
    limit: int = Query(default=50, le=500),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    run = get_or_404(db, Run, run_id, "실행")
    members = run.snapshot.get("members", [])
    baseline = next((m["label"] for m in members if m.get("is_baseline")), "")
    cand = candidate or next((m["label"] for m in members if m["label"] != baseline), "")
    stmt = select(RunCase).where(RunCase.run_id == run_id).options(selectinload(RunCase.responses))
    if status:
        stmt = stmt.where(RunCase.status.in_(status.split(",")))
    if category:
        stmt = stmt.where(RunCase.category == category)
    if q:
        stmt = stmt.where(or_(RunCase.case_key.contains(q), func.json_extract(RunCase.inputs, "$").contains(q)))
    cases = db.scalars(stmt.order_by(RunCase.row_index)).all()

    def diff(c: RunCase) -> float | None:
        a, b = (c.metrics or {}).get(cand, {}), (c.metrics or {}).get(baseline, {})
        if a.get("ndcg") is None or b.get("ndcg") is None:
            return None
        return a["ndcg"] - b["ndcg"]

    if outcome:
        def keep(c: RunCase) -> bool:
            pw = (c.pairwise or {}).get(cand)
            if not pw:
                return False
            if outcome == "inconsistent":
                return pw.get("consistent") is False
            return pw["winner"] == {"win": "candidate", "loss": "baseline", "tie": "tie"}[outcome]
        cases = [c for c in cases if keep(c)]
    if sort != "row":
        cases.sort(key=lambda c: (diff(c) is None, (diff(c) or 0) * (1 if sort == "ndcg_diff" else -1)))
    total = len(cases)
    page = cases[offset: offset + limit]
    items = []
    for c in page:
        resp = {r.label: r for r in c.responses}
        tops = {}
        for m in members:
            r = resp.get(m["label"])
            top = r.items[0] if r and r.ok and r.items else None
            tops[m["label"]] = {
                "ok": r.ok if r else None, "error": r.error if r else "",
                "title": top["title"] if top else None,
                "grade": (c.item_judgments or {}).get(top["key"], {}).get("grade") if top else None,
                "latency_ms": r.latency_ms if r else None, "count": len(r.items) if r and r.ok else 0,
            }
        items.append({
            "id": c.id, "row_index": c.row_index, "case_key": c.case_key, "category": c.category,
            "inputs": c.inputs, "expected": c.expected, "status": c.status, "error": c.error,
            "metrics": c.metrics, "pairwise": c.pairwise, "tops": tops, "ndcg_diff": diff(c),
            "human_reviewed": bool(c.human_judgments or c.human_pairwise),
        })
    categories = sorted({c for c in db.scalars(select(RunCase.category).where(RunCase.run_id == run_id)) if c})
    return {"total": total, "items": items, "categories": categories, "candidate": cand, "baseline": baseline}


@router.get("/runs/{run_id}/cases/{case_id}")
def get_case(run_id: int, case_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = get_or_404(db, RunCase, case_id, "케이스")
    if c.run_id != run_id:
        raise bad_request("다른 실행의 케이스입니다.")
    return {
        "id": c.id, "row_index": c.row_index, "case_key": c.case_key, "category": c.category,
        "inputs": c.inputs, "expected": c.expected, "status": c.status, "error": c.error,
        "metrics": c.metrics, "pairwise": c.pairwise, "item_judgments": c.item_judgments,
        "human_judgments": c.human_judgments or {}, "human_pairwise": c.human_pairwise or {}, "human_by": c.human_by or {},
        "responses": [
            {"label": r.label, "ok": r.ok, "status_code": r.status_code, "latency_ms": r.latency_ms,
             "error": r.error, "items": r.items, "raw": r.raw}
            for r in c.responses
        ],
        "updated_at": iso(c.updated_at),
    }


# ── 사람 판정 ────────────────────────────────────────────


class HumanIn(BaseModel):
    # 항목 key(접두사 포함, item_judgments 와 같은 규칙) → 0~3, None 이면 지움
    grades: dict[str, int | None] = Field(default_factory=dict)
    notes: dict[str, str] = Field(default_factory=dict)
    # 후보 라벨 → candidate | baseline | tie, None 이면 지움
    pairwise: dict[str, Literal["candidate", "baseline", "tie"] | None] = Field(default_factory=dict)
    # 로그인 없이 쓸 때 검수자 이름(계정으로 로그인하면 무시)
    reviewer: str = ""


@router.put("/runs/{run_id}/cases/{case_id}/human")
def save_human(run_id: int, case_id: int, body: HumanIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    """검수자 본인의 등급·목록 선호를 저장하고, 검수자들의 합의와 요약(사람·결합·일치도)을 다시 계산한다."""
    from app.evaluation.human import consensus

    run = get_or_404(db, Run, run_id, "실행")
    case = db.get(RunCase, case_id)
    if case is None or case.run_id != run_id:
        raise bad_request("케이스를 찾을 수 없습니다.")
    if case.status != "done":
        raise bad_request("판정이 끝난 케이스만 사람 판정을 더할 수 있습니다.")
    who = reviewer_name(request, body.reviewer)
    labels = {m["label"] for m in run.snapshot.get("members", []) if not m.get("is_baseline")}
    by = {k: {"grades": dict(v.get("grades") or {}), "pairwise": dict(v.get("pairwise") or {})} for k, v in (case.human_by or {}).items()}
    mine = by.setdefault(who, {"grades": {}, "pairwise": {}})
    hj, hp = mine["grades"], mine["pairwise"]
    for key, grade in body.grades.items():
        if grade is None:
            hj.pop(key, None)
        elif 0 <= grade <= 3:
            hj[key] = {"grade": int(grade), "note": body.notes.get(key, hj.get(key, {}).get("note", "")), "at": iso(utcnow())}
        else:
            raise bad_request("등급은 0~3 입니다.")
    for key, note in body.notes.items():
        if key in hj and key not in body.grades:
            hj[key] = {**hj[key], "note": note}
    for cand, w in body.pairwise.items():
        if cand not in labels:
            raise bad_request(f"'{cand}' 은 이 실행의 후보가 아닙니다.")
        if w is None:
            hp.pop(cand, None)
        else:
            hp[cand] = w
    if not hj and not hp:
        by.pop(who, None)
    case.human_by = by
    case.human_judgments, case.human_pairwise = consensus(by)
    db.flush()
    run.summary = {**(run.summary or {}), **compute_summary(db, run)}
    return {"reviewer": who, "human_by": by, "human_judgments": case.human_judgments, "human_pairwise": case.human_pairwise, "summary": run.summary}


def reviewer_name(request: Request, given: str = "") -> str:
    """로그인한 계정이면 그 이름, 로그인 없이 쓰면 화면에서 받은 이름(없으면 '공용')."""
    u = getattr(request.state, "user", None) or {}
    if u.get("id"):
        return u.get("name") or u.get("username")
    return (given or "").strip()[:40] or "공용"


@router.get("/runs/{run_id}/review")
def review_queue(run_id: int, request: Request, seed: int = 7, mode: Literal["mine", "overlap", "fresh", "all"] = "mine",
                 reviewer: str = "", db: Session = Depends(get_db)) -> dict[str, Any]:
    """검수 순서(시드 고정 무작위). mine: 내가 다 안 본 것 먼저 · overlap: 다른 사람이 본 것 먼저(검수자 간 일치도용)
    · fresh: 아무도 안 본 것 먼저 · all: 그대로."""
    import random as _random

    from app.evaluation.human import case_variants
    from app.runs import criteria_groups

    run = get_or_404(db, Run, run_id, "실행")
    who = reviewer_name(request, reviewer)
    cases = db.scalars(
        select(RunCase).where(RunCase.run_id == run_id, RunCase.status == "done").options(selectinload(RunCase.responses))
    ).all()
    groups = criteria_groups(run.snapshot)
    order = sorted(cases, key=lambda c: c.row_index)
    _random.Random(seed).shuffle(order)
    items = []
    for c in order:
        v = case_variants(c, run.snapshot, groups)
        by = c.human_by or {}
        mine = by.get(who) or {}
        my_graded = sum(1 for g in (mine.get("grades") or {}).values() if g and g.get("grade") is not None)
        items.append({"id": c.id, "case_key": c.case_key, "category": c.category, "reviewed": v["reviewed"],
                      "complete": v["complete"], "graded": v["graded"], "needed": v["needed"],
                      "pairwise_done": len(v["human_pairwise"]), "reviewers": sorted(by), "mine_graded": my_graded,
                      "mine_complete": bool(v["needed"]) and my_graded >= v["needed"]})
    if mode == "mine":
        items.sort(key=lambda x: x["mine_complete"])
    elif mode == "overlap":
        items.sort(key=lambda x: (x["mine_complete"], not any(r != who for r in x["reviewers"])))
    elif mode == "fresh":
        items.sort(key=lambda x: (x["mine_complete"], bool(x["reviewers"])))
    return {"reviewer": who, "items": items,
            "candidates": [m["label"] for m in run.snapshot.get("members", []) if not m.get("is_baseline")]}


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = get_or_404(db, Run, run_id, "실행")
    if run.status not in ACTIVE:
        raise bad_request("진행 중인 실행이 아닙니다.")
    db.commit()
    if not await manager.cancel(run_id):
        with session_scope() as s:
            r = s.get(Run, run_id)
            r.status = "cancelled"
    return {"ok": True}


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = get_or_404(db, Run, run_id, "실행")
    if run.status in ACTIVE or manager.is_running(run_id):
        raise bad_request("이미 진행 중입니다.")
    pending = db.scalar(select(func.count(RunCase.id)).where(RunCase.run_id == run_id, RunCase.status != "done")) or 0
    if pending == 0:
        raise bad_request("남은 케이스가 없습니다. 모두 완료되었습니다.")
    if run.judge_model_id is None or db.get(JudgeModel, run.judge_model_id) is None:
        raise bad_request("이 실행의 판정 모델이 삭제되어 이어서 실행할 수 없습니다.")
    if (run.error or "").startswith("비용 상한"):
        # 사용자가 직접 이어서 실행하는 것이므로 상한을 풀고 남은 케이스를 처리한다
        run.options = {**(run.options or {}), "max_cost": None}
    run.status, run.error = "queued", ""
    db.commit()
    manager.start(run_id)
    return run_out(run, with_summary=False)


@router.post("/runs/{run_id}/rerun")
async def rerun(run_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """같은 설정으로 새 실행을 만든다(현재 저장된 대상·기준·모델 기준)."""
    run = get_or_404(db, Run, run_id, "실행")
    snap = run.snapshot
    if not run.suite_id or not run.dataset_id:
        raise bad_request("원본 비교 세트 또는 데이터셋이 삭제되어 다시 실행할 수 없습니다.")
    body = RunIn(
        name=f"{run.name} (재실행)", suite_id=run.suite_id, dataset_id=run.dataset_id,
        criteria_id=snap.get("criteria", {}).get("id"), judge_model_id=run.judge_model_id,
        criteria_by_member={k: v["id"] for k, v in (snap.get("criteria_by_member") or {}).items() if v.get("id")},
        mapping=MappingIn(**snap.get("mapping", {})), concurrency=run.options.get("concurrency", 4),
        judge_batch_size=run.options.get("judge_batch_size", 12),
    )
    return await create_run(body, db)


@router.delete("/runs/{run_id}")
async def delete_run(run_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = get_or_404(db, Run, run_id, "실행")
    if manager.is_running(run_id):
        raise bad_request("진행 중인 실행은 먼저 취소하세요.")
    db.delete(run)
    return {"ok": True}


@router.get("/runs/{run_id}/events")
async def run_events(run_id: int, request: Request) -> StreamingResponse:
    """SSE — 처음에 현재 상태를 보내고, 이후 케이스 완료·상태 변경을 보낸다."""
    with session_scope() as s:
        run = get_or_404(s, Run, run_id, "실행")
        initial = run_progress(run)

    async def stream():
        q = hub.subscribe(run_id)
        try:
            yield f"event: status\ndata: {json.dumps({'type': 'status', 'run': initial}, ensure_ascii=False)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                except TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield f"event: {event.get('type', 'message')}\ndata: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
        finally:
            hub.unsubscribe(run_id, q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/runs/{run_id}/export")
def export_run(run_id: int, format: Literal["csv", "xlsx", "json", "html"] = "xlsx", db: Session = Depends(get_db)) -> Response:
    run = get_or_404(db, Run, run_id, "실행")
    if run.status in ACTIVE:
        run.summary = compute_summary(db, run)
    cases = db.scalars(
        select(RunCase).where(RunCase.run_id == run_id).options(selectinload(RunCase.responses)).order_by(RunCase.row_index)
    ).all()
    base = f"run-{run.id}"
    if format == "csv":
        return Response(to_csv(run, list(cases)), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{base}.csv"'})
    if format == "html":
        return Response(to_html(run, list(cases)), media_type="text/html; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{base}.html"'})
    if format == "json":
        return Response(to_json(run, list(cases)), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{base}.json"'})
    return Response(
        to_xlsx(run, list(cases)),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{base}.xlsx"'},
    )

