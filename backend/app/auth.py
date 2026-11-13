"""계정·역할·세션.

인증 방식(자동 결정):
- open: 계정도 APP_PASSWORD 도 없음 → 로그인 없이 모두 관리자(처음 설치 상태, 이전과 같음)
- password: APP_PASSWORD 만 있음 → 비밀번호 하나로 로그인(관리자)
- users: 계정이 하나라도 있음 → 아이디·비밀번호 로그인, 역할에 따라 권한
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from typing import Any

from sqlalchemy import func, select

from app.config import get_settings
from app.security import _load_key

ROLES = {"viewer": 0, "reviewer": 1, "editor": 2, "admin": 3}
ROLE_LABEL = {"viewer": "보기 전용", "reviewer": "검수자", "editor": "편집자", "admin": "관리자"}
OPEN_USER = {"id": None, "username": "", "name": "로그인 없음", "role": "admin"}
PASSWORD_USER = {"id": 0, "username": "admin", "name": "관리자(공용 비밀번호)", "role": "admin"}


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${h.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(h)))
        return hmac.compare_digest(got.hex(), h)
    except (ValueError, TypeError):
        return False


def password_problem(pw: str) -> str | None:
    if len(pw) < 8:
        return "비밀번호는 8자 이상이어야 합니다."
    if not (re.search(r"[A-Za-z]", pw) and re.search(r"\d", pw)):
        return "비밀번호에 영문과 숫자를 함께 넣어 주세요."
    return None


def _sign(payload: str) -> str:
    key = hashlib.sha256(b"session:" + _load_key()).digest()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def issue_token(user_id: int) -> str:
    expires = int(time.time()) + get_settings().SESSION_HOURS * 3600
    payload = f"{expires}.{user_id}.{secrets.token_hex(8)}"
    return f"{payload}.{_sign(payload)}"


def token_user_id(token: str | None) -> int | None:
    """서명·만료가 맞으면 계정 id(공용 비밀번호 세션은 0)."""
    if not token:
        return None
    parts = token.split(".")
    if len(parts) == 3:  # 이전 형식(공용 비밀번호): 만료.난수.서명
        from app.security import verify_session

        return 0 if verify_session(token) else None
    if len(parts) != 4:
        return None
    expires, uid, nonce, sig = parts
    if not hmac.compare_digest(sig, _sign(f"{expires}.{uid}.{nonce}")):
        return None
    if not expires.isdigit() or int(expires) < time.time() or not uid.isdigit():
        return None
    return int(uid)


def mode(db) -> str:
    from app.models import User

    if (db.scalar(select(func.count(User.id)).where(User.active.is_(True))) or 0) > 0:
        return "users"
    return "password" if get_settings().APP_PASSWORD else "open"


def user_out(u: Any) -> dict[str, Any]:
    return {"id": u.id, "username": u.username, "name": u.name, "role": u.role, "role_label": ROLE_LABEL.get(u.role, u.role),
            "active": u.active, "created_at": u.created_at.isoformat() + "Z" if u.created_at else None,
            "last_login_at": u.last_login_at.isoformat() + "Z" if u.last_login_at else None}


def current_user(db, token: str | None) -> dict[str, Any] | None:
    from app.models import User

    m = mode(db)
    if m == "open":
        return dict(OPEN_USER)
    uid = token_user_id(token)
    if uid is None:
        return None
    if uid == 0:
        return dict(PASSWORD_USER) if m == "password" else None
    if m != "users":
        return None
    u = db.get(User, uid)
    if not u or not u.active:
        return None
    return {"id": u.id, "username": u.username, "name": u.name or u.username, "role": u.role}


# ── 요청마다 필요한 역할 ─────────────────────────────────────

_ADMIN_WRITE = (re.compile(r"^/api/users"), re.compile(r"^/api/system/import"), re.compile(r"^/api/judge-models"),
                re.compile(r"^/api/notifications"), re.compile(r"^/api/tokens"))
_ADMIN_READ = (re.compile(r"^/api/users"), re.compile(r"^/api/audit"), re.compile(r"^/api/notifications"), re.compile(r"^/api/tokens"))
_REVIEWER_WRITE = (re.compile(r"^/api/runs/\d+/cases/\d+/human$"), re.compile(r"^/api/auth/password$"))


# 바꾸지 않는 POST(보기만 하는 호출)
_READLIKE_POST = (re.compile(r"^/api/compare$"), re.compile(r"^/api/criteria/preview$"))


def required_role(method: str, path: str) -> str:
    if method == "POST" and any(p.match(path) for p in _READLIKE_POST):
        return "viewer"
    if method in ("GET", "HEAD", "OPTIONS"):
        return "admin" if any(p.match(path) for p in _ADMIN_READ) else "viewer"
    if any(p.match(path) for p in _REVIEWER_WRITE):
        return "reviewer" if not path.endswith("/password") else "viewer"
    if any(p.match(path) for p in _ADMIN_WRITE):
        return "admin"
    return "editor"


def allowed(role: str, need: str) -> bool:
    return ROLES.get(role, -1) >= ROLES[need]


_ACTIONS = [
    (r"^POST /api/runs$", "평가 시작"), (r"^POST /api/runs/\d+/cancel$", "평가 취소"), (r"^POST /api/runs/\d+/resume$", "평가 이어서 실행"),
    (r"^DELETE /api/runs/\d+$", "평가 기록 삭제"), (r"^PUT /api/runs/\d+/cases/\d+/human$", "사람 검수"),
    (r"^POST /api/runs/\d+/share$", "공유 링크 만들기"), (r"^DELETE /api/shares/\d+$", "공유 링크 끄기"),
    (r"^(POST|PUT) /api/targets", "검색 API 저장"), (r"^DELETE /api/targets", "검색 API 삭제"),
    (r"^(POST|PUT) /api/judge-models", "판정 모델 저장"), (r"^DELETE /api/judge-models", "판정 모델 삭제"),
    (r"^(POST|PUT) /api/suites", "비교 세트 저장"), (r"^DELETE /api/suites", "비교 세트 삭제"),
    (r"^(POST|PUT) /api/criteria", "평가 기준 저장"), (r"^DELETE /api/criteria", "평가 기준 삭제"),
    (r"^POST /api/generate", "테스트 데이터 생성"), (r"^(POST|PUT) /api/datasets", "테스트 데이터 저장"), (r"^DELETE /api/datasets", "테스트 데이터 삭제"),
    (r"^POST /api/users$", "계정 만들기"), (r"^PUT /api/users", "계정 수정"), (r"^POST /api/auth/login$", "로그인"),
    (r"^POST /api/auth/password$", "비밀번호 변경"), (r"^POST /api/system/import$", "설정 가져오기"),
    (r"^POST /api/ci/runs$", "CI 평가 실행"), (r"^(POST|PUT) /api/notifications", "알림 설정"), (r"^DELETE /api/notifications", "알림 삭제"),
    (r"^POST /api/tokens$", "API 토큰 만들기"), (r"^DELETE /api/tokens", "API 토큰 끄기"),
]


def action_label(method: str, path: str) -> str:
    key = f"{method} {path}"
    return next((label for pat, label in _ACTIONS if re.match(pat, key)), "")
