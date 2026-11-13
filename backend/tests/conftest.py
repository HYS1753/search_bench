"""테스트 공통 — 임시 DATA_DIR, 가짜 판정 모델, 가짜 대상 서버(httpx MockTransport)."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config, db, security
from app.judges.base import JudgeClient, JudgeConfig, JudgeResult, Usage

# 대상 서버 응답: ASIS 는 정답을 2위에, TOBE 는 1위에 둔다.
PEOPLE = [
    {"employee_id": "E1", "member_name": "정답자", "duty": "자녀 학자금 지급 정답"},
    {"employee_id": "E2", "member_name": "다른사람", "duty": "급여 지급"},
    {"employee_id": "E3", "member_name": "무관자", "duty": "법인카드 관리"},
]


V2_REQUESTS: list[dict[str, Any]] = []


def fake_server(request: httpx.Request) -> httpx.Response:
    host = request.url.host
    if "fail" in host:
        return httpx.Response(500, json={"detail": "boom"})
    if host.startswith("v2"):
        # 요청·응답 형태가 다른 '새 검색엔진': POST 중첩 본문, data.hits[]._source, ID 는 'EMP-E1'
        body = json.loads(request.content or b"{}")
        V2_REQUESTS.append(body)
        size = body.get("query", {}).get("size", 3)
        return httpx.Response(200, json={"data": {"hits": [
            {"_source": {"emp": f"EMP-{p['employee_id']}", "name": p["member_name"], "work": p["duty"]}}
            for p in PEOPLE[:size]
        ]}})
    order = PEOPLE if host.startswith("tobe") else [PEOPLE[1], PEOPLE[0], PEOPLE[2]]
    top_k = int(request.url.params.get("top_k", 3))
    return httpx.Response(200, json={"results": [
        {"employee_id": p["employee_id"], "member_name": p["member_name"], "score": 1 / (i + 1),
         "assignments": [{"org_nm": "인사팀", "primary_responsibilities": p["duty"], "role_keywords": ["k"]}]}
        for i, p in enumerate(order[:top_k])
    ]})


class FakeJudge(JudgeClient):
    """'정답' 이 들어간 항목은 3, '급여' 는 1, 나머지 0. 목록 비교는 1위 등급이 높은 쪽 승."""

    calls: list[str] = []
    systems: list[str] = []

    def __init__(self) -> None:
        super().__init__(JudgeConfig(provider="fake", model="fake"))

    async def _call(self, system: str, prompt: str, schema: dict[str, Any], name: str) -> JudgeResult:
        FakeJudge.calls.append(name)
        FakeJudge.systems.append(system)
        if name == "item_relevance":
            out = []
            for key, body in re.findall(r"^\[(.+?)\] (.*?)(?=^\[|\Z)", prompt.split("# 판정할 항목")[1], re.M | re.S):
                grade = 3 if "정답" in body else 1 if "급여" in body else 0
                out.append({"key": key, "reason": "테스트", "grade": grade})
            return JudgeResult({"judgments": out}, Usage(100, 20))
        if name == "pairwise":
            a = prompt.split("# 결과 A")[1].split("# 결과 B")[0]
            b = prompt.split("# 결과 B")[1]
            a1 = "정답" in a.split("2위.")[0]
            b1 = "정답" in b.split("2위.")[0]
            winner = "A" if a1 and not b1 else "B" if b1 and not a1 else "TIE"
            return JudgeResult({"reason": f"{winner} 의 1위가 정답", "winner": winner, "confidence": "high"}, Usage(200, 30))
        return JudgeResult({"answer": "연결 성공", "ok": True}, Usage(5, 5))


class FakeGen(JudgeClient):
    """테스트 질의 생성기: '# 만들 칸' 의 칸마다 케이스를 만든다. 첫 묶음엔 중복 1개·개인정보 1개를 섞는다."""

    n = 0

    def __init__(self) -> None:
        super().__init__(JudgeConfig(provider="fake", model="fake-gen"))

    async def _call(self, system: str, prompt: str, schema: dict[str, Any], name: str) -> JudgeResult:
        props = schema["properties"]["cases"]["items"]["properties"]["inputs"]["properties"]
        slots = re.findall(r"^(\d+)\. 분류: (.*?) · 표현: (\S+)", prompt.split("# 만들 칸")[1], re.M)
        style_key = {"키워드형": "keyword", "자연어": "natural", "조건": "multi", "오타·줄임말·구어체": "typo", "모호한": "ambiguous"}
        cases = []
        for slot, cat, style in slots:
            FakeGen.n += 1
            inputs = {}
            for k, spec in props.items():
                if spec["type"] == "array":
                    inputs[k] = ["학자금", f"키워드{FakeGen.n}"]
                elif spec["type"] == "integer":
                    inputs[k] = 3
                else:
                    inputs[k] = f"{cat or '일반'} 담당자 찾기 질의 번호 {FakeGen.n} {'가나다라마바사'[FakeGen.n % 7]}"
            cases.append({"slot": int(slot), "category": cat if cat != "(자유)" else "", "style": style_key.get(style, "natural"),
                          "inputs": inputs, "expected": "학자금 담당자", "source": f"S{slot}"})
        if FakeGen.n <= 12 and cases:
            cases.append({**cases[0], "slot": 99})  # 중복
            cases.append({**cases[0], "slot": 98, "inputs": {**cases[0]["inputs"], **{k: "연락 010-1234-5678" for k, v in props.items() if v["type"] == "string"}}})
        return JudgeResult({"cases": cases}, Usage(300, 120))


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("STATIC_DIR", str(tmp_path / "nostatic"))
    for key in ("APP_PASSWORD", "APP_SECRET_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
                "GOOGLE_APPLICATION_CREDENTIALS"):
        monkeypatch.setenv(key, "")
    config.get_settings.cache_clear()
    db.reset_engine()
    security.reset_crypto()
    FakeJudge.calls = []
    FakeJudge.systems = []

    transport = httpx.MockTransport(fake_server)
    mock_client = lambda verify=None: httpx.AsyncClient(transport=transport)  # noqa: E731
    import app.api.data_api as data_api
    import app.api.settings_api as settings_api
    import app.runs as runs

    monkeypatch.setattr(runs, "http_client", mock_client)
    monkeypatch.setattr(data_api, "http_client", mock_client)
    monkeypatch.setattr(settings_api, "http_client", mock_client)
    monkeypatch.setattr(runs, "client_for", lambda m: FakeJudge())
    monkeypatch.setattr(data_api, "client_for", lambda m: FakeJudge())
    monkeypatch.setattr(settings_api, "client_for", lambda m: FakeJudge())
    import app.generation as generation

    FakeGen.n = 0
    monkeypatch.setattr(generation, "make_client", lambda m: FakeGen())

    from app.main import create_app

    with TestClient(create_app()) as client:
        yield client
    db.reset_engine()
    config.get_settings.cache_clear()
    security.reset_crypto()


def target_body(name: str, host: str) -> dict[str, Any]:
    return {
        "name": name, "method": "GET", "base_url": f"http://{host}", "path": "/search",
        "auth": {"type": "bearer", "env": ""}, "secret": "sk-test-1234567890",
        "params": [
            {"name": "q", "field": "q"},
            {"name": "keywords", "field": "keywords", "array_style": "repeat"},
            {"name": "top_k", "field": "top_k"},
        ],
        "response_mapping": {
            "results_path": "results", "id_path": "employee_id", "title_path": "member_name",
            "text_fields": [{"label": "담당업무", "path": "assignments[].primary_responsibilities"}],
        },
    }


@pytest.fixture
def setup_suite(app_client):
    c = app_client
    model = c.post("/api/judge-models", json={"name": "fake", "provider": "openai", "model": "x", "secret": "sk-abc",
                                              "price_input_per_mtok": 1.0, "price_output_per_mtok": 2.0}).json()
    asis = c.post("/api/targets", json=target_body("ASIS", "asis.test")).json()
    tobe = c.post("/api/targets", json=target_body("TOBE", "tobe.test")).json()
    crit = c.post("/api/criteria", json={"name": "기준", "k": 3}).json()
    suite = c.post("/api/suites", json={
        "name": "세트", "default_criteria_id": crit["id"],
        "input_fields": [{"key": "q", "label": "질문", "type": "text", "required": True},
                         {"key": "keywords", "label": "키워드", "type": "list"},
                         {"key": "top_k", "label": "결과 수", "type": "int", "default": 3}],
        "members": [{"target_id": asis["id"], "label": "ASIS", "is_baseline": True},
                    {"target_id": tobe["id"], "label": "TOBE"}],
    }).json()
    rows = "case_id,category,expected,q,keywords\n" + "\n".join(
        f"C{i:02d},{'인사' if i % 2 else '재무'},학자금 담당,학자금 담당자 {i},학자금 교육비" for i in range(1, 13)
    )
    ds = c.post("/api/datasets/upload", files={"file": ("cases.csv", rows.encode("utf-8"), "text/csv")},
                data={"name": "케이스"}).json()
    return {"model": model, "asis": asis, "tobe": tobe, "criteria": crit, "suite": suite, "dataset": ds}


def wait_done(client: TestClient, run_id: int, timeout: float = 20.0) -> dict[str, Any]:
    import time

    end = time.time() + timeout
    while time.time() < end:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] not in ("queued", "running"):
            return run
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not finish: {json.dumps(run)[:300]}")
