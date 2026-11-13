"""앱 진입점 — API(/api) + 빌드된 UI(정적 파일, SPA) 를 한 포트로 제공한다."""

from __future__ import annotations

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api import costs_api, data_api, generate_api, integrations_api, runs_api, settings_api, system_api, users_api
from app.api.integrations_api import user_from_token
from app.generation import manager as gen_manager
from app.config import BACKEND_DIR, get_settings
from app.auth import ROLE_LABEL, action_label, allowed, current_user, required_role
from app.db import get_engine, session_scope
from app.models import AuditLog
from app.runs import manager
from app.security import SESSION_COOKIE, fernet

log = logging.getLogger("judge")
PUBLIC_API = {"/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"}
PUBLIC_PREFIX = ("/api/share/",)


def migrate(revision: str = "head") -> None:
    """시작할 때마다 최신 스키마로 올린다(빈 볼륨이면 새로 만들고, 기존 데이터는 보존).

    SQLite 는 컬럼·제약을 바꿀 때 테이블을 새로 만들어 옮긴 뒤 옛 테이블을 지운다(batch). 이때 외래 키가 켜져 있으면
    옛 부모 테이블을 지우는 순간 ON DELETE CASCADE 로 자식 행(예: 테스트 데이터의 행)이 함께 지워진다.
    그래서 마이그레이션 동안만 이 연결의 외래 키를 끄고, 끝나면 무결성을 검사한 뒤 다시 켠다(SQLite·Alembic 권장 절차).
    """
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    with get_engine().connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")  # 트랜잭션 밖에서 실행해야 적용된다
        conn.commit()
        try:
            with conn.begin():
                cfg.attributes["connection"] = conn
                command.upgrade(cfg, revision)
            broken = conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
            if broken:
                log.warning("마이그레이션 후 외래 키 불일치 %d건: %s", len(broken), broken[:5])
        finally:
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")
            conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
    migrate()
    fernet()  # 키 파일이 없으면 이 시점에 생성
    interrupted = manager.recover_on_startup()
    if interrupted:
        log.warning("서버 재시작으로 중단된 실행 %d건을 'interrupted' 로 표시했습니다.", interrupted)
    yield
    await manager.shutdown()
    await gen_manager.shutdown()


_READ_LIKE = [re.compile(r"^/api/compare$"), re.compile(r"^/api/criteria/preview$"), re.compile(r"^/api/runs/validate$"),
              re.compile(r"^/api/suites/preview$"), re.compile(r"^/api/targets/test$")]


def _audit_later(request: Request, method: str, path: str, status: int) -> None:
    """요청의 DB 트랜잭션이 끝나기 전에 쓰면 SQLite 잠금을 기다리며 이벤트 루프가 멈추므로 다른 스레드에서 남긴다."""
    user = dict(getattr(request.state, "user", None) or {})

    def write() -> None:
        try:
            with session_scope() as s:
                s.add(AuditLog(user_id=user.get("id"), username=user.get("username") or user.get("name") or "", method=method,
                               path=path[:300], status=status, action=action_label(method, path)))
        except Exception:  # noqa: BLE001 — 기록 실패가 요청을 막지 않게
            log.exception("audit failed")

    asyncio.get_running_loop().run_in_executor(None, write)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.APP_NAME, version=__version__, lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                           allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def auth_guard(request: Request, call_next):
        """로그인 확인 → 역할 확인 → 바꾸는 요청은 감사 기록."""
        path, method = request.url.path, request.method
        if not path.startswith("/api") or path in PUBLIC_API or path.startswith(PUBLIC_PREFIX):
            response = await call_next(request)
            if path == "/api/auth/login" and method == "POST":
                _audit_later(request, method, path, response.status_code)
            return response
        with session_scope() as s:
            authz = request.headers.get("authorization", "")
            if authz.lower().startswith("bearer sbk_"):
                # CI·스크립트용 API 토큰(계정과 무관하게 토큰의 역할로)
                user = user_from_token(s, authz.split(" ", 1)[1].strip())
                if user is None:
                    return JSONResponse({"detail": "API 토큰이 올바르지 않거나 꺼졌습니다."}, status_code=401)
            else:
                user = current_user(s, request.cookies.get(SESSION_COOKIE))
        if user is None:
            return JSONResponse({"detail": "로그인이 필요합니다."}, status_code=401)
        need = required_role(method, path)
        if not allowed(user["role"], need):
            return JSONResponse({"detail": f"권한이 없습니다. 이 작업은 {ROLE_LABEL[need]} 이상만 할 수 있습니다(지금 역할: {ROLE_LABEL.get(user['role'], user['role'])}). 관리자에게 요청하세요."},
                                status_code=403)
        request.state.user = user
        response = await call_next(request)
        if method not in ("GET", "HEAD", "OPTIONS") and not any(p.match(path) for p in _READ_LIKE):
            _audit_later(request, method, path, response.status_code)
        return response

    for router in (users_api.router, integrations_api.router, system_api.router, settings_api.router, generate_api.router, data_api.router, runs_api.router, costs_api.router):
        app.include_router(router, prefix="/api")

    static_dir: Path = settings.STATIC_DIR
    index = static_dir / "index.html"
    if index.exists():
        if (static_dir / "assets").exists():
            app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str):
            # /api 로 시작하는데 여기 왔으면 없는 API
            if full_path.startswith("api/"):
                return JSONResponse({"detail": "없는 API 입니다."}, status_code=404)
            candidate = (static_dir / full_path).resolve()
            if full_path and candidate.is_file() and static_dir.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()


def run() -> None:
    import uvicorn

    s = get_settings()
    uvicorn.run("app.main:app", host=s.APP_HOST, port=s.APP_PORT, proxy_headers=True)


if __name__ == "__main__":
    run()
