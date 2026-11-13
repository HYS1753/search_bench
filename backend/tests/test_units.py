"""순수 함수 단위 테스트 — 지표·경로 매핑·요청 구성·데이터셋·판정 JSON."""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from app.datasets_io import DatasetError, auto_mapping, coerce, parse_file
from app.evaluation.engine import relabel
from app.evaluation.metrics import bootstrap_ci, case_metrics, dcg, sign_test_p, summarize, verdict
from app.judges.base import extract_json, strict_schema, validate
from app.targets import build_request, get_values, normalize_items


def test_dcg_and_ndcg_against_pool():
    assert dcg([3, 0]) == pytest.approx(7.0)
    perfect = case_metrics([3, 1, 0], [3, 1, 0], k=3, threshold=2)
    assert perfect["ndcg"] == pytest.approx(1.0)
    swapped = case_metrics([1, 3, 0], [3, 1, 0], k=3, threshold=2)
    expected = (1 + 7 / math.log2(3)) / (7 + 1 / math.log2(3))
    assert swapped["ndcg"] == pytest.approx(expected)
    assert swapped["hit1"] == 0.0 and swapped["mrr"] == pytest.approx(0.5)
    assert swapped["precision"] == pytest.approx(1 / 3)


def test_ndcg_undefined_when_pool_has_no_relevance():
    m = case_metrics([0, 0], [0, 0], k=2, threshold=2)
    assert m["ndcg"] is None and m["hit1"] == 0.0


def test_precision_denominator_is_k_even_with_fewer_results():
    m = case_metrics([3], [3], k=5, threshold=2)
    assert m["precision"] == pytest.approx(0.2)


def test_sign_test_and_bootstrap():
    assert sign_test_p(0, 0) is None
    assert sign_test_p(10, 0) == pytest.approx(2 / 1024)
    assert sign_test_p(5, 5) == pytest.approx(1.0)
    lo, hi = bootstrap_ci([0.1] * 20)
    assert lo == pytest.approx(0.1) and hi == pytest.approx(0.1)
    assert bootstrap_ci([0.1]) is None


def test_verdict_codes():
    assert verdict(0.1, (0.05, 0.2), 30, 10, 2, 30)["code"] == "improved"
    assert verdict(-0.1, (-0.2, -0.05), 30, 2, 10, 30)["code"] == "regressed"
    assert verdict(0.01, (-0.02, 0.04), 30, 5, 5, 30)["code"] == "no_difference"
    assert verdict(0.3, (0.1, 0.5), 5, 5, 0, 5)["code"] == "inconclusive"


def test_summarize_counts_wins_and_categories():
    members = [{"label": "A", "is_baseline": True}, {"label": "B"}]
    cases = [
        {"category": "x", "metrics": {"A": {"ndcg": 0.5, "hit1": 0, "ok": True, "latency_ms": 10},
                                      "B": {"ndcg": 1.0, "hit1": 1, "ok": True, "latency_ms": 20}},
         "pairwise": {"B": {"winner": "candidate", "consistent": True}}},
        {"category": "y", "metrics": {"A": {"ndcg": 1.0, "hit1": 1, "ok": True, "latency_ms": 10},
                                      "B": {"ndcg": 0.0, "hit1": 0, "ok": False, "latency_ms": 5}},
         "pairwise": {"B": {"winner": "tie", "consistent": False}}},
    ]
    s = summarize(cases, members)
    cmp = s["comparisons"][0]
    assert (cmp["wins"], cmp["losses"], cmp["ties"], cmp["inconsistent"]) == (1, 0, 1, 1)
    assert s["targets"][1]["error_rate"] == pytest.approx(0.5)
    assert {c["category"] for c in s["by_category"]} == {"x", "y"}


def test_get_values_paths():
    body = {"results": [{"a": [{"b": 1}, {"b": 2}]}, {"a": [{"b": 3}]}]}
    assert get_values(body, "results[].a[].b") == [1, 2, 3]
    assert get_values(body, "results[0].a[1].b") == [2]
    assert get_values([1, 2], "$") == [[1, 2]]
    assert get_values(body, "missing.path") == []


