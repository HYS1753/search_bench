"""케이스 1건 평가 — 배치와 단건 검색 비교가 같은 로직을 쓴다.

1) 모든 대상의 상위 k 항목을 key 로 모아(풀) 아직 판정하지 않은 항목만 관련도 판정
2) 대상별 지표 계산(nDCG·Hit@1·MRR·Precision)
3) 후보 × 기준 쌍마다 목록 비교를 순서를 바꿔 두 번 → 일치하면 승자, 엇갈리면 무승부
이미 판정된 항목·쌍은 다시 묻지 않는다(이어서 실행·재현성·비용 절감).
"""

from __future__ import annotations

import asyncio
import hashlib
import random
import re
from dataclasses import dataclass, field
from typing import Any

from app.evaluation import prompts
from app.evaluation.metrics import case_metrics, failed_metrics
from app.judges import JudgeClient, JudgeError, Usage

ITEM_BATCH = 12  # 기본 묶음 크기(한 번의 판정 호출에 넣는 항목 수). 1 이면 항목마다 따로 묻는다(UMBRELA 방식).
BATCH_CHOICES = (1, 4, 8, 12, 20)


@dataclass
class Criteria:
    task_context: str = ""
    user_requirements: str = ""
    k: int = 5
    relevant_threshold: int = 2
    pairwise_enabled: bool = True
    system_prompt: str = ""
    item_template: str = ""
    pairwise_template: str = ""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Criteria:
        return cls(
            task_context=d.get("task_context", ""),
            user_requirements=d.get("user_requirements", ""),
            k=int(d.get("k") or 5),
            relevant_threshold=int(d.get("relevant_threshold") or 2),
            pairwise_enabled=bool(d.get("pairwise_enabled", True)),
            system_prompt=d.get("system_prompt", "") or "",
            item_template=d.get("item_template", "") or "",
            pairwise_template=d.get("pairwise_template", "") or "",
        )


@dataclass
class Side:
    """대상 1개의 응답(정규화 후)."""

    label: str
    is_baseline: bool
    ok: bool
    items: list[dict[str, Any]]
    error: str = ""
    latency_ms: int | None = None


@dataclass
class CaseEvaluation:
    item_judgments: dict[str, dict[str, Any]] = field(default_factory=dict)
    metrics: dict[str, dict[str, Any]] = field(default_factory=dict)
    pairwise: dict[str, dict[str, Any]] = field(default_factory=dict)
    usage: Usage = field(default_factory=Usage)
    calls: int = 0


async def judge_items(
    client: JudgeClient, crit: Criteria, inputs: dict[str, Any], labels: dict[str, str],
    expected: str, items: list[dict[str, Any]], batch_size: int = ITEM_BATCH,
) -> tuple[dict[str, dict[str, Any]], Usage, int]:
    """항목 묶음 단위로 관련도 판정. 응답에 빠진 항목은 한 번 더 묻는다.

    묶기 전에 항목 순서를 섞는다(항목 key 로 시드를 정해 재현 가능). 풀은 대상 순서대로 모이므로
    섞지 않으면 기준 API 의 상위 항목이 늘 묶음 앞쪽에 놓여 위치 효과가 한쪽에 쏠릴 수 있다.
    """
    out: dict[str, dict[str, Any]] = {}
    usage = Usage()
    calls = 0
    size = max(1, int(batch_size or ITEM_BATCH))
    pending = list(items)
    seed = int(hashlib.sha256("|".join(sorted(it["key"] for it in pending)).encode()).hexdigest()[:8], 16)
    random.Random(seed).shuffle(pending)
    for _round in range(2):
        if not pending:
            break
        chunks = [pending[i : i + size] for i in range(0, len(pending), size)]

        async def one(chunk: list[dict[str, Any]]) -> tuple[dict[str, Any], Usage]:
            prompt = prompts.build_item_prompt(
                task_context=crit.task_context, requirements=crit.user_requirements,
                expected=expected, inputs=inputs, labels=labels, items=chunk, template=crit.item_template,
            )
            res = await client.complete_json(prompts.system_text(crit.system_prompt), prompt, prompts.ITEM_SCHEMA, name="item_relevance")
            return res.data, res.usage

        results = await asyncio.gather(*(one(c) for c in chunks))
        calls += len(chunks)
        wanted = {it["key"] for it in pending}
        for data, u in results:
            usage.add(u)
            for j in data.get("judgments", []):
                key = str(j.get("key", "")).strip()
                if key in wanted:
                    grade = max(0, min(3, int(j.get("grade", 0))))
                    out[key] = {"grade": grade, "reason": str(j.get("reason", "")).strip()}
        pending = [it for it in pending if it["key"] not in out]
    if pending:
        raise JudgeError(f"판정 모델이 항목 {len(pending)}개의 등급을 내지 않았습니다.")
    return out, usage, calls


