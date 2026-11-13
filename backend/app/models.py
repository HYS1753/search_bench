"""DB 스키마. 변경 시 alembic 리비전을 추가한다(기존 볼륨 데이터 보존).

시간은 모두 UTC naive 로 저장하고, API 응답에서 'Z' 를 붙여 내보낸다.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class JudgeModel(TimestampMixin, Base):
    """판정에 쓰는 LLM 연결. secret_enc 는 Fernet 암호문(API 키 또는 서비스 계정 JSON)."""

    __tablename__ = "judge_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    project: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    location: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    secret_enc: Mapped[str] = mapped_column(Text, default="", nullable=False)
    secret_hint: Mapped[str] = mapped_column(String(50), default="", nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    price_input_per_mtok: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    price_output_per_mtok: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_test_message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Target(TimestampMixin, Base):
    """비교 대상 API 1개 — 요청 방식과 응답 매핑."""

    __tablename__ = "targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    method: Mapped[str] = mapped_column(String(10), default="GET", nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    path: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    headers: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, nullable=False)
    # auth: {"type": "none|bearer|header|query", "name": "X-API-Key", "env": "ASIS_API_KEY"}
    auth: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    secret_enc: Mapped[str] = mapped_column(Text, default="", nullable=False)
    secret_hint: Mapped[str] = mapped_column(String(50), default="", nullable=False)
    # [{"name","source":"field|const","field","value","location":"query|body","array_style":"repeat|space|comma|json"}]
    params: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    # {"results_path","id_path","title_path","text_fields":[{"label","path"}],"score_path"}
    response_mapping: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    timeout_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    verify_ssl: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Suite(TimestampMixin, Base):
    """비교 세트 — 함께 비교할 대상들과 공통 입력 필드."""

    __tablename__ = "suites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # [{"key","label","type":"text|list|int","required","default","help"}]
    input_fields: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    default_criteria_id: Mapped[int | None] = mapped_column(
        ForeignKey("criteria.id", ondelete="SET NULL"), nullable=True
    )
    # 같은 결과를 알아보는 기준: id | title | none
    match_mode: Mapped[str] = mapped_column(String(10), default="id", server_default="id", nullable=False)
    members: Mapped[list[SuiteTarget]] = relationship(
        back_populates="suite", cascade="all, delete-orphan", order_by="SuiteTarget.position"
    )
    datasets: Mapped[list[Dataset]] = relationship(viewonly=True, primaryjoin="Suite.id == foreign(Dataset.suite_id)")


class SuiteTarget(Base):
    __tablename__ = "suite_targets"
    __table_args__ = (UniqueConstraint("suite_id", "target_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    suite_id: Mapped[int] = mapped_column(ForeignKey("suites.id", ondelete="CASCADE"), nullable=False)
    target_id: Mapped[int] = mapped_column(ForeignKey("targets.id", ondelete="CASCADE"), nullable=False)
    label: Mapped[str] = mapped_column(String(50), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_baseline: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 공통 입력 → 이 API 입력 연결 규칙, 고유 번호 정규화 규칙 (app/matching.py)
    input_bindings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}", nullable=False)
    match: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}", nullable=False)
    # 후보마다 기준 API 와 비교할 때 쓰는 평가 기준(없으면 세트 기본 기준)
    criteria_id: Mapped[int | None] = mapped_column(
        ForeignKey("criteria.id", ondelete="SET NULL", name="fk_suite_targets_criteria"), nullable=True
    )

    suite: Mapped[Suite] = relationship(back_populates="members")
    target: Mapped[Target] = relationship()


class Criteria(TimestampMixin, Base):
    """평가 기준 — 공용 루브릭(코드 고정) 위에 검색 목적·사용자 요구사항을 덧붙인다."""

    __tablename__ = "criteria"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    task_context: Mapped[str] = mapped_column(Text, default="", nullable=False)
    user_requirements: Mapped[str] = mapped_column(Text, default="", nullable=False)
    k: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    relevant_threshold: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    pairwise_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # 고급 설정 — 비우면 기본 판정 프롬프트(app/evaluation/prompts.py)
    system_prompt: Mapped[str] = mapped_column(Text, default="", server_default="", nullable=False)
    item_template: Mapped[str] = mapped_column(Text, default="", server_default="", nullable=False)
    pairwise_template: Mapped[str] = mapped_column(Text, default="", server_default="", nullable=False)


class Dataset(TimestampMixin, Base):
    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    source_filename: Mapped[str] = mapped_column(String(300), default="", nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 이 데이터를 쓰는 비교 세트와 저장된 컬럼 연결(평가할 때 고친 연결이 여기에 남는다)
    suite_id: Mapped[int | None] = mapped_column(
        ForeignKey("suites.id", ondelete="SET NULL", name="fk_datasets_suite"), nullable=True
    )
    mapping: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}", nullable=False)
    # 출처: {"source": "file|manual|paste|llm", ...생성 설정}
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}", nullable=False)
    # 지금 버전(저장할 때마다 1씩, dataset_versions 에 사본)
    version: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    suite: Mapped[Suite | None] = relationship()
    rows: Mapped[list[DatasetRow]] = relationship(
        back_populates="dataset", cascade="all, delete-orphan", order_by="DatasetRow.row_index"
    )


class DatasetRow(Base):
    __tablename__ = "dataset_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id", ondelete="CASCADE"), index=True)
    row_index: Mapped[int] = mapped_column(Integer, nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    dataset: Mapped[Dataset] = relationship(back_populates="rows")


class Run(TimestampMixin, Base):
    """배치 실행. 설정은 실행 시점 스냅샷으로 저장해 이후 설정 변경과 무관하게 재현 가능하게 한다."""

    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    suite_id: Mapped[int | None] = mapped_column(ForeignKey("suites.id", ondelete="SET NULL"), nullable=True)
    dataset_id: Mapped[int | None] = mapped_column(ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True)
    judge_model_id: Mapped[int | None] = mapped_column(
        ForeignKey("judge_models.id", ondelete="SET NULL"), nullable=True
    )
    # {"suite":{...,"members":[{target snapshot}]}, "criteria":{...}, "judge_model":{name,provider,model}, "mapping":{...}}
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True, nullable=False)
    total: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tokens_input: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tokens_output: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    judge_calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_estimate: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    cases: Mapped[list[RunCase]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="RunCase.row_index"
    )


class RunCase(Base):
    __tablename__ = "run_cases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    row_index: Mapped[int] = mapped_column(Integer, nullable=False)
    case_key: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    category: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    inputs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    expected: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True, nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # {"<label>": {"ndcg":..,"hit1":..,"mrr":..,"precision":..,"ok":..}}
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    # {"<candidate label>": {"winner":"candidate|baseline|tie","consistent":bool,"reason":..,"orders":[..]}}
    pairwise: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    # {"<item_key>": {"grade":0..3,"reason":..}}
    item_judgments: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    # 사람 판정: {"<item_key>": {"grade":0..3,"note":..,"at":..}} (key 는 item_judgments 와 같은 규칙)
    human_judgments: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}", nullable=False)
    # 사람의 목록 선호: {"<candidate label>": "candidate|baseline|tie"}
    human_pairwise: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}", nullable=False)
    # 검수자별 원본: {"검수자": {"grades": {key: {grade, note, at}}, "pairwise": {후보: 선호}}}
    # human_judgments/human_pairwise 는 여기서 계산한 합의(등급 중앙값·선호 다수결)다.
    human_by: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    run: Mapped[Run] = relationship(back_populates="cases")
    responses: Mapped[list[RunResponse]] = relationship(
        back_populates="case", cascade="all, delete-orphan", order_by="RunResponse.position"
    )


class RunResponse(Base):
    """케이스 × 대상 1건의 호출 결과(정규화된 항목 목록 포함)."""

    __tablename__ = "run_responses"
    __table_args__ = (UniqueConstraint("run_case_id", "label"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_case_id: Mapped[int] = mapped_column(ForeignKey("run_cases.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(50), nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ok: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # [{"key","title","fields":[{"label","value"}],"score"}]
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    raw: Mapped[Any] = mapped_column(JSON, nullable=True)

    case: Mapped[RunCase] = relationship(back_populates="responses")


class GenerationJob(Base):
    """LLM 으로 테스트 데이터를 만드는 작업(서버에서 비동기로 진행, 결과는 검토 후 데이터셋으로 저장)."""

    __tablename__ = "generation_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    suite_id: Mapped[int | None] = mapped_column(ForeignKey("suites.id", ondelete="SET NULL"), nullable=True)
    judge_model_id: Mapped[int | None] = mapped_column(ForeignKey("judge_models.id", ondelete="SET NULL"), nullable=True)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="queued", nullable=False)
    stage: Mapped[str] = mapped_column(String(50), default="", nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    rows: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    tokens_input: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tokens_output: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    judge_calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_estimate: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    error: Mapped[str] = mapped_column(Text, default="", nullable=False)
    dataset_id: Mapped[int | None] = mapped_column(ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class User(Base):
    """로그인 계정. 역할: admin(관리자) · editor(편집자) · reviewer(검수자) · viewer(보기 전용)."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    password_hash: Mapped[str] = mapped_column(String(300), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="viewer", nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ShareLink(Base):
    """평가 결과를 로그인 없이 보기 전용으로 보여 주는 링크."""

    __tablename__ = "share_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True, nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    views: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class AuditLog(Base):
    """바꾸는 요청(누가·언제·무엇을). 요청 본문은 남기지 않는다(키·비밀번호 보호)."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True, nullable=False)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    username: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    path: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(200), default="", nullable=False)


class DatasetVersion(Base):
    """테스트 데이터의 한 버전(그때의 열·행 전체 사본)."""

    __tablename__ = "dataset_versions"
    __table_args__ = (UniqueConstraint("dataset_id", "version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id", ondelete="CASCADE"), index=True, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    columns: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    rows: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list, nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    note: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class NotificationChannel(Base):
    """평가 완료·실패·저하 결론 등을 보낼 곳(Slack 수신 웹훅 또는 일반 웹훅). 주소는 암호화해 저장."""

    __tablename__ = "notification_channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), default="slack", nullable=False)
    url_enc: Mapped[str] = mapped_column(Text, default="", nullable=False)
    url_hint: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    events: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class ApiToken(Base):
    """CI·스크립트용 토큰(Authorization: Bearer sbk_…). 원문은 만들 때 한 번만 보여 주고 해시만 저장."""

    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    prefix: Mapped[str] = mapped_column(String(20), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="editor", nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
