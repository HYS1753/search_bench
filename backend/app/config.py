"""환경 변수 설정. 모든 값은 .env 또는 컨테이너 환경 변수로 덮어쓸 수 있다."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_DIR / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── 앱 ───────────────────────────────────────────────
    APP_NAME: str = "SearchBench"
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    # 모든 실행 데이터(SQLite·업로드·키 파일)가 쌓이는 곳. git·docker 이미지에서 제외된다.
    DATA_DIR: Path = Field(default=PROJECT_DIR / "data")
    # 비우면 로그인 없이 사용. 값이 있으면 이 비밀번호로 로그인해야 한다.
    APP_PASSWORD: str = ""
    # 저장 키 암호화(Fernet) 키. 비우면 DATA_DIR/secret.key 를 자동 생성해 재사용한다.
    APP_SECRET_KEY: str = ""
    SESSION_HOURS: int = 12
    # 알림 메시지에 넣을 화면 주소(예: https://searchbench.example.com). 비우면 링크 없이 보낸다.
    PUBLIC_URL: str = ""
    # 빌드된 UI 경로(Docker: /app/static). 없으면 API만 제공한다.
    STATIC_DIR: Path = Field(default=BACKEND_DIR / "static")
    # 개발 모드에서 Vite(5173) 등 다른 출처 허용 (쉼표 구분)
    CORS_ORIGINS: str = ""

    # ── 비교 대상 호출 기본값 ─────────────────────────────
    TARGET_TIMEOUT_SECONDS: float = 30.0
    TARGET_VERIFY_SSL: bool = True

    # ── 배치 기본값 ──────────────────────────────────────
    RUN_CASE_CONCURRENCY: int = 4
    JUDGE_TIMEOUT_SECONDS: float = 120.0
    JUDGE_MAX_RETRIES: int = 3

    # ── 판정 모델 키(설정 화면 값보다 우선) ───────────────
    OPENAI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    GOOGLE_APPLICATION_CREDENTIALS: str = ""
    GCP_PROJECT: str = ""
    GCP_LOCATION: str = ""

    @property
    def db_path(self) -> Path:
        return self.DATA_DIR / "judge.db"

    @property
    def upload_dir(self) -> Path:
        return self.DATA_DIR / "uploads"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path}"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
