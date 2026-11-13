# 구조

## 구성

```
브라우저 (React SPA, CSR)
   │  /            정적 파일(빌드된 화면)
   │  /api/*       JSON API · SSE
   ▼
FastAPI (uvicorn, 단일 프로세스·단일 포트)
   ├─ api/          REST: 설정·데이터셋·단건 검색 비교·실행·시스템
   ├─ runs.py       배치 실행 관리자(asyncio 작업) + 이벤트 허브(SSE)
   ├─ evaluation/   프롬프트 조립 · 판정 엔진 · 지표/통계
   ├─ judges/       공급자 어댑터(Vertex·Gemini·Anthropic·OpenAI·OpenAI 호환)
   ├─ targets.py    비교 대상 호출 · 응답 정규화(경로 매핑)
   └─ SQLite (WAL)  data/judge.db  ← Alembic 으로 시작 시 자동 마이그레이션
```

- 화면은 **클라이언트 사이드 렌더링**입니다. 서버 기능(실행·판정·저장)은 모두 FastAPI 가 담당하므로 실행 시 Node 프로세스가 필요 없습니다(빌드할 때만 사용).
- 개발 시에는 Vite(5173)가 `/api` 를 백엔드(8000)로 프록시합니다.

## 데이터 모델

| 테이블 | 내용 |
|---|---|
| `judge_models` | 판정 모델 연결(공급자·모델·주소·암호화된 키·파라미터·단가·기본 여부·마지막 테스트) |
| `targets` | 비교 대상 API(메서드·주소·경로·헤더·인증·암호화된 키·파라미터·응답 매핑·타임아웃) |
| `suites`, `suite_targets` | 비교 세트(공통 입력·기본 평가 기준·같은 결과 기준 `match_mode`), 구성 API(라벨·순서·기준 여부·입력 연결 `input_bindings`·고유 번호 규칙 `match`) |
| `criteria` | 평가 기준(검색 목적·사용자 요구사항·k·관련 기준 등급·목록 비교) |
| `datasets`, `dataset_rows` | 데이터셋(컬럼), 행(JSON) |
| `runs` | 실행(설정 스냅샷·옵션·상태·진행·토큰·비용·요약) |
| `run_cases` | 케이스(입력·기대·상태·지표·목록 비교·항목 판정) |
| `run_responses` | 케이스×대상 응답(성공 여부·상태 코드·지연·정규화된 항목·원본) |

- 실행은 생성 시점의 비교 세트·대상·평가 기준·판정 모델·컬럼 연결을 `runs.snapshot` 에 **복사**합니다. 이후 설정을 바꿔도 결과가 재현됩니다. 대상의 **키는 스냅샷에 넣지 않고** 실행 시점에 현재 저장값을 씁니다.
- 스키마 변경은 `backend/migrations/versions` 에 Alembic 리비전으로 추가합니다. 컨테이너 시작 시 `upgrade head` 가 자동 실행되어 기존 볼륨 데이터를 보존합니다.

```bash
cd backend
DATA_DIR=/tmp/schema uv run alembic revision --autogenerate -m "변경 내용" --rev-id 0002
```

## 서로 다른 API 맞추기 (`app/matching.py`)

```
공통 입력 {q, keywords, top_k}
   ├─ ASIS: bind_inputs → {q, keywords, top_k}            → GET ?q=…&keywords=…&keywords=…
   └─ TOBE: bind_inputs → {query_text, query_size, keyword} → POST {"query": {"text", "size"}, "keyword"}
응답 → normalize_items(API 별 응답 매핑) → apply_match(같은 결과 key: 고유 번호 규칙 | 제목 | 대상별)
```

- `input_bindings`: `{API 입력 key: {from: 공통 입력 key, transform, value}}`. 없으면 같은 이름을 그대로 쓴다(이전 동작).
- 본문 파라미터 이름이 `a.b[0].c` 같은 경로면 `set_path` 로 중첩 JSON 을 만들고 `json_type` 으로 숫자·불리언을 복원한다.
- `apply_match` 가 바꾼 key 로 항목 판정을 공유하고 순위 변화·겹침을 계산한다(원래 값은 `raw_key`).
- `POST /api/suites/preview`: 저장 전 설정으로 실제 호출해 API 별 보낸 입력·겹침을 돌려준다.

