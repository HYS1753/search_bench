"""연동 — 알림 채널(Slack·웹훅), 자동화용 API 토큰, CI 에서 평가를 돌리고 통과/실패를 받는 엔드포인트."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import bad_request, get_or_404, iso
from app.db import get_db, session_scope
from app.models import ApiToken, Dataset, NotificationChannel, Run, Suite
from app.notify import EVENTS, run_payload, send_one
from app.security import encrypt

router = APIRouter(tags=["integrations"])


# ── 알림 채널 ──────────────────────────────────────────────


class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["slack", "webhook"] = "slack"
    url: str | None = None  # 수정할 때 비우면 그대로
    events: list[Literal["run_done", "run_failed", "run_regressed", "generation_done"]] = Field(default_factory=lambda: ["run_done", "run_failed"])
    active: bool = True


def channel_out(c: NotificationChannel) -> dict[str, Any]:
    return {"id": c.id, "name": c.name, "kind": c.kind, "url_hint": c.url_hint, "events": c.events or [], "active": c.active,
            "last_ok": c.last_ok, "last_message": c.last_message, "last_sent_at": iso(c.last_sent_at)}


def _hint(url: str) -> str:
    from urllib.parse import urlparse

    u = urlparse(url)
    return f"{u.scheme}://{u.netloc}/…{url[-4:]}" if u.netloc else "…"


@router.get("/notifications")
def list_channels(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"events": EVENTS, "items": [channel_out(c) for c in db.scalars(select(NotificationChannel).order_by(NotificationChannel.id))]}


@router.post("/notifications")
def create_channel(body: ChannelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    if not body.url or not body.url.startswith(("http://", "https://")):
        raise bad_request("http(s):// 로 시작하는 주소를 넣어 주세요. Slack 은 ‘Incoming Webhook’ 주소입니다.")
    c = NotificationChannel(name=body.name, kind=body.kind, url_enc=encrypt(body.url), url_hint=_hint(body.url), events=list(body.events), active=body.active)
    db.add(c)
    db.flush()
    return channel_out(c)


@router.put("/notifications/{cid}")
def update_channel(cid: int, body: ChannelIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = get_or_404(db, NotificationChannel, cid, "알림")
    c.name, c.kind, c.events, c.active = body.name, body.kind, list(body.events), body.active
    if body.url:
        c.url_enc, c.url_hint = encrypt(body.url), _hint(body.url)
    return channel_out(c)


@router.delete("/notifications/{cid}")
def delete_channel(cid: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    db.delete(get_or_404(db, NotificationChannel, cid, "알림"))
    return {"ok": True}


@router.post("/notifications/{cid}/test")
async def test_channel(cid: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    c = get_or_404(db, NotificationChannel, cid, "알림")
    sample = {"run_id": 0, "name": "알림 테스트", "status": "done", "cases": 30, "candidate": "TOBE", "baseline": "ASIS",
              "verdict": "improved", "verdict_title": "후보가 기준보다 개선되었습니다(테스트 메시지)", "ndcg_diff": 0.05,
              "ndcg_ci": [0.01, 0.09], "win_rate": 0.7, "cost": 0, "error": "", "url": None}
    ok, msg = await send_one(c, "run_done", sample)
    from app.models import utcnow

    c.last_ok, c.last_message, c.last_sent_at = ok, f"테스트 · {msg}", utcnow()
    return {"ok": ok, "message": msg, "channel": channel_out(c)}


# ── API 토큰 ───────────────────────────────────────────────


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    role: Literal["editor", "viewer"] = "editor"


def token_out(t: ApiToken) -> dict[str, Any]:
    return {"id": t.id, "name": t.name, "prefix": t.prefix, "role": t.role, "created_by": t.created_by,
            "created_at": iso(t.created_at), "last_used_at": iso(t.last_used_at), "revoked": t.revoked}


@router.get("/tokens")
def list_tokens(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [token_out(t) for t in db.scalars(select(ApiToken).order_by(ApiToken.id.desc()))]


@router.post("/tokens")
def create_token(body: TokenIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    raw = "sbk_" + secrets.token_urlsafe(32)
    u = getattr(request.state, "user", None) or {}
    t = ApiToken(name=body.name, prefix=raw[:10], token_hash=token_hash(raw), role=body.role, created_by=u.get("name") or u.get("username") or "")
    db.add(t)
    db.flush()
    return {**token_out(t), "token": raw}


@router.delete("/tokens/{tid}")
def revoke_token(tid: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    t = get_or_404(db, ApiToken, tid, "토큰")
    t.revoked = True
    return token_out(t)


def user_from_token(db: Session, raw: str) -> dict[str, Any] | None:
    t = db.scalar(select(ApiToken).where(ApiToken.token_hash == token_hash(raw), ApiToken.revoked.is_(False)))
    if not t:
        return None
    from app.models import utcnow

    t.last_used_at = utcnow()
    return {"id": None, "username": f"token:{t.name}", "name": f"토큰 {t.name}", "role": t.role, "token_id": t.id}


# ── CI ────────────────────────────────────────────────────


class CiRunIn(BaseModel):
    suite: int | str  # 비교 세트 id 또는 이름
    dataset: int | str  # 테스트 데이터 id 또는 이름
    name: str = ""
    case_limit: int | None = Field(default=None, ge=1)
    judge_model_id: int | None = None
    judge_batch_size: int = Field(default=12, ge=1, le=50)
    criteria_by_member: dict[str, int] = Field(default_factory=dict)
    # 이번 실행만 API 주소를 바꾼다(예: PR 미리보기 배포): {"TOBE": {"base_url": "https://pr-123.example.com"}}
    target_overrides: dict[str, dict[str, str]] = Field(default_factory=dict)
    skip_invalid: bool = True
    max_cost: float | None = Field(default=None, gt=0)  # 이 실행의 비용 상한(USD)
    wait: bool = True
    timeout_seconds: int = Field(default=1800, ge=10, le=7200)
    # 통과 기준: regressed = '저하'만 실패 · not_improved = '개선'이 아니면 실패 · none = 끝나기만 하면 통과
    gate: Literal["regressed", "not_improved", "none"] = "regressed"


def ci_result(run: Run, gate: str) -> dict[str, Any]:
    from app.config import get_settings

    cmp = ((run.summary or {}).get("comparisons") or [None])[0] or {}
    code = (cmp.get("verdict") or {}).get("code")
    title = (cmp.get("verdict") or {}).get("title") or "결론 없음"
    finished = run.status not in ("queued", "running")
    if not finished:
        passed = None
        reason = "아직 진행 중입니다."
    elif run.status != "done":
        passed, reason = False, f"평가가 끝나지 못했습니다({run.status}). {run.error}"
    elif gate == "regressed":
        passed, reason = code != "regressed", f"‘저하’ 결론이면 실패 — 결과: {title}"
    elif gate == "not_improved":
        passed, reason = code == "improved", f"‘개선’ 결론이어야 통과 — 결과: {title}"
    else:
        passed, reason = True, "끝나면 통과"
    base = get_settings().PUBLIC_URL.rstrip("/")
    return {"run_id": run.id, "status": run.status, "finished": finished, "passed": passed, "gate": gate, "reason": reason,
            "verdict": code, "verdict_title": (cmp.get("verdict") or {}).get("title"), "ndcg_diff": cmp.get("ndcg_diff"),
            "ndcg_ci": cmp.get("ndcg_ci"), "win_rate": cmp.get("win_rate"), "permutation_p": cmp.get("permutation_p"),
            "cases": (run.summary or {}).get("cases"), "cost": run.cost_estimate, "url": f"{base}/runs/{run.id}" if base else f"/runs/{run.id}"}


@router.post("/ci/runs")
async def ci_run(body: CiRunIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    """CI 에서 한 번에: 평가 시작 → (wait) 끝날 때까지 기다림 → 통과/실패. 통과 여부는 응답의 passed 로 판단하세요."""
    from app.api.runs_api import MappingIn, RunIn, create_run
    from app.dataset_link import effective_mapping

    suite = db.get(Suite, body.suite) if isinstance(body.suite, int) else db.scalar(select(Suite).where(Suite.name == body.suite))
    if not suite:
        raise bad_request(f"비교 세트 '{body.suite}' 를 찾지 못했습니다.")
    ds = db.get(Dataset, body.dataset) if isinstance(body.dataset, int) else db.scalar(select(Dataset).where(Dataset.name == body.dataset))
    if not ds:
        raise bad_request(f"테스트 데이터 '{body.dataset}' 를 찾지 못했습니다.")
    labels = {m.label for m in suite.members}
    bad = [k for k in body.target_overrides if k not in labels]
    if bad:
        raise bad_request(f"target_overrides 의 라벨이 비교 세트에 없습니다: {', '.join(bad)} (있는 라벨: {', '.join(sorted(labels))})")
    m = effective_mapping(ds, suite)
    run_body = RunIn(name=body.name or f"CI · {suite.name} · {ds.name}", suite_id=suite.id, dataset_id=ds.id,
                     mapping=MappingIn(**{k: m.get(k) or ("" if k != "fields" else {}) for k in ("fields", "case_key", "category", "expected")}),
                     judge_model_id=body.judge_model_id, judge_batch_size=body.judge_batch_size, case_limit=body.case_limit,
                     criteria_by_member=body.criteria_by_member, skip_invalid=body.skip_invalid, target_overrides=body.target_overrides,
                     max_cost=body.max_cost)
    created = await create_run(run_body, db)
    run_id = created["id"]
    if not body.wait:
        return ci_result(db.get(Run, run_id), body.gate)
    db.commit()
    deadline = time.time() + body.timeout_seconds
    while time.time() < deadline:
        await asyncio.sleep(1.0)
        with session_scope() as s:
            r = s.get(Run, run_id)
            if r and r.status not in ("queued", "running"):
                return ci_result(r, body.gate)
    with session_scope() as s:
        return {**ci_result(s.get(Run, run_id), body.gate), "passed": False, "reason": f"{body.timeout_seconds}초 안에 끝나지 않았습니다(실행은 계속됩니다)."}


@router.get("/ci/runs/{run_id}")
def ci_status(run_id: int, gate: Literal["regressed", "not_improved", "none"] = "regressed", db: Session = Depends(get_db)) -> dict[str, Any]:
    return ci_result(get_or_404(db, Run, run_id, "실행"), gate)


@router.get("/ci/catalog")
def ci_catalog(db: Session = Depends(get_db)) -> dict[str, Any]:
    """CI 설정을 만들 때 고를 이름 목록."""
    return {
        "suites": [{"id": s.id, "name": s.name, "labels": [m.label for m in s.members]} for s in db.scalars(select(Suite).order_by(Suite.id))],
        "datasets": [{"id": d.id, "name": d.name, "rows": d.row_count, "suite_id": d.suite_id} for d in db.scalars(select(Dataset).order_by(Dataset.id.desc()))],
        "tokens": db.scalar(select(func.count(ApiToken.id)).where(ApiToken.revoked.is_(False))) or 0,
    }
