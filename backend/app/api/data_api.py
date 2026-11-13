"""데이터셋·단건 검색 비교 API."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import bad_request, criteria_out, dataset_out, get_or_404, iso
from app.dataset_link import compat, dataset_columns_for, effective_mapping
from app.dataset_versions import diff as version_diff
from app.dataset_versions import record as record_version
from app.dataset_versions import who
from app.datasets_io import DatasetError, coerce, parse_file, template_csv
from app.db import get_db
from app.evaluation.engine import Criteria as CritCfg
from app.evaluation.engine import Side, evaluate_case
from app.judges import client_for
from app.matching import apply_match, bind_inputs, overlap
from app.validation import field_label, input_labels, member_errors, members_spec
from app.models import Criteria, Dataset, DatasetRow, DatasetVersion, JudgeModel, Run, Suite, Target
from app.targets import call_target, http_client

router = APIRouter()

# ── 데이터셋 ─────────────────────────────────────────────────


@router.get("/datasets")
def list_datasets(suite_id: int | None = None, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """suite_id 를 주면 데이터마다 그 비교 세트와의 호환 상태를 붙이고 바로 쓸 수 있는 것부터 정렬한다."""
    items = db.scalars(select(Dataset).order_by(Dataset.id.desc())).all()
    if not suite_id:
        return [dataset_out(d) for d in items]
    suite = get_or_404(db, Suite, suite_id, "비교 세트")
    order = {"ready": 0, "check": 1, "missing": 2}
    out = [{**dataset_out(d), "compat": compat(d, suite)} for d in items]
    out.sort(key=lambda x: (not x["compat"]["bound"], order[x["compat"]["status"]]))
    return out


@router.get("/datasets/blank-columns")
def blank_columns(suite_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """비교 세트로 새 데이터를 만들 때의 열 이름(사람이 읽는 이름)과 연결."""
    suite = get_or_404(db, Suite, suite_id, "비교 세트")
    columns, mapping = dataset_columns_for(suite.input_fields or [])
    return {"columns": columns, "mapping": mapping}


@router.get("/datasets/template")
def dataset_template(suite_id: int, db: Session = Depends(get_db)) -> Response:
    suite = get_or_404(db, Suite, suite_id, "비교 세트")
    return Response(
        template_csv(suite.input_fields or []),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="dataset_template_suite{suite.id}.csv"'},
    )


@router.get("/datasets/{dataset_id}")
def get_dataset(
    dataset_id: int, offset: int = 0, limit: int = Query(default=100, le=5000), db: Session = Depends(get_db)
) -> dict[str, Any]:
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    rows = db.scalars(
        select(DatasetRow).where(DatasetRow.dataset_id == d.id).order_by(DatasetRow.row_index).offset(offset).limit(limit)
    ).all()
    return {**dataset_out(d), "rows": [r.data for r in rows], "offset": offset}


@router.post("/datasets/upload")
async def upload_dataset(
    request: Request, file: UploadFile = File(...), name: str = Form(""), description: str = Form(""), db: Session = Depends(get_db)
) -> dict[str, Any]:
    raw = await file.read()
    try:
        columns, rows = parse_file(file.filename or "data.csv", raw)
    except DatasetError as exc:
        raise bad_request(str(exc)) from exc
    d = Dataset(name=(name or (file.filename or "데이터셋")).strip()[:100], description=description,
                columns=columns, source_filename=file.filename or "", row_count=len(rows), meta={"source": "file"})
    for i, r in enumerate(rows):
        d.rows.append(DatasetRow(row_index=i, data=r))
    db.add(d)
    db.flush()
    record_version(db, d, f"파일 올림 · {file.filename or ''}", who(request))
    return dataset_out(d)


class DatasetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    columns: list[str] = Field(min_length=1)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    # 비교 세트와 연결해 두면 평가할 때 연결을 다시 맞출 필요가 없다
    suite_id: int | None = None
    mapping: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None


def _replace_rows(d: Dataset, body: DatasetIn) -> None:
    cols = [c.strip() for c in body.columns if c.strip()]
    if len(set(cols)) != len(cols):
        raise bad_request("컬럼명이 중복되었습니다.")
    rows = [{c: r.get(c, "") for c in cols} for r in body.rows if any(str(r.get(c, "")).strip() for c in cols)]
    d.name, d.description, d.columns, d.row_count = body.name, body.description, cols, len(rows)
    if body.suite_id is not None:
        d.suite_id = body.suite_id or None
    if body.mapping is not None:
        d.mapping = body.mapping
    if body.meta is not None:
        d.meta = body.meta
    d.rows.clear()
    for i, r in enumerate(rows):
        d.rows.append(DatasetRow(row_index=i, data=r))


@router.post("/datasets")
def create_dataset(body: DatasetIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = Dataset(source_filename="직접 입력", meta={"source": "manual"})
    _replace_rows(d, body)
    db.add(d)
    db.flush()
    record_version(db, d, "만듦", who(request))
    return dataset_out(d)


@router.put("/datasets/{dataset_id}")
def update_dataset(dataset_id: int, body: DatasetIn, request: Request, note: str = "", db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    _replace_rows(d, body)
    db.flush()
    record_version(db, d, note or "화면에서 수정", who(request))
    return dataset_out(d)


# ── 버전 ──────────────────────────────────────────────────


def _version(db: Session, dataset_id: int, version: int) -> DatasetVersion:
    v = db.scalar(select(DatasetVersion).where(DatasetVersion.dataset_id == dataset_id, DatasetVersion.version == version))
    if v is None:
        raise bad_request(f"v{version} 이 없습니다(오래된 버전은 최근 30개만 보관).")
    return v


@router.get("/datasets/{dataset_id}/versions")
def list_versions(dataset_id: int, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """버전 목록과 직전 버전 대비 바뀐 수(추가·삭제·변경)."""
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    vs = db.scalars(select(DatasetVersion).where(DatasetVersion.dataset_id == d.id).order_by(DatasetVersion.version)).all()
    key = (d.mapping or {}).get("case_key") or None
    out, prev = [], None
    for v in vs:
        ch = version_diff(prev.columns, prev.rows, v.columns, v.rows, key, limit=0) if prev else None
        runs = db.scalar(select(func.count(Run.id)).where(Run.snapshot["dataset"]["id"].as_integer() == d.id,
                                                          Run.snapshot["dataset"]["version"].as_integer() == v.version)) or 0
        out.append({"version": v.version, "note": v.note, "created_by": v.created_by, "created_at": iso(v.created_at),
                    "row_count": v.row_count, "current": v.version == d.version, "runs": runs,
                    "changes": {k: ch[k] for k in ("added", "removed", "changed", "columns_added", "columns_removed")} if ch else None})
        prev = v
    return list(reversed(out))


@router.get("/datasets/{dataset_id}/versions/diff")
def diff_versions(dataset_id: int, a: int, b: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    va, vb = _version(db, d.id, a), _version(db, d.id, b)
    return {"a": a, "b": b, **version_diff(va.columns, va.rows, vb.columns, vb.rows, (d.mapping or {}).get("case_key") or None)}


@router.post("/datasets/{dataset_id}/versions/{version}/restore")
def restore_version(dataset_id: int, version: int, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    """옛 버전 내용으로 되돌린다(그 내용을 새 버전으로 남기므로 되돌린 것도 다시 되돌릴 수 있다)."""
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    v = _version(db, d.id, version)
    d.columns, d.row_count = list(v.columns), len(v.rows)
    d.rows.clear()
    db.flush()
    for i, r in enumerate(v.rows):
        d.rows.append(DatasetRow(row_index=i, data=r))
    db.flush()
    record_version(db, d, f"v{version} 으로 되돌림", who(request))
    return dataset_out(d)


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    db.delete(d)
    return {"ok": True}


class AddRowIn(BaseModel):
    suite_id: int
    dataset_id: int | None = None  # 없으면 새 테스트 데이터를 만든다
    name: str = ""
    inputs: dict[str, Any] = Field(default_factory=dict)
    expected: str = ""
    category: str = ""


@router.post("/datasets/add-row")
def add_row(body: AddRowIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    """단건 검색 비교에서 본 입력을 테스트 데이터에 한 줄로 더한다(비교 세트 연결·열 연결까지 맞춤)."""
    suite = get_or_404(db, Suite, body.suite_id, "비교 세트")
    fields = suite.input_fields or []
    if body.dataset_id:
        d = get_or_404(db, Dataset, body.dataset_id, "데이터셋")
        m = effective_mapping(d, suite)
        columns = list(d.columns or [])
        mapping = {"fields": dict(m["fields"]), "case_key": m.get("case_key", ""), "category": m.get("category", ""), "expected": m.get("expected", "")}
        _, default_map = dataset_columns_for(fields)
        # 이 세트의 입력에 맞는 열이 없으면 사람이 읽는 이름으로 열을 더한다
        for f in fields:
            if not mapping["fields"].get(f["key"]):
                col = default_map["fields"][f["key"]]
                if col not in columns:
                    columns.append(col)
                mapping["fields"][f["key"]] = col
        for k, col in (("case_key", "케이스"), ("category", "분류"), ("expected", "기대 정답")):
            if not mapping.get(k):
                if col not in columns:
                    columns.append(col)
                mapping[k] = col
    else:
        columns, mapping = dataset_columns_for(fields)
        d = Dataset(name=(body.name.strip() or f"{suite.name} · 단건 비교에서 모은 질의")[:100], description="", columns=columns,
                    source_filename="단건 검색 비교", meta={"source": "compare"}, row_count=0)
        db.add(d)
        db.flush()
    if d.suite_id in (None, suite.id):
        d.suite_id, d.mapping = suite.id, mapping
    n = d.row_count or 0
    row: dict[str, Any] = {c: "" for c in columns}
    for f in fields:
        v = body.inputs.get(f["key"], "")
        row[mapping["fields"][f["key"]]] = " ".join(map(str, v)) if isinstance(v, list) else ("" if v is None else v)
    row[mapping["case_key"]] = f"C{n + 1:03d}"
    row[mapping["category"]] = body.category
    row[mapping["expected"]] = body.expected
    d.columns = columns
    d.rows.append(DatasetRow(row_index=n, data=row))
    d.row_count = n + 1
    db.flush()
    record_version(db, d, "단건 검색 비교에서 추가", who(request))
    return dataset_out(d)


@router.get("/datasets/{dataset_id}/mapping")
def suggest_mapping(dataset_id: int, suite_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    s = get_or_404(db, Suite, suite_id, "비교 세트")
    return effective_mapping(d, s)


@router.get("/datasets/{dataset_id}/compat")
def dataset_compat(dataset_id: int, suite_id: int | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    sid = suite_id or d.suite_id
    if not sid:
        return {"status": "unbound"}
    s = get_or_404(db, Suite, sid, "비교 세트")
    return {**compat(d, s), "suite_id": s.id, "suite_name": s.name}


class BindingIn(BaseModel):
    suite_id: int | None
    mapping: dict[str, Any] = Field(default_factory=dict)


@router.put("/datasets/{dataset_id}/binding")
def save_binding(dataset_id: int, body: BindingIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """이 데이터를 어느 비교 세트에 쓰는지와 컬럼 연결을 기억한다."""
    d = get_or_404(db, Dataset, dataset_id, "데이터셋")
    if body.suite_id:
        get_or_404(db, Suite, body.suite_id, "비교 세트")
    d.suite_id = body.suite_id
    d.mapping = {k: v for k, v in body.mapping.items() if k in ("fields", "case_key", "category", "expected")}
    db.flush()
    return dataset_out(d)


# ── 단건 검색 비교 ─────────────────────────────────────────────────


class CompareIn(BaseModel):
    suite_id: int
    inputs: dict[str, Any] = Field(default_factory=dict)
    expected: str = ""
    judge: bool = False
    judge_model_id: int | None = None
    criteria_id: int | None = None


def coerce_inputs(fields: list[dict[str, Any]], raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in fields:
        value = raw.get(f["key"])
        if value in (None, "", []) and f.get("default") not in (None, ""):
            value = f["default"]
        try:
            value = coerce(value, f.get("type", "text"))
        except ValueError as exc:
            raise bad_request(f"{f.get('label') or f['key']}: {exc}") from exc
        if f.get("required") and value in (None, "", []):
            raise bad_request(f"'{field_label(f)}' 은(는) 필수입니다.")
        out[f["key"]] = value
    return out


def resolve_judge_setup(
    db: Session, suite: Suite, criteria_id: int | None, judge_model_id: int | None
) -> tuple[Criteria | None, JudgeModel | None]:
    crit = db.get(Criteria, criteria_id or suite.default_criteria_id or 0) if (criteria_id or suite.default_criteria_id) else None
    if crit is None:
        crit = db.scalar(select(Criteria).order_by(Criteria.id))
    model = db.get(JudgeModel, judge_model_id) if judge_model_id else db.scalar(
        select(JudgeModel).where(JudgeModel.is_default.is_(True))
    )
    return crit, model


async def call_members(specs: list[dict[str, Any]], inputs: dict[str, Any], match_mode: str) -> list[dict[str, Any]]:
    """공통 입력을 API 마다 연결 규칙대로 바꿔 동시에 부르고, 같은 결과 판단 기준을 적용한다."""

    async def one(spec: dict[str, Any]) -> dict[str, Any]:
        target = spec["target"]
        try:
            bound = bind_inputs(inputs, spec.get("input_bindings"), target.params or [])
        except ValueError as exc:
            return {"label": spec["label"], "is_baseline": spec["is_baseline"], "target_name": target.name,
                    "ok": False, "status_code": None, "latency_ms": 0, "error": f"입력 변환 실패: {exc}",
                    "items": [], "request": {}, "raw": None, "inputs": {}}
        async with http_client(target.verify_ssl) as client:
            r = await call_target(client, target, bound)
        items = apply_match(r.items, match_mode, spec.get("match"), spec["label"]) if r.ok else []
        return {"label": spec["label"], "is_baseline": spec["is_baseline"], "target_name": target.name,
                "ok": r.ok, "status_code": r.status_code, "latency_ms": r.latency_ms, "error": r.error,
                "items": items, "request": r.request, "raw": r.raw, "inputs": bound}

    return list(await asyncio.gather(*(one(sp) for sp in specs)))


class PreviewMember(BaseModel):
    target_id: int
    label: str
    is_baseline: bool = False
    input_bindings: dict[str, Any] = Field(default_factory=dict)
    match: dict[str, Any] = Field(default_factory=dict)


class SuitePreviewIn(BaseModel):
    input_fields: list[dict[str, Any]] = Field(default_factory=list)
    members: list[PreviewMember] = Field(min_length=1)
    match_mode: str = "id"
    inputs: dict[str, Any] = Field(default_factory=dict)


@router.post("/suites/preview")
async def preview_suite(body: SuitePreviewIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """저장 전 비교 세트로 실제 호출해 보고, API 별로 보낸 요청과 겹치는 결과를 확인한다."""
    inputs = coerce_inputs(body.input_fields, body.inputs)
    specs = []
    for m in body.members:
        target = get_or_404(db, Target, m.target_id, "검색 API")
        specs.append({"label": m.label, "is_baseline": m.is_baseline, "target": target,
                      "input_bindings": m.input_bindings, "match": m.match})
    sides = await call_members(specs, inputs, body.match_mode)
    base = next((x for x in sides if x["is_baseline"]), sides[0])
    for x in sides:
        x["overlap"] = overlap(base["items"], x["items"]) if x is not base and base["ok"] and x["ok"] else None
        x.pop("raw", None)
    return {"inputs": inputs, "sides": sides}


@router.post("/compare")
async def compare(body: CompareIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    suite = get_or_404(db, Suite, body.suite_id, "비교 세트")
    fields = suite.input_fields or []
    inputs = coerce_inputs(fields, body.inputs)
    problems = member_errors(inputs, members_spec(suite.members))
    if problems:
        raise bad_request("\n".join(problems))
    crit_row, model_row = resolve_judge_setup(db, suite, body.criteria_id, body.judge_model_id)
    crit = CritCfg.from_dict(criteria_out(crit_row)) if crit_row else CritCfg()
    specs = [
        {"label": m.label, "is_baseline": m.is_baseline, "target": m.target,
         "input_bindings": m.input_bindings or {}, "match": m.match or {}}
        for m in suite.members
    ]
    out_sides = await call_members(specs, inputs, suite.match_mode or "id")
    sides = [Side(o["label"], o["is_baseline"], o["ok"], o["items"], o["error"], o["latency_ms"]) for o in out_sides]

    evaluation: dict[str, Any] | None = None
    if body.judge:
        if model_row is None:
            raise bad_request("판정 모델이 없습니다. 설정 > 판정 모델에서 먼저 등록하세요.")
        labels = input_labels(fields)
        try:
            ev = await evaluate_case(client_for(model_row), crit, inputs, labels, body.expected, sides)
        except Exception as exc:  # noqa: BLE001
            evaluation = {"ok": False, "error": str(exc)}
        else:
            cost = (ev.usage.input_tokens * model_row.price_input_per_mtok
                    + ev.usage.output_tokens * model_row.price_output_per_mtok) / 1_000_000
            evaluation = {
                "ok": True, "item_judgments": ev.item_judgments, "metrics": ev.metrics, "pairwise": ev.pairwise,
                "tokens_input": ev.usage.input_tokens, "tokens_output": ev.usage.output_tokens,
                "judge_calls": ev.calls, "cost_estimate": cost,
                "judge_model": {"id": model_row.id, "name": model_row.name, "model": model_row.model},
                "criteria": {"id": crit_row.id, "name": crit_row.name, "k": crit.k} if crit_row else None,
            }
    return {"inputs": inputs, "sides": out_sides, "evaluation": evaluation}

