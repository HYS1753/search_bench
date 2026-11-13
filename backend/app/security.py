"""저장 키 암호화와 로그인 세션 토큰.

- 저장 키: Fernet(AES-128-CBC + HMAC). 키는 APP_SECRET_KEY 또는 DATA_DIR/secret.key(최초 자동 생성).
- 세션: HMAC-SHA256 서명 토큰(만료 시각 포함)을 HttpOnly 쿠키로 보낸다.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings

_fernet: Fernet | None = None


def _load_key() -> bytes:
    settings = get_settings()
    if settings.APP_SECRET_KEY.strip():
        raw = settings.APP_SECRET_KEY.strip().encode()
        # Fernet 형식이 아니면 임의 문자열에서 결정적으로 유도한다.
        try:
            Fernet(raw)
            return raw
        except ValueError:
            return base64.urlsafe_b64encode(hashlib.sha256(raw).digest())
    path = settings.DATA_DIR / "secret.key"
    if path.exists():
        return path.read_bytes().strip()
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    # 다른 사용자가 읽지 못하게 0600 으로 만든다.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key)
    return key


def fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_key())
    return _fernet


def reset_crypto() -> None:
    global _fernet
    _fernet = None


def encrypt(value: str) -> str:
    return fernet().encrypt(value.encode()).decode() if value else ""


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError(
            "저장된 키를 복호화할 수 없습니다. APP_SECRET_KEY 또는 data/secret.key 가 바뀌었는지 확인하세요."
        ) from exc


def secret_hint(value: str) -> str:
    """화면 표시용 마스킹(끝 4자리)."""
    value = value.strip()
    if not value:
        return ""
    if value.startswith("{"):
        return "서비스 계정 JSON"
    return "••••" + value[-4:] if len(value) > 8 else "••••"


# ── 로그인 세션 ─────────────────────────────────────────────

SESSION_COOKIE = "judge_session"


def _sign(payload: str) -> str:
    key = hashlib.sha256(b"session:" + _load_key()).digest()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def issue_session() -> str:
    expires = int(time.time()) + get_settings().SESSION_HOURS * 3600
    payload = f"{expires}.{secrets.token_hex(8)}"
    return f"{payload}.{_sign(payload)}"


def verify_session(token: str | None) -> bool:
    if not token or token.count(".") != 2:
        return False
    expires, nonce, sig = token.split(".")
    payload = f"{expires}.{nonce}"
    if not hmac.compare_digest(sig, _sign(payload)):
        return False
    return expires.isdigit() and int(expires) > time.time()


def check_password(candidate: str) -> bool:
    expected = get_settings().APP_PASSWORD
    return bool(expected) and hmac.compare_digest(candidate.encode(), expected.encode())