def test_normalize_items_dedup_and_hash_key():
    body = {"results": [{"id": "1", "t": "x"}, {"id": "1", "t": "dup"}, {"t": "noid"}]}
    items = normalize_items(body, {"results_path": "results", "id_path": "id", "title_path": "t"})
    assert [i["key"] for i in items[:1]] == ["1"] and len(items) == 2
    assert items[1]["key"].startswith("h:")


def test_build_request_param_styles_and_auth(monkeypatch):
    monkeypatch.setenv("MY_KEY", "env-secret")
    t = SimpleNamespace(
        method="GET", base_url="http://x/", path="/v1/{kind}", headers={}, secret_enc="",
        auth={"type": "bearer", "env": "MY_KEY"},
        params=[
            {"name": "kind", "field": "kind", "location": "path"},
            {"name": "kw", "field": "kw", "array_style": "repeat"},
            {"name": "kw2", "field": "kw", "array_style": "space"},
            {"name": "fixed", "source": "const", "value": "1"},
            {"name": "empty", "field": "none"},
        ],
    )
    req = build_request(t, {"kind": "person", "kw": ["a", "b"]})
    assert req["url"] == "http://x/v1/person"
    assert req["params"] == [("kw", "a"), ("kw", "b"), ("kw2", "a b"), ("fixed", "1")]
    assert req["headers"]["Authorization"] == "Bearer env-secret"


def test_parse_csv_cp949_and_xlsx_like_errors():
    cols, rows = parse_file("a.csv", "q,keywords\n학자금,교육비 학비\n,\n".encode("cp949"))
    assert cols == ["q", "keywords"] and rows == [{"q": "학자금", "keywords": "교육비 학비"}]
    with pytest.raises(DatasetError):
        parse_file("a.txt", b"x")
    with pytest.raises(DatasetError):
        parse_file("a.csv", b"q,q\n1,2\n")


def test_coerce_list_variants():
    assert coerce("a b", "list") == ["a", "b"]
    assert coerce("a, b c", "list") == ["a", "b c"]
    assert coerce('["x","y"]', "list") == ["x", "y"]
    assert coerce("", "list") == []
    assert coerce("3.0", "int") == 3


def test_auto_mapping_matches_by_name():
    m = auto_mapping(["case_id", "Q", "분류"], [{"key": "q", "label": "질문"}])
    assert m["fields"]["q"] == "Q" and m["case_key"] == "case_id" and m["category"] == "분류"


def test_extract_and_validate_json():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('설명 {"a": 2} 끝') == {"a": 2}
    schema = {"type": "object", "properties": {"w": {"type": "string", "enum": ["A", "B"]}}, "required": ["w"]}
    validate({"w": "A"}, schema)
    with pytest.raises(ValueError):
        validate({"w": "C"}, schema)
    strict = strict_schema({"type": "object", "properties": {"x": {"type": "array", "items": {"type": "object", "properties": {}}}}})
    assert strict["additionalProperties"] is False and strict["properties"]["x"]["items"]["additionalProperties"] is False


def test_relabel_ab():
    assert relabel("A가 더 좋고 B는 무관, ABC 유지", "ASIS", "TOBE") == "ASIS가 더 좋고 TOBE는 무관, ABC 유지"


def test_both_failed_cases_are_excluded_and_warned():
    members = [{"label": "A", "is_baseline": True}, {"label": "B"}]
    failed = {"ndcg": 0.0, "hit1": 0.0, "ok": False, "latency_ms": None}
    cases = [{"category": "", "metrics": {"A": dict(failed), "B": dict(failed)},
              "pairwise": {"B": {"winner": "tie", "consistent": True}}} for _ in range(3)]
    s = summarize(cases, members)
    assert s["comparisons"][0]["ndcg_cases"] == 0
    assert any("실패율" in w for w in s["warnings"])


