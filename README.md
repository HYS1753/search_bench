# SearchBench — 검색 품질 판정 랩 (LLM as a Judge)

검색 API 의 **변경안(TOBE)이 운영(ASIS)보다 나은지**를 LLM 판정으로 비교하고, 근거와 통계를 붙여 결론을 내는 도구입니다.
본 서비스(`data-access-api/src`)와 완전히 분리된 독립 프로젝트이며, 비교 대상은 HTTP 로만 호출합니다.

| 할 수 있는 일 | 설명 |
|---|---|
| 검색 API 연결 | 어떤 API 든 예시 요청(URL·curl, 중첩 JSON 본문 포함)을 붙여넣고, 실제 응답을 보며 쓸 필드만 고르면 끝 |
| 서로 다른 API 비교 | 요청 파라미터·형식·응답 구조·ID 체계가 달라도 공통 입력 연결·변환과 ‘같은 결과’ 규칙으로 비교 |
| API 별 입력 | A 는 `q`+`keywords`, B 는 `q`+`cat` 처럼 받는 값이 달라도 공통/API 전용 입력으로 자동 분리, API 별 필수 값 지정 |
| 후보별 평가 기준 | 후보마다 다른 평가 기준으로 기준 API 와 비교(세트에 저장, 실행마다 변경 가능) |
| 처음 쓰는 사람 | 개요의 ‘처음 사용하시나요?’ → 단계별 시작 가이드, ⌘K 빠른 이동 |
| 실행 전 검증 | 평가 전에 테스트 데이터 전 행을 API 별로 검사 — 실패 행·이유 표시, 고치거나 빼고 실행 |
| 단건 검색 비교 | 같은 입력을 모든 API 에 보내 결과를 나란히 보기(겹침·순위 변화) |
| 평가 | 표에 붙여넣기·파일·저장된 데이터로 여러 입력을 판정 → 결론·지표·차트·분류별 분석 |
| 다양한 판정 모델 | Vertex AI · Gemini API · Anthropic Claude · OpenAI · OpenAI 호환(로컬 Ollama·vLLM 등) |
| 평가 기준 커스터마이즈 | 공용 루브릭은 고정, 검색 목적·사용자 요구사항만 덧붙임(프롬프트 미리보기) |
| 비용 | 판정 모델별·기간별 추정 비용(총액·이전 기간 대비·날짜별·비용 큰 평가), 개요에서 이번 달 총액 우선 표시 |
| 테스트 데이터 LLM 생성 | 서비스 설명으로 비교 세트 입력 형식에 맞춘 질의 생성, 선택 시 실제 검색 결과 기반(답 있는 질의·답 확인), 검토 후 저장 → 바로 평가 |
| 데이터–세트 연결 | 데이터가 비교 세트·열 연결을 기억, 바로 사용/연결 확인/필수 열 부족 표시, 비슷한 이름 자동 연결 |
| 사람 검수 | LLM 판정에 사람 등급·목록 선호를 더해 LLM / 결합 / 사람 점수와 일치도(카파) 비교 |
| 통계 | 부트스트랩 신뢰구간 + 순열 검정 + Holm 보정 + 효과 크기 + 필요 케이스 수 + 윌슨 구간 |
| 판정 설정 | 판정 묶음 크기(1개씩~20개), 평가 기준별 판정 프롬프트 고급 설정 |
| 결과 내보내기 | 엑셀(요약·케이스·항목 판정·목록 비교·설정), CSV, JSON |
| 실행끼리 비교 | 실행 2~6개를 나란히(지표·신뢰구간), 같은 데이터면 케이스별 변화까지 |
| 여러 명이 검수 | 검수자별로 따로 저장, 합의 등급, 검수자 간 일치도 |
| 테스트 데이터 버전 | 편집할 때마다 버전 기록·차이 보기·되돌리기, 실행이 쓴 버전 표시 |
| 계정·권한·공유 | 계정과 역할(관리자·편집자·검수자·보기 전용), 로그인 없이 보는 결과 공유 링크, 감사 기록 |
| 알림·CI | Slack·웹훅 알림, API 토큰, PR 마다 회귀 평가를 돌리는 CI 게이트(curl·GitHub Actions 생성) |
| 비용 상한 | 평가마다 USD 상한, 닿으면 멈추고 ‘이어서 실행’으로 계속 |

