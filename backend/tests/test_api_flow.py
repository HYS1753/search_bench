"""API 흐름 — 설정 → 단건 비교 → 배치 실행·이어서 실행 → 내보내기 → 인증."""

from __future__ import annotations

import io
import json

from openpyxl import load_workbook

from app import config
from app.db import session_scope
from app.models import Run, RunCase
from tests.conftest import FakeJudge, target_body, wait_done


def test_secrets_are_never_returned(app_client, setup_suite):
    models = app_client.get("/api/judge-models").json()
    assert models[0]["has_secret"] and "sk-abc" not in json.dumps(models)
    targets = app_client.get("/api/targets").json()
    assert all(t["secret_hint"] == "••••7890" for t in targets)
    assert "sk-test" not in json.dumps(targets)


def test_model_connection_test(app_client, setup_suite):
    out = app_client.post(f"/api/judge-models/{setup_suite['model']['id']}/test").json()
    assert out["ok"] and out["model"]["last_test_ok"] is True


def test_target_test_redacts_secret(app_client, setup_suite):
    body = {"target": {**target_body("x", "tobe.test"), "secret": None}, "target_id": setup_suite["tobe"]["id"],
            "inputs": {"q": "학자금", "top_k": 2}}
    out = app_client.post("/api/targets/test", json=body).json()
    assert out["ok"] and [i["key"] for i in out["items"]] == ["E1", "E2"]
    assert out["request"]["headers"]["Authorization"] == "••••"


def test_single_compare_with_judge(app_client, setup_suite):
    out = app_client.post("/api/compare", json={
        "suite_id": setup_suite["suite"]["id"], "inputs": {"q": "학자금 담당", "keywords": "학자금 교육비"}, "judge": True,
    }).json()
    assert [s["label"] for s in out["sides"]] == ["ASIS", "TOBE"]
    ev = out["evaluation"]
    assert ev["ok"], ev
    assert ev["item_judgments"]["E1"]["grade"] == 3
    assert ev["metrics"]["TOBE"]["hit1"] == 1.0 and ev["metrics"]["ASIS"]["hit1"] == 0.0
    assert ev["pairwise"]["TOBE"]["winner"] == "candidate" and ev["pairwise"]["TOBE"]["consistent"]
    assert ev["tokens_input"] > 0 and ev["cost_estimate"] > 0


def test_compare_requires_required_input(app_client, setup_suite):
    r = app_client.post("/api/compare", json={"suite_id": setup_suite["suite"]["id"], "inputs": {}})
    assert r.status_code == 400 and "질문" in r.json()["detail"]


def test_batch_run_end_to_end_and_exports(app_client, setup_suite):
    s = setup_suite
    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    assert mapping["fields"]["q"] == "q" and mapping["category"] == "category"
    run = app_client.post("/api/runs", json={
        "suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping, "concurrency": 3,
    }).json()
    run = wait_done(app_client, run["id"])
    assert run["status"] == "done" and run["completed"] == 12 and run["failed"] == 0
    cmp = run["summary"]["comparisons"][0]
    assert cmp["wins"] == 12 and cmp["losses"] == 0
    assert cmp["verdict"]["code"] == "improved"
    assert run["summary"]["targets"][1]["hit1"] == 1.0
    dist = run["summary"]["grade_distribution"]
    assert dist["TOBE"]["top1"]["3"] == 12 and dist["ASIS"]["top1"]["1"] == 12
    assert run["cost_estimate"] > 0 and run["judge_calls"] == 12 * 3

    cases = app_client.get(f"/api/runs/{run['id']}/cases", params={"outcome": "win"}).json()
    assert cases["total"] == 12 and cases["items"][0]["tops"]["TOBE"]["grade"] == 3
    assert set(cases["categories"]) == {"인사", "재무"}
    detail = app_client.get(f"/api/runs/{run['id']}/cases/{cases['items'][0]['id']}").json()
    assert len(detail["responses"]) == 2 and detail["item_judgments"]

    html = app_client.get(f"/api/runs/{run['id']}/export", params={"format": "html"})
    assert html.status_code == 200 and html.headers["content-type"].startswith("text/html")
    assert 'filename="run-' in html.headers["content-disposition"]
    page = html.text
    assert page.startswith("<!doctype html>") and "<script" not in page and "http://" not in page.split("<main")[0]
    assert cmp["verdict"]["title"] in page and "C01" in page and "TOBE vs ASIS" in page

    xlsx = app_client.get(f"/api/runs/{run['id']}/export", params={"format": "xlsx"})
    wb = load_workbook(io.BytesIO(xlsx.content))
    assert wb.sheetnames == ["요약", "케이스", "항목 판정", "목록 비교", "설정"]
    csv_text = app_client.get(f"/api/runs/{run['id']}/export", params={"format": "csv"}).text
    assert csv_text.startswith("﻿케이스") and csv_text.count("\n") == 13
    js = app_client.get(f"/api/runs/{run['id']}/export", params={"format": "json"}).json()
    assert len(js["cases"]) == 12 and "secret_enc" not in json.dumps(js)


