"""공급자별 어댑터 — 공식 SDK 를 얇게 감싼다."""

from __future__ import annotations

import json
from typing import Any

from app.errors import explain
from app.judges.base import (
    JudgeClient,
    JudgeConfig,
    JudgeError,
    JudgeResult,
    RetryableError,
    Usage,
    extract_json,
    strict_schema,
)

_RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 529}


def _status_of(exc: Exception) -> int | None:
    for attr in ("status_code", "code", "status"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def _raise_mapped(exc: Exception) -> None:
    status = _status_of(exc)
    if status in _RETRY_STATUS:
        raise RetryableError(f"{status} {exc}") from exc
    name = type(exc).__name__
    if "Timeout" in name or "Connection" in name:
        raise RetryableError(f"{name}: {exc}") from exc
    if status in (401, 403):
        raise JudgeError(f"인증 실패({status}): 키·권한을 확인하세요. {exc}") from exc
    if status == 404:
        raise JudgeError(f"모델 또는 주소를 찾을 수 없습니다(404): {exc}") from exc
    raise JudgeError(explain(f"{name}: {exc}")) from exc


# ── Google (Vertex AI / Gemini API) ─────────────────────────────


class GoogleJudge(JudgeClient):
    def __init__(self, config: JudgeConfig) -> None:
        super().__init__(config)
        from google import genai
        from google.genai import types

        self._types = types
        if config.provider == "vertex":
            credentials = None
            if config.secret.strip().startswith("{"):
                from google.oauth2 import service_account

                info = json.loads(config.secret)
                credentials = service_account.Credentials.from_service_account_info(
                    info, scopes=["https://www.googleapis.com/auth/cloud-platform"]
                )
                project = config.project or info.get("project_id", "")
            else:
                project = config.project
            if not project:
                raise JudgeError("Vertex AI 프로젝트 ID 가 필요합니다.")
            self._client = genai.Client(
                vertexai=True,
                project=project,
                location=config.location or "global",
                credentials=credentials,
            )
        else:
            if not config.secret:
                raise JudgeError("Gemini API 키가 필요합니다.")
            self._client = genai.Client(api_key=config.secret)

    async def _call(self, system: str, prompt: str, schema: dict[str, Any], name: str) -> JudgeResult:
        types = self._types
        cfg: dict[str, Any] = {
            "system_instruction": system,
            "response_mime_type": "application/json",
            "response_json_schema": schema,
            "max_output_tokens": self.config.max_tokens,
        }
        if self.config.temperature is not None:
            cfg["temperature"] = self.config.temperature
        try:
            resp = await self._client.aio.models.generate_content(
                model=self.config.model,
                contents=prompt,
                config=types.GenerateContentConfig(**cfg),
            )
        except Exception as exc:  # noqa: BLE001
            _raise_mapped(exc)
        meta = getattr(resp, "usage_metadata", None)
        usage = Usage(
            input_tokens=int(getattr(meta, "prompt_token_count", 0) or 0),
            output_tokens=int(getattr(meta, "candidates_token_count", 0) or 0),
        )
        text = resp.text or ""
        return JudgeResult(extract_json(text), usage, text)


# ── Anthropic Claude ─────────────────────────────────────────────


class AnthropicJudge(JudgeClient):
    def __init__(self, config: JudgeConfig) -> None:
        super().__init__(config)
        import anthropic

        if not config.secret:
            raise JudgeError("Anthropic API 키가 필요합니다.")
        self._anthropic = anthropic
        self._client = anthropic.AsyncAnthropic(
            api_key=config.secret, base_url=config.base_url or None, max_retries=0
        )
        # 구조화 출력(output_config)을 지원하지 않는 모델이면 도구 강제 호출로 전환한다.
        self._use_tool = False

    async def _call(self, system: str, prompt: str, schema: dict[str, Any], name: str) -> JudgeResult:
        base: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }
        try:
            if not self._use_tool:
                try:
                    resp = await self._client.messages.create(
                        **base,
                        output_config={"format": {"type": "json_schema", "schema": strict_schema(schema)}},
                    )
                    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
                    return JudgeResult(extract_json(text), self._usage(resp), text)
                except self._anthropic.BadRequestError as exc:
                    if "output_config" not in str(exc) and "format" not in str(exc):
                        raise
                    self._use_tool = True
            resp = await self._client.messages.create(
                **base,
                tools=[{"name": name, "description": "평가 결과를 제출한다.", "input_schema": schema}],
                tool_choice={"type": "tool", "name": name},
            )
        except JudgeError:
            raise
        except Exception as exc:  # noqa: BLE001
            _raise_mapped(exc)
        for block in resp.content:
            if getattr(block, "type", "") == "tool_use":
                return JudgeResult(dict(block.input), self._usage(resp), json.dumps(block.input, ensure_ascii=False))
        raise ValueError("도구 호출 결과가 없습니다.")

    @staticmethod
    def _usage(resp: Any) -> Usage:
        u = getattr(resp, "usage", None)
        return Usage(int(getattr(u, "input_tokens", 0) or 0), int(getattr(u, "output_tokens", 0) or 0))