## 빠른 시작

### Docker (권장)

```bash
cd llm_as_a_judge
cp .env.example .env          # 필요하면 APP_PASSWORD 등 설정
docker compose up -d --build  # http://localhost:8000
```

처음 열면 빈 상태에서 **시작하기 체크리스트**가 나옵니다. 데이터는 `judge-data` 볼륨에 남아 다음에 다시 띄워도 그대로입니다.

### 로컬 개발

```bash
# 백엔드 (Python 3.12+, uv)
cd llm_as_a_judge/backend
uv sync
uv run python -m app.main                 # http://127.0.0.1:8000  (API 문서: /api/docs)

# 프론트엔드 (Node 20+) — 다른 터미널
cd llm_as_a_judge/frontend
npm install
npm run dev                               # http://localhost:5173  (/api 는 8000 으로 프록시)
```

빌드된 화면까지 백엔드 하나로 띄우려면 `npm run build` 후 `STATIC_DIR=../frontend/dist uv run python -m app.main`.

### 처음 5분 따라 하기
1. **연결 → 판정 모델**: 모델을 등록하고 **연결 테스트**를 누릅니다.
2. **연결 → 검색 API**: 운영(ASIS) API 의 예시 요청을 붙여넣고, 실제 응답에서 제목·판정 내용을 고릅니다. 변경안(TOBE)도 같은 방법으로(또는 복사 후 주소만 바꿔) 연결합니다.
3. **평가 구성 → 비교 세트**: 기준(ASIS)과 후보(TOBE)를 고릅니다. **평가 기준**에서 검색 종류를 고릅니다.
4. **단건 검색 비교**: 입력 하나로 결과를 나란히 확인합니다.
5. **평가**: 입력 여러 개를 표에 붙여넣고 시작 → 결과 화면에서 결론과 차트를 봅니다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | 화면별 사용법, 비교 대상·응답 매핑 설정, 데이터셋 형식 (처음이라면 앱의 도움말 › 시작 가이드) |
| [docs/design.md](docs/design.md) | 화면 디자인·모션 원칙(브랜드, 레이아웃, 애니메이션, 접근성) |
| [docs/evaluation.md](docs/evaluation.md) | 판정 방식(벤치마킹 근거), 지표의 의미와 읽는 법, 결론 규칙 |
| [docs/architecture.md](docs/architecture.md) | 구조, 데이터 모델, 배치 실행·이어서 실행, 보안 |
| [docs/deployment.md](docs/deployment.md) | Docker 배포, 환경 변수, 백업·업그레이드, 운영 점검 |

## 디렉터리

```
llm_as_a_judge/
├── backend/            FastAPI · SQLAlchemy · Alembic · 판정 엔진 · 테스트
│   ├── app/
│   │   ├── api/        REST API (설정·데이터·실행·시스템)
│   │   ├── evaluation/ 프롬프트·판정 엔진·지표/통계
│   │   └── judges/     판정 모델 공급자 어댑터
│   ├── migrations/     DB 스키마 변경 이력(시작 시 자동 적용)
│   └── tests/
├── frontend/           Vite · React · TypeScript · Tailwind
├── docs/
├── Dockerfile · docker-compose.yml · .env.example
└── data/               (실행 시 생성 · git·이미지 제외) SQLite · 업로드 · 암호화 키
```

## 테스트

```bash
cd backend && uv run pytest          # 가짜 판정 모델·가짜 대상 서버로 전체 흐름 검증
cd frontend && npm run typecheck
```

## 데이터가 git 에 올라가지 않게
- 실행 데이터는 모두 `data/` 에만 저장됩니다. `.gitignore` 와 저장소 루트 `.gitignore` 가 `data/`, `*.db`, `secret.key`, `.env` 를 막습니다.
- Docker 이미지에도 들어가지 않습니다(`.dockerignore`).