def test_resume_reuses_finished_work(app_client, setup_suite):
    s = setup_suite
    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = wait_done(app_client, app_client.post("/api/runs", json={
        "suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping}).json()["id"])
    # 서버 중단을 흉내: 4건을 미완료로 되돌린다(판정 결과는 일부 남겨 재사용 여부 확인)
    with session_scope() as db:
        r = db.get(Run, run["id"])
        r.status = "interrupted"
        for c in db.query(RunCase).filter(RunCase.run_id == r.id).limit(4):
            c.status = "pending"
            c.pairwise = {}
    calls_before = len(FakeJudge.calls)
    out = app_client.post(f"/api/runs/{run['id']}/resume")
    assert out.status_code == 200
    run2 = wait_done(app_client, run["id"])
    assert run2["status"] == "done" and run2["completed"] == 12
    # 항목 판정은 재사용, 목록 비교만 4건 × 2회 다시 물었다
    assert FakeJudge.calls[calls_before:].count("item_relevance") == 0
    assert FakeJudge.calls[calls_before:].count("pairwise") == 8
    assert app_client.post(f"/api/runs/{run['id']}/resume").status_code == 400


def test_failed_target_counts_as_zero_and_auto_loss(app_client, setup_suite):
    s = setup_suite
    bad = app_client.post("/api/targets", json=target_body("FAIL", "fail.test")).json()
    suite = app_client.post("/api/suites", json={
        "name": "실패 세트", "default_criteria_id": s["criteria"]["id"],
        "input_fields": [{"key": "q", "label": "질문", "type": "text", "required": True}],
        "members": [{"target_id": s["asis"]["id"], "label": "ASIS", "is_baseline": True},
                    {"target_id": bad["id"], "label": "FAIL"}],
    }).json()
    out = app_client.post("/api/compare", json={"suite_id": suite["id"], "inputs": {"q": "학자금"}, "judge": True}).json()
    fail = next(x for x in out["sides"] if x["label"] == "FAIL")
    assert not fail["ok"] and "HTTP 500" in fail["error"]
    ev = out["evaluation"]
    assert ev["metrics"]["FAIL"]["ndcg"] == 0.0
    assert ev["pairwise"]["FAIL"]["winner"] == "baseline" and ev["pairwise"]["FAIL"]["auto"]


def test_three_targets_compare_each_against_baseline(app_client, setup_suite):
    s = setup_suite
    third = app_client.post("/api/targets", json=target_body("TOBE2", "tobe2.test")).json()
    suite = app_client.post("/api/suites", json={
        "name": "3개", "default_criteria_id": s["criteria"]["id"],
        "input_fields": [{"key": "q", "label": "질문", "type": "text", "required": True}],
        "members": [{"target_id": s["asis"]["id"], "label": "ASIS", "is_baseline": True},
                    {"target_id": s["tobe"]["id"], "label": "TOBE"}, {"target_id": third["id"], "label": "TOBE2"}],
    }).json()
    out = app_client.post("/api/compare", json={"suite_id": suite["id"], "inputs": {"q": "학자금"}, "judge": True}).json()
    assert set(out["evaluation"]["pairwise"]) == {"TOBE", "TOBE2"}


def test_suite_validation(app_client, setup_suite):
    s = setup_suite
    r = app_client.post("/api/suites", json={
        "name": "중복", "input_fields": [{"key": "q"}],
        "members": [{"target_id": s["asis"]["id"], "label": "X"}, {"target_id": s["tobe"]["id"], "label": "X"}],
    })
    assert r.status_code == 400
    assert app_client.delete(f"/api/targets/{s['asis']['id']}").status_code == 400


def test_run_rejects_bad_mapping(app_client, setup_suite):
    s = setup_suite
    r = app_client.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"],
                                           "mapping": {"fields": {"q": ""}}})
    assert r.status_code == 400 and "필수" in r.json()["detail"]


def test_criteria_preview_includes_user_requirements(app_client):
    out = app_client.post("/api/criteria/preview", json={"task_context": "", "user_requirements": "퇴직자는 0점", "k": 3}).json()
    assert "퇴직자는 0점" in out["item"] and "사용자 요구사항" in out["pairwise"]
    assert out["default_task_context"] in out["item"]


def test_config_export_import_roundtrip(app_client, setup_suite):
    exported = app_client.get("/api/system/export-config").json()
    assert "sk-" not in json.dumps(exported)
    out = app_client.post("/api/system/import-config", json=exported).json()
    assert out["created"]["suites"] == 1 and out["created"]["targets"] == 2


def test_password_login(app_client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "pw-123")
    config.get_settings.cache_clear()
    assert app_client.get("/api/suites").status_code == 401
    st = app_client.get("/api/auth/status").json()
    assert st["required"] is True and st["authenticated"] is False and st["mode"] == "password"
    assert app_client.post("/api/auth/login", json={"password": "wrong"}).status_code == 400
    assert app_client.post("/api/auth/login", json={"password": "pw-123"}).status_code == 200
    assert app_client.get("/api/suites").status_code == 200


def test_heterogeneous_apis_with_bindings_and_id_rules(app_client, setup_suite):
    """요청(GET 쿼리 vs POST 중첩 본문)·응답(results vs data.hits)·ID 형식(E1 vs EMP-E1)이 다른 두 API."""
    from tests.conftest import V2_REQUESTS

    s = setup_suite
    v2 = app_client.post("/api/targets", json={
        "name": "V2", "method": "POST", "base_url": "http://v2.test", "path": "/search",
        "params": [
            {"name": "query.text", "field": "text", "location": "body", "example": "학자금"},
            {"name": "query.size", "field": "size", "location": "body", "json_type": "number"},
            {"name": "keyword", "field": "keyword", "location": "body"},
        ],
        "response_mapping": {"results_path": "data.hits", "id_path": "_source.emp", "title_path": "_source.name",
                             "text_fields": [{"label": "업무", "path": "_source.work"}]},
    }).json()
    suite_body = {
        "name": "이기종", "default_criteria_id": s["criteria"]["id"], "match_mode": "id",
        "input_fields": [{"key": "q", "label": "질문", "type": "text", "required": True},
                         {"key": "keywords", "label": "키워드", "type": "list"},
                         {"key": "top_k", "label": "결과 수", "type": "int", "default": 3}],
        "members": [
            {"target_id": s["asis"]["id"], "label": "ASIS", "is_baseline": True, "match": {"lower": True}},
            {"target_id": v2["id"], "label": "V2", "match": {"lower": True, "strip_prefix": "EMP-"},
             "input_bindings": {"text": {"from": "q"}, "size": {"from": "top_k", "transform": "number"},
                                "keyword": {"from": "keywords", "transform": "join_space"}}},
        ],
    }
    # 저장 전 미리 호출: 보낸 요청과 겹침 확인
    preview = app_client.post("/api/suites/preview", json={**{k: suite_body[k] for k in ("input_fields", "members", "match_mode")},
                                                           "inputs": {"q": "학자금 담당", "keywords": "학자금 교육비"}}).json()
    v2_side = next(x for x in preview["sides"] if x["label"] == "V2")
    assert v2_side["inputs"] == {"text": "학자금 담당", "size": 3, "keyword": "학자금 교육비"}
    assert V2_REQUESTS[-1] == {"query": {"text": "학자금 담당", "size": 3}, "keyword": "학자금 교육비"}
    assert v2_side["overlap"]["common"] == 3 and [i["key"] for i in v2_side["items"]] == ["e1", "e2", "e3"]

    suite = app_client.post("/api/suites", json=suite_body).json()
    assert suite["match_mode"] == "id" and suite["members"][1]["input_bindings"]["size"]["transform"] == "number"
    FakeJudge.calls = []
    out = app_client.post("/api/compare", json={"suite_id": suite["id"], "inputs": {"q": "학자금 담당"}, "judge": True}).json()
    ev = out["evaluation"]
    assert ev["ok"], ev
    # 같은 결과로 알아봐서 항목 판정은 한 번(3개 항목)만, V2 가 정답을 1위로 올렸다
    assert FakeJudge.calls.count("item_relevance") == 1
    assert set(ev["item_judgments"]) == {"e1", "e2", "e3"}
    assert ev["metrics"]["V2"]["hit1"] == 1.0 and ev["pairwise"]["V2"]["winner"] == "candidate"

    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": suite["id"]}).json()
    run = wait_done(app_client, app_client.post("/api/runs", json={"suite_id": suite["id"], "dataset_id": s["dataset"]["id"],
                                                                   "mapping": mapping, "case_limit": 3}).json()["id"])
    assert run["status"] == "done" and run["summary"]["comparisons"][0]["wins"] == 3


def test_api_specific_inputs_and_validation(app_client, setup_suite):
    """A 는 q + keywords, B 는 q + cat(필수). 공통 q, A 전용 keywords, B 전용 cat 으로 나눠 넣고 실행 전에 검증한다."""
    from tests.conftest import V2_REQUESTS

    s = setup_suite
    b = app_client.post("/api/targets", json={
        "name": "B", "method": "POST", "base_url": "http://v2.test", "path": "/search",
        "params": [
            {"name": "query.text", "field": "q", "location": "body", "label": "질문", "required": True},
            {"name": "cat", "field": "cat", "location": "body", "label": "분류", "required": True},
        ],
        "response_mapping": {"results_path": "data.hits", "id_path": "_source.emp", "title_path": "_source.name",
                             "text_fields": [{"label": "업무", "path": "_source.work"}]},
    }).json()
    suite = app_client.post("/api/suites", json={
        "name": "입력이 다른 API", "default_criteria_id": s["criteria"]["id"],
        "input_fields": [
            {"key": "q", "label": "질문", "type": "text", "required": True},
            {"key": "ASIS__keywords", "label": "키워드", "type": "list", "scope": "ASIS"},
            {"key": "B__cat", "label": "분류", "type": "text", "scope": "B"},
        ],
        "members": [
            {"target_id": s["asis"]["id"], "label": "ASIS", "is_baseline": True,
             "input_bindings": {"q": {"from": "q"}, "keywords": {"from": "ASIS__keywords"}, "top_k": {"from": ""}}},
            {"target_id": b["id"], "label": "B", "match": {"strip_prefix": "EMP-"},
             "input_bindings": {"q": {"from": "q"}, "cat": {"from": "B__cat"}}},
        ],
    }).json()
    assert [f["scope"] for f in suite["input_fields"]] == ["", "ASIS", "B"]

    # 단건 비교: B 가 꼭 받아야 하는 cat 이 없으면 호출 전에 막는다
    r = app_client.post("/api/compare", json={"suite_id": suite["id"], "inputs": {"q": "학자금"}})
    assert r.status_code == 400 and "B" in r.json()["detail"] and "분류" in r.json()["detail"]
    out = app_client.post("/api/compare", json={"suite_id": suite["id"], "inputs": {"q": "학자금", "ASIS__keywords": "학자금 교육비", "B__cat": "인사"}}).json()
    assert V2_REQUESTS[-1] == {"query": {"text": "학자금"}, "cat": "인사"}
    assert all(sd["ok"] for sd in out["sides"])

    # 배치: 일부 행만 B 전용 입력이 채워진 테스트 데이터 → 검증 리포트, 실패 행 빼고 실행
    rows = "case_id,q,ASIS__keywords,B__cat\n" + "\n".join(
        f"C{i},학자금 {i},학자금,{'인사' if i % 3 else ''}" for i in range(1, 13)
    )
    ds = app_client.post("/api/datasets/upload", files={"file": ("x.csv", rows.encode(), "text/csv")}, data={"name": "다른입력"}).json()
    mapping = app_client.get(f"/api/datasets/{ds['id']}/mapping", params={"suite_id": suite["id"]}).json()
    assert mapping["fields"] == {"q": "q", "ASIS__keywords": "ASIS__keywords", "B__cat": "B__cat"}
    report = app_client.post("/api/runs/validate", json={"suite_id": suite["id"], "dataset_id": ds["id"], "mapping": mapping}).json()
    assert (report["total"], report["valid"], report["invalid"]) == (12, 8, 4)
    assert report["errors"][0]["row"] == 3 and "B" in report["errors"][0]["messages"][0]
    cat = next(i for i in report["inputs"] if i["key"] == "B__cat")
    assert cat["label"] == "B 전용 · 분류" and cat["empty"] == 4
    blocked = app_client.post("/api/runs", json={"suite_id": suite["id"], "dataset_id": ds["id"], "mapping": mapping})
    assert blocked.status_code == 400 and "검증에 실패한 행이 4개" in blocked.json()["detail"]
    run = app_client.post("/api/runs", json={"suite_id": suite["id"], "dataset_id": ds["id"], "mapping": mapping, "skip_invalid": True}).json()
    run = wait_done(app_client, run["id"])
    assert run["status"] == "done" and run["total"] == 8


def test_per_candidate_criteria(app_client, setup_suite):
    """후보마다 다른 평가 기준: TOBE 는 기준1, TOBE2 는 기준2 로 각각 기준 API 와 비교한다."""
    s = setup_suite
    crit2 = app_client.post("/api/criteria", json={"name": "엄격한 기준", "k": 2, "relevant_threshold": 3}).json()
    tobe2 = app_client.post("/api/targets", json=target_body("TOBE2", "tobe.test")).json()
    suite = app_client.post("/api/suites", json={
        "name": "후보별 기준", "input_fields": s["suite"]["input_fields"],
        "members": [
            {"target_id": s["asis"]["id"], "label": "ASIS", "is_baseline": True},
            {"target_id": s["tobe"]["id"], "label": "TOBE", "criteria_id": s["criteria"]["id"]},
            {"target_id": tobe2["id"], "label": "TOBE2", "criteria_id": crit2["id"]},
        ],
    }).json()
    assert [m["criteria_id"] for m in suite["members"]] == [None, s["criteria"]["id"], crit2["id"]]
    assert suite["default_criteria_id"] == s["criteria"]["id"]

    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": suite["id"]}).json()
    run = app_client.post("/api/runs", json={"suite_id": suite["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping, "case_limit": 3}).json()
    assert run["criteria_by_member"]["TOBE2"]["name"] == "엄격한 기준"
    run = wait_done(app_client, run["id"])
    assert run["status"] == "done" and run["completed"] == 3
    cmps = {c["candidate"]: c for c in run["summary"]["comparisons"]}
    assert cmps["TOBE"]["criteria"]["name"] == "기준" and cmps["TOBE2"]["criteria"]["name"] == "엄격한 기준"
    assert cmps["TOBE2"]["wins"] == 3

    cases = app_client.get(f"/api/runs/{run['id']}/cases").json()
    detail = app_client.get(f"/api/runs/{run['id']}/cases/{cases['items'][0]['id']}").json()
    assert any(k.startswith(f"@{crit2['id']}:") for k in detail["item_judgments"])
    assert "ASIS@TOBE2" in detail["metrics"] and "ASIS" in detail["metrics"]

    # 요청에서 후보별 기준을 바꿀 수 있다
    run2 = app_client.post("/api/runs", json={"suite_id": suite["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping,
                                             "case_limit": 1, "criteria_by_member": {"TOBE2": s["criteria"]["id"]}}).json()
    assert run2["criteria_by_member"]["TOBE2"]["name"] == "기준"
    wait_done(app_client, run2["id"])
    xlsx = app_client.get(f"/api/runs/{run['id']}/export", params={"format": "xlsx"})
    assert xlsx.status_code == 200


def test_costs_by_model(app_client, setup_suite):
    s = setup_suite
    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = app_client.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping, "case_limit": 2}).json()
    run = wait_done(app_client, run["id"])
    out = app_client.get("/api/costs", params={"period": "30d"}).json()
    assert out["totals"]["runs"] >= 1 and abs(out["totals"]["cost"] - out["all_time_cost"]) < 1e-9
    m = next(x for x in out["models"] if x["id"] == s["model"]["id"])
    assert m["runs"] >= 1 and m["cost"] > 0 and abs(m["share"] - 1) < 1e-9 and m["priced"]
    assert abs(m["cost_input"] + m["cost_output"] - m["cost"]) < 1e-9
    assert len(out["daily"]) == 30 and abs(sum(d["total"] for d in out["daily"]) - out["totals"]["cost"]) < 1e-9
    assert out["top_runs"][0]["id"] == run["id"] and out["series"] == [m["name"]]
    for p in ("7d", "90d", "month", "all"):
        assert app_client.get("/api/costs", params={"period": p}).status_code == 200


def test_human_review_combined_and_agreement(app_client, setup_suite):
    """LLM 만으로 결과가 나오고, 사람이 등급·목록 선호를 더하면 사람·결합 점수와 일치도가 생긴다."""
    s = setup_suite
    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = app_client.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping,
                                            "case_limit": 4}).json()
    run = wait_done(app_client, run["id"])
    assert "human" not in run["summary"] and run["summary"]["review"]["reviewed_cases"] == 0

    queue = app_client.get(f"/api/runs/{run['id']}/review").json()
    assert len(queue["items"]) == 4 and queue["candidates"] == ["TOBE"]
    cid = queue["items"][0]["id"]
    detail = app_client.get(f"/api/runs/{run['id']}/cases/{cid}").json()
    llm = detail["item_judgments"]
    # 사람은 LLM 과 반대로: 모든 항목을 0 으로, 기준이 더 낫다고 고른다
    out = app_client.put(f"/api/runs/{run['id']}/cases/{cid}/human",
                         json={"grades": {k: 0 for k in llm}, "pairwise": {"TOBE": "baseline"}}).json()
    summ = out["summary"]
    assert summ["review"] == {**summ["review"], "reviewed_cases": 1, "complete_cases": 1, "pairwise_cases": 1}
    ag = summ["agreement"]
    assert ag["items"] == len(llm) and ag["bias"] > 0 and ag["pairwise_agree"] == 0.0
    assert summ["human"]["comparisons"][0]["losses"] == 1
    comb = summ["combined"]["comparisons"][0]
    assert comb["losses"] == 1 and comb["wins"] == 3  # 사람이 본 1건만 바뀌고 나머지는 LLM
    assert summ["comparisons"][0]["wins"] == 4  # LLM 결과는 그대로

    # 지우면 원래대로
    out = app_client.put(f"/api/runs/{run['id']}/cases/{cid}/human",
                         json={"grades": {k: None for k in llm}, "pairwise": {"TOBE": None}}).json()
    assert out["summary"]["review"]["reviewed_cases"] == 0
    bad = app_client.put(f"/api/runs/{run['id']}/cases/{cid}/human", json={"grades": {"x": 5}})
    assert bad.status_code == 400


def test_batch_size_and_custom_prompts(app_client, setup_suite):
    from tests.conftest import FakeJudge

    s = setup_suite
    # 잘못된 템플릿은 저장 전에 막는다
    bad = app_client.put(f"/api/criteria/{s['criteria']['id']}", json={**s["criteria"], "item_template": "질의 {query_block} {oops}"})
    assert bad.status_code == 400 and "oops" in bad.json()["detail"] and "items_block" in bad.json()["detail"]
    pv = app_client.post("/api/criteria/preview", json={"item_template": "{query_block}"}).json()
    assert pv["errors"]["item_template"]
    defaults = app_client.get("/api/criteria/prompt-defaults").json()
    assert "{items_block}" in defaults["defaults"]["item_template"] and "query_block" in defaults["placeholders"]["item_template"]["required"]

    custom = defaults["defaults"]["item_template"].replace("# 평가 과제", "# 평가 과제 (사내 규칙)")
    ok = app_client.put(f"/api/criteria/{s['criteria']['id']}", json={**s["criteria"], "system_prompt": "사내 판정자", "item_template": custom})
    assert ok.status_code == 200 and ok.json()["system_prompt"] == "사내 판정자"

    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = app_client.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping,
                                            "case_limit": 2, "judge_batch_size": 1}).json()
    assert run["options"]["judge_batch_size"] == 1
    run = wait_done(app_client, run["id"])
    assert run["status"] == "done"
    item_calls = FakeJudge.calls.count("item_relevance")
    assert item_calls > 2  # 항목마다 따로 물었다(묶음이면 케이스당 1회)
    assert "사내 판정자" in FakeJudge.systems


