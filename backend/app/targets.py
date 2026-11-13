"""비교 대상 API 호출과 응답 정규화.

경로 문법(응답 매핑):
  results            최상위 키
  data.items         중첩 키
  assignments[].org  배열의 모든 원소에서 값을 모은다
  items[0].name      특정 인덱스
  $ 또는 빈 값        응답 전체(최상위가 배열일 때)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.errors import explain
from app.config import get_settings
from app.matching import json_typed, set_path
from app.security import decrypt

_TOKEN = re.compile(r"([^.\[\]]+)|\[(\d*)\]")
MAX_RAW_BYTES = 300_000
MAX_FIELD_CHARS = 1500


def get_values(obj: Any, path: str) -> list[Any]:
    """경로에 해당하는 값 목록(없으면 빈 목록)."""
    path = (path or "").strip()
    if path in ("", "$"):
        return [obj]
    current = [obj]
    for name, index in _TOKEN.findall(path):
        nxt: list[Any] = []
        for value in current:
            if name:
                if isinstance(value, dict) and name in value:
                    nxt.append(value[name])
            elif index == "":
                if isinstance(value, list):
                    nxt.extend(value)
            elif isinstance(value, list) and int(index) < len(value):
                nxt.append(value[int(index)])
        current = nxt
    return current


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(t for t in (_text(v) for v in value) if t)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def _join(values: list[Any]) -> str:
    parts: list[str] = []
    for v in values:
        t = _text(v)
        if t and t not in parts:
            parts.append(t)
    out = " / ".join(parts)
    return out if len(out) <= MAX_FIELD_CHARS else out[: MAX_FIELD_CHARS - 1] + "…"


def normalize_items(body: Any, mapping: dict[str, Any], limit: int | None = None) -> list[dict[str, Any]]:
    """응답 본문 → [{key, title, fields:[{label,value}], score}] (판정·화면 공용)."""
    results_path = mapping.get("results_path", "results")
    found = get_values(body, results_path)
    rows: list[Any] = []
    for value in found:
        if isinstance(value, list):
            rows.extend(value)
        else:
            rows.append(value)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows[: limit or None]:
        title = _join(get_values(row, mapping.get("title_path", "")) if mapping.get("title_path") else [])
        fields = []
        for spec in mapping.get("text_fields", []) or []:
            value = _join(get_values(row, spec.get("path", "")))
            if value:
                fields.append({"label": spec.get("label") or spec.get("path"), "value": value})
        key = _join(get_values(row, mapping["id_path"])) if mapping.get("id_path") else ""
        if not key:
            digest = hashlib.sha1(
                json.dumps([title, fields], ensure_ascii=False, sort_keys=True).encode()
            ).hexdigest()[:12]
            key = f"h:{digest}"
        if key in seen:  # 같은 응답 안 중복 항목은 첫 순위만 남긴다
            continue
        seen.add(key)
        score_values = get_values(row, mapping["score_path"]) if mapping.get("score_path") else []
        score = score_values[0] if score_values and isinstance(score_values[0], (int, float)) else None
        items.append({"key": key, "title": title or key, "fields": fields, "score": score})
    return items


@dataclass
class CallResult:
    ok: bool
    status_code: int | None
    latency_ms: int
    error: str
    items: list[dict[str, Any]] = field(default_factory=list)
    raw: Any = None
    request: dict[str, Any] = field(default_factory=dict)


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [p for p in re.split(r"[\s,]+", str(value).strip()) if p]


def _encode(value: Any, style: str) -> Any:
    if isinstance(value, list) or style in ("repeat", "space", "comma", "json"):
        items = _as_list(value) if not isinstance(value, list) else [str(v) for v in value]
        if style == "space":
            return " ".join(items)
        if style == "comma":
            return ",".join(items)
        if style == "json":
            return items
        return items  # repeat
    return value


def resolve_secret(target: Any) -> str:
    env_name = (target.auth or {}).get("env", "").strip()
    if env_name and os.getenv(env_name):
        return os.getenv(env_name, "")
    return decrypt(target.secret_enc)


def build_request(target: Any, inputs: dict[str, Any]) -> dict[str, Any]:
    """대상 설정 + 입력값 → httpx 요청 인자. 비어 있는 선택 입력은 보내지 않는다."""
    query: list[tuple[str, str]] = []
    body: dict[str, Any] = {}
    path = target.path or ""
    for spec in target.params or []:
        name = spec.get("name", "").strip()
        if not name:
            continue
        if spec.get("source", "field") == "const":
            value: Any = spec.get("value", "")
        else:
            value = inputs.get(spec.get("field") or name)
        if value is None or value == "" or value == []:
            continue
        location = spec.get("location", "query")
        style = spec.get("array_style", "")
        encoded = _encode(value, style) if style else value
        if location == "path":
            path = path.replace("{" + name + "}", str(encoded))
        elif location == "body":
            # 'query.text' 처럼 경로로 적은 이름은 중첩 JSON 으로 조립한다.
            set_path(body, name, json_typed(encoded, spec.get("json_type", "")))
        elif isinstance(encoded, list):
            query.extend((name, str(v)) for v in encoded)
        else:
            query.append((name, str(encoded)))

    headers = {"Accept": "application/json", **(target.headers or {})}
    auth = target.auth or {}
    secret = resolve_secret(target) if auth.get("type", "none") != "none" else ""
    if secret:
        if auth.get("type") == "bearer":
            headers["Authorization"] = f"Bearer {secret}"
        elif auth.get("type") == "header":
            headers[auth.get("name") or "X-API-Key"] = secret
        elif auth.get("type") == "query":
            query.append((auth.get("name") or "api_key", secret))
    request: dict[str, Any] = {
        "method": (target.method or "GET").upper(),
        "url": target.base_url.rstrip("/") + ("/" + path.lstrip("/") if path else ""),
        "params": query,
        "headers": headers,
    }
    if body and request["method"] != "GET":
        request["json"] = body
    return request


def _redact(request: dict[str, Any], secret: str) -> dict[str, Any]:
    shown = json.loads(json.dumps({k: v for k, v in request.items() if k != "headers"}, default=str))
    shown["headers"] = {
        k: ("••••" if secret and secret in str(v) else v) for k, v in request.get("headers", {}).items()
    }
    if secret:
        shown["params"] = [[k, "••••" if v == secret else v] for k, v in shown.get("params", [])]
    return shown


def _error_message(body: Any, status: int) -> str:
    detail = ""
    if isinstance(body, dict):
        for key in ("detail", "message", "error", "title"):
            if body.get(key):
                value = body[key]
                detail = (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))[:500]
                break
    if not detail:
        detail = (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False))[:500]
    return explain(f"HTTP {status}: {detail}")


async def call_target(
    client: httpx.AsyncClient, target: Any, inputs: dict[str, Any], *, limit: int | None = None
) -> CallResult:
    settings = get_settings()
    try:
        request = build_request(target, inputs)
        secret = resolve_secret(target) if (target.auth or {}).get("type", "none") != "none" else ""
    except Exception as exc:  # noqa: BLE001 — 설정 오류도 결과로 돌려준다
        return CallResult(False, None, 0, f"요청 구성 실패: {exc}")
    timeout = target.timeout_seconds or settings.TARGET_TIMEOUT_SECONDS
    started = time.perf_counter()
    try:
        resp = await client.request(timeout=timeout, **request)
    except httpx.HTTPError as exc:
        return CallResult(
            False, None, round((time.perf_counter() - started) * 1000),
            explain(f"{type(exc).__name__}: {exc}"), request=_redact(request, secret),
        )
    latency = round((time.perf_counter() - started) * 1000)
    try:
        body: Any = resp.json()
    except (json.JSONDecodeError, ValueError):
        body = resp.text[:5000]
    raw = body if len(resp.content) <= MAX_RAW_BYTES else {"_truncated": True, "size": len(resp.content)}
    shown = _redact(request, secret)
    if resp.status_code >= 400:
        return CallResult(False, resp.status_code, latency, _error_message(body, resp.status_code), raw=raw, request=shown)
    try:
        items = normalize_items(body, target.response_mapping or {}, limit)
    except Exception as exc:  # noqa: BLE001
        return CallResult(False, resp.status_code, latency, f"응답 매핑 실패: {exc}", raw=raw, request=shown)
    return CallResult(True, resp.status_code, latency, "", items, raw, shown)


def http_client(verify: bool | None = None) -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(
        verify=settings.TARGET_VERIFY_SSL if verify is None else verify,
        timeout=settings.TARGET_TIMEOUT_SECONDS,
        follow_redirects=True,
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
    )