## 입력 범위와 검증 (`app/validation.py`)

- 대상 파라미터: `params[i] = {name, source:"field"|"const", field, label, required, …}` — `required` 는 ‘이 API 는 이 값이 꼭 필요’.
- 비교 세트 입력: `input_fields[i] = {key, label, type, required, scope}` — `scope=""` 공통, `scope="<API 라벨>"` 그 API 전용(key 는 관례상 `라벨__이름`).
- `row_inputs`: 테스트 데이터 행 → 입력값(타입 변환·기본값·필수 검사).
- `member_errors`: API 마다 `bind_inputs` 로 실제 보낼 값을 만든 뒤 `required` 파라미터가 비었는지 검사. 단건 검색 비교(`/api/compare`)는 이 결과가 있으면 호출 전에 400.
- `POST /api/runs/validate`: 전 행 검사 결과 `{total, valid, invalid, errors[{row, messages}], inputs[{key,label,column,filled,empty}], unmapped}`.
- `POST /api/runs`: 같은 검증을 다시 하고, 실패 행이 있으면 `skip_invalid=true` 일 때만 통과한 행으로 케이스를 만든다.

## 후보별 평가 기준

- `suite_targets.criteria_id`: 후보가 기준 API 와 견줄 때 쓰는 평가 기준(마이그레이션 0003, 기존 세트는 세트 기본 기준을 복사). `suites.default_criteria_id` 는 첫 후보의 기준(대체값).
- 실행 스냅샷: `criteria`(대표 = 첫 후보의 기준, 이전 형식 호환) + `criteria_by_member`(후보 라벨 → 기준). 요청의 `criteria_by_member` 가 세트 설정보다 우선합니다.
- 판정(`runs.evaluate_groups`): 같은 기준을 쓰는 후보끼리 묶어 기준 API 와 함께 `evaluate_case` 를 돌립니다. 그룹이 하나면 이전과 같습니다.
  - 대표 그룹의 항목 판정은 key 그대로, 다른 그룹은 `@{기준 id}:{key}` 로 `item_judgments` 에 저장(같은 항목도 기준이 다르면 등급이 다를 수 있음).
  - 기준 API 지표: 대표 그룹은 `metrics[기준]`, 다른 그룹은 `metrics["{기준}@{후보}"]`. 요약의 비교(`comparisons[]`)는 후보의 기준으로 본 기준 API 값과 견주고, `criteria`·`baseline_ndcg`·`baseline_hit1` 을 함께 돌려줍니다.

## 테스트 데이터 ↔ 비교 세트 (`app/dataset_link.py`)

- `datasets.suite_id`·`datasets.mapping`(저장된 열 연결)·`datasets.meta`(출처: file/manual/paste/llm + 생성 설정). 마이그레이션 0005.
- `effective_mapping`: 같은 세트에 저장된 연결이 있으면 우선, 없어진 열만 자동 연결로 채움. `compat`: ready / check / missing + 빠진 필수 입력·비슷한 이름 연결·안 쓰는 열.
- `GET /api/datasets?suite_id=` 는 호환 상태를 붙여 정렬, `GET /api/datasets/{id}/compat`, `PUT /api/datasets/{id}/binding`, `GET /api/datasets/blank-columns`. 평가를 만들 때(`POST /api/runs`) 쓴 연결을 데이터에 저장합니다(다른 세트에 이미 묶인 데이터는 건드리지 않음).

## 테스트 데이터 버전 (`app/dataset_versions.py`)

- `dataset_versions`(데이터마다 최근 30개, 열·행 전체 사본), `datasets.version`(지금 버전). 마이그레이션 0008(기존 데이터는 v1). 내용이 직전 버전과 같으면(값은 글자 기준 비교) 남기지 않습니다.
- `GET /api/datasets/{id}/versions`(직전 대비 바뀐 수·그 버전으로 한 평가 수), `GET …/versions/diff?a=&b=`(케이스 열로 짝지어 추가·삭제·변경), `POST …/versions/{v}/restore`(그 내용을 새 버전으로).
- 실행 사본 `snapshot.dataset.version` 에 실행 당시 버전을 남깁니다.

