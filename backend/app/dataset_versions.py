"""테스트 데이터 버전 — 저장할 때마다 사본을 남기고, 버전 사이 바뀐 행을 계산한다."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select

from app.models import Dataset, DatasetRow, DatasetVersion

KEEP = 30  # 데이터마다 최근 버전 수


def who(request: Any) -> str:
    u = getattr(getattr(request, "state", None), "user", None) or {}
    if u.get("id") is None:  # 로그인 없이 쓰는 상태
        return ""
    return u.get("name") or u.get("username") or ""


def _norm(r: dict[str, Any]) -> dict[str, str]:
    """화면에서 고치면 숫자가 문자로 저장되므로 값 비교는 글자 기준으로(5 와 "5" 는 같음)."""
    return {k: "" if v is None else (json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else str(v)) for k, v in r.items()}


def record(db: Any, d: Dataset, note: str, by: str = "") -> int:
    """지금 상태를 새 버전으로 남긴다. 직전 버전과 내용이 같으면 남기지 않는다."""
    db.flush()
    rows = [r.data for r in db.scalars(select(DatasetRow).where(DatasetRow.dataset_id == d.id).order_by(DatasetRow.row_index))]
    last = db.scalar(select(DatasetVersion).where(DatasetVersion.dataset_id == d.id).order_by(DatasetVersion.version.desc()))
    if last and last.columns == (d.columns or []) and [_norm(r) for r in last.rows] == [_norm(r) for r in rows]:
        return last.version
    v = (last.version if last else 0) + 1
    db.add(DatasetVersion(dataset_id=d.id, version=v, columns=list(d.columns or []), rows=rows, row_count=len(rows),
                          note=note[:200], created_by=by[:100]))
    d.version = v
    old = db.scalars(select(DatasetVersion).where(DatasetVersion.dataset_id == d.id).order_by(DatasetVersion.version.desc()).offset(KEEP)).all()
    for o in old:
        db.delete(o)
    return v


def _key_of(columns: list[str], key_col: str | None):
    def k(i: int, r: dict[str, Any]) -> str:
        if key_col and str(r.get(key_col, "")).strip():
            return f"k:{r.get(key_col)}"
        return f"i:{i}"
    return k


def diff(a_cols: list[str], a_rows: list[dict[str, Any]], b_cols: list[str], b_rows: list[dict[str, Any]],
         key_col: str | None = None, limit: int = 200) -> dict[str, Any]:
    """a → b 사이 추가·삭제·변경된 행. 케이스 열(있으면)로 짝짓고, 없으면 순서로 짝짓는다."""
    ka, kb = _key_of(a_cols, key_col), _key_of(b_cols, key_col)
    am = {ka(i, r): r for i, r in enumerate(a_rows)}
    bm = {kb(i, r): r for i, r in enumerate(b_rows)}
    added = [bm[k] for k in bm if k not in am]
    removed = [am[k] for k in am if k not in bm]
    changed = []
    for k in am.keys() & bm.keys():
        na, nb = _norm(am[k]), _norm(bm[k])
        if na != nb:
            cols = sorted({c for c in set(na) | set(nb) if na.get(c, "") != nb.get(c, "")})
            changed.append({"before": am[k], "after": bm[k], "columns": cols})
    return {
        "added": len(added), "removed": len(removed), "changed": len(changed),
        "columns_added": [c for c in b_cols if c not in a_cols], "columns_removed": [c for c in a_cols if c not in b_cols],
        "added_rows": added[:limit], "removed_rows": removed[:limit], "changed_rows": changed[:limit],
    }


def version_count(db: Any, dataset_id: int) -> int:
    return db.scalar(select(func.count(DatasetVersion.id)).where(DatasetVersion.dataset_id == dataset_id)) or 0
