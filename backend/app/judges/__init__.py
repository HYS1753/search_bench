"""판정 모델 레지스트리 — DB 의 JudgeModel 을 실행 가능한 클라이언트로 바꾼다.

키 우선순위: 환경 변수(.env) > 설정 화면에 저장한 암호화 키.
"""

from __future__ import annotations

from pathlib import Path

from app.config import get_settings
from app.judges.base import PROVIDERS, JudgeClient, JudgeConfig, JudgeError, JudgeResult, Usage
from app.judges.providers import build_client
from app.models import JudgeModel
from app.security import decrypt

__all__ = [
    "PROVIDERS",
    "JudgeClient",
    "JudgeConfig",
    "JudgeError",
    "JudgeResult",
    "Usage",
    "client_for",
    "config_for",
    "env_secret_source",
]


def env_secret_source(provider: str) -> str:
    """이 공급자에 대해 환경 변수로 키가 주어졌으면 그 변수 이름을 돌려준다."""
    s = get_settings()
    if provider == "openai" and s.OPENAI_API_KEY:
        return "OPENAI_API_KEY"
    if provider == "anthropic" and s.ANTHROPIC_API_KEY:
        return "ANTHROPIC_API_KEY"
    if provider == "gemini" and s.GEMINI_API_KEY:
        return "GEMINI_API_KEY"
    if provider == "vertex" and s.GOOGLE_APPLICATION_CREDENTIALS:
        return "GOOGLE_APPLICATION_CREDENTIALS"
    return ""


def _env_secret(provider: str) -> str:
    s = get_settings()
    if provider == "openai":
        return s.OPENAI_API_KEY
    if provider == "anthropic":
        return s.ANTHROPIC_API_KEY
    if provider == "gemini":
        return s.GEMINI_API_KEY
    if provider == "vertex" and s.GOOGLE_APPLICATION_CREDENTIALS:
        path = Path(s.GOOGLE_APPLICATION_CREDENTIALS).expanduser()
        if not path.exists():
            raise JudgeError(f"GOOGLE_APPLICATION_CREDENTIALS 파일이 없습니다: {path}")
        return path.read_text(encoding="utf-8")
    return ""


def config_for(model: JudgeModel) -> JudgeConfig:
    s = get_settings()
    secret = _env_secret(model.provider) or decrypt(model.secret_enc)
    project = model.project or (s.GCP_PROJECT if model.provider == "vertex" else "")
    location = model.location or (s.GCP_LOCATION if model.provider == "vertex" else "")
    return JudgeConfig(
        provider=model.provider,
        model=model.model,
        base_url=model.base_url,
        project=project,
        location=location,
        secret=secret,
        params=dict(model.params or {}),
        timeout=s.JUDGE_TIMEOUT_SECONDS,
        max_retries=s.JUDGE_MAX_RETRIES,
    )


def client_for(model: JudgeModel) -> JudgeClient:
    return build_client(config_for(model))