## 테스트 데이터 생성 (`app/generation.py`, `app/api/generate_api.py`)

- `generation_jobs` 테이블, 서버 안 asyncio 작업(평가 실행과 같은 방식). `POST /api/generate` → `GET /api/generate/{id}`(진행·행) → `POST /api/generate/{id}/save`(검토한 행으로 데이터셋 저장 + 세트 연결) / `cancel`.
- 비교 세트 입력으로 JSON 스키마를 만들어 구조화 출력으로 받고, 칸(분류·말투) 할당량을 미리 나눠 10개씩 요청. 형식·필수값 검사, 개인정보 패턴, 문자 3-gram 유사 중복 제거, 이미 만든 질의를 ‘피할 목록’으로 전달.
- grounded: 탐색 질의 → `data_api.call_members` 로 모든 API 호출 → API 별로 번갈아 원본 항목 선택 → 원본이 답인 질의 생성 → 다시 검색해 `check.found_in / empty` 기록.
- 생성 모델은 판정 모델 설정에서 temperature 만 0.9 로 올려 씁니다. 비용은 `/api/costs` 에 합산(`totals.by_purpose.generation`).

## 알림·API 토큰·CI (`app/notify.py`, `app/api/integrations_api.py`)

- `notification_channels`(Slack 수신 웹훅·일반 웹훅, 주소 암호화, 이벤트: run_done·run_failed·run_regressed·generation_done, 마지막 전송 결과), `api_tokens`(sha256 해시만 저장, 원문은 만들 때 한 번, 역할 editor/viewer). 마이그레이션 0009.
- 평가가 끝나면 `runs` 가 `notify.dispatch` 를 부릅니다(실패해도 평가에 영향 없음). 링크는 `PUBLIC_URL` 이 있을 때만.
- 미들웨어: `Authorization: Bearer sbk_…` 면 토큰의 역할로 인증(계정 로그인과 별개). 감사 기록에는 `token:이름` 으로 남음.
- `POST /api/ci/runs`: 비교 세트·테스트 데이터를 id 또는 이름으로, 저장된 열 연결로 평가 시작 → `wait` 면 끝날 때까지 기다려 `{passed, reason, verdict, ndcg_diff, ndcg_ci, url}`. 게이트: `regressed`(저하면 실패, 기본) · `not_improved`(개선이어야 통과) · `none`. `target_overrides: {"TOBE": {"base_url": "…"}}` 로 이번 실행만 API 주소를 바꿈(실행 사본 `target_overrides` 에 기록). `max_cost` 로 비용 상한(상한에 닿아 멈추면 `cancelled` 라 게이트는 실패). `GET /api/ci/runs/{id}?gate=` 로 나중에 다시 확인.

## 마이그레이션과 외래 키

SQLite 는 제약을 바꿀 때 테이블을 새로 만들어 옮기고 옛 테이블을 지웁니다(batch). 연결마다 `PRAGMA foreign_keys=ON` 이라 그대로 두면 옛 부모 테이블을 지울 때 `ON DELETE CASCADE` 로 자식 행이 지워집니다. 그래서 `app.main.migrate` 와 `migrations/env.py` 는 마이그레이션 연결에서만 외래 키를 끄고, 끝난 뒤 `PRAGMA foreign_key_check` 로 검사하고 다시 켭니다(회귀 테스트 `test_migrations_keep_child_rows`). 새 마이그레이션도 이 경로로만 실행하세요.

## 사람 판정 (`app/evaluation/human.py`)

