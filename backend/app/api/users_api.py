"""로그인·계정·역할·공유 링크·감사 기록."""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.common import bad_request, get_or_404, iso, run_out
from app.auth import (
    ROLE_LABEL, current_user, hash_password, issue_token, mode, password_problem, user_out, verify_password,
)
from app.config import get_settings
from app.db import get_db
from app.models import AuditLog, Run, RunCase, ShareLink, User, utcnow
from app.security import SESSION_COOKIE, check_password, issue_session

router = APIRouter(tags=["users"])
Role = Literal["admin", "editor", "reviewer", "viewer"]


def _set_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", max_age=get_settings().SESSION_HOURS * 3600)


def me(request: Request) -> dict[str, Any]:
    return getattr(request.state, "user", None) or {}


# ── 로그인 ─────────────────────────────────────────────────


@router.get("/auth/status")
def auth_status(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = mode(db)
    u = current_user(db, request.cookies.get(SESSION_COOKIE))
    return {"mode": m, "required": m != "open", "authenticated": u is not None,
            "user": ({**u, "role_label": ROLE_LABEL.get(u["role"], u["role"])} if u else None)}


class LoginIn(BaseModel):
    username: str = ""
    password: str


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    m = mode(db)
    if m == "open":
        return {"ok": True}
    if m == "password":
        if not check_password(body.password):
            raise bad_request("비밀번호가 올바르지 않습니다.")
        _set_cookie(response, request, issue_session())
        return {"ok": True}
    u = db.scalar(select(User).where(func.lower(User.username) == body.username.strip().lower()))
    if not u or not u.active or not verify_password(body.password, u.password_hash):
        raise bad_request("아이디 또는 비밀번호가 올바르지 않습니다.")
    u.last_login_at = utcnow()
    request.state.user = {"id": u.id, "username": u.username, "name": u.name, "role": u.role}
    _set_cookie(response, request, issue_token(u.id))
    return {"ok": True, "user": user_out(u)}


@router.post("/auth/logout")
def logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


class PasswordIn(BaseModel):
    current: str
    new: str


@router.post("/auth/password")
def change_password(body: PasswordIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    uid = me(request).get("id")
    u = db.get(User, uid) if uid else None
    if not u:
        raise bad_request("계정으로 로그인한 경우에만 바꿀 수 있습니다.")
    if not verify_password(body.current, u.password_hash):
        raise bad_request("지금 비밀번호가 올바르지 않습니다.")
    if (p := password_problem(body.new)):
        raise bad_request(p)
    u.password_hash = hash_password(body.new)
    return {"ok": True}


# ── 계정(관리자) ────────────────────────────────────────────


class UserIn(BaseModel):
    username: str = Field(min_length=2, max_length=60, pattern=r"^[A-Za-z0-9._@-]+$")
    name: str = Field(default="", max_length=100)
    role: Role = "viewer"
    password: str


class UserPatch(BaseModel):
    name: str | None = None
    role: Role | None = None
    active: bool | None = None
    password: str | None = None


@router.get("/users")
def list_users(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"mode": mode(db), "roles": ROLE_LABEL, "items": [user_out(u) for u in db.scalars(select(User).order_by(User.id))]}


def _admins_left(db: Session, except_id: int | None = None) -> int:
    q = select(func.count(User.id)).where(User.active.is_(True), User.role == "admin")
    if except_id:
        q = q.where(User.id != except_id)
    return db.scalar(q) or 0


@router.post("/users")
def create_user(body: UserIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    first = mode(db) != "users"
    if first and body.role != "admin":
        raise bad_request("첫 계정은 관리자여야 합니다. 계정을 만들면 그때부터 로그인이 필요합니다.")
    if db.scalar(select(User).where(func.lower(User.username) == body.username.lower())):
        raise bad_request("이미 있는 아이디입니다.")
    if (p := password_problem(body.password)):
        raise bad_request(p)
    u = User(username=body.username, name=body.name.strip() or body.username, role=body.role, password_hash=hash_password(body.password))
    db.add(u)
    db.flush()
    if first:
        # 로그인 없이 쓰던 상태에서 첫 관리자를 만들면 바로 그 계정으로 로그인된 상태로 둔다(잠기지 않게)
        _set_cookie(response, request, issue_token(u.id))
    return user_out(u)


@router.put("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    u = get_or_404(db, User, user_id, "계정")
    demote = (body.role and body.role != "admin") or body.active is False
    if u.role == "admin" and u.active and demote and _admins_left(db, u.id) == 0:
        raise bad_request("마지막 관리자는 역할을 바꾸거나 끌 수 없습니다. 다른 관리자를 먼저 만드세요.")
    if body.name is not None:
        u.name = body.name.strip() or u.username
    if body.role:
        u.role = body.role
    if body.active is not None:
        u.active = body.active
    if body.password:
        if (p := password_problem(body.password)):
            raise bad_request(p)
        u.password_hash = hash_password(body.password)
    return user_out(u)


@router.get("/audit")
def audit(limit: int = 200, user: str = "", db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    q = select(AuditLog).order_by(AuditLog.id.desc()).limit(min(1000, max(1, limit)))
    if user:
        q = q.where(AuditLog.username == user)
    return [{"id": a.id, "at": iso(a.at), "username": a.username, "method": a.method, "path": a.path, "status": a.status, "action": a.action}
            for a in db.scalars(q)]


# ── 공유 링크 ──────────────────────────────────────────────


class ShareIn(BaseModel):
    days: int | None = Field(default=30, ge=1, le=365)


def share_out(s: ShareLink) -> dict[str, Any]:
    expired = bool(s.expires_at and s.expires_at < utcnow())
    return {"id": s.id, "token": s.token, "url": f"/share/{s.token}", "run_id": s.run_id, "created_by": s.created_by,
            "created_at": iso(s.created_at), "expires_at": iso(s.expires_at), "revoked": s.revoked, "expired": expired, "views": s.views,
            "active": not s.revoked and not expired}


@router.post("/runs/{run_id}/share")
def create_share(run_id: int, body: ShareIn, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    get_or_404(db, Run, run_id, "실행")
    s = ShareLink(token=secrets.token_urlsafe(24), run_id=run_id, created_by=me(request).get("name") or me(request).get("username") or "",
                  expires_at=utcnow() + timedelta(days=body.days) if body.days else None)
    db.add(s)
    db.flush()
    return share_out(s)


@router.get("/runs/{run_id}/shares")
def list_shares(run_id: int, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [share_out(s) for s in db.scalars(select(ShareLink).where(ShareLink.run_id == run_id).order_by(ShareLink.id.desc()))]


@router.delete("/shares/{share_id}")
def revoke_share(share_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_or_404(db, ShareLink, share_id, "공유 링크")
    s.revoked = True
    return share_out(s)


def _valid_share(db: Session, token: str) -> ShareLink:
    s = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if not s or s.revoked or (s.expires_at and s.expires_at < utcnow()):
        raise bad_request("공유 링크가 없거나 만료·해제되었습니다. 링크를 보낸 사람에게 새 링크를 요청하세요.")
    return s


@router.get("/share/{token}")
def view_share(token: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """로그인 없이 보는 결과(보기 전용). 키·주소 같은 설정 세부는 빼고 결과만 준다."""
    s = _valid_share(db, token)
    s.views += 1
    run = db.get(Run, s.run_id)
    out = run_out(run)
    for k in ("mapping", "options", "judge_model_id", "suite_id", "dataset_id"):
        out.pop(k, None)
    cases = db.scalars(select(RunCase).where(RunCase.run_id == run.id).options(selectinload(RunCase.responses)).order_by(RunCase.row_index)).all()
    cand = next((m["label"] for m in run.snapshot.get("members", []) if not m.get("is_baseline")), "")
    base = next((m["label"] for m in run.snapshot.get("members", []) if m.get("is_baseline")), "")
    rows = []
    for c in cases:
        if c.status != "done":
            continue
        resp = {r.label: r for r in c.responses}
        a, b = (c.metrics or {}).get(cand, {}), (c.metrics or {}).get(base, {})
        rows.append({
            "id": c.id, "case_key": c.case_key, "category": c.category, "inputs": c.inputs,
            "ndcg_diff": a["ndcg"] - b["ndcg"] if a.get("ndcg") is not None and b.get("ndcg") is not None else None,
            "winner": ((c.pairwise or {}).get(cand) or {}).get("winner"),
            "tops": {lb: (r.items[0]["title"] if r.ok and r.items else None) for lb, r in resp.items()},
        })
    return {"run": out, "cases": rows, "expires_at": iso(s.expires_at), "shared_by": s.created_by}