def test_bindings_transforms_and_default_passthrough():
    from app.matching import bind_inputs

    params = [
        {"name": "query.text", "source": "field", "field": "text"},
        {"name": "keyword", "source": "field", "field": "keyword"},
        {"name": "query.size", "source": "field", "field": "size"},
        {"name": "lang", "source": "field", "field": "lang"},
        {"name": "q", "source": "field", "field": "q"},
        {"name": "fixed", "source": "const", "value": "x"},
    ]
    common = {"q": "학자금 담당", "keywords": ["학자금", "교육비"], "top_k": "3"}
    out = bind_inputs(common, {
        "text": {"from": "q", "transform": "as_is"},
        "keyword": {"from": "keywords", "transform": "join_space"},
        "size": {"from": "top_k", "transform": "number"},
        "lang": {"from": "", "transform": "template", "value": "ko:{q}"},
    }, params)
    assert out == {"text": "학자금 담당", "keyword": "학자금 교육비", "size": 3, "lang": "ko:학자금 담당", "q": "학자금 담당"}


def test_nested_body_build():
    t = SimpleNamespace(
        method="POST", base_url="http://x", path="/s", headers={}, secret_enc="", auth={},
        params=[
            {"name": "query.text", "field": "text", "location": "body"},
            {"name": "query.size", "field": "size", "location": "body", "json_type": "number"},
            {"name": "filters[0].field", "source": "const", "value": "status", "location": "body"},
            {"name": "filters[0].on", "source": "const", "value": "true", "location": "body", "json_type": "boolean"},
        ],
    )
    req = build_request(t, {"text": "학자금", "size": "5"})
    assert req["json"] == {"query": {"text": "학자금", "size": 5}, "filters": [{"field": "status", "on": True}]}


def test_match_rules():
    from app.matching import apply_match, normalize_key

    assert normalize_key("EMP-E1", {"strip_prefix": "emp-", "lower": True}) == "e1"
    assert normalize_key("ID_000123", {"digits_only": True}) == "123"
    items = [{"key": "A", "title": "제목 하나!"}, {"key": "B", "title": "제목하나"}]
    assert [i["key"] for i in apply_match(items, "title", None, "X")] == ["t:제목하나"]
    assert apply_match(items, "none", None, "X")[0]["key"] == "X:A"


def test_migrations_keep_child_rows(tmp_path, monkeypatch):
    """테이블을 다시 만드는 마이그레이션(0005: datasets)이 자식 행(dataset_rows)을 지우지 않아야 한다."""
    from sqlalchemy import text

    from app import config, db
    from app.main import migrate

    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    config.get_settings.cache_clear()
    db.reset_engine()
    (tmp_path / "data").mkdir()
    migrate("0004")
    with db.get_engine().begin() as conn:
        conn.execute(text("INSERT INTO datasets (id, name, description, columns, source_filename, row_count, created_at, updated_at) "
                          "VALUES (1, 'd', '', '[\"q\"]', '', 2, '2026-01-01', '2026-01-01')"))
        conn.execute(text("INSERT INTO dataset_rows (dataset_id, row_index, data) VALUES (1, 0, '{\"q\": \"a\"}'), (1, 1, '{\"q\": \"b\"}')"))
    migrate()
    with db.get_engine().connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM dataset_rows")).scalar() == 2
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1
    db.reset_engine()
    config.get_settings.cache_clear()


def test_verdict_marks_weak_evidence_under_30_cases():
    from app.evaluation.metrics import verdict

    weak = verdict(0.1, (0.05, 0.15), 15, 10, 2, 15)
    assert weak["code"] == "improved" and weak["weak"] and "15건" in weak["detail"]
    strong = verdict(0.1, (0.05, 0.15), 40, 30, 5, 40)
    assert strong["code"] == "improved" and not strong.get("weak")
    assert not verdict(0.1, (0.05, 0.15), 5, 3, 1, 5).get("weak")  # 보류는 따로 표시


def test_version_diff_ignores_number_vs_text():
    from app.dataset_versions import diff

    d = diff(["q", "k"], [{"q": "a", "k": 5}], ["q", "k"], [{"q": "a", "k": "5"}])
    assert d["changed"] == 0
    d2 = diff(["q", "k"], [{"q": "a", "k": 5}], ["q", "k"], [{"q": "b", "k": "5"}])
    assert d2["changed"] == 1 and d2["changed_rows"][0]["columns"] == ["q"]
