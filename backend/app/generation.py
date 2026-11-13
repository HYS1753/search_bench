"""LLM 으로 테스트 데이터 만들기.

기본(설명으로 만들기): 서비스 설명·분류·표현 방식 비율을 주면 비교 세트의 입력 형식 그대로 질의를 만든다.
선택(실제 검색 결과 참고, grounded): 정확도를 높이는 옵션.
  1) 탐색 질의를 몇 개 만들어 모든 API 를 실제로 불러 결과 항목을 모은다(한 API 에 치우치지 않게 번갈아 뽑음).
  2) 실제 항목을 보여 주고 '이 항목이 답인 질의'를 쓰게 한다(문서 단어를 그대로 베끼지 않게 지시) → 답이 있는 질의, 정답 힌트.
  3) 만든 질의로 모든 API 를 다시 불러, 원본 항목이 어느 API 상위 결과에 나오는지·결과가 0건인지 확인한다.

공통 품질 장치: 입력 형식(JSON 스키마) 강제, 형식·필수값 검사, 개인정보 패턴 제거, 중복·유사 중복 제거,
이미 만든 질의를 '피할 목록'으로 넘겨 다양성 확보, 분류·표현 방식 할당량.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from types import SimpleNamespace
from typing import Any

from app.api.common import target_snapshot
from app.datasets_io import DatasetError, coerce
from app.db import session_scope
from app.judges import JudgeClient, JudgeError, build_client, config_for
from app.models import GenerationJob, JudgeModel, Suite, Target, utcnow
from app.validation import field_label

log = logging.getLogger("judge.generation")

STYLES: dict[str, str] = {
    "keyword": "키워드형 — 핵심 단어 2~4개만 (예: '학자금 신청 담당')",
    "natural": "자연어 질문 — 사람이 묻듯 완전한 문장 (예: '학자금 신청은 누구에게 문의하나요?')",
    "multi": "조건 여러 개 — 지역·기간·대상 등 조건을 2개 이상 포함",
    "typo": "오타·줄임말·구어체 — 실제 사용자가 대충 치는 형태",
    "ambiguous": "모호한 질의 — 의도가 여러 갈래로 해석될 수 있는 짧은 질의",
}
BATCH = 10
PII = [re.compile(p) for p in (r"\d{6}-?[1-4]\d{6}", r"01[016789]-?\d{3,4}-?\d{4}", r"[\w.+-]+@[\w-]+\.[\w.]+")]


# ── 클라이언트(테스트에서 바꿔 끼움) ─────────────────────────────


def make_client(model: JudgeModel) -> JudgeClient:
    """생성은 다양성이 필요하므로 판정 모델 설정에서 temperature 만 높여 쓴다."""
    cfg = config_for(model)
    cfg.params = {**cfg.params, "temperature": 0.9}
    return build_client(cfg)


# ── 프롬프트 ───────────────────────────────────────────────


SYSTEM = (
    "당신은 검색 서비스의 품질 평가용 테스트 질의를 설계하는 전문가입니다. 실제 사용자가 입력할 법한 현실적이고 다양한 질의를 "
    "지정된 JSON 형식으로만 만듭니다. 개인정보(주민번호·전화번호·이메일)는 절대 넣지 않습니다."
)


def input_spec(fields: list[dict[str, Any]]) -> str:
    lines = []
    for f in fields:
        kind = {"list": "여러 값(문자열 배열)", "int": "정수"}.get(f.get("type", "text"), "문자열")
        scope = f"  ※ {f['scope']} API 에만 보내는 값" if f.get("scope") else ""
        req = "필수" if f.get("required") else "선택(필요할 때만)"
        ex = f" · {f['help']}" if f.get("help") else ""
        lines.append(f"- {f['key']}: {field_label(f)} — {kind}, {req}{ex}{scope}")
    return "\n".join(lines)


def case_schema(fields: list[dict[str, Any]], grounded: bool) -> dict[str, Any]:
    props: dict[str, Any] = {}
    for f in fields:
        t = f.get("type", "text")
        props[f["key"]] = {"type": "array", "items": {"type": "string"}} if t == "list" else {"type": "integer" if t == "int" else "string"}
    case = {
        "type": "object",
        "properties": {
            "slot": {"type": "integer"},
            "category": {"type": "string"},
            "style": {"type": "string"},
            "inputs": {"type": "object", "properties": props, "required": [f["key"] for f in fields if f.get("required")]},
            "expected": {"type": "string"},
            **({"source": {"type": "string"}} if grounded else {}),
        },
        "required": ["slot", "category", "style", "inputs", "expected"],
    }
    return {"type": "object", "properties": {"cases": {"type": "array", "items": case}}, "required": ["cases"]}


def slots_for(n: int, start: int, categories: list[str], styles: dict[str, int]) -> list[dict[str, Any]]:
    """분류·표현 방식 할당량을 정확히 맞추도록 칸을 미리 나눈다."""
    weights = {k: v for k, v in styles.items() if v > 0} or {"natural": 1}
    total_w = sum(weights.values())
    seq: list[str] = []
    for k, w in weights.items():
        seq += [k] * max(1, round(w / total_w * 100))
    out = []
    for i in range(n):
        g = start + i
        out.append({"slot": i + 1, "category": categories[g % len(categories)] if categories else "",
                    "style": seq[(g * 37) % len(seq)]})
    return out


def batch_prompt(p: dict[str, Any], fields: list[dict[str, Any]], slots: list[dict[str, Any]], avoid: list[str],
                 sources: list[dict[str, Any]] | None = None) -> str:
    slot_lines = "\n".join(
        f"{s['slot']}. 분류: {s['category'] or '(자유)'} · 표현: {STYLES.get(s['style'], s['style'])}"
        + (f" · 원본: [S{s['source']}]" if sources is not None else "")
        for s in slots
    )
    src_block = ""
    if sources is not None:
        items = []
        for i, it in enumerate(sources, start=1):
            fields_txt = " / ".join(f"{x['label']}: {x['value']}" for x in it["item"].get("fields", [])[:6])
            items.append(f"[S{i}] {it['item'].get('title', '')}{' — ' + fields_txt if fields_txt else ''}")
        src_block = (
            "\n# 실제 검색 결과 항목\n" + "\n".join(items) + "\n\n"
            "각 칸의 원본 항목이 **정답이 되는** 질의를 만든다. 원본 항목의 문구를 그대로 베끼지 말고, 그 항목을 찾는 사용자가 "
            "실제로 쓸 말로 바꿔 쓴다(동의어·상위 개념·상황 설명). source 에는 원본 번호(예: S3)를, expected 에는 정답이 왜 그 항목인지 한 문장으로 쓴다.\n"
        )
    avoid_block = ("\n# 이미 만든 질의(겹치지 않게)\n" + "\n".join(f"- {a}" for a in avoid[-60:]) + "\n") if avoid else ""
    return f"""# 과제
