"""알림 — 평가가 끝나거나 실패하거나 '저하' 결론이 나면 Slack·웹훅으로 알린다(실패해도 평가에는 영향 없음)."""

from __future__ import annotations

import logging
from typing import Any

import httpx
from sqlalchemy import select

from app.config import get_settings
from app.db import session_scope
from app.models import NotificationChannel, utcnow
from app.security import decrypt

log = logging.getLogger("judge.notify")

EVENTS = {
    "run_done": "평가 완료",
    "run_failed": "평가 실패·중단",
    "run_regressed": "‘저하’ 결론",
    "generation_done": "테스트 데이터 생성 완료",
}


def run_payload(run: Any) -> dict[str, Any]:
    summ = run.summary or {}
    cmp = (summ.get("comparisons") or [None])[0] or {}
    verdict = (cmp.get("verdict") or {})
    base = get_settings().PUBLIC_URL.rstrip("/")
    return {
        "run_id": run.id, "name": run.name, "status": run.status, "cases": summ.get("cases", 0),
        "candidate": cmp.get("candidate"), "baseline": cmp.get("baseline"),
        "verdict": verdict.get("code"), "verdict_title": verdict.get("title"), "ndcg_diff": cmp.get("ndcg_diff"),
        "ndcg_ci": cmp.get("ndcg_ci"), "win_rate": cmp.get("win_rate"), "cost": run.cost_estimate, "error": run.error,
        "url": f"{base}/runs/{run.id}" if base else None,
    }


def events_for_run(run: Any) -> list[str]:
    if run.status in ("failed", "interrupted", "cancelled"):
        return ["run_failed"]
    ev = ["run_done"]
    cmp = ((run.summary or {}).get("comparisons") or [None])[0] or {}
    if (cmp.get("verdict") or {}).get("code") == "regressed":
        ev.append("run_regressed")
    return ev


def slack_message(event: str, p: dict[str, Any]) -> dict[str, Any]:
    icon = {"run_done": "✅", "run_failed": "⚠️", "run_regressed": "🔻", "generation_done": "✨"}.get(event, "🔔")
    if event == "generation_done":
        text = f"{icon} *테스트 데이터 생성 완료* · {p.get('name')} ({p.get('count')}개)"
    elif event == "run_failed":
        text = f"{icon} *평가가 끝나지 못했습니다* · {p['name']} ({p['status']})\n{p.get('error') or ''}"
    else:
        diff = p.get("ndcg_diff")
        ci = p.get("ndcg_ci")
        text = (f"{icon} *{EVENTS[event]}* · {p['name']}\n"
                f"*{p.get('verdict_title') or '결론 없음'}* — {p.get('candidate')} vs {p.get('baseline')}(기준), 케이스 {p.get('cases')}건\n"
                f"nDCG 차이 {diff:+.3f}" + (f" (95% {ci[0]:+.3f} ~ {ci[1]:+.3f})" if ci else "") + (f" · 승률 {p['win_rate'] * 100:.0f}%" if p.get("win_rate") is not None else "")
                if diff is not None else f"{icon} *{EVENTS[event]}* · {p['name']} — 결론 없음")
    if p.get("url"):
        text += f"\n<{p['url']}|결과 보기>"
    return {"text": text}


def http() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=8.0)


async def send_one(ch: NotificationChannel, event: str, payload: dict[str, Any]) -> tuple[bool, str]:
    url = decrypt(ch.url_enc)
    body = slack_message(event, payload) if ch.kind == "slack" else {"event": event, "event_label": EVENTS.get(event, event), **payload}
    try:
        async with http() as client:
            r = await client.post(url, json=body)
        return r.status_code < 300, f"HTTP {r.status_code}"
    except httpx.HTTPError as exc:
        from app.errors import explain

        return False, explain(f"{type(exc).__name__}: {exc}")


async def dispatch(events: list[str], payload: dict[str, Any]) -> None:
    with session_scope() as s:
        chans = [c for c in s.scalars(select(NotificationChannel).where(NotificationChannel.active.is_(True))) if set(c.events or []) & set(events)]
        s.expunge_all()
    for ch in chans:
        for ev in [e for e in events if e in (ch.events or [])]:
            ok, msg = await send_one(ch, ev, payload)
            with session_scope() as s:
                row = s.get(NotificationChannel, ch.id)
                if row:
                    row.last_ok, row.last_message, row.last_sent_at = ok, f"{EVENTS.get(ev, ev)} · {msg}", utcnow()
