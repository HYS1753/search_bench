"""설정 API — 판정 모델·비교 대상·비교 세트·평가 기준."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.errors import explain
from app.api.common import bad_request, criteria_out, get_or_404, judge_model_out, suite_out, target_out
from app.db import get_db
from app.evaluation import prompts
from app.judges import PROVIDERS, client_for
from app.models import Criteria, JudgeModel, Run, Suite, SuiteTarget, Target, utcnow
from app.security import encrypt, secret_hint
from app.targets import call_target, http_client

router = APIRouter()

# ── 판정 모델 ─────────────────────────────────────────────────


class JudgeModelIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    provider: Literal["vertex", "gemini", "anthropic", "openai", "openai_compatible"]
    model: str = Field(min_length=1, max_length=200)
    base_url: str = ""
    project: str = ""
    location: str = ""
    # None: 기존 키 유지, "": 키 삭제, 값: 새 키
    secret: str | None = None
    params: dict[str, Any] = Field(default_factory=lambda: {"temperature": 0, "max_tokens": 4096})
    price_input_per_mtok: float = Field(default=0.0, ge=0)
    price_output_per_mtok: float = Field(default=0.0, ge=0)
    is_default: bool = False


def _apply_model(m: JudgeModel, body: JudgeModelIn) -> None:
    for key in ("name", "provider", "model", "base_url", "project", "location", "params",
                "price_input_per_mtok", "price_output_per_mtok"):
        setattr(m, key, getattr(body, key))
    if body.secret is not None:
        m.secret_enc = encrypt(body.secret.strip())
        m.secret_hint = secret_hint(body.secret)
    m.last_test_ok = None
    m.last_test_message = ""


@router.get("/providers")
def providers() -> dict[str, Any]:
    from app.judges import env_secret_source

    return {k: {**v, "env_secret": env_secret_source(k)} for k, v in PROVIDERS.items()}


@router.get("/judge-models")
def list_models(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [judge_model_out(m) for m in db.scalars(select(JudgeModel).order_by(JudgeModel.id))]


@router.post("/judge-models")
def create_model(body: JudgeModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = JudgeModel()
    _apply_model(m, body)
    first = db.scalar(select(func.count(JudgeModel.id))) == 0
    if body.is_default or first:
        db.execute(update(JudgeModel).values(is_default=False))
        m.is_default = True
    db.add(m)
    db.flush()
    return judge_model_out(m)


@router.put("/judge-models/{model_id}")
def update_model(model_id: int, body: JudgeModelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = get_or_404(db, JudgeModel, model_id, "판정 모델")
    _apply_model(m, body)
    if body.is_default:
        db.execute(update(JudgeModel).where(JudgeModel.id != m.id).values(is_default=False))
        m.is_default = True
    return judge_model_out(m)


@router.post("/judge-models/{model_id}/default")
def set_default(model_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = get_or_404(db, JudgeModel, model_id, "판정 모델")
    db.execute(update(JudgeModel).values(is_default=False))
    m.is_default = True
    return judge_model_out(m)


@router.delete("/judge-models/{model_id}")
def delete_model(model_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = get_or_404(db, JudgeModel, model_id, "판정 모델")
    was_default = m.is_default
    db.delete(m)
    db.flush()
    if was_default:
        nxt = db.scalar(select(JudgeModel).order_by(JudgeModel.id))
        if nxt:
            nxt.is_default = True
    return {"ok": True}


@router.post("/judge-models/{model_id}/test")
async def test_model(model_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = get_or_404(db, JudgeModel, model_id, "판정 모델")
    schema = {"type": "object", "properties": {"answer": {"type": "string"}, "ok": {"type": "boolean"}},
              "required": ["answer", "ok"]}
    try:
        client = client_for(m)
        res = await client.complete_json(
            "연결 테스트입니다. 지시에 따라 JSON 만 출력하세요.",
            'answer 에 "연결 성공" 을, ok 에 true 를 넣으세요.', schema, name="connection_test",
        )
        ok, message = True, f"응답 확인 · 토큰 {res.usage.input_tokens}/{res.usage.output_tokens}"
    except Exception as exc:  # noqa: BLE001
        ok, message = False, explain(str(exc))[:600]
    m.last_test_ok, m.last_test_message, m.last_tested_at = ok, message, utcnow()
    return {"ok": ok, "message": message, "model": judge_model_out(m)}


# ── 비교 대상 ─────────────────────────────────────────────────


class ParamSpec(BaseModel):
    name: str
    source: Literal["field", "const"] = "field"
    field: str = ""
    value: str = ""
    location: Literal["query", "body", "path"] = "query"
    array_style: Literal["", "repeat", "space", "comma", "json"] = ""
    example: str = ""
    label: str = ""
    required: bool = False
    json_type: Literal["", "string", "number", "boolean"] = ""


class TextField(BaseModel):
    label: str = ""
    path: str


class ResponseMapping(BaseModel):
    results_path: str = "results"
    id_path: str = ""
    title_path: str = ""
    score_path: str = ""
    text_fields: list[TextField] = Field(default_factory=list)


class AuthSpec(BaseModel):
    type: Literal["none", "bearer", "header", "query"] = "none"
    name: str = ""
    env: str = ""


class TargetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    method: Literal["GET", "POST"] = "GET"
    base_url: str = Field(min_length=1, max_length=500)
    path: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    auth: AuthSpec = Field(default_factory=AuthSpec)
    secret: str | None = None
    params: list[ParamSpec] = Field(default_factory=list)
    response_mapping: ResponseMapping = Field(default_factory=ResponseMapping)
    timeout_seconds: float | None = Field(default=None, gt=0, le=600)
    verify_ssl: bool = True


def _apply_target(t: Target, body: TargetIn) -> None:
    data = body.model_dump()
    for key in ("name", "description", "method", "base_url", "path", "headers", "auth", "params",
                "response_mapping", "timeout_seconds", "verify_ssl"):
        setattr(t, key, data[key])
    if body.secret is not None:
        t.secret_enc = encrypt(body.secret.strip())
        t.secret_hint = secret_hint(body.secret)


@router.get("/targets")
def list_targets(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [target_out(t) for t in db.scalars(select(Target).order_by(Target.id))]


@router.post("/targets")
def create_target(body: TargetIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    t = Target()
    _apply_target(t, body)
    db.add(t)
    db.flush()
    return target_out(t)


@router.put("/targets/{target_id}")
def update_target(target_id: int, body: TargetIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    t = get_or_404(db, Target, target_id, "검색 API")
    _apply_target(t, body)
    return target_out(t)


@router.post("/targets/{target_id}/duplicate")
def duplicate_target(target_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    t = get_or_404(db, Target, target_id, "검색 API")
    copy = Target(**{c: getattr(t, c) for c in ("description", "method", "base_url", "path", "headers", "auth",
                                                 "secret_enc", "secret_hint", "params", "response_mapping",
                                                 "timeout_seconds", "verify_ssl")}, name=f"{t.name} (복사본)")
    db.add(copy)
    db.flush()
    return target_out(copy)


@router.delete("/targets/{target_id}")
def delete_target(target_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    t = get_or_404(db, Target, target_id, "검색 API")
    used = db.scalars(select(Suite.name).join(SuiteTarget).where(SuiteTarget.target_id == t.id)).all()
    if used:
        raise bad_request(f"비교 세트에서 사용 중입니다: {', '.join(used)}. 세트에서 먼저 빼 주세요.")
    db.delete(t)
    return {"ok": True}


class TargetTestIn(BaseModel):
    target: TargetIn
    target_id: int | None = None
    inputs: dict[str, Any] = Field(default_factory=dict)


@router.post("/targets/test")
async def test_target(body: TargetTestIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """저장 전 설정으로 실제 호출해 보고, 응답 매핑 결과를 미리 본다."""
    t = Target()
    _apply_target(t, body.target)
    if body.target.secret is None and body.target_id:
        stored = db.get(Target, body.target_id)
        if stored:
            t.secret_enc = stored.secret_enc
    async with http_client(t.verify_ssl) as client:
        res = await call_target(client, t, body.inputs)
    return {
        "ok": res.ok, "status_code": res.status_code, "latency_ms": res.latency_ms, "error": res.error,
        "items": res.items, "raw": res.raw, "request": res.request,
    }


# ── 비교 세트 ─────────────────────────────────────────────────


class InputField(BaseModel):
    key: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    label: str = ""
    type: Literal["text", "list", "int"] = "text"
    required: bool = False
    default: Any = None
    help: str = ""
    scope: str = ""  # "" = 모든 API 공통, 아니면 그 입력을 쓰는 API 의 라벨


class BindingIn(BaseModel):
    source: str = Field(default="", alias="from")
    transform: Literal["as_is", "join_space", "join_comma", "split", "first", "number", "const", "template"] = "as_is"
    value: str = ""

    model_config = {"populate_by_name": True}

    def dump(self) -> dict[str, Any]:
        return {"from": self.source, "transform": self.transform, "value": self.value}


class MatchIn(BaseModel):
    lower: bool = False
    digits_only: bool = False
    strip_prefix: str = ""
    strip_suffix: str = ""


class MemberIn(BaseModel):
    target_id: int
    label: str = Field(min_length=1, max_length=50)
    is_baseline: bool = False
    input_bindings: dict[str, BindingIn] = Field(default_factory=dict)
    match: MatchIn = Field(default_factory=MatchIn)
    # 후보: 기준 API 와 비교할 때 쓸 평가 기준
    criteria_id: int | None = None


class SuiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    input_fields: list[InputField] = Field(min_length=1)
    members: list[MemberIn] = Field(min_length=2)
    default_criteria_id: int | None = None
    match_mode: Literal["id", "title", "none"] = "id"


def _apply_suite(s: Suite, body: SuiteIn, db: Session) -> None:
    labels = [m.label.strip() for m in body.members]
    if len(set(labels)) != len(labels):
        raise bad_request("대상 이름(라벨)이 중복되었습니다.")
    if len({m.target_id for m in body.members}) != len(body.members):
        raise bad_request("같은 검색 API 를 두 번 넣을 수 없습니다.")
    keys = [f.key for f in body.input_fields]
    if len(set(keys)) != len(keys):
        raise bad_request("입력 필드 key 가 중복되었습니다.")
    for m in body.members:
        if not db.get(Target, m.target_id):
            raise bad_request(f"검색 API #{m.target_id} 가 없습니다.")
    baselines = [m for m in body.members if m.is_baseline]
    base_index = body.members.index(baselines[0]) if baselines else 0
    s.name, s.description = body.name, body.description
    s.input_fields = [f.model_dump() for f in body.input_fields]
    for m in body.members:
        if m.criteria_id and not db.get(Criteria, m.criteria_id):
            raise bad_request(f"평가 기준 #{m.criteria_id} 가 없습니다.")
    cand_crit = [m.criteria_id for i, m in enumerate(body.members) if i != base_index and m.criteria_id]
    # 세트 기본 기준 = 첫 번째 후보의 기준(후보별 기준이 없을 때 대체값)
    s.default_criteria_id = cand_crit[0] if cand_crit else body.default_criteria_id
    s.match_mode = body.match_mode
    s.members.clear()
    db.flush()
    for pos, m in enumerate(body.members):
        s.members.append(SuiteTarget(
            target_id=m.target_id, label=m.label.strip(), position=pos, is_baseline=pos == base_index,
            input_bindings={k: v.dump() for k, v in m.input_bindings.items()}, match=m.match.model_dump(),
            criteria_id=None if pos == base_index else (m.criteria_id or body.default_criteria_id),
        ))


@router.get("/suites")
def list_suites(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [suite_out(s) for s in db.scalars(select(Suite).order_by(Suite.id))]


@router.get("/suites/{suite_id}")
def get_suite(suite_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_or_404(db, Suite, suite_id, "비교 세트")
    return suite_out(s)


@router.post("/suites")
def create_suite(body: SuiteIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = Suite()
    _apply_suite(s, body, db)
    db.add(s)
    db.flush()
    return suite_out(s)


@router.put("/suites/{suite_id}")
def update_suite(suite_id: int, body: SuiteIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_or_404(db, Suite, suite_id, "비교 세트")
    _apply_suite(s, body, db)
    db.flush()
    return suite_out(s)


@router.delete("/suites/{suite_id}")
def delete_suite(suite_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_or_404(db, Suite, suite_id, "비교 세트")
    db.delete(s)
    return {"ok": True}


# ── 평가 기준 ─────────────────────────────────────────────────


class CriteriaIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""
    task_context: str = ""
    user_requirements: str = ""
    k: int = Field(default=5, ge=1, le=50)
    relevant_threshold: int = Field(default=2, ge=1, le=3)
    pairwise_enabled: bool = True
    # 고급 설정(비우면 기본 판정 프롬프트)
    system_prompt: str = ""
    item_template: str = ""
    pairwise_template: str = ""

    def check(self) -> None:
        errs = [f"{label}: {e}" for kind, label in (("system_prompt", "시스템 프롬프트"), ("item_template", "항목 판정 프롬프트"),
                                                    ("pairwise_template", "목록 비교 프롬프트"))
                for e in prompts.validate_template(kind, getattr(self, kind))]
        if errs:
            raise bad_request("\n".join(errs))


@router.get("/criteria/prompt-defaults")
def prompt_defaults() -> dict[str, Any]:
    """고급 설정 화면: 기본 프롬프트 원문과 쓸 수 있는 자리 표시자."""
    return {"defaults": prompts.DEFAULTS, "placeholders": prompts.PLACEHOLDERS}


@router.get("/criteria")
def list_criteria(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [criteria_out(c) for c in db.scalars(select(Criteria).order_by(Criteria.id))]


@router.post("/criteria")
def create_criteria(body: CriteriaIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    body.check()
    c = Criteria(**body.model_dump())
    db.add(c)
    db.flush()
    return criteria_out(c)


@router.put("/criteria/{criteria_id}")
def update_criteria(criteria_id: int, body: CriteriaIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = get_or_404(db, Criteria, criteria_id, "평가 기준")
    body.check()
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    return criteria_out(c)


@router.post("/criteria/{criteria_id}/duplicate")
def duplicate_criteria(criteria_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = get_or_404(db, Criteria, criteria_id, "평가 기준")
    copy = Criteria(**{k: getattr(c, k) for k in CriteriaIn.model_fields})
    copy.name = f"{c.name} (복사본)"
    db.add(copy)
    db.flush()
    return criteria_out(copy)


@router.delete("/criteria/{criteria_id}")
def delete_criteria(criteria_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = get_or_404(db, Criteria, criteria_id, "평가 기준")
    db.delete(c)
    return {"ok": True}


class PreviewIn(BaseModel):
    task_context: str = ""
    user_requirements: str = ""
    k: int = 5
    system_prompt: str = ""
    item_template: str = ""
    pairwise_template: str = ""


@router.post("/criteria/preview")
def preview_criteria(body: PreviewIn) -> dict[str, Any]:
    errors = {kind: prompts.validate_template(kind, getattr(body, kind)) for kind in prompts.DEFAULTS}
    if any(errors.values()):
        return {"errors": errors, "system": "", "item": "", "pairwise": "",
                "default_task_context": prompts.DEFAULT_TASK_CONTEXT, "grade_scale": prompts.GRADE_SCALE}
    out = prompts.preview(body.task_context, body.user_requirements, body.k, system_prompt=body.system_prompt,
                          item_template=body.item_template, pairwise_template=body.pairwise_template)
    out["errors"] = errors
    out["default_task_context"] = prompts.DEFAULT_TASK_CONTEXT
    out["grade_scale"] = prompts.GRADE_SCALE
    return out


@router.get("/criteria/{criteria_id}/usage")
def criteria_usage(criteria_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    runs = db.scalar(select(func.count(Run.id)).where(Run.snapshot["criteria"]["id"].as_integer() == criteria_id))
    return {"runs": runs or 0}
