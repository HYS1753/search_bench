"""입력 검증 — 비교 세트의 입력(공통·API 전용)과 각 API 가 요구하는 값을 실행 전에 확인한다.

- 입력 항목: suite.input_fields[i] = {key, label, type, required, scope("" 공통 | API 라벨)}
- API 가 꼭 받아야 하는 값: target.params[j].required (API 설정의 '입력 방식')
"""

from __future__ import annotations

from typing import Any

from app.datasets_io import DatasetError, coerce
from app.matching import bind_inputs


def field_label(f: dict[str, Any]) -> str:
    base = f.get("label") or f["key"]
    return f"{f['scope']} 전용 · {base}" if f.get("scope") else base


def input_labels(fields: list[dict[str, Any]]) -> dict[str, str]:
    """판정 프롬프트·화면에서 쓸 입력 이름(API 전용 입력은 'TOBE 전용 · cat')."""
    return {f["key"]: field_label(f) for f in fields}


def row_inputs(fields: list[dict[str, Any]], data: dict[str, Any], mapping_fields: dict[str, str]) -> tuple[dict[str, Any], list[str]]:
    inputs: dict[str, Any] = {}
    errors: list[str] = []
    for f in fields:
        col = mapping_fields.get(f["key"], "")
        value = data.get(col) if col else None
        if value in (None, "") and f.get("default") not in (None, ""):
            value = f["default"]
        try:
            inputs[f["key"]] = coerce(value, f.get("type", "text"))
        except DatasetError as exc:
            errors.append(f"{field_label(f)}: {exc}")
            inputs[f["key"]] = None
            continue
        if f.get("required") and inputs[f["key"]] in (None, "", []):
            errors.append(f"{field_label(f)} 이(가) 비어 있습니다.")
    return inputs, errors


def member_errors(inputs: dict[str, Any], members: list[dict[str, Any]]) -> list[str]:
    """API 별로 실제로 보낼 값을 만들어 보고, 그 API 가 꼭 받아야 하는 값이 비었는지 본다."""
    errors: list[str] = []
    for m in members:
        params = m["params"]
        try:
            bound = bind_inputs(inputs, m.get("input_bindings"), params)
        except ValueError as exc:
            errors.append(f"{m['label']}: 입력 변환 실패 — {exc}")
            continue
        for p in params:
            if p.get("source", "field") != "field" or not p.get("required"):
                continue
            key = p.get("field") or p.get("name")
            if bound.get(key) in (None, "", []):
                errors.append(f"{m['label']}: 꼭 필요한 '{p.get('label') or p.get('name')}' 값이 비어 있습니다.")
    return errors


def validate_rows(
    fields: list[dict[str, Any]], members: list[dict[str, Any]], rows: list[tuple[int, dict[str, Any]]],
    mapping_fields: dict[str, str], *, max_errors: int = 200,
) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    valid: list[int] = []
    filled = {f["key"]: 0 for f in fields}
    for idx, data in rows:
        inputs, msgs = row_inputs(fields, data, mapping_fields)
        if not msgs:
            msgs = member_errors(inputs, members)
        for k, v in inputs.items():
            if v not in (None, "", []):
                filled[k] += 1
        if msgs:
            if len(errors) < max_errors:
                errors.append({"row": idx + 1, "messages": msgs})
        else:
            valid.append(idx)
    total = len(rows)
    unmapped = [field_label(f) for f in fields if not mapping_fields.get(f["key"]) and f.get("default") in (None, "")]
    return {
        "total": total,
        "valid": len(valid),
        "invalid": total - len(valid),
        "valid_rows": valid,
        "errors": errors,
        "inputs": [
            {"key": f["key"], "label": field_label(f), "scope": f.get("scope", ""), "required": bool(f.get("required")),
             "column": mapping_fields.get(f["key"], ""), "filled": filled[f["key"]], "empty": total - filled[f["key"]]}
            for f in fields
        ],
        "unmapped": unmapped,
    }


def members_spec(suite_members: list[Any]) -> list[dict[str, Any]]:
    return [{"label": m.label, "params": m.target.params or [], "input_bindings": m.input_bindings or {}} for m in suite_members]
