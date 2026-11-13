"""데이터셋 파일 읽기(CSV·XLSX·JSONL·JSON)와 입력값 변환."""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

MAX_ROWS = 5000
MAX_BYTES = 10 * 1024 * 1024
RESERVED_COLUMNS = ("case_id", "category", "expected")


class DatasetError(ValueError):
    pass


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise DatasetError("파일 인코딩을 읽을 수 없습니다. UTF-8 로 저장해 주세요.")


def _clean(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        return value.strip()
    return value


def _finish(columns: list[str], rows: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, Any]]]:
    columns = [c for c in (str(c).strip() for c in columns) if c]
    if not columns:
        raise DatasetError("헤더(첫 줄 컬럼명)가 없습니다.")
    if len(set(columns)) != len(columns):
        raise DatasetError("컬럼명이 중복되었습니다.")
    cleaned = []
    for row in rows:
        data = {c: _clean(row.get(c)) for c in columns}
        if any(v not in ("", None) for v in data.values()):
            cleaned.append(data)
    if not cleaned:
        raise DatasetError("데이터 행이 없습니다.")
    if len(cleaned) > MAX_ROWS:
        raise DatasetError(f"행이 너무 많습니다({len(cleaned)}행). 최대 {MAX_ROWS}행까지 올릴 수 있습니다.")
    return columns, cleaned


def parse_file(filename: str, raw: bytes) -> tuple[list[str], list[dict[str, Any]]]:
    if len(raw) > MAX_BYTES:
        raise DatasetError("파일이 너무 큽니다(최대 10MB).")
    name = filename.lower()
    if name.endswith(".csv") or name.endswith(".tsv"):
        text = _decode(raw)
        dialect = "excel-tab" if name.endswith(".tsv") else "excel"
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        return _finish(reader.fieldnames or [], list(reader))
    if name.endswith(".xlsx"):
        from openpyxl import load_workbook

        try:
            wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        except Exception as exc:  # noqa: BLE001
            raise DatasetError(f"엑셀 파일을 열 수 없습니다: {exc}") from exc
        ws = wb.worksheets[0]
        it = ws.iter_rows(values_only=True)
        header = next(it, None)
        if not header:
            raise DatasetError("첫 시트가 비어 있습니다.")
        columns = [str(h).strip() if h is not None else "" for h in header]
        rows = [{columns[i]: v for i, v in enumerate(r) if i < len(columns) and columns[i]} for r in it]
        return _finish(columns, rows)
    if name.endswith(".jsonl") or name.endswith(".ndjson"):
        rows = []
        for n, line in enumerate(_decode(raw).splitlines(), start=1):
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise DatasetError(f"{n}번째 줄 JSON 오류: {exc.msg}") from exc
            if not isinstance(obj, dict):
                raise DatasetError(f"{n}번째 줄이 객체가 아닙니다.")
            rows.append(obj)
        return _finish(_columns_of(rows), rows)
    if name.endswith(".json"):
        try:
            data = json.loads(_decode(raw))
        except json.JSONDecodeError as exc:
            raise DatasetError(f"JSON 오류: {exc.msg}") from exc
        if not isinstance(data, list) or not all(isinstance(r, dict) for r in data):
            raise DatasetError("JSON 은 객체 배열이어야 합니다.")
        return _finish(_columns_of(data), data)
    raise DatasetError("지원 형식: CSV, TSV, XLSX, JSONL, JSON")


def _columns_of(rows: list[dict[str, Any]]) -> list[str]:
    cols: list[str] = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    return cols


def coerce(value: Any, kind: str) -> Any:
    """데이터셋 셀 값 → 입력 필드 타입."""
    if value is None or value == "":
        return [] if kind == "list" else None
    if kind == "list":
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
        text = str(value).strip()
        if text.startswith("["):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return [str(v).strip() for v in parsed if str(v).strip()]
            except json.JSONDecodeError:
                pass
        sep = r"[|,;\n]" if re.search(r"[|,;\n]", text) else r"\s+"
        return [p.strip() for p in re.split(sep, text) if p.strip()]
    if kind == "int":
        try:
            return int(float(value))
        except (TypeError, ValueError) as exc:
            raise DatasetError(f"정수가 아닌 값: {value}") from exc
    return str(value).strip()


def template_csv(input_fields: list[dict[str, Any]]) -> str:
    from app.dataset_link import dataset_columns_for

    header, mapping = dataset_columns_for(input_fields)
    sample = {"케이스": "C001", "분류": "분류 예시", "기대 정답": "(선택) 기대 정답 힌트"}
    for f in input_fields:
        sample[mapping["fields"][f["key"]]] = {"list": "값1 값2", "int": str(f.get("default") or 1)}.get(
            f.get("type", "text"), (f.get("help") or "").replace("예: ", "") or str(f.get("default") or "예시 값")
        )
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=header)
    writer.writeheader()
    writer.writerow(sample)
    return "﻿" + buf.getvalue()


def auto_mapping(columns: list[str], input_fields: list[dict[str, Any]]) -> dict[str, Any]:
    """하위 호환: 실제 규칙은 app/dataset_link.py"""
    from app.dataset_link import auto_mapping as _auto

    return _auto(columns, input_fields)