# ── OpenAI / OpenAI 호환 ─────────────────────────────────────────


class OpenAIJudge(JudgeClient):
    def __init__(self, config: JudgeConfig) -> None:
        super().__init__(config)
        import openai

        if config.provider == "openai" and not config.secret:
            raise JudgeError("OpenAI API 키가 필요합니다.")
        if config.provider == "openai_compatible" and not config.base_url:
            raise JudgeError("OpenAI 호환 서버 주소(base_url)가 필요합니다.")
        self._openai = openai
        self._client = openai.AsyncOpenAI(
            api_key=config.secret or "not-needed",
            base_url=config.base_url or None,
            max_retries=0,
        )
        # 서버가 json_schema 를 거부하면 json_object → 지시문만 순서로 낮춘다.
        self._mode = "json_schema"
        self._send_temperature = config.temperature is not None

    async def _call(self, system: str, prompt: str, schema: dict[str, Any], name: str) -> JudgeResult:
        user = prompt
        if self._mode != "json_schema":
            user = f"{prompt}\n\n다음 JSON 스키마를 따르는 JSON 객체 하나만 출력하세요.\n{json.dumps(schema, ensure_ascii=False)}"
        kwargs: dict[str, Any] = {
            "model": self.config.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_completion_tokens": self.config.max_tokens,
        }
        if self._send_temperature:
            kwargs["temperature"] = self.config.temperature
        if self._mode == "json_schema":
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": name, "schema": strict_schema(schema), "strict": True},
            }
        elif self._mode == "json_object":
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = await self._client.chat.completions.create(**kwargs)
        except self._openai.BadRequestError as exc:
            message = str(exc).lower()
            if "temperature" in message and self._send_temperature:
                self._send_temperature = False
                raise RetryableError("temperature 미지원 → 제외 후 재시도") from exc
            if "max_completion_tokens" in message:
                raise JudgeError(f"이 서버는 max_completion_tokens 를 지원하지 않습니다: {exc}") from exc
            if "response_format" in message or "json_schema" in message or "schema" in message:
                self._mode = "json_object" if self._mode == "json_schema" else "none"
                raise RetryableError(f"구조화 출력 미지원 → {self._mode} 로 재시도") from exc
            _raise_mapped(exc)
        except Exception as exc:  # noqa: BLE001
            _raise_mapped(exc)
        text = (resp.choices[0].message.content or "") if resp.choices else ""
        u = getattr(resp, "usage", None)
        usage = Usage(int(getattr(u, "prompt_tokens", 0) or 0), int(getattr(u, "completion_tokens", 0) or 0))
        return JudgeResult(extract_json(text), usage, text)


def build_client(config: JudgeConfig) -> JudgeClient:
    if config.provider in ("vertex", "gemini"):
        return GoogleJudge(config)
    if config.provider == "anthropic":
        return AnthropicJudge(config)
    if config.provider in ("openai", "openai_compatible"):
        return OpenAIJudge(config)
    raise JudgeError(f"지원하지 않는 공급자입니다: {config.provider}")
