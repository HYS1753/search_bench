"""후보 vs 기준 상세 지표 — 결과 화면 '지표 상세'와 HTML·엑셀·JSON 내보내기가 같은 값을 쓴다.

저장된 실행 결과(케이스별 응답 목록·항목 판정·목록 비교·케이스 지표)만으로 계산하므로 판정을 다시 하지 않는다.
평가 기준이 후보마다 다르면 그 후보의 기준(접두사·k·관련 등급)으로 양쪽을 본다.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from app.models import Run, RunCase
from app.runs import member_prefix


def _criteria_for(snapshot: dict[str, Any], label: str) -> dict[str, Any]:
    return (snapshot.get("criteria_by_member") or {}).get(label) or snapshot.get("criteria") or {}


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def comparison_details(run: Run, cases: list[RunCase], candidate: str) -> dict[str, Any] | None:
    snap = run.snapshot or {}
    members = snap.get("members", [])
    baseline = next((m["label"] for m in members if m.get("is_baseline")), None)
    if not baseline or candidate == baseline or candidate not in {m["label"] for m in members}:
        return None
    prefix, k = member_prefix(snap).get(candidate, ("", 5))
    crit = _criteria_for(snap, candidate)
    threshold = int(crit.get("relevant_threshold") or 2)

    jaccards: list[float] = []
    top1_same = identical = overlap_cases = 0
    filled = {"baseline": [], "candidate": []}
    by_rank: dict[str, list[list[int]]] = {"baseline": [[] for _ in range(k)], "candidate": [[] for _ in range(k)]}
    rel = Counter()  # both / baseline_only / candidate_only (항목 수)
    rel_cases = Counter()  # gain / loss / same (케이스 수)
    agree = {w: {"up": 0, "same": 0, "down": 0} for w in ("candidate", "tie", "baseline")}
    confidence = Counter()
    ndcg_pairs: list[tuple[float, float]] = []
    first_rank = {"baseline": [0] * (k + 1), "candidate": [0] * (k + 1)}  # 1..k, 마지막 칸 = 없음
    transition: Counter = Counter()
    paired = 0

    for c in cases:
        if c.status != "done":
            continue
        resp = {r.label: r for r in c.responses}
        b, x = resp.get(baseline), resp.get(candidate)
        if not b or not x or not b.ok or not x.ok:
            continue
        paired += 1
        judged = c.item_judgments or {}
        kb = [it["key"] for it in b.items[:k]]
        kc = [it["key"] for it in x.items[:k]]
        filled["baseline"].append(len(kb))
        filled["candidate"].append(len(kc))

        # 결과 겹침
        union = set(kb) | set(kc)
        if union:
            overlap_cases += 1
            jaccards.append(len(set(kb) & set(kc)) / len(union))
            top1_same += int(bool(kb) and bool(kc) and kb[0] == kc[0])
            identical += int(kb == kc)

        # 순위별 등급, 관련 결과 집합
        sets = {}
        for side, keys in (("baseline", kb), ("candidate", kc)):
            relevant = set()
            for i, key in enumerate(keys):
                g = (judged.get(prefix + key) or {}).get("grade")
                if g is None:
                    continue
                by_rank[side][i].append(g)
                if g >= threshold:
                    relevant.add(key)
            sets[side] = relevant
        both = sets["baseline"] & sets["candidate"]
        b_only, c_only = sets["baseline"] - both, sets["candidate"] - both
        rel["both"] += len(both)
        rel["baseline_only"] += len(b_only)
        rel["candidate_only"] += len(c_only)
        net = len(sets["candidate"]) - len(sets["baseline"])
        rel_cases["gain" if net > 0 else "loss" if net < 0 else "same"] += 1

        # 케이스 지표(nDCG·MRR·1위 등급)
        mb, mc = (c.metrics or {}).get(baseline) or {}, (c.metrics or {}).get(candidate) or {}
        if mb.get("ndcg") is not None and mc.get("ndcg") is not None:
            ndcg_pairs.append((mb["ndcg"], mc["ndcg"]))
        for side, m in (("baseline", mb), ("candidate", mc)):
            mrr = m.get("mrr") or 0
            first_rank[side][min(k, round(1 / mrr)) - 1 if mrr > 0 else k] += 1
        gb = -1 if mb.get("top1_grade") is None else int(round(mb["top1_grade"]))
        gc = -1 if mc.get("top1_grade") is None else int(round(mc["top1_grade"]))
        transition[f"{gb}:{gc}"] += 1

        # 목록 비교 ↔ nDCG 방향
        pw = (c.pairwise or {}).get(candidate)
        if pw and mb.get("ndcg") is not None and mc.get("ndcg") is not None:
            d = mc["ndcg"] - mb["ndcg"]
            agree[pw["winner"]]["up" if d > 1e-9 else "down" if d < -1e-9 else "same"] += 1
            for o in pw.get("orders") or []:
                if o.get("confidence"):
                    confidence[o["confidence"]] += 1

    n_agree = sum(sum(v.values()) for v in agree.values())
    matched = agree["candidate"]["up"] + agree["baseline"]["down"] + agree["tie"]["same"]
    opposite = agree["candidate"]["down"] + agree["baseline"]["up"]
    hist = {"baseline": [0] * 10, "candidate": [0] * 10}
    for a, b2 in ndcg_pairs:
        hist["baseline"][min(9, int(a * 10))] += 1
        hist["candidate"][min(9, int(b2 * 10))] += 1

    return {
        "candidate": candidate,
        "baseline": baseline,
        "k": k,
        "relevant_threshold": threshold,
        "cases": paired,
        "overlap": {
            "cases": overlap_cases,
            "mean_jaccard": _mean(jaccards),
            "top1_same_rate": top1_same / overlap_cases if overlap_cases else None,
            "identical_rate": identical / overlap_cases if overlap_cases else None,
            # Jaccard 0~1 을 5칸으로: 0–0.2 … 0.8–1.0
            "hist": [sum(1 for j in jaccards if min(4, int(j * 5)) == i) for i in range(5)],
            "mean_filled": {s: _mean([float(v) for v in vs]) for s, vs in filled.items()},
            "short_rate": {s: (sum(1 for v in vs if v < k) / len(vs)) if vs else None for s, vs in filled.items()},
        },
        "grade_by_rank": {
            side: [{"rank": i + 1, "mean": _mean([float(g) for g in gs]), "relevant_rate": (sum(1 for g in gs if g >= threshold) / len(gs)) if gs else None, "n": len(gs)}
                   for i, gs in enumerate(ranks)]
            for side, ranks in by_rank.items()
        },
        "relevant_found": {
            "items": {"both": rel["both"], "baseline_only": rel["baseline_only"], "candidate_only": rel["candidate_only"]},
            "cases": {"gain": rel_cases["gain"], "same": rel_cases["same"], "loss": rel_cases["loss"]},
        },
        "agreement": {
            "matrix": agree,
            "cases": n_agree,
            "agree_rate": matched / n_agree if n_agree else None,
            "opposite_rate": opposite / n_agree if n_agree else None,
            "confidence": {c: confidence.get(c, 0) for c in ("high", "medium", "low")},
        },
        "ndcg_hist": hist,
        "first_rank": first_rank,
        "grade_transition": dict(transition),
    }


def run_details(run: Run, cases: list[RunCase]) -> dict[str, dict[str, Any]]:
    """모든 후보에 대한 상세 지표 {후보: …} — 내보내기용"""
    out = {}
    for m in (run.snapshot or {}).get("members", []):
        if m.get("is_baseline"):
            continue
        d = comparison_details(run, cases, m["label"])
        if d:
            out[m["label"]] = d
    return out