def test_richer_statistics(app_client, setup_suite):
    s = setup_suite
    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = wait_done(app_client, app_client.post("/api/runs", json={
        "suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping}).json()["id"])
    cmp = run["summary"]["comparisons"][0]
    assert cmp["permutation_p"] is not None and cmp["permutation_p"] < 0.01
    assert cmp["permutation_p_holm"] == cmp["permutation_p"] and cmp["multiple_comparisons"] == 1
    assert cmp["win_rate_ci"][0] > 0.7 and cmp["win_rate_with_ties"] == 1.0
    assert cmp["hit1_ci"] is not None


def _wait_job(client, jid, timeout=10.0):
    import time

    end = time.time() + timeout
    while time.time() < end:
        j = client.get(f"/api/generate/{jid}").json()
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.05)
    raise AssertionError("generation timeout")


def test_generate_dataset_by_description(app_client, setup_suite):
    s = setup_suite
    opts = app_client.get("/api/generate/options", params={"suite_id": s["suite"]["id"]}).json()
    assert "keyword" in opts["styles"] and opts["inputs"][0]["key"] == "q"
    job = app_client.post("/api/generate", json={"suite_id": s["suite"]["id"], "description": "사내 담당자 검색",
                                                 "categories": ["인사", "재무"], "count": 12,
                                                 "styles": {"keyword": 1, "natural": 1}}).json()
    job = _wait_job(app_client, job["id"])
    assert job["status"] == "done", job
    assert len(job["rows"]) == 12
    assert job["stats"]["dropped_duplicate"] >= 1 and job["stats"]["dropped_pii"] >= 1
    assert {r["category"] for r in job["rows"]} == {"인사", "재무"}
    assert job["cost_estimate"] > 0 and job["judge_calls"] >= 2

    ds = app_client.post(f"/api/generate/{job['id']}/save", json={"name": "생성 데이터"}).json()
    assert ds["suite_id"] == s["suite"]["id"] and ds["meta"]["source"] == "llm" and ds["row_count"] == 12
    assert "질문" in ds["columns"] and "분류" in ds["columns"]
    # 저장된 연결로 바로 평가 가능
    lst = app_client.get("/api/datasets", params={"suite_id": s["suite"]["id"]}).json()
    me = next(x for x in lst if x["id"] == ds["id"])
    assert me["compat"]["status"] == "ready" and me["compat"]["bound"]
    mapping = app_client.get(f"/api/datasets/{ds['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    assert mapping["fields"]["q"] == "질문" and mapping["saved"]
    run = wait_done(app_client, app_client.post("/api/runs", json={
        "suite_id": s["suite"]["id"], "dataset_id": ds["id"], "mapping": mapping, "case_limit": 3}).json()["id"])
    assert run["status"] == "done" and run["completed"] == 3
    costs = app_client.get("/api/costs").json()
    assert costs["totals"]["generations"] == 1 and costs["totals"]["by_purpose"]["generation"] > 0


def test_generate_grounded_checks_answers(app_client, setup_suite):
    s = setup_suite
    job = app_client.post("/api/generate", json={"suite_id": s["suite"]["id"], "description": "사내 담당자 검색",
                                                 "count": 6, "grounded": True}).json()
    job = _wait_job(app_client, job["id"])
    assert job["status"] == "done", job
    assert job["stats"]["source_items"] > 0 and set(job["stats"]["source_by_api"]) == {"ASIS", "TOBE"}
    assert all(r.get("source") for r in job["rows"])
    assert all("check" in r for r in job["rows"]) and job["stats"]["answer_found"] >= 1
    ds = app_client.post(f"/api/generate/{job['id']}/save", json={"name": "검색 기반"}).json()
    assert "원본 항목" in ds["columns"] and "답 확인" in ds["columns"]


def test_dataset_linkage_smart_mapping_and_compat(app_client, setup_suite):
    s = setup_suite
    # 열 이름이 달라도(검색어/키워드) 비슷한 이름으로 연결
    ds = app_client.post("/api/datasets", json={"name": "다른 이름", "columns": ["번호", "검색어", "키워드"],
                                                "rows": [{"번호": "1", "검색어": "학자금", "키워드": "교육비"}]}).json()
    lst = app_client.get("/api/datasets", params={"suite_id": s["suite"]["id"]}).json()
    me = next(x for x in lst if x["id"] == ds["id"])
    assert me["compat"]["mapping"]["fields"]["q"] == "검색어" and me["compat"]["mapping"]["fields"]["keywords"] == "키워드"
    assert me["compat"]["status"] == "check" and not me["compat"]["bound"]
    # 필수 열이 없으면 missing
    bad = app_client.post("/api/datasets", json={"name": "빈", "columns": ["메모"], "rows": [{"메모": "x"}]}).json()
    assert app_client.get(f"/api/datasets/{bad['id']}/compat", params={"suite_id": s["suite"]["id"]}).json()["status"] == "missing"
    # 평가에 쓰면 연결을 기억 → 다음부터 ready
    mapping = me["compat"]["mapping"]
    wait_done(app_client, app_client.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": ds["id"], "mapping": mapping}).json()["id"])
    again = app_client.get(f"/api/datasets/{ds['id']}/compat").json()
    assert again["bound"] and again["mapping"]["saved"] and again["status"] == "ready"
    # 템플릿은 사람이 읽는 열 이름
    tpl = app_client.get("/api/datasets/template", params={"suite_id": s["suite"]["id"]}).text
    assert "질문" in tpl.splitlines()[0] and "케이스" in tpl.splitlines()[0]
    blank = app_client.get("/api/datasets/blank-columns", params={"suite_id": s["suite"]["id"]}).json()
    assert blank["mapping"]["fields"]["q"] == "질문"
    suites = app_client.get("/api/suites").json()
    assert next(x for x in suites if x["id"] == s["suite"]["id"])["dataset_count"] >= 1


def test_add_row_from_compare(app_client, setup_suite):
    s = setup_suite
    sid = s["suite"]["id"]
    d = app_client.post("/api/datasets/add-row", json={"suite_id": sid, "inputs": {"q": "학자금", "keywords": ["교육비"]}, "expected": "학자금 담당"}).json()
    assert d["row_count"] == 1 and d["suite_id"] == sid and d["meta"]["source"] == "compare"
    d2 = app_client.post("/api/datasets/add-row", json={"suite_id": sid, "dataset_id": d["id"], "inputs": {"q": "법인카드"}, "category": "재무"}).json()
    assert d2["row_count"] == 2
    rows = app_client.get(f"/api/datasets/{d['id']}").json()["rows"]
    assert rows[1]["질문"] == "법인카드" and rows[1]["분류"] == "재무" and rows[0]["키워드"] == "교육비"
    # 기존 데이터(다른 열 이름)에 더해도 연결된 열로 들어간다
    r = app_client.post("/api/datasets/add-row", json={"suite_id": sid, "dataset_id": s["dataset"]["id"], "inputs": {"q": "새 질의"}}).json()
    assert r["row_count"] == 13
    last = app_client.get(f"/api/datasets/{s['dataset']['id']}?limit=50").json()["rows"][-1]
    assert last["q"] == "새 질의"


def test_compare_runs(app_client, setup_suite):
    s = setup_suite
    mapping = app_client.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    ids = []
    for limit in (4, 6):
        r = app_client.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping, "case_limit": limit}).json()
        ids.append(wait_done(app_client, r["id"])["id"])
    out = app_client.get("/api/runs/compare", params={"ids": ",".join(map(str, ids))}).json()
    assert out["candidate"] == "TOBE" and [x["id"] for x in out["runs"]] == ids
    assert out["runs"][0]["comparison"]["ndcg_diff"] is not None and out["runs"][1]["cand_top1"] is not None
    assert out["differs"] == []
    cd = out["case_diff"]
    assert cd["matched"] == 4 and cd["same"] == 4 and len(cd["rows"]) == 4
    assert app_client.get("/api/runs/compare", params={"ids": str(ids[0])}).status_code == 400



def test_accounts_roles_share_and_audit(app_client, setup_suite):
    """계정이 없으면 열린 상태 → 첫 관리자 만들기(바로 로그인) → 역할별 권한 → 공유 링크 → 감사 기록."""
    import time

    c = app_client
    assert c.get("/api/auth/status").json()["mode"] == "open"
    assert c.post("/api/users", json={"username": "kim", "role": "viewer", "password": "abcd1234"}).status_code == 400  # 첫 계정은 관리자
    assert c.post("/api/users", json={"username": "admin", "name": "관리자", "role": "admin", "password": "short"}).status_code == 400
    admin = c.post("/api/users", json={"username": "admin", "name": "관리자", "role": "admin", "password": "admin1234"}).json()
    st = c.get("/api/auth/status").json()
    assert st["mode"] == "users" and st["user"]["username"] == "admin"  # 쿠키로 바로 로그인됨
    viewer = c.post("/api/users", json={"username": "view", "role": "viewer", "password": "view1234"}).json()
    c.post("/api/users", json={"username": "rev", "role": "reviewer", "password": "rev12345"})
    # 마지막 관리자는 끌 수 없다
    assert c.put(f"/api/users/{admin['id']}", json={"active": False}).status_code == 400

    # 실행 하나
    s = setup_suite
    mapping = c.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = wait_done(c, c.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping, "case_limit": 2}).json()["id"])
    share = c.post(f"/api/runs/{run['id']}/share", json={"days": 7}).json()
    assert share["active"] and share["url"].startswith("/share/")

    # 보기 전용: 읽기 OK, 바꾸기 403, 단건 비교 OK
    c.post("/api/auth/logout")
    c.cookies.clear()
    assert c.get("/api/suites").status_code == 401
    assert c.post("/api/auth/login", json={"username": "view", "password": "wrong1234"}).status_code == 400
    assert c.post("/api/auth/login", json={"username": "VIEW", "password": "view1234"}).status_code == 200
    assert c.get("/api/suites").status_code == 200
    r = c.post("/api/criteria", json={"name": "x"})
    assert r.status_code == 403 and "보기 전용" in r.json()["detail"]
    assert c.post("/api/compare", json={"suite_id": s["suite"]["id"], "inputs": {"q": "학자금"}}).status_code == 200
    case_id = c.get(f"/api/runs/{run['id']}/cases").json()["items"][0]["id"]
    assert c.put(f"/api/runs/{run['id']}/cases/{case_id}/human", json={"grades": {}}).status_code == 403
    assert c.get("/api/users").status_code == 403

    # 검수자: 사람 검수 OK, 설정 바꾸기 403
    c.cookies.clear()
    c.post("/api/auth/login", json={"username": "rev", "password": "rev12345"})
    assert c.put(f"/api/runs/{run['id']}/cases/{case_id}/human", json={"pairwise": {"TOBE": "tie"}}).status_code == 200
    assert c.post("/api/criteria", json={"name": "x"}).status_code == 403
    assert c.post("/api/auth/password", json={"current": "rev12345", "new": "rev56789"}).status_code == 200

    # 공유 링크는 로그인 없이
    c.cookies.clear()
    pub = c.get(f"/api/share/{share['token']}").json()
    assert pub["run"]["id"] == run["id"] and len(pub["cases"]) == 2 and "mapping" not in pub["run"]

    # 관리자: 공유 끄기, 감사 기록
    c.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
    c.delete(f"/api/shares/{share['id']}")
    time.sleep(0.3)
    logs = c.get("/api/audit").json()
    actions = {x["action"] for x in logs}
    assert {"평가 시작", "사람 검수", "공유 링크 만들기", "로그인"} <= actions
    assert any(x["username"] == "rev" and x["action"] == "사람 검수" for x in logs)
    c.cookies.clear()
    assert c.get(f"/api/share/{share['token']}").status_code == 400
    # 계정을 끄면 그 세션도 막힌다
    c.post("/api/auth/login", json={"username": "admin", "password": "admin1234"})
    c.put(f"/api/users/{viewer['id']}", json={"active": False})
    c.cookies.clear()
    assert c.post("/api/auth/login", json={"username": "view", "password": "view1234"}).status_code == 400