async def judge_pair(
    client: JudgeClient, crit: Criteria, inputs: dict[str, Any], labels: dict[str, str],
    expected: str, candidate: Side, baseline: Side,
) -> tuple[dict[str, Any], Usage, int]:
    """후보 대 기준. (기준=A, 후보=B) 와 (후보=A, 기준=B) 두 번 묻고 결과를 합친다."""
    if not candidate.ok or not baseline.ok:
        if not candidate.ok and not baseline.ok:
            winner, reason = "tie", "두 대상 모두 호출에 실패했습니다."
        elif not candidate.ok:
            winner, reason = "baseline", f"후보 호출 실패: {candidate.error}"
        else:
            winner, reason = "candidate", f"기준 호출 실패: {baseline.error}"
        return {"winner": winner, "consistent": True, "auto": True, "reason": reason, "orders": []}, Usage(), 0

    k = crit.k
    cand = {"ok": True, "items": candidate.items[:k]}
    base = {"ok": True, "items": baseline.items[:k]}

    async def ask(a: dict[str, Any], b: dict[str, Any]) -> tuple[dict[str, Any], Usage]:
        prompt = prompts.build_pairwise_prompt(
            task_context=crit.task_context, requirements=crit.user_requirements, expected=expected,
            inputs=inputs, labels=labels, k=k, a=a, b=b, template=crit.pairwise_template,
        )
        res = await client.complete_json(prompts.system_text(crit.system_prompt), prompt, prompts.PAIRWISE_SCHEMA, name="pairwise")
        return res.data, res.usage

    (first, u1), (second, u2) = await asyncio.gather(ask(base, cand), ask(cand, base))
    map1 = {"A": "baseline", "B": "candidate", "TIE": "tie"}
    map2 = {"A": "candidate", "B": "baseline", "TIE": "tie"}
    w1, w2 = map1[first["winner"]], map2[second["winner"]]
    r1 = relabel(first["reason"], baseline.label, candidate.label)
    r2 = relabel(second["reason"], candidate.label, baseline.label)
    consistent = w1 == w2
    usage = Usage()
    usage.add(u1)
    usage.add(u2)
    return {
        "winner": w1 if consistent else "tie",
        "consistent": consistent,
        "auto": False,
        "reason": r2 if consistent else f"순서를 바꾸자 판정이 달라져 무승부로 처리했습니다. {r1}",
        "orders": [
            {"order": f"A={baseline.label}, B={candidate.label}", "winner": w1,
             "confidence": first.get("confidence"), "reason": r1},
            {"order": f"A={candidate.label}, B={baseline.label}", "winner": w2,
             "confidence": second.get("confidence"), "reason": r2},
        ],
    }, usage, 2


_AB = re.compile(r"(?<![A-Za-z])([AB])(?![A-Za-z])")


def relabel(text: str, a_label: str, b_label: str) -> str:
    """판정문의 A/B 표기를 실제 대상 이름으로 바꾼다."""
    return _AB.sub(lambda m: a_label if m.group(1) == "A" else b_label, text or "")


def compute_metrics(
    sides: list[Side], judgments: dict[str, dict[str, Any]], crit: Criteria
) -> dict[str, dict[str, Any]]:
    pool_keys = {it["key"] for s in sides if s.ok for it in s.items[: crit.k]}
    pool = [judgments[k]["grade"] for k in pool_keys if k in judgments]
    out: dict[str, dict[str, Any]] = {}
    for s in sides:
        if not s.ok:
            m: dict[str, Any] = failed_metrics()
        else:
            grades = [judgments.get(it["key"], {}).get("grade", 0) for it in s.items[: crit.k]]
            m = case_metrics(grades, pool, k=crit.k, threshold=crit.relevant_threshold)
        m.update({"ok": s.ok, "latency_ms": s.latency_ms, "empty": s.ok and not s.items})
        out[s.label] = m
    return out


async def evaluate_case(
    client: JudgeClient | None,
    crit: Criteria,
    inputs: dict[str, Any],
    labels: dict[str, str],
    expected: str,
    sides: list[Side],
    *,
    existing_judgments: dict[str, dict[str, Any]] | None = None,
    existing_pairwise: dict[str, dict[str, Any]] | None = None,
    batch_size: int = ITEM_BATCH,
) -> CaseEvaluation:
    ev = CaseEvaluation(
        item_judgments=dict(existing_judgments or {}),
        pairwise=dict(existing_pairwise or {}),
    )
    pool: dict[str, dict[str, Any]] = {}
    for s in sides:
        if s.ok:
            for it in s.items[: crit.k]:
                pool.setdefault(it["key"], it)
    todo = [it for key, it in pool.items() if key not in ev.item_judgments]
    if client is None:
        ev.metrics = compute_metrics(sides, ev.item_judgments, crit)
        return ev

    if todo:
        judged, usage, calls = await judge_items(client, crit, inputs, labels, expected, todo, batch_size)
        ev.item_judgments.update(judged)
        ev.usage.add(usage)
        ev.calls += calls
    ev.metrics = compute_metrics(sides, ev.item_judgments, crit)

    if crit.pairwise_enabled:
        baseline = next((s for s in sides if s.is_baseline), sides[0])
        tasks = [s for s in sides if s.label != baseline.label and s.label not in ev.pairwise]
        results = await asyncio.gather(
            *(judge_pair(client, crit, inputs, labels, expected, s, baseline) for s in tasks)
        )
        for s, (pw, usage, calls) in zip(tasks, results, strict=True):
            ev.pairwise[s.label] = pw
            ev.usage.add(usage)
            ev.calls += calls
    return ev