- `run_cases.human_judgments`(항목 key → 등급·메모, key 규칙은 `item_judgments` 와 같음), `run_cases.human_pairwise`(후보 → candidate|baseline|tie). 마이그레이션 0004.
- 검수자별 원본은 `run_cases.human_by`(마이그레이션 0007, 이전 검수는 ‘기존 검수’로 옮김). `human_judgments/human_pairwise` 는 그 합의(`human.consensus`)입니다. 요약에 `inter_rater`(검수자 간 일치도)·`reviewers`(검수자별 통계)가 더해집니다. 큐는 `GET /api/runs/{id}/review?mode=mine|overlap|fresh&reviewer=`.
- `PUT /api/runs/{id}/cases/{case_id}/human` 으로 저장하면 `compute_summary` 가 요약을 다시 계산합니다: `summary.review`(검수 현황), `summary.agreement`(일치도), `summary.combined`(사람 우선 결합), `summary.human`(풀 전체를 사람이 채점한 케이스).
- `GET /api/runs/{id}/review`: 판정이 끝난 케이스를 시드 고정 무작위 순서로(검수 현황 포함).

## 판정 프롬프트·묶음 크기

- `criteria.system_prompt / item_template / pairwise_template`(비면 `prompts.DEFAULTS`). `prompts.validate_template` 이 자리 표시자 오타·누락·중괄호 오류를 검사합니다. 실행 스냅샷의 `criteria` 에 함께 복사됩니다.
- `runs.options.judge_batch_size`(기본 12) → `engine.judge_items(batch_size)`. 묶기 전에 항목 key 해시를 시드로 순서를 섞습니다.

## 비용 (`app/api/costs_api.py`)

- `GET /api/costs?period=7d|30d|90d|month|all`: 실행에 저장한 토큰·추정 비용(`runs.cost_estimate`, 실행 당시 단가)을 판정 모델별로 모읍니다. 삭제된 모델은 실행 스냅샷의 이름으로 묶습니다.
- 돌려주는 값: 총계(비용·실행·케이스·호출·토큰·평균, 이전 같은 길이 기간 대비 증감), 누적 비용, 모델별 행(단가·사용량·비용·비율·입력/출력 비용 분할), 날짜별 모델별 비용, 비용이 큰 실행 8개, 단가가 비어 있는 모델.

## 배치 실행

```
POST /api/runs ─▶ run + run_cases 생성(status=queued) ─▶ RunManager.start(run_id) ─▶ 즉시 응답
                                                        │
                      asyncio 작업: 세마포어(동시 실행 수)로 케이스 병렬 처리
                      케이스마다: 대상 호출(성공 응답 재사용) → 판정(기존 판정 재사용) → DB 기록 → SSE 이벤트
                      끝: 요약 집계 → status=done/cancelled/failed
```

- **브라우저와 무관**하게 서버에서 진행되고, 진행은 케이스마다 DB 에 기록됩니다.
- 화면은 `GET /api/runs/{id}/events`(SSE)로 실시간 갱신하고, 끊기면 주기 조회로 대체합니다. 사이드바는 `/api/runs/active` 를 주기적으로 조회해 어디서든 진행 상황과 완료 알림을 보여 줍니다.
- **서버 재시작**: 시작 시 `queued/running` 실행을 `interrupted` 로 바꿉니다. **이어서 실행**은 `done` 이 아닌 케이스만 다시 처리하며, 성공한 대상 응답·항목 판정·목록 비교는 다시 묻지 않습니다.
- **실행끼리 비교**: `GET /api/runs/compare?ids=1,2[,…]&candidate=` 는 실행 2~6개를 같은 후보 라벨 기준으로 나란히(nDCG·Hit@1·1위 평균 등급·신뢰구간) 돌려주고, 같은 테스트 데이터로 2개를 비교하면 케이스별 변화도 줍니다. 비교 세트·데이터(버전)·판정 모델·묶음 크기·평가 기준 등 조건이 다른 항목은 따로 알려 줍니다. 저장된 요약만 읽으므로 판정 모델을 다시 부르지 않습니다.
- **비용 상한**: `options.max_cost`(USD)가 있으면 케이스를 끝낼 때마다 `runs.cost_estimate` 를 확인하고, 닿으면 남은 케이스를 시작하지 않습니다. 이미 처리 중인 케이스(최대 동시 처리 수만큼)는 끝까지 가므로 상한을 조금 넘을 수 있습니다. 끝나면 `status=cancelled`, `error` 가 "비용 상한…"으로 시작합니다. 이 상태에서 이어서 실행하면 `max_cost` 를 비우고 남은 케이스를 처리합니다.
- 판정 호출 실패는 공급자별 일시 오류(429·5xx·타임아웃)를 지수 백오프로 재시도하고(`JUDGE_MAX_RETRIES`), 그래도 실패하면 케이스를 `error` 로 남깁니다(지표에서 제외, 이어서 실행으로 재처리).