def test_multiple_reviewers_consensus_and_agreement(app_client, setup_suite):
    c = app_client
    s = setup_suite
    mapping = c.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = wait_done(c, c.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping, "case_limit": 6}).json()["id"])
    q = c.get(f"/api/runs/{run['id']}/review", params={"reviewer": "가"}).json()
    assert q["reviewer"] == "가" and len(q["items"]) == 6
    for item in q["items"]:
        keys = list(c.get(f"/api/runs/{run['id']}/cases/{item['id']}").json()["item_judgments"])
        c.put(f"/api/runs/{run['id']}/cases/{item['id']}/human", json={"reviewer": "가", "grades": {k: 3 for k in keys}, "pairwise": {"TOBE": "candidate"}})
        out = c.put(f"/api/runs/{run['id']}/cases/{item['id']}/human", json={"reviewer": "나", "grades": {k: (2 if i % 2 else 3) for i, k in enumerate(keys)}, "pairwise": {"TOBE": "baseline"}}).json()
    last = c.get(f"/api/runs/{run['id']}/cases/{q['items'][-1]['id']}").json()
    assert set(last["human_by"]) == {"가", "나"}
    some_key = next(iter(last["human_judgments"]))
    assert last["human_judgments"][some_key]["n"] == 2  # 두 사람 합의
    assert last["human_pairwise"]["TOBE"] == "tie"  # 1:1 → 비슷
    summ = out["summary"]
    assert summ["review"]["reviewers"] == 2 and {r["reviewer"] for r in summ["reviewers"]} == {"가", "나"}
    ir = summ["inter_rater"]
    assert ir["pairs"][0]["items"] > 5 and ir["pairwise_agree"] == 0.0
    # 내 큐: '가'는 모두 끝냄
    q2 = c.get(f"/api/runs/{run['id']}/review", params={"reviewer": "가", "mode": "mine"}).json()
    assert all(x["mine_complete"] for x in q2["items"]) and q2["items"][0]["reviewers"] == ["가", "나"]
    # '다'는 아직 안 봄 → overlap 모드에서 남이 본 케이스가 먼저
    q3 = c.get(f"/api/runs/{run['id']}/review", params={"reviewer": "다", "mode": "overlap"}).json()
    assert not q3["items"][0]["mine_complete"] and q3["items"][0]["reviewers"]


