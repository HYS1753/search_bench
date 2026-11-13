"""API 공통 — 직렬화와 오류."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import HTTPException

from app.judges import env_secret_source
from app.models import Criteria, Dataset, JudgeModel, Run, Suite, Target


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") + "Z" if dt else None


def not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what}을(를) 찾을 수 없습니다.")


def bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)


def judge_model_out(m: JudgeModel) -> dict[str, Any]:
    env = env_secret_source(m.provider)
    return {
        "id": m.id, "name": m.name, "provider": m.provider, "model": m.model,
        "base_url": m.base_url, "project": m.project, "location": m.location,
        "has_secret": bool(m.secret_enc), "secret_hint": m.secret_hint, "secret_env": env,
        "params": m.params or {}, "price_input_per_mtok": m.price_input_per_mtok,
        "price_output_per_mtok": m.price_output_per_mtok, "is_default": m.is_default,
        "last_test_ok": m.last_test_ok, "last_test_message": m.last_test_message,
        "last_tested_at": iso(m.last_tested_at), "created_at": iso(m.created_at), "updated_at": iso(m.updated_at),
    }


def target_out(t: Target) -> dict[str, Any]:
    return {
        "id": t.id, "name": t.name, "description": t.description, "method": t.method,
        "base_url": t.base_url, "path": t.path, "headers": t.headers or {}, "auth": t.auth or {"type": "none"},
        "has_secret": bool(t.secret_enc), "secret_hint": t.secret_hint,
        "params": t.params or [], "response_mapping": t.response_mapping or {},
        "timeout_seconds": t.timeout_seconds, "verify_ssl": t.verify_ssl,
        "created_at": iso(t.created_at), "updated_at": iso(t.updated_at),
    }


def target_snapshot(t: Target) -> dict[str, Any]:
    """실행 스냅샷용(키 제외)."""
    out = target_out(t)
    for k in ("has_secret", "secret_hint", "created_at", "updated_at"):
        out.pop(k, None)
    return out


def suite_out(s: Suite) -> dict[str, Any]:
    return {
        "id": s.id, "name": s.name, "description": s.description, "input_fields": s.input_fields or [],
        "default_criteria_id": s.default_criteria_id,
        "match_mode": s.match_mode or "id",
        "dataset_count": len(s.datasets) if hasattr(s, "datasets") else 0,
        "members": [
            {"target_id": m.target_id, "label": m.label, "position": m.position, "is_baseline": m.is_baseline,
             "target_name": m.target.name if m.target else "",
             "input_bindings": m.input_bindings or {}, "match": m.match or {},
             "criteria_id": None if m.is_baseline else (m.criteria_id or s.default_criteria_id)}
            for m in s.members
        ],
        "created_at": iso(s.created_at), "updated_at": iso(s.updated_at),
    }


def criteria_out(c: Criteria) -> dict[str, Any]:
    return {
        "id": c.id, "name": c.name, "description": c.description, "task_context": c.task_context,
        "user_requirements": c.user_requirements, "k": c.k, "relevant_threshold": c.relevant_threshold,
        "pairwise_enabled": c.pairwise_enabled,
        "system_prompt": c.system_prompt or "", "item_template": c.item_template or "", "pairwise_template": c.pairwise_template or "",
        "created_at": iso(c.created_at), "updated_at": iso(c.updated_at),
    }


def dataset_out(d: Dataset) -> dict[str, Any]:
    return {
        "id": d.id, "name": d.name, "description": d.description, "columns": d.columns or [],
        "source_filename": d.source_filename, "row_count": d.row_count,
        "suite_id": d.suite_id, "suite_name": d.suite.name if d.suite else None,
        "mapping": d.mapping or {}, "meta": d.meta or {}, "version": d.version or 0,
        "created_at": iso(d.created_at), "updated_at": iso(d.updated_at),
    }


def run_out(r: Run, *, with_summary: bool = True) -> dict[str, Any]:
    snap = r.snapshot or {}
    out = {
        "id": r.id, "name": r.name, "status": r.status, "suite_id": r.suite_id, "dataset_id": r.dataset_id,
        "judge_model_id": r.judge_model_id,
        "suite_name": snap.get("suite", {}).get("name"), "dataset_name": snap.get("dataset", {}).get("name"),
        "dataset_version": snap.get("dataset", {}).get("version"),
        "judge_model": snap.get("judge_model"), "criteria": snap.get("criteria"),
        "criteria_by_member": snap.get("criteria_by_member") or {},
        "members": [{"label": m["label"], "is_baseline": m.get("is_baseline"), "target_name": m["target"].get("name")}
                    for m in snap.get("members", [])],
        "input_fields": snap.get("suite", {}).get("input_fields", []),
        "mapping": snap.get("mapping"), "options": r.options,
        "total": r.total, "completed": r.completed, "failed": r.failed,
        "judge_calls": r.judge_calls, "tokens_input": r.tokens_input, "tokens_output": r.tokens_output,
        "cost_estimate": r.cost_estimate, "error": r.error,
        "created_at": iso(r.created_at), "started_at": iso(r.started_at), "finished_at": iso(r.finished_at),
    }
    if with_summary:
        out["summary"] = r.summary or {}
    else:
        s = r.summary or {}
        cmp = (s.get("comparisons") or [None])[0]
        out["headline"] = {
            "verdict": cmp["verdict"] if cmp else None,
            "ndcg_diff": cmp["ndcg_diff"] if cmp else None,
            "wins": cmp["wins"] if cmp else None, "losses": cmp["losses"] if cmp else None,
            "ties": cmp["ties"] if cmp else None,
            "candidate": cmp["candidate"] if cmp else None,
        }
    return out


def get_or_404(db, model, ident: int, what: str):
    obj = db.get(model, ident)
    if obj is None:
        raise not_found(what)
    return obj