## 판정 모델 어댑터

| 공급자 | SDK | 구조화 출력 |
|---|---|---|
| Vertex AI / Gemini API | `google-genai` | `response_json_schema` |
| Anthropic | `anthropic` | `output_config.format`(JSON 스키마), 미지원 모델은 도구 강제 호출로 전환 |
| OpenAI / OpenAI 호환 | `openai` | `response_format: json_schema(strict)` → 미지원 시 `json_object` → 지시문 |

모든 응답은 JSON 추출·필수 필드 검증을 거치며, 형식 오류는 재시도합니다. `temperature` 를 거부하는 모델은 자동으로 빼고 다시 호출합니다.

## 계정·권한·공유·감사 (`app/auth.py`, `app/api/users_api.py`)

| 방식 | 조건 | 로그인 |
|---|---|---|
| open | 계정·APP_PASSWORD 없음 | 없음(모두 관리자) — 처음 설치 상태 |
| password | APP_PASSWORD 만 있음 | 공용 비밀번호(관리자) — 이전 방식 |
| users | 사용 중인 계정이 1개 이상 | 아이디·비밀번호, 역할별 권한 |

- 역할: 관리자(계정·판정 모델·설정 가져오기·감사 기록) ⊃ 편집자(설정·평가 실행·데이터 생성) ⊃ 검수자(사람 검수) ⊃ 보기 전용(조회·단건 검색 비교). 미들웨어가 요청마다 `required_role(method, path)` 로 검사하고 403 에 지금 역할·필요 역할을 알려 줍니다.
- 비밀번호: scrypt(n=2^14) 해시, 영문·숫자 8자 이상. 세션: HMAC 서명 쿠키(`만료.계정id.난수.서명`), 계정을 끄면 바로 막힘. 마지막 관리자는 끄거나 강등할 수 없음. 열린 상태에서 첫 관리자를 만들면 그 브라우저는 바로 로그인 상태가 됨.
- 공유 링크(`share_links`): 실행 하나를 로그인 없이 보기 전용으로(`/share/{token}`, `GET /api/share/{token}`). 7·30·90일 또는 기한 없음, 조회 수, 끄기. 응답에서 컬럼 연결·옵션 등 설정 세부는 뺍니다.
- 감사 기록(`audit_logs`): 바꾸는 요청과 로그인(시각·누가·무엇을·결과). 요청 본문은 남기지 않음. 기록은 요청 트랜잭션과 겹쳐 SQLite 잠금을 기다리지 않도록 별도 스레드에서 씁니다.

## 보안
- **키 저장**: Fernet(AES-128-CBC + HMAC) 암호화. 암호화 키는 `APP_SECRET_KEY` 또는 `data/secret.key`(최초 실행 시 0600 권한으로 생성).
- **키 노출 방지**: API 응답·설정 내보내기·실행 스냅샷·결과 내보내기에 키를 넣지 않습니다(끝 4자리 힌트만). 테스트 호출의 요청 표시는 키를 가립니다.
- **로그인**: `APP_PASSWORD` 가 있으면 HMAC 서명 세션 쿠키(HttpOnly, SameSite=Lax, HTTPS 면 Secure)로 `/api` 전체를 보호합니다.
- **판정 모델로 가는 데이터**: 입력값과 응답 매핑에서 고른 필드만. 개인정보 필드는 매핑하지 않도록 안내합니다.
- **git·이미지 제외**: `data/`, `*.db`, `secret.key`, `.env` 는 `.gitignore`·`.dockerignore` 로 막습니다.