def test_dataset_versions_diff_restore_and_run_link(app_client, setup_suite):
    c = app_client
    s = setup_suite
    sid = s["suite"]["id"]
    d = c.post("/api/datasets", json={"name": "버전 테스트", "columns": ["case_id", "q"],
                                      "rows": [{"case_id": "A", "q": "학자금"}, {"case_id": "B", "q": "법인카드"}]}).json()
    assert d["version"] == 1
    c.put(f"/api/datasets/{d['id']}/binding", json={"suite_id": sid, "mapping": {"fields": {"q": "q"}, "case_key": "case_id"}})
    # 같은 내용으로 저장하면 버전이 늘지 않는다
    same = c.put(f"/api/datasets/{d['id']}", json={"name": "버전 테스트", "columns": ["case_id", "q"],
                                                  "rows": [{"case_id": "A", "q": "학자금"}, {"case_id": "B", "q": "법인카드"}]}).json()
    assert same["version"] == 1
    v2 = c.put(f"/api/datasets/{d['id']}", json={"name": "버전 테스트", "columns": ["case_id", "q"],
                                                "rows": [{"case_id": "A", "q": "학자금 신청"}, {"case_id": "C", "q": "출장비"}]}).json()
    assert v2["version"] == 2
    mapping = c.get(f"/api/datasets/{d['id']}/mapping", params={"suite_id": sid}).json()
    run = wait_done(c, c.post("/api/runs", json={"suite_id": sid, "dataset_id": d["id"], "mapping": mapping}).json()["id"])
    assert run["dataset_version"] == 2
    vs = c.get(f"/api/datasets/{d['id']}/versions").json()
    assert [v["version"] for v in vs] == [2, 1] and vs[0]["current"] and vs[0]["runs"] == 1
    assert vs[0]["changes"] == {"added": 1, "removed": 1, "changed": 1, "columns_added": [], "columns_removed": []}
    df = c.get(f"/api/datasets/{d['id']}/versions/diff", params={"a": 1, "b": 2}).json()
    assert df["changed_rows"][0]["columns"] == ["q"] and df["added_rows"][0]["case_id"] == "C"
    back = c.post(f"/api/datasets/{d['id']}/versions/1/restore").json()
    assert back["version"] == 3 and back["row_count"] == 2
    rows = c.get(f"/api/datasets/{d['id']}").json()["rows"]
    assert rows[1]["q"] == "법인카드"
    # 단건 비교에서 추가해도 버전이 남는다
    assert c.post("/api/datasets/add-row", json={"suite_id": sid, "dataset_id": d["id"], "inputs": {"q": "새"}}).json()["version"] == 4


