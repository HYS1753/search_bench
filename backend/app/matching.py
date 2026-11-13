"""요청·응답 형태가 서로 다른 API 를 같은 기준으로 비교하기 위한 규칙.

입력 맞추기 — 비교 세트의 '공통 입력'을 API 마다 다른 파라미터로 옮긴다.
  input_bindings = {"<API 의 입력 key>": {"from": "<공통 입력 key>", "transform": "...", "value": "..."}}
  연결이 없으면 같은 이름의 공통 입력을 그대로 쓴다(이전 버전과 같은 동작).

응답 맞추기 — 서로 다른 API 결과 중 '같은 결과'를 알아보는 기준.
  match_mode: "id"(고유 번호, 기본) | "title"(제목) | "none"(같게 보지 않음)
  member match = {"lower": bool, "digits_only": bool, "strip_prefix": str, "strip_suffix": str} (기본: 그대로 비교)
"""

from __future__ import annotations

import re
from typing import Any

TRANSFORMS = {
    "as_is": "그대로",
    "join_space": "목록을 공백으로 합치기",
    "join_comma": "목록을 쉼표로 합치기",
    "split": "문장을 목록으로 나누기",
    "first": "첫 번째 값만",
    "number": "숫자로",
    "const": "고정 값",
    "template": "조합 문장",
}


def _as_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [p for p in re.split(r"[\s,]+", str(value).strip()) if p]


def _as_text(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(str(v) for v in value)
    return "" if value is None else str(value)


def apply_transform(value: Any, transform: str, *, const: str = "", common: dict[str, Any] | None = None) -> Any:
    if transform == "const":
        return const
    if transform == "template":
        return re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: _as_text((common or {}).get(m.group(1))), const).strip()
    if value is None or value == "" or value == []:
        return None
    if transform == "join_space":
        return " ".join(_as_list(value)) if isinstance(value, list) else str(value)
    if transform == "join_comma":
        return ",".join(_as_list(value)) if isinstance(value, list) else str(value)
    if transform == "split":
        return _as_list(value)
    if transform == "first":
        return value[0] if isinstance(value, list) and value else value
    if transform == "number":
        try:
            num = float(value[0] if isinstance(value, list) else value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"숫자로 바꿀 수 없는 값: {value}") from exc
        return int(num) if num.is_integer() else num
    return value


def bind_inputs(common: dict[str, Any], bindings: dict[str, Any] | None, params: list[dict[str, Any]]) -> dict[str, Any]:
    """공통 입력 → 이 API 의 입력(key = 파라미터의 field)."""
    bindings = bindings or {}
    out: dict[str, Any] = {}
    for spec in params or []:
        if spec.get("source", "field") != "field":
            continue
        key = spec.get("field") or spec.get("name")
        if not key or key in out:
            continue
        rule = bindings.get(key)
        if rule is None:
            if key in common:
                out[key] = common[key]
            continue
        src = rule.get("from", "")
        transform = rule.get("transform", "as_is") or "as_is"
        if not src and transform not in ("const", "template"):
            continue  # '보내지 않음'
        value = apply_transform(common.get(src), transform, const=rule.get("value", ""), common=common)
        if value not in (None, "", []):
            out[key] = value
    return out


# ── 중첩 본문 ───────────────────────────────────────────────

_PATH = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def set_path(obj: dict[str, Any], path: str, value: Any) -> None:
    """'query.filters[0].value' 같은 경로에 값을 넣으며 중간 객체·배열을 만든다."""
    tokens = [(n, int(i) if i else None) for n, i in _PATH.findall(path)]
    if not tokens:
        return
    cur: Any = obj
    for idx, (name, index) in enumerate(tokens):
        last = idx == len(tokens) - 1
        nxt_is_index = not last and tokens[idx + 1][1] is not None
        if index is None:
            if last:
                cur[name] = value
                return
            if name not in cur or not isinstance(cur[name], (dict, list)):
                cur[name] = [] if nxt_is_index else {}
            cur = cur[name]
        else:
            while len(cur) <= index:
                cur.append(None)
            if last:
                cur[index] = value
                return
            if not isinstance(cur[index], (dict, list)):
                cur[index] = [] if nxt_is_index else {}
            cur = cur[index]


def json_typed(value: Any, json_type: str) -> Any:
    """본문 JSON 의 원래 타입(숫자·불리언)으로 되돌린다."""
    if json_type == "number" and not isinstance(value, (int, float)):
        try:
            num = float(value)
            return int(num) if num.is_integer() else num
        except (TypeError, ValueError):
            return value
    if json_type == "boolean" and isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "y")
    return value


# ── 응답 맞추기 ───────────────────────────────────────────────

_TITLE_NOISE = re.compile(r"[\s\W_]+", re.UNICODE)


def normalize_key(key: str, rule: dict[str, Any] | None) -> str:
    rule = rule or {}
    k = str(key).strip()
    prefix, suffix = rule.get("strip_prefix", ""), rule.get("strip_suffix", "")
    if prefix and k.lower().startswith(prefix.lower()):
        k = k[len(prefix):]
    if suffix and k.lower().endswith(suffix.lower()):
        k = k[: -len(suffix)]
    if rule.get("digits_only"):
        digits = re.sub(r"\D", "", k)
        k = digits.lstrip("0") or digits or k
    if rule.get("lower"):
        k = k.lower()
    return k.strip()


def apply_match(items: list[dict[str, Any]], mode: str, rule: dict[str, Any] | None, label: str) -> list[dict[str, Any]]:
    """항목 key 를 '같은 결과' 판단 기준에 맞게 바꾼다(원래 값은 raw_key 로 남김)."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in items:
        raw = it.get("raw_key", it["key"])
        if mode == "title":
            key = "t:" + (_TITLE_NOISE.sub("", str(it.get("title", ""))).lower() or raw)
        elif mode == "none":
            key = f"{label}:{raw}"
        else:
            key = normalize_key(raw, rule) or raw
        if key in seen:
            continue
        seen.add(key)
        out.append({**it, "key": key, "raw_key": raw})
    return out


def overlap(base: list[dict[str, Any]], cand: list[dict[str, Any]], k: int | None = None) -> dict[str, int]:
    b = [it["key"] for it in base[: k or None]]
    c = [it["key"] for it in cand[: k or None]]
    common = set(b) & set(c)
    return {"common": len(common), "base": len(b), "cand": len(c), "top1_same": int(bool(b and c and b[0] == c[0]))}