아래 검색 서비스를 평가할 테스트 케이스 {len(slots)}개를 만든다. 칸마다 지정된 분류·표현 방식을 지킨다.

# 서비스 설명
{p.get('description') or '(설명 없음 — 입력 항목 이름으로 짐작해 일반적인 사용자 질의를 만든다)'}

# 입력 항목 (inputs 의 key 는 아래 key 를 그대로 쓴다)
{input_spec(fields)}
- 'API 에만 보내는 값'은 그 API 가 쓰는 조건이다. 필수면 반드시 채우고, 선택이면 자연스러울 때만 채운다.
- 여러 값 항목은 배열로, 정수 항목은 숫자로 쓴다.
{src_block}{avoid_block}
# 만들 칸
{slot_lines}

# 원칙
- 실제 사용자가 쓸 법한 한국어로, 칸마다 서로 다른 의도를 갖게 한다.
- 개인정보(주민번호·전화번호·이메일·실명 나열)는 넣지 않는다.
- expected 에는 '좋은 검색 결과라면 무엇이 나와야 하는지'를 한 문장으로 쓴다(판정 모델의 참고 힌트).

# 출력
cases 배열에 칸마다 하나씩: slot(칸 번호), category, style(칸의 표현 key: {', '.join(STYLES)}), inputs, expected{', source' if sources is not None else ''}.
"""


# ── 검사·정리 ──────────────────────────────────────────────


def main_text_key(fields: list[dict[str, Any]]) -> str | None:
    f = next((f for f in fields if f.get("type", "text") == "text" and not f.get("scope")), None) or next(
        (f for f in fields if f.get("type", "text") == "text"), None)
    return f["key"] if f else None


def text_of(inputs: dict[str, Any], key: str | None) -> str:
    v = inputs.get(key) if key else None
    if v is None:
        v = " ".join(str(x) for x in inputs.values() if x not in (None, "", []))
    return " ".join(v) if isinstance(v, list) else str(v)


def _grams(s: str) -> set[str]:
    t = re.sub(r"\s+", "", s.lower())
    return {t[i:i + 3] for i in range(max(1, len(t) - 2))}


def near_dup(a: str, b: str) -> bool:
    ga, gb = _grams(a), _grams(b)
    return bool(ga and gb) and len(ga & gb) / len(ga | gb) >= 0.75


def clean_case(raw: dict[str, Any], fields: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str]:
    inputs_raw = raw.get("inputs") or {}
    inputs: dict[str, Any] = {}
    for f in fields:
        try:
            v = coerce(inputs_raw.get(f["key"]), f.get("type", "text"))
        except DatasetError:
            return None, "invalid"
        if f.get("required") and v in (None, "", []):
            return None, "invalid"
        inputs[f["key"]] = v if v is not None else ""
    blob = json.dumps(inputs, ensure_ascii=False) + str(raw.get("expected", ""))
    if any(p.search(blob) for p in PII):
        return None, "pii"
    style = raw.get("style") if raw.get("style") in STYLES else "natural"
    return {"category": str(raw.get("category") or "").strip(), "style": style, "inputs": inputs,
            "expected": str(raw.get("expected") or "").strip(), "source_ref": str(raw.get("source") or "")}, ""


# ── 작업 실행 ──────────────────────────────────────────────


class GenerationManager:
    def __init__(self) -> None:
        self._tasks: dict[int, asyncio.Task[None]] = {}

    def start(self, job_id: int) -> None:
        task = asyncio.create_task(self._run(job_id), name=f"gen-{job_id}")
        self._tasks[job_id] = task
        task.add_done_callback(lambda _t: self._tasks.pop(job_id, None))

    def is_running(self, job_id: int) -> bool:
        t = self._tasks.get(job_id)
        return t is not None and not t.done()

    async def cancel(self, job_id: int) -> None:
        t = self._tasks.get(job_id)
        if t and not t.done():
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t

    async def shutdown(self) -> None:
        for jid in list(self._tasks):
            await self.cancel(jid)

    @staticmethod
    def _update(job_id: int, **kw: Any) -> None:
        with session_scope() as s:
            job = s.get(GenerationJob, job_id)
            if job:
                for k, v in kw.items():
                    setattr(job, k, v)

    async def _run(self, job_id: int) -> None:
        with session_scope() as s:
            job = s.get(GenerationJob, job_id)
            suite = s.get(Suite, job.suite_id) if job and job.suite_id else None
            model = s.get(JudgeModel, job.judge_model_id) if job and job.judge_model_id else None
            if not job or not suite or not model:
                if job:
                    job.status, job.error = "failed", "비교 세트나 생성 모델이 삭제되었습니다."
                return
            p = dict(job.params)
            fields = list(suite.input_fields or [])
            price = (model.price_input_per_mtok, model.price_output_per_mtok)
            specs = []
            for m in suite.members:
                t = target_snapshot(m.target)
                live = s.get(Target, m.target_id)
                specs.append({"label": m.label, "is_baseline": m.is_baseline,
                              "target": SimpleNamespace(**t, secret_enc=live.secret_enc if live else ""),
                              "input_bindings": m.input_bindings or {}, "match": m.match or {}})
            match_mode = suite.match_mode or "id"
            try:
                client = make_client(model)
            except Exception as exc:  # noqa: BLE001
                job.status, job.error = "failed", f"생성 모델 준비 실패: {exc}"
                return
            job.status, job.stage = "running", "준비"

        usage = {"in": 0, "out": 0, "calls": 0}
        stats = {"dropped_duplicate": 0, "dropped_invalid": 0, "dropped_pii": 0}

        def cost() -> float:
            return (usage["in"] * price[0] + usage["out"] * price[1]) / 1_000_000

        async def ask(prompt: str, schema: dict[str, Any]) -> list[dict[str, Any]]:
            res = await client.complete_json(SYSTEM, prompt, schema, name="generate_cases")
            usage["in"] += res.usage.input_tokens
            usage["out"] += res.usage.output_tokens
            usage["calls"] += 1
            return list(res.data.get("cases") or [])

        count = int(p.get("count") or 20)
        grounded = bool(p.get("grounded"))
        categories = [c for c in (p.get("categories") or []) if c.strip()]
        styles = {k: int(v) for k, v in (p.get("styles") or {"natural": 3, "keyword": 2}).items() if k in STYLES}
        key = main_text_key(fields)
        rows: list[dict[str, Any]] = []
        texts: list[str] = []

        def accept(cases: list[dict[str, Any]], sources: list[dict[str, Any]] | None = None) -> None:
            for raw in cases:
                if len(rows) >= count:
                    break
                c, why = clean_case(raw, fields)
                if c is None:
                    stats["dropped_pii" if why == "pii" else "dropped_invalid"] += 1
                    continue
                t = text_of(c["inputs"], key)
                if not t.strip() or any(t == x or near_dup(t, x) for x in texts):
                    stats["dropped_duplicate"] += 1
                    continue
                if sources is not None:
                    m = re.search(r"(\d+)", c.pop("source_ref", ""))
                    src = sources[int(m.group(1)) - 1] if m and 0 < int(m.group(1)) <= len(sources) else None
                    c["source"] = {"api": src["api"], "key": src["item"]["key"], "title": src["item"].get("title", "")} if src else None
                else:
                    c.pop("source_ref", None)
                c["id"] = len(rows) + 1
                rows.append(c)
                texts.append(t)

        try:
            sources: list[dict[str, Any]] | None = None
            total_steps = count + (count if grounded else 0)
            self._update(job_id, total=total_steps)
            if grounded:
                from app.api import data_api  # http_client 를 테스트에서 바꿔 끼울 수 있게 모듈 경유

                # 1) 탐색 질의 → 실제 검색으로 항목 모으기
                self._update(job_id, stage="실제 검색 결과 모으는 중")
                n_seed = min(12, max(4, count // 4))
                seeds = await ask(batch_prompt(p, fields, slots_for(n_seed, 0, categories, {"keyword": 1, "natural": 1}), []),
                                  case_schema(fields, False))
                pools: dict[str, list[dict[str, Any]]] = {sp["label"]: [] for sp in specs}
                seen: set[str] = set()
                for raw in seeds:
                    c, _ = clean_case(raw, fields)
                    if not c:
                        continue
                    sides = await data_api.call_members(specs, c["inputs"], match_mode)
                    for sd in sides:
                        for it in sd["items"][:5]:
                            k = it.get("key") or it.get("title")
                            if k and k not in seen:
                                seen.add(k)
                                pools[sd["label"]].append({"api": sd["label"], "item": it})
                # 한 API 에 치우치지 않게 번갈아 뽑는다
                sources = []
                while any(pools.values()) and len(sources) < count * 2:
                    for lab in list(pools):
                        if pools[lab]:
                            sources.append(pools[lab].pop(0))
                stats["source_items"] = len(sources)
                stats["source_by_api"] = {lab: sum(1 for x in sources if x["api"] == lab) for lab in pools}
                if not sources:
                    stats["grounded_fallback"] = True
                    sources = None

            # 2) 질의 만들기
            self._update(job_id, stage="질의 만드는 중", progress=0)
            attempts = 0
            src_i = 0
            while len(rows) < count and attempts < (count // BATCH + 4):
                attempts += 1
                need = min(BATCH, count - len(rows))
                slots = slots_for(need, len(rows), categories, styles)
                batch_sources = None
                if sources:
                    batch_sources = [sources[(src_i + i) % len(sources)] for i in range(need)]
                    src_i += need
                    for i, sl in enumerate(slots):
                        sl["source"] = i + 1
                cases = await ask(batch_prompt(p, fields, slots, texts, batch_sources), case_schema(fields, batch_sources is not None))
                accept(cases, batch_sources)
                self._update(job_id, progress=len(rows), rows=list(rows), tokens_input=usage["in"], tokens_output=usage["out"],
                             judge_calls=usage["calls"], cost_estimate=cost(), stats=dict(stats))

            # 3) 답이 있는지 확인(실제 검색 결과 참고일 때)
            if grounded and sources:
                from app.api import data_api

                self._update(job_id, stage="답이 있는지 확인하는 중")
                sem = asyncio.Semaphore(4)
                k = int(p.get("check_k") or 5)

                async def check(r: dict[str, Any]) -> None:
                    async with sem:
                        sides = await data_api.call_members(specs, r["inputs"], match_mode)
                    src = r.get("source") or {}
                    norm = lambda x: re.sub(r"\s+", "", str(x or "")).lower()  # noqa: E731
                    found = [sd["label"] for sd in sides if sd["ok"] and any(
                        (src.get("key") and it.get("key") == src.get("key")) or (src.get("title") and norm(it.get("title")) == norm(src.get("title")))
                        for it in sd["items"][:k])]
                    r["check"] = {"found_in": found, "empty": all(sd["ok"] and not sd["items"] for sd in sides),
                                  "failed": [sd["label"] for sd in sides if not sd["ok"]]}

                done = 0
                for chunk in [rows[i:i + 8] for i in range(0, len(rows), 8)]:
                    await asyncio.gather(*(check(r) for r in chunk))
                    done += len(chunk)
                    self._update(job_id, progress=count + done, rows=list(rows))
                stats["answer_found"] = sum(1 for r in rows if r.get("check", {}).get("found_in"))
                stats["all_empty"] = sum(1 for r in rows if r.get("check", {}).get("empty"))
            stats["generated"] = len(rows)
            with contextlib.suppress(Exception):
                from app.notify import dispatch

                await dispatch(["generation_done"], {"name": p.get("description", "")[:40] or "테스트 데이터", "count": len(rows), "url": None})
            self._update(job_id, status="done", stage="완료", rows=rows, stats=stats, progress=total_steps,
                         tokens_input=usage["in"], tokens_output=usage["out"], judge_calls=usage["calls"],
                         cost_estimate=cost(), finished_at=utcnow(),
                         error="" if rows else "질의를 만들지 못했습니다. 서비스 설명을 구체적으로 적거나 다른 모델을 써 보세요.")
        except asyncio.CancelledError:
            self._update(job_id, status="cancelled", stage="취소됨", rows=rows, stats=stats, finished_at=utcnow(),
                         tokens_input=usage["in"], tokens_output=usage["out"], judge_calls=usage["calls"], cost_estimate=cost())
            raise
        except JudgeError as exc:
            self._update(job_id, status="failed", error=f"생성 모델 호출 실패: {exc}", rows=rows, stats=stats, finished_at=utcnow(),
                         tokens_input=usage["in"], tokens_output=usage["out"], judge_calls=usage["calls"], cost_estimate=cost())
        except Exception as exc:  # noqa: BLE001
            log.exception("generation %s failed", job_id)
            self._update(job_id, status="failed", error=f"{type(exc).__name__}: {exc}", rows=rows, stats=stats, finished_at=utcnow())


manager = GenerationManager()