def test_notifications_tokens_and_ci_gate(app_client, setup_suite, monkeypatch):
    import httpx as _httpx

    import app.notify as notify

    sent: list[dict] = []

    def hook(request: _httpx.Request) -> _httpx.Response:
        sent.append({"url": str(request.url), "body": json.loads(request.content)})
        return _httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(notify, "http", lambda: _httpx.AsyncClient(transport=_httpx.MockTransport(hook)))
    c = app_client
    s = setup_suite
    ch = c.post("/api/notifications", json={"name": "팀 슬랙", "kind": "slack", "url": "https://hooks.slack.test/T/B/xyz", "events": ["run_done", "run_regressed"]}).json()
    assert ch["url_hint"].startswith("https://hooks.slack.test/") and "T/B" not in ch["url_hint"]
    assert c.post(f"/api/notifications/{ch['id']}/test").json()["ok"]
    assert "알림 테스트" in sent[-1]["body"]["text"]

    tok = c.post("/api/tokens", json={"name": "github", "role": "editor"}).json()
    raw = tok["token"]
    assert raw.startswith("sbk_") and "token" not in c.get("/api/tokens").json()[0]
    h = {"Authorization": f"Bearer {raw}"}
    assert c.post("/api/ci/runs", json={"suite": "세트", "dataset": 999}, headers={"Authorization": "Bearer sbk_wrong"}).status_code == 401

    # 개선이 확실한 원래 설정 → not_improved 게이트도 통과
    res = c.post("/api/ci/runs", headers=h, json={"suite": "세트", "dataset": s["dataset"]["id"], "gate": "not_improved"}).json()
    assert res["finished"] and res["passed"] is True and res["verdict"] == "improved"
    assert any("평가 완료" in x["body"]["text"] for x in sent)
    # TOBE 주소를 ASIS 로 바꾸면 차이가 없어진다 → not_improved 실패, regressed 게이트는 통과
    res2 = c.post("/api/ci/runs", headers=h, json={"suite": s["suite"]["id"], "dataset": s["dataset"]["id"], "gate": "not_improved",
                                                    "target_overrides": {"TOBE": {"base_url": "http://asis.test"}}}).json()
    assert res2["passed"] is False and res2["verdict"] != "improved"
    assert c.get(f"/api/ci/runs/{res2['run_id']}", params={"gate": "regressed"}).json()["passed"] is True
    run2 = c.get(f"/api/runs/{res2['run_id']}").json()
    assert run2["members"][1]["target_name"] == "TOBE"
    assert c.post("/api/ci/runs", headers=h, json={"suite": "세트", "dataset": s["dataset"]["id"], "target_overrides": {"없는": {"base_url": "x"}}}).status_code == 400
    # 토큰 끄면 막힘
    c.delete(f"/api/tokens/{tok['id']}")
    assert c.get("/api/suites", headers=h).status_code == 401


def test_cost_cap_stops_and_resume_continues(app_client, setup_suite):
    c = app_client
    s = setup_suite
    mapping = c.get(f"/api/datasets/{s['dataset']['id']}/mapping", params={"suite_id": s["suite"]["id"]}).json()
    run = c.post("/api/runs", json={"suite_id": s["suite"]["id"], "dataset_id": s["dataset"]["id"], "mapping": mapping,
                                    "concurrency": 1, "max_cost": 0.000001}).json()
    run = wait_done(c, run["id"])
    assert run["status"] == "cancelled" and "비용 상한" in run["error"] and run["completed"] < run["total"]
    c.post(f"/api/runs/{run['id']}/resume")
    run = wait_done(c, run["id"])
    assert run["status"] == "done" and run["completed"] == run["total"]
