"""판정 모델 공통 인터페이스.

모든 공급자는 `complete_json(system, prompt, schema)` 하나로 같은 형태의 JSON 과 토큰 사용량을 돌려준다.
구조화 출력이 실패하면 응답 본문에서 JSON 을 추출해 검증하고, 그래도 안 되면 재시도한다.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from app.errors import explain

PROVIDERS: dict[str, dict[str, Any]] = {
    "vertex": {
        "label": "Google Vertex AI (Gemini)",
        "needs": ["model", "project", "location", "secret"],
        "secret_label": "서비스 계정 JSON",
        "secret_optional": True,
        "model_placeholder": "gemini-3.1-flash-lite",
        "help": "서비스 계정 JSON 을 붙여넣거나 업로드합니다. 비우면 GOOGLE_APPLICATION_CREDENTIALS(파일 경로)를 사용합니다.",
    },
    "gemini": {
        "label": "Google Gemini API",
        "needs": ["model", "secret"],
        "secret_label": "API 키",
        "secret_optional": True,
        "model_placeholder": "gemini-3.1-flash-lite",
        "help": "Google AI Studio API 키. 비우면 GEMINI_API_KEY 환경 변수를 사용합니다.",
    },
    "anthropic": {
        "label": "Anthropic Claude",
        "needs": ["model", "secret"],
        "secret_label": "API 키",
        "secret_optional": True,
        "model_placeholder": "claude-sonnet-5-5",
        "help": "Anthropic API 키. 비우면 ANTHROPIC_API_KEY 환경 변수를 사용합니다.",
    },
    "openai": {
        "label": "OpenAI",
        "needs": ["model", "secret"],
        "secret_label": "API 키",
        "secret_optional": True,
        "model_placeholder": "모델 ID (예: OpenAI 콘솔의 모델 이름)",
        "help": "OpenAI API 키. 비우면 OPENAI_API_KEY 환경 변수를 사용합니다.",
    },
    "openai_compatible": {
        "label": "OpenAI 호환 (로컬·사내 모델)",
        "needs": ["model", "base_url", "secret"],
        "secret_label": "API 키 (선택)",
        "secret_optional": True,
        "model_placeholder": "예: llama3.1:8b",
        "help": "Ollama(http://localhost:11434/v1), vLLM, LM Studio, 사내 게이트웨이 등 /v1/chat/completions 를 제공하는 서버.",
    },
}


class JudgeError(Exception):
    """판정 호출 실패(재시도 후에도). message 는 화면에 그대로 보여 준다."""


class RetryableError(Exception):
    pass


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens


@dataclass
class JudgeConfig:
    provider: str
    model: str
    base_url: str = ""
    project: str = ""
    location: str = ""
    secret: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    timeout: float = 120.0
    max_retries: int = 3

    @property
    def temperature(self) -> float | None:
        value = self.params.get("temperature", 0)
        return None if value in (None, "") else float(value)

    @property
    def max_tokens(self) -> int:
        return int(self.params.get("max_tokens") or 4096)


@dataclass
class JudgeResult:
    data: dict[str, Any]
    usage: Usage
    raw_text: str = ""


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def extract_json(text: str) -> dict[str, Any]:
    """코드 펜스·설명문이 섞인 응답에서 JSON 객체를 꺼낸다."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = _JSON_BLOCK.search(text)
        if not match:
            raise ValueError("응답에서 JSON 을 찾을 수 없습니다.") from None
        value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise ValueError("응답 JSON 이 객체가 아닙니다.")
    return value


def validate(data: dict[str, Any], schema: dict[str, Any]) -> None:
    """필수 필드 존재·기본 타입만 가볍게 검사한다(외부 의존성 없이)."""
    for key in schema.get("required", []):
        if key not in data:
            raise ValueError(f"응답에 '{key}' 필드가 없습니다.")
    for key, spec in schema.get("properties", {}).items():
        if key not in data:
            continue
        kind = spec.get("type")
        value = data[key]
        ok = {
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
            "array": isinstance(value, list),
            "object": isinstance(value, dict),
        }.get(kind, True)
        if not ok:
            raise ValueError(f"'{key}' 필드 타입이 {kind} 가 아닙니다.")
        if kind == "string" and "enum" in spec and value not in spec["enum"]:
            raise ValueError(f"'{key}' 값 '{value}' 은 허용되지 않습니다.")
        if kind == "array" and isinstance(spec.get("items"), dict) and spec["items"].get("type") == "object":
            for item in value:
                if not isinstance(item, dict):
                    raise ValueError(f"'{key}' 항목이 객체가 아닙니다.")
                validate(item, spec["items"])


class JudgeClient(ABC):
    def __init__(self, config: JudgeConfig) -> None:
        self.config = config

    @abstractmethod
    async def _call(self, system: str, prompt: str, schema: dict[str, Any], name: str) -> JudgeResult:
        """공급자 호출 1회. 일시 오류는 RetryableError 로 올린다."""

    async def complete_json(
        self, system: str, prompt: str, schema: dict[str, Any], *, name: str = "judgement"
    ) -> JudgeResult:
        attempts = max(1, self.config.max_retries)
        usage = Usage()
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                result = await asyncio.wait_for(
                    self._call(system, prompt, schema, name), timeout=self.config.timeout
                )
                usage.add(result.usage)
                validate(result.data, schema)
                result.usage = usage
                return result
            except (RetryableError, TimeoutError, ValueError) as exc:
                last = exc
                if attempt + 1 < attempts:
                    await asyncio.sleep(min(20.0, (2**attempt) + random.random()))
            except JudgeError:
                raise
            except Exception as exc:  # noqa: BLE001 — SDK 별 예외를 화면용 메시지로 정리
                raise JudgeError(explain(f"{type(exc).__name__}: {exc}")) from exc
        raise JudgeError(explain(f"{type(last).__name__}: {last}", prefix=f"{attempts}번 시도했지만 실패했습니다. "))


def strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """OpenAI strict / Anthropic 구조화 출력용: 모든 객체에 additionalProperties=false."""
    out = dict(schema)
    if out.get("type") == "object":
        out["additionalProperties"] = False
        out["properties"] = {k: strict_schema(v) for k, v in out.get("properties", {}).items()}
    if out.get("type") == "array" and isinstance(out.get("items"), dict):
        out["items"] = strict_schema(out["items"])
    return out
