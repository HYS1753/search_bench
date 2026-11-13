"""테스트 데이터 LLM 생성 API — 작업 만들기·진행 조회·취소·검토 후 저장."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import bad_request, dataset_out, get_or_404, iso
from app.dataset_link import dataset_columns_for
from app.dataset_versions import record as record_version
from app.dataset_versions import who
from app.db import get_db
from app.generation import STYLES, manager
from app.models import Dataset, DatasetRow, GenerationJob, JudgeModel, Suite, utcnow
from app.validation import field_label

router = APIRouter(tags=["generate"])


class GenerateIn(BaseModel):
    suite_id: int
    judge_model_id: int | None = None
    description: str = Field(default="", max_length=4000)
    categories: list[str] = Field(default_factory=list, max_length=30)
    count: int = Field(default=30, ge=1, le=500)
    styles: dict[str, int] = Field(default_factory=lambda: {"natural": 3, "keyword": 2})
    grounded: bool = False
    preview: bool = False


def job_out(j: GenerationJob, *, with_rows: bool = True) -> dict[str, Any]:
    out = {
        "id": j.id, "suite_id": j.suite_id, "judge_model_id": j.judge_model_id, "params": j.params, "status": j.status,
        "stage": j.stage, "progress": j.progress, "total": j.total, "stats": j.stats, "error": j.error,
        "tokens_input": j.tokens_input, "tokens_output": j.tokens_output, "judge_calls": j.judge_calls,
        "cost_estimate": j.cost_estimate, "dataset_id": j.dataset_id, "created_at": iso(j.created_at),
        "finished_at": iso(j.finished_at), "row_count": len(j.rows or []),
    }
    if with_rows:
        out["rows"] = j.rows or []
    return out


@router.get("/generate/options")
def options(suite_id: int | None = None, db: Session = Depends(get_db)) -> dict[str, Any]:
    """생성 화면 기본값: 표현 방식 설명, 비교 세트 입력, 서비스 설명 초안(평가 기준의 검색 목적·세트 메모)."""
    out: dict[str, Any] = {"styles": STYLES}
    if suite_id:
        s = get_or_404(db, Suite, suite_id, "비교 세트")
        from app.models import Criteria

        crit_ids = [m.criteria_id for m in s.members if m.criteria_id] + ([s.default_criteria_id] if s.default_criteria_id else [])
        crit = db.get(Criteria, crit_ids[0]) if crit_ids else None
        draft = "\n".join(x for x in [s.description.strip(), (crit.task_context or "").strip() if crit else ""] if x)
        out["description_draft"] = draft
        out["inputs"] = [{"key": f["key"], "label": field_label(f), "type": f.get("type", "text"), "required": bool(f.get("required")),
                          "scope": f.get("scope", "")} for f in s.input_fields or []]
        out["members"] = [m.label for m in s.members]
    return out


@router.post("/generate")
async def create_job(body: GenerateIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    suite = get_or_404(db, Suite, body.suite_id, "비교 세트")
    model = db.get(JudgeModel, body.judge_model_id) if body.judge_model_id else db.scalar(
        select(JudgeModel).where(JudgeModel.is_default.is_(True))) or db.scalar(select(JudgeModel).order_by(JudgeModel.id))
    if model is None:
        raise bad_request("생성에 쓸 모델이 없습니다. 연결 › 판정 모델에서 먼저 등록해 주세요.")
    if not suite.input_fields:
        raise bad_request("비교 세트에 입력 항목이 없습니다.")
    params = body.model_dump(exclude={"suite_id", "judge_model_id"})
    if body.preview:
        params["count"] = min(5, body.count)
    params["model_name"] = model.name
    job = GenerationJob(suite_id=suite.id, judge_model_id=model.id, params=params, status="queued", stage="대기")
    db.add(job)
    db.flush()
    jid = job.id
    db.commit()
    manager.start(jid)
    return job_out(job)


@router.get("/generate/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    j = get_or_404(db, GenerationJob, job_id, "생성 작업")
    if j.status in ("queued", "running") and not manager.is_running(j.id):
        j.status, j.error = "failed", "서버가 재시작되어 중단되었습니다. 다시 만들어 주세요."
    return job_out(j)


@router.post("/generate/{job_id}/cancel")
async def cancel_job(job_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    get_or_404(db, GenerationJob, job_id, "생성 작업")
    await manager.cancel(job_id)
    return {"ok": True}


class SaveRow(BaseModel):
    category: str = ""
    style: str = ""
    inputs: dict[str, Any] = Field(default_factory=dict)
    expected: str = ""
    source: dict[str, Any] | None = None
    check: dict[str, Any] | None = None


class SaveIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    rows: list[SaveRow] | None = None  # 검토 화면에서 고친 행(없으면 작업 결과 그대로)


@router.post("/generate/{job_id}/save")
def save_job(job_id: int, body: SaveIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    """검토한 결과를 테스트 데이터로 저장한다. 비교 세트와 연결·컬럼 연결까지 저장되어 바로 평가에 쓸 수 있다."""
    j = get_or_404(db, GenerationJob, job_id, "생성 작업")
    suite = get_or_404(db, Suite, j.suite_id or 0, "비교 세트")
    rows = [r.model_dump() for r in body.rows] if body.rows is not None else (j.rows or [])
    if not rows:
        raise bad_request("저장할 행이 없습니다.")
    fields = suite.input_fields or []
    columns, mapping = dataset_columns_for(fields)
    grounded = bool(j.params.get("grounded"))
    extra = ["표현 방식"] + (["원본 항목", "답 확인"] if grounded else [])
    d = Dataset(name=body.name, description=body.description, columns=[*columns, *extra], source_filename="LLM 생성",
                suite_id=suite.id, mapping=mapping,
                meta={"source": "llm", "job_id": j.id, "model": j.params.get("model_name"), "grounded": grounded,
                      "count": len(rows), "styles": j.params.get("styles"), "categories": j.params.get("categories"),
                      "description": j.params.get("description"), "created_at": iso(utcnow())})
    for i, r in enumerate(rows):
        data: dict[str, Any] = {"케이스": f"G{i + 1:03d}", "분류": r.get("category", ""), "기대 정답": r.get("expected", ""),
                                "표현 방식": STYLES.get(r.get("style", ""), r.get("style", "")).split(" — ")[0]}
        for f in fields:
            v = (r.get("inputs") or {}).get(f["key"], "")
            data[mapping["fields"][f["key"]]] = " ".join(map(str, v)) if isinstance(v, list) else ("" if v is None else v)
        if grounded:
            src, chk = r.get("source") or {}, r.get("check") or {}
            data["원본 항목"] = f"{src.get('api', '')} · {src.get('title', '')}" if src else ""
            data["답 확인"] = ("찾음: " + ", ".join(chk["found_in"])) if chk.get("found_in") else ("결과 0건" if chk.get("empty") else ("못 찾음" if chk else ""))
        d.rows.append(DatasetRow(row_index=i, data=data))
    d.row_count = len(rows)
    db.add(d)
    db.flush()
    record_version(db, d, f"LLM 생성 · {j.params.get('model_name') or ''}", who(request))
    j.dataset_id = d.id
    return dataset_out(d)
