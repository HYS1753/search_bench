"""배치 실행 — 서버 안의 비동기 작업으로 돌고, 진행은 케이스마다 DB 에 기록한다.

- 브라우저를 닫아도 계속 진행된다. 화면은 SSE·조회로 상태만 본다.
- 서버가 재시작되면 진행 중이던 실행은 'interrupted' 로 표시되고, 이어서 실행하면 남은 케이스만 처리한다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import defaultdict
from types import SimpleNamespace
from typing import Any

import httpx
from sqlalchemy import select, update
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.db import session_scope
from app.evaluation.engine import Criteria, Side, evaluate_case
from app.evaluation.metrics import summarize
from app.judges import JudgeError, client_for
from app.matching import apply_match, bind_inputs
from app.notify import dispatch, events_for_run, run_payload
from app.validation import input_labels
from app.models import JudgeModel, Run, RunCase, RunResponse, Target, utcnow
from app.targets import CallResult, call_target, http_client

log = logging.getLogger("judge.runs")

ACTIVE = ("queued", "running")


class EventHub:
    """실행별 구독자에게 이벤트를 뿌린다(SSE)."""

    def __init__(self) -> None:
        self._subs: dict[int, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)

    def subscribe(self, run_id: int) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        self._subs[run_id].add(q)
        return q

    def unsubscribe(self, run_id: int, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subs[run_id].discard(q)

    def publish(self, run_id: int, event: dict[str, Any]) -> None:
        for q in list(self._subs.get(run_id, ())):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(event)


hub = EventHub()


def run_progress(run: Run) -> dict[str, Any]:
    return {
        "id": run.id,
        "status": run.status,
        "total": run.total,
        "completed": run.completed,
        "failed": run.failed,
        "judge_calls": run.judge_calls,
        "tokens_input": run.tokens_input,
        "tokens_output": run.tokens_output,
        "cost_estimate": run.cost_estimate,
        "error": run.error,
    }


def case_rows_for_summary(cases: list[RunCase]) -> list[dict[str, Any]]:
    return [
        {"category": c.category, "metrics": c.metrics or {}, "pairwise": c.pairwise or {}}
        for c in cases
        if c.status == "done"
    ]


# ── 후보별 평가 기준 ────────────────────────────────────────
# 후보마다 다른 평가 기준을 쓸 수 있다. 같은 기준을 쓰는 후보끼리 묶어(그룹) 기준 API 와 함께 판정한다.
# - 대표 기준(snapshot.criteria, 첫 후보의 기준) 그룹의 항목 판정은 key 그대로 저장(이전과 동일)
# - 다른 기준 그룹의 항목 판정은 "@{기준 id}:{key}" 로 저장
# - 기준 API 의 지표: 대표 그룹은 metrics[기준], 다른 그룹은 metrics["{기준}@{후보}"]


def criteria_groups(snapshot: dict[str, Any]) -> list[tuple[dict[str, Any], str, list[str]]]:
    primary = snapshot.get("criteria") or {}
    by_member = snapshot.get("criteria_by_member") or {}
    groups: dict[Any, tuple[dict[str, Any], str, list[str]]] = {}
    for m in snapshot.get("members", []):
        if m.get("is_baseline"):
            continue
        c = by_member.get(m["label"]) or primary
        cid = c.get("id")
        if cid not in groups:
            prefix = "" if cid == primary.get("id") else f"@{cid}:"
            groups[cid] = (c, prefix, [])
        groups[cid][2].append(m["label"])
    out = list(groups.values())
    out.sort(key=lambda g: g[1] != "")  # 대표 그룹을 앞에
    if not out:
        out = [(primary, "", [])]
    return out


def member_prefix(snapshot: dict[str, Any]) -> dict[str, tuple[str, int]]:
    """라벨 → (항목 판정 key 접두사, k). 기준 API 는 대표 기준."""
    primary = snapshot.get("criteria") or {}
    out = {m["label"]: ("", int(primary.get("k") or 5)) for m in snapshot.get("members", [])}
    for c, prefix, labels in criteria_groups(snapshot):
        for label in labels:
            out[label] = (prefix, int(c.get("k") or 5))
    return out


def compute_summary(session, run: Run) -> dict[str, Any]:
    cases = session.scalars(
        select(RunCase).where(RunCase.run_id == run.id).options(selectinload(RunCase.responses))
    ).all()
    members = run.snapshot.get("members", [])
    summary = summarize(case_rows_for_summary(list(cases)), members)
    summary.update(human_summaries(run, [c for c in cases if c.status == "done"], members))
    summary["status_counts"] = {
        s: sum(1 for c in cases if c.status == s) for s in ("done", "error", "pending")
    }
    by_member = run.snapshot.get("criteria_by_member") or {}
    primary = run.snapshot.get("criteria") or {}
    for cmp in summary.get("comparisons", []):
        c = by_member.get(cmp["candidate"]) or primary
        cmp["criteria"] = {"id": c.get("id"), "name": c.get("name"), "k": c.get("k")}
    summary["grade_distribution"] = grade_distribution(list(cases), members, member_prefix(run.snapshot))
    return summary


def human_summaries(run: Run, done: list[RunCase], members: list[dict[str, Any]]) -> dict[str, Any]:
    """사람 판정이 있으면 '사람'·'결합' 요약과 LLM–사람 일치도를 함께 낸다."""
    from app.evaluation.human import agreement, case_variants, inter_rater, reviewer_stats

    groups = criteria_groups(run.snapshot)
    variants = [(c, case_variants(c, run.snapshot, groups)) for c in done]
    reviewed = [(c, v) for c, v in variants if v["reviewed"]]
    review = {
        "done_cases": len(done),
        "reviewed_cases": len(reviewed),
        "complete_cases": sum(1 for _, v in reviewed if v["complete"]),
        "pairwise_cases": sum(1 for _, v in reviewed if v["human_pairwise"]),
        "items_graded": sum(v["graded"] for _, v in reviewed),
    }
    out: dict[str, Any] = {"review": review}
    if not reviewed:
        return out
    threshold = int((run.snapshot.get("criteria") or {}).get("relevant_threshold") or 2)
    out["agreement"] = agreement([c for c, _ in reviewed], threshold)
    out["inter_rater"] = inter_rater([c for c, _ in reviewed])
    out["reviewers"] = reviewer_stats([c for c, _ in reviewed], threshold)
    review["reviewers"] = len(out["reviewers"])
    out["human"] = summarize(
        [{"category": c.category, "metrics": v["human_metrics"], "pairwise": v["human_pairwise"]} for c, v in reviewed],
        members,
    )
    out["combined"] = summarize(
        [{"category": c.category, "metrics": v["combined_metrics"], "pairwise": v["combined_pairwise"]} for c, v in variants],
        members,
    )
    return out


def grade_distribution(cases: list[RunCase], members: list[dict[str, Any]], prefixes: dict[str, tuple[str, int]] | int) -> dict[str, Any]:
    """대상별 상위 k 항목의 등급 분포와 1위 항목의 등급 분포(차트용)."""
    out: dict[str, Any] = {}
    for m in members:
        label = m["label"]
        prefix, k = ("", prefixes) if isinstance(prefixes, int) else prefixes.get(label, ("", 5))
        all_items = {"3": 0, "2": 0, "1": 0, "0": 0}
        top1 = {"3": 0, "2": 0, "1": 0, "0": 0, "none": 0}
        for c in cases:
            if c.status != "done":
                continue
            resp = next((r for r in c.responses if r.label == label), None)
            if resp is None or not resp.ok or not resp.items:
                top1["none"] += 1
                continue
            judged = c.item_judgments or {}
            for i, it in enumerate(resp.items[:k]):
                g = judged.get(prefix + it["key"], {}).get("grade")
                if g is None:
                    continue
                all_items[str(g)] += 1
                if i == 0:
                    top1[str(g)] += 1
        out[label] = {"items": all_items, "top1": top1}
    return out


def _target_for(member: dict[str, Any], session) -> SimpleNamespace:
    """스냅샷의 대상 설정 + 현재 저장된 키(키는 스냅샷에 넣지 않는다)."""
    t = dict(member["target"])
    live = session.get(Target, t.get("id")) if t.get("id") else None
    t["secret_enc"] = live.secret_enc if live else ""
    return SimpleNamespace(**t)


class RunManager:
    def __init__(self) -> None:
        self._tasks: dict[int, asyncio.Task[None]] = {}

    def is_running(self, run_id: int) -> bool:
        task = self._tasks.get(run_id)
        return task is not None and not task.done()

    def start(self, run_id: int) -> None:
        if self.is_running(run_id):
            return
        task = asyncio.create_task(self._execute(run_id), name=f"run-{run_id}")
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t: self._tasks.pop(run_id, None))

    async def cancel(self, run_id: int) -> bool:
        task = self._tasks.get(run_id)
        if task is None or task.done():
            return False
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        return True

    async def shutdown(self) -> None:
        for run_id in list(self._tasks):
            task = self._tasks.get(run_id)
            if task:
                task.cancel()
        for task in list(self._tasks.values()):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        # 종료로 끊긴 실행은 이어서 실행할 수 있게 표시한다.
        with session_scope() as s:
            s.execute(update(Run).where(Run.status.in_(ACTIVE)).values(status="interrupted"))

    @staticmethod
    def recover_on_startup() -> int:
        with session_scope() as s:
            result = s.execute(
                update(Run)
                .where(Run.status.in_(ACTIVE))
                .values(status="interrupted", error="서버가 재시작되어 중단되었습니다. '이어서 실행'으로 남은 케이스를 처리할 수 있습니다.")
            )
            return result.rowcount or 0

    # ── 실행 본체 ────────────────────────────────────────────

    async def _execute(self, run_id: int) -> None:
        settings = get_settings()
        with session_scope() as s:
            run = s.get(Run, run_id)
            if run is None:
                return
            judge_row = s.get(JudgeModel, run.judge_model_id) if run.judge_model_id else None
            if judge_row is None:
                run.status = "failed"
                run.error = "판정 모델이 삭제되었거나 지정되지 않았습니다."
                hub.publish(run_id, {"type": "status", "run": run_progress(run)})
                return
            try:
                judge = client_for(judge_row)
            except Exception as exc:  # noqa: BLE001
                run.status = "failed"
                run.error = f"판정 모델 준비 실패: {exc}"
                hub.publish(run_id, {"type": "status", "run": run_progress(run)})
                return
            price_in, price_out = judge_row.price_input_per_mtok, judge_row.price_output_per_mtok
            run.status = "running"
            run.error = ""
            run.started_at = run.started_at or utcnow()
            run.finished_at = None
            snapshot = run.snapshot
            options = run.options
            members = snapshot["members"]
            targets = {m["label"]: _target_for(m, s) for m in members}
            case_ids = s.scalars(
                select(RunCase.id).where(RunCase.run_id == run_id, RunCase.status != "done").order_by(RunCase.row_index)
            ).all()
            hub.publish(run_id, {"type": "status", "run": run_progress(run)})

        crit = Criteria.from_dict(snapshot["criteria"])
        groups = [(Criteria.from_dict(c), prefix, labels_) for c, prefix, labels_ in criteria_groups(snapshot)]
        match_mode = snapshot["suite"].get("match_mode", "id")
        labels = input_labels(snapshot["suite"].get("input_fields", []))
        limit = max([crit.k, *(g[0].k for g in groups), int(options.get("fetch_limit") or crit.k)])
        concurrency = max(1, int(options.get("concurrency") or settings.RUN_CASE_CONCURRENCY))
        batch_size = int(options.get("judge_batch_size") or 12)
        sem = asyncio.Semaphore(concurrency)
        lock = asyncio.Lock()

        clients: dict[bool, httpx.AsyncClient] = {True: http_client(True), False: http_client(False)}
        try:
            budget = float(options.get("max_cost") or 0) or None
            state = {"over": False}

            async def process(case_id: int) -> None:
                async with sem:
                    if state["over"]:
                        return  # 비용 상한에 닿으면 남은 케이스는 시작하지 않는다(이어서 실행으로 처리 가능)
                    await self._process_case(
                        run_id, case_id, members, targets, clients, judge, groups, labels, limit,
                        price_in, price_out, lock, match_mode, batch_size,
                    )
                    if budget:
                        with session_scope() as s2:
                            r2 = s2.get(Run, run_id)
                            if r2 and r2.cost_estimate >= budget:
                                state["over"] = True

            await asyncio.gather(*(process(cid) for cid in case_ids))
            final_status = "done"
            if state["over"]:
                final_status = "cancelled"
                with session_scope() as s:
                    r = s.get(Run, run_id)
                    if r:
                        r.error = (f"비용 상한 ${budget:g} 에 닿아 멈췄습니다(지금 ${r.cost_estimate:.4f}). "
                                   "‘이어서 실행’하면 남은 케이스를 처리합니다. 상한을 늘리려면 같은 설정으로 다시 실행하세요.")
        except asyncio.CancelledError:
            final_status = "cancelled"
        except Exception as exc:  # noqa: BLE001
            log.exception("run %s failed", run_id)
            final_status = "failed"
            with session_scope() as s:
                run = s.get(Run, run_id)
                if run:
                    run.error = f"{type(exc).__name__}: {exc}"
        finally:
            for c in clients.values():
                await c.aclose()

        with session_scope() as s:
            run = s.get(Run, run_id)
            if run is None:
                return
            run.summary = compute_summary(s, run)
            if final_status == "cancelled" and run.status != "interrupted":
                run.status = "cancelled"
            elif final_status != "cancelled":
                run.status = final_status
            run.finished_at = utcnow()
            hub.publish(run_id, {"type": "status", "run": run_progress(run)})
            hub.publish(run_id, {"type": "summary", "summary": run.summary})
            notice = (events_for_run(run), run_payload(run))
        # 알림(실패해도 평가 결과에는 영향 없음)
        with contextlib.suppress(Exception):
            await dispatch(*notice)

    async def _process_case(
        self, run_id, case_id, members, targets, clients, judge, groups, labels, limit,
        price_in, price_out, lock, match_mode="id", batch_size=12,
    ) -> None:
        with session_scope() as s:
            case = s.get(RunCase, case_id)
            inputs, expected = dict(case.inputs), case.expected
            existing = {r.label: r for r in case.responses}
            reuse = {
                label: Side(label, False, True, r.items, "", r.latency_ms)
                for label, r in existing.items()
                if r.ok
            }
            judgments = dict(case.item_judgments or {})
            pairwise = dict(case.pairwise or {})

        # 1) 대상 호출 (성공한 응답은 재사용)
        async def call(member: dict[str, Any]) -> tuple[dict[str, Any], Any]:
            if member["label"] in reuse:
                return member, None
            target = targets[member["label"]]
            client = clients[bool(getattr(target, "verify_ssl", True))]
            try:
                bound = bind_inputs(inputs, member.get("input_bindings"), target.params)
            except ValueError as exc:
                return member, CallResult(False, None, 0, f"입력 변환 실패: {exc}")
            result = await call_target(client, target, bound, limit=limit)
            if result.ok:
                result.items = apply_match(result.items, match_mode, member.get("match"), member["label"])
            return member, result

        calls = await asyncio.gather(*(call(m) for m in members))
        sides: list[Side] = []
        with session_scope() as s:
            for member, result in calls:
                label = member["label"]
                if result is None:
                    side = reuse[label]
                else:
                    row = s.scalar(
                        select(RunResponse).where(RunResponse.run_case_id == case_id, RunResponse.label == label)
                    ) or RunResponse(run_case_id=case_id, label=label, position=member.get("position", 0))
                    row.ok, row.status_code, row.latency_ms = result.ok, result.status_code, result.latency_ms
                    row.error, row.items, row.raw = result.error, result.items, result.raw
                    s.add(row)
                    side = Side(label, False, result.ok, result.items, result.error, result.latency_ms)
                side.is_baseline = bool(member.get("is_baseline"))
                sides.append(side)

        # 2) 판정
        status, error = "done", ""
        usage_in = usage_out = calls_made = 0
        try:
            judgments, pairwise, metrics, usage_in, usage_out, calls_made = await evaluate_groups(
                judge, groups, inputs, labels, expected, sides, judgments, pairwise, batch_size,
            )
        except JudgeError as exc:
            status, error, metrics = "error", f"판정 실패: {exc}", {}
        except Exception as exc:  # noqa: BLE001
            status, error, metrics = "error", f"{type(exc).__name__}: {exc}", {}

        async with lock:
            with session_scope() as s:
                case = s.get(RunCase, case_id)
                case.status, case.error = status, error
                case.item_judgments, case.pairwise = judgments, pairwise
                if metrics:
                    case.metrics = metrics
                run = s.get(Run, run_id)
                run.tokens_input += usage_in
                run.tokens_output += usage_out
                run.judge_calls += calls_made
                run.cost_estimate = (run.tokens_input * price_in + run.tokens_output * price_out) / 1_000_000
                counts = s.execute(
                    select(RunCase.status).where(RunCase.run_id == run_id)
                ).scalars().all()
                run.completed = sum(1 for c in counts if c == "done")
                run.failed = sum(1 for c in counts if c == "error")
                event = {
                    "type": "case",
                    "case": {"id": case_id, "status": status, "error": error, "metrics": metrics, "pairwise": pairwise},
                    "run": run_progress(run),
                }
            hub.publish(run_id, event)


async def evaluate_groups(
    judge, groups: list[tuple[Criteria, str, list[str]]], inputs: dict[str, Any], labels: dict[str, str],
    expected: str, sides: list[Side], judgments: dict[str, Any], pairwise: dict[str, Any], batch_size: int = 12,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], int, int, int]:
    """평가 기준이 같은 후보끼리 묶어 기준 API 와 함께 판정한다(그룹이 하나면 이전과 같다)."""
    baseline = next((s for s in sides if s.is_baseline), sides[0])
    if len(groups) <= 1:
        crit = groups[0][0]
        ev = await evaluate_case(judge, crit, inputs, labels, expected, sides,
                                 existing_judgments=judgments, existing_pairwise=pairwise, batch_size=batch_size)
        return ev.item_judgments, ev.pairwise, ev.metrics, ev.usage.input_tokens, ev.usage.output_tokens, ev.calls

    async def one(crit: Criteria, prefix: str, group_labels: list[str]):
        if prefix:
            existing = {k[len(prefix):]: v for k, v in judgments.items() if k.startswith(prefix)}
        else:
            existing = {k: v for k, v in judgments.items() if not k.startswith("@")}
        sub = [baseline, *(s for s in sides if s.label in group_labels)]
        ev = await evaluate_case(judge, crit, inputs, labels, expected, sub, existing_judgments=existing,
                                 existing_pairwise={k: v for k, v in pairwise.items() if k in group_labels},
                                 batch_size=batch_size)
        return prefix, group_labels, ev

    results = await asyncio.gather(*(one(*g) for g in groups))
    new_j: dict[str, Any] = {}
    new_pw: dict[str, Any] = dict(pairwise)
    metrics: dict[str, Any] = {}
    ui = uo = calls = 0
    for prefix, group_labels, ev in results:
        new_j.update({prefix + k: v for k, v in ev.item_judgments.items()})
        new_pw.update(ev.pairwise)
        for label in group_labels:
            metrics[label] = ev.metrics[label]
            if prefix:
                metrics[f"{baseline.label}@{label}"] = ev.metrics[baseline.label]
        if not prefix:
            metrics[baseline.label] = ev.metrics[baseline.label]
        ui += ev.usage.input_tokens
        uo += ev.usage.output_tokens
        calls += ev.calls
    return new_j, new_pw, metrics, ui, uo, calls


manager = RunManager()
