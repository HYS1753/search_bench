"""테스트 데이터 ↔ 비교 세트 연결.

- 컬럼 자동 연결: key·보이는 이름·'○○ 전용 · 이름' 표기 → 공백·기호·대소문자 무시 → 비슷한 이름(동의어·단수/복수)
- 저장된 연결: 데이터가 기억하는 비교 세트·연결이 있으면 그것을 먼저 쓰고, 없어진 컬럼만 다시 찾는다.
- 호환 상태: ready(바로 사용) / check(연결 확인 권장) / missing(필수 입력에 맞는 열 없음)
"""

from __future__ import annotations

import re
from typing import Any

from app.validation import field_label

META = {
    "case_key": ["case_id", "id", "케이스", "케이스id", "번호", "no"],
    "category": ["category", "분류", "카테고리", "유형"],
    "expected": ["expected", "기대정답", "기대", "정답", "answer", "정답힌트", "기대정답힌트"],
}
SYNONYMS = [
    ["q", "query", "question", "text", "keyword", "search", "term", "prompt", "input", "message", "querytext",
     "searchquery", "질문", "검색어", "질의", "쿼리", "문의", "입력"],
    ["keywords", "kw", "terms", "tags", "keywordlist", "키워드", "핵심어", "태그"],
    ["topk", "size", "limit", "k", "n", "count", "rows", "pagesize", "num", "numresults", "maxresults", "결과수", "개수"],
    ["lang", "locale", "language", "언어"],
    ["cat", "category", "type", "filter", "분류", "카테고리", "유형"],
]


def norm(s: str) -> str:
    return re.sub(r"[\s_\-.·:/()\[\]]+", "", str(s or "")).lower()


def _stem(s: str) -> str:
    n = norm(s)
    return re.sub(r"(es|s)$", "", n) if re.fullmatch(r"[a-z0-9]+", n) else n


def _group(s: str) -> int:
    n = norm(s)
    return next((i for i, g in enumerate(SYNONYMS) if n in g), -1)


def _leaf(key: str) -> str:
    return key.split("__", 1)[1] if "__" in key else key


def names_for(f: dict[str, Any]) -> list[str]:
    """이 입력에 해당할 수 있는 열 이름(정확히 같다고 볼 것)."""
    out = [f["key"], field_label(f)]
    if f.get("label"):
        if f.get("scope"):
            out += [f"{f['scope']} {f['label']}", f"{f['scope']}_{f['label']}", f"{f['scope']} 전용 {f['label']}"]
        else:
            out.append(f["label"])
    if f.get("scope"):
        out += [f"{f['scope']}_{_leaf(f['key'])}", f"{f['scope']} {_leaf(f['key'])}"]
    return [norm(x) for x in out if x]


def auto_mapping(columns: list[str], input_fields: list[dict[str, Any]]) -> dict[str, Any]:
    by_norm: dict[str, str] = {}
    for c in columns:
        by_norm.setdefault(norm(c), c)
    used: set[str] = set()
    fields: dict[str, str] = {}
    how: dict[str, str] = {}
    # 1) 정확히 같은 이름
    for f in input_fields:
        for n in names_for(f):
            col = by_norm.get(n)
            if col and col not in used:
                fields[f["key"]], how[f["key"]] = col, "exact"
                used.add(col)
                break
    meta_norms = {n for names in META.values() for n in (norm(x) for x in names)}
    # 2) 비슷한 이름(공통 입력만, 메타 열은 건드리지 않음). 같은 API 전용 입력끼리 헷갈리지 않게 scope 가 있으면 건너뛴다.
    for f in input_fields:
        if f["key"] in fields:
            continue
        leaf = f.get("label") or _leaf(f["key"])
        candidates = [_leaf(f["key"]), leaf]
        for c in columns:
            if c in used or norm(c) in meta_norms:
                continue
            if any(_stem(c) == _stem(x) for x in candidates) or (
                not f.get("scope") and any(_group(x) >= 0 and _group(x) == _group(c) for x in candidates)
            ):
                fields[f["key"]], how[f["key"]] = c, "similar"
                used.add(c)
                break
        fields.setdefault(f["key"], "")

    def pick(names: list[str]) -> str:
        for n in names:
            col = by_norm.get(norm(n))
            if col and col not in used:
                return col
        return ""

    return {"fields": fields, "case_key": pick(META["case_key"]), "category": pick(META["category"]),
            "expected": pick(META["expected"]), "matched_by": how}


def effective_mapping(dataset: Any, suite: Any) -> dict[str, Any]:
    """저장된 연결(같은 비교 세트일 때) 우선, 빠진 것은 자동 연결로 채운다."""
    columns = dataset.columns or []
    fields_def = suite.input_fields or []
    auto = auto_mapping(columns, fields_def)
    saved = dataset.mapping or {}
    if dataset.suite_id != suite.id or not saved:
        return {**auto, "saved": False}
    out = {"fields": {}, "matched_by": {}, "saved": True}
    for f in fields_def:
        col = (saved.get("fields") or {}).get(f["key"], "")
        if col and col in columns:
            out["fields"][f["key"]], out["matched_by"][f["key"]] = col, "saved"
        else:
            out["fields"][f["key"]] = auto["fields"].get(f["key"], "")
            if out["fields"][f["key"]]:
                out["matched_by"][f["key"]] = auto["matched_by"].get(f["key"], "exact")
    for k in ("case_key", "category", "expected"):
        v = saved.get(k, "")
        out[k] = v if v in columns else auto[k]
    return out


def compat(dataset: Any, suite: Any) -> dict[str, Any]:
    m = effective_mapping(dataset, suite)
    fields_def = suite.input_fields or []
    missing = [field_label(f) for f in fields_def if f.get("required") and not m["fields"].get(f["key"]) and f.get("default") in (None, "")]
    optional_unmapped = [field_label(f) for f in fields_def if not f.get("required") and not m["fields"].get(f["key"]) and f.get("default") in (None, "")]
    similar = [field_label(f) for f in fields_def if m["matched_by"].get(f["key"]) == "similar"]
    used = set(v for v in m["fields"].values() if v) | {m.get("case_key"), m.get("category"), m.get("expected")}
    unused = [c for c in (dataset.columns or []) if c not in used]
    status = "missing" if missing else "check" if (similar or (optional_unmapped and not m["saved"])) else "ready"
    return {"status": status, "mapping": m, "missing_required": missing, "unmapped_optional": optional_unmapped,
            "similar": similar, "unused_columns": unused, "bound": dataset.suite_id == suite.id}


def dataset_columns_for(fields_def: list[dict[str, Any]]) -> tuple[list[str], dict[str, Any]]:
    """비교 세트에서 새 데이터를 만들 때 쓸 사람이 읽기 쉬운 열 이름과 그 연결."""
    cols = ["케이스", "분류"]
    mapping: dict[str, Any] = {"fields": {}, "case_key": "케이스", "category": "분류", "expected": "기대 정답"}
    seen = set(cols)
    for f in fields_def:
        name = field_label(f)
        if name in seen:
            name = f["key"]
        seen.add(name)
        cols.append(name)
        mapping["fields"][f["key"]] = name
    cols.append("기대 정답")
    return cols, mapping
