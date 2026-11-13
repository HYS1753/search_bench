# LLM as a Judge — 화면(정적 빌드) + API 를 한 컨테이너·한 포트로 제공한다.
# 데이터는 /app/data 볼륨에만 쌓인다(처음엔 빈 상태, 이후 재사용).

# ── 1단계: 화면 빌드 (최종 이미지에는 Node 가 들어가지 않는다) ──
FROM node:20-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── 2단계: Python 의존성 ──
FROM python:3.12-slim AS deps
COPY --from=ghcr.io/astral-sh/uv:0.9.3 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# ── 3단계: 실행 이미지 ──
FROM python:3.12-slim
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
COPY --from=deps /app/.venv /app/.venv
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY backend/alembic.ini ./alembic.ini
COPY --from=ui /ui/dist ./static
RUN mkdir -p /app/data && chown -R app:app /app/data
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/static \
    APP_PORT=8000
USER app
VOLUME ["/app/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"APP_PORT\",\"8000\")}/api/health', timeout=4)" || exit 1
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${APP_PORT} --proxy-headers --forwarded-allow-ips='*'"]
