# 배포·운영

## Docker Compose

```bash
cd llm_as_a_judge
cp .env.example .env      # APP_PASSWORD 는 팀 서버라면 꼭 설정
docker compose up -d --build
docker compose logs -f
```

- 이미지: 1단계 Node 로 화면 빌드 → 최종 이미지는 Python 만(비루트 사용자 `app`), 포트 8000, `/api/health` 헬스체크.
- **처음 실행**: 빈 볼륨이면 DB·암호화 키를 새로 만들고 시작하기 체크리스트를 보여 줍니다(예시 데이터는 자동으로 넣지 않음).
- **다시 실행**: 볼륨(`judge-data` → `/app/data`)의 DB 를 그대로 씁니다. 이미지를 바꿔도 시작 시 마이그레이션으로 데이터가 유지됩니다.
- 초기 상태로 되돌리기: `docker compose down -v` (볼륨 삭제 — 모든 설정·결과가 지워집니다).

### 이미지만 따로

```bash
docker build -t llm-as-a-judge:0.1.0 .
docker run -d --name judge -p 8000:8000 -v judge-data:/app/data --env-file .env llm-as-a-judge:0.1.0
```

### Vertex AI 서비스 계정 파일
화면에서 JSON 을 붙여넣어도 되고(암호화 저장), 파일로 쓰려면:

```yaml
    volumes:
      - judge-data:/app/data
      - ./secrets/sa.json:/app/secrets/sa.json:ro
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /app/secrets/sa.json
```

## 환경 변수

| 변수 | 기본 | 설명 |
|---|---|---|
| `APP_PORT` | 8000 | 서버 포트 |
| `DATA_DIR` | `./data` (Docker `/app/data`) | SQLite·업로드·키 파일 위치 |
| `PUBLIC_URL` | (없음) | 이 서버의 화면 주소(예: https://searchbench.example.com). 알림·CI 응답에 결과 링크를 넣을 때 씀 |
| `APP_PASSWORD` | (없음) | 계정이 없을 때 쓰는 공용 비밀번호(설정하면 로그인 필요). 운영 › 사용자·권한에서 계정을 만들면 계정 로그인으로 바뀝니다 |
| `APP_SECRET_KEY` | (자동) | 저장 키 암호화 키. 비우면 `DATA_DIR/secret.key` 자동 생성 |
| `SESSION_HOURS` | 12 | 로그인 유지 시간 |
| `CORS_ORIGINS` | (없음) | 다른 출처 화면을 쓸 때만(개발) |
| `TARGET_TIMEOUT_SECONDS` | 30 | 비교 대상 기본 타임아웃(대상별로 덮어쓰기 가능) |
| `TARGET_VERIFY_SSL` | true | 기본 SSL 검증(대상별로 덮어쓰기 가능) |
| `RUN_CASE_CONCURRENCY` | 4 | 배치 기본 동시 실행 수 |
| `JUDGE_TIMEOUT_SECONDS` | 120 | 판정 호출 1회 타임아웃 |
| `JUDGE_MAX_RETRIES` | 3 | 판정 호출 재시도 횟수 |
| `OPENAI_API_KEY` · `ANTHROPIC_API_KEY` · `GEMINI_API_KEY` | (없음) | 있으면 화면에 저장한 키보다 우선 |
| `GOOGLE_APPLICATION_CREDENTIALS` · `GCP_PROJECT` · `GCP_LOCATION` | (없음) | Vertex AI 기본값 |
| (자유 이름, 예: `ASIS_API_KEY`) | | 비교 대상의 ‘환경 변수 이름’과 맞춰 쓰는 대상 API 키 |

## 백업·복원
- 백업 대상: `data/judge.db`(+ `-wal`, `-shm`), **`data/secret.key`**(또는 `APP_SECRET_KEY` 값). 키를 잃으면 저장된 API 키를 복호화할 수 없습니다(다시 입력하면 됨).
- 실행 중 백업은 SQLite 온라인 백업을 권장합니다.

```bash
docker compose exec judge python -c "import sqlite3; s=sqlite3.connect('/app/data/judge.db'); d=sqlite3.connect('/app/data/backup.db'); s.backup(d)"
docker compose cp judge:/app/data/backup.db ./backup-$(date +%F).db
```

- 설정만 옮길 때는 **설정 → 환경 → 설정 내보내기/가져오기**(키 제외 JSON)를 쓰세요.

## 업그레이드
1. 백업.
2. `git pull` → `docker compose up -d --build`.
3. 시작 로그에서 마이그레이션 오류가 없는지 확인. 진행 중이던 실행은 ‘중단됨’이 되며 **이어서 실행**으로 계속할 수 있습니다.

## 운영 점검
- 헬스체크: `GET /api/health`
- API 문서: `/api/docs`
- 단일 프로세스(uvicorn) 구성입니다. 배치 실행 상태가 프로세스 메모리에 있으므로 **워커를 여러 개로 늘리지 마세요**(필요해지면 큐 기반 워커로 분리).
- 판정 모델 호출 한도(RPM)에 맞춰 배치의 **동시 실행 수**를 조절하세요. 429 는 자동 재시도하지만 한도를 크게 넘으면 오류 케이스가 늘어납니다.
- 리버스 프록시 뒤에 둘 때 SSE(`/api/runs/{id}/events`)가 버퍼링되지 않게 설정하세요(nginx: `proxy_buffering off;`). 응답에 `X-Accel-Buffering: no` 를 넣어 두었습니다.
