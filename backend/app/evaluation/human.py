"""사람 판정 — LLM 판정 위에 사람이 등급·목록 선호를 덧붙인다.

세 가지 점수:
- LLM: 판정 모델만으로 낸 결과(기존).
- 사람: 사람이 풀의 모든 항목을 채점한 케이스만으로 낸 결과(사람이 고른 목록 선호 포함).
- 결합: 항목마다 사람 등급이 있으면 사람 것을, 없으면 LLM 것을 쓴 결과(사람이 고친 LLM 판정).
  LLM 만으로도 결과를 볼 수 있고, 사람이 검수할수록 결합 점수가 사람 기준에 가까워진다.

일치도: 같은 항목을 둘 다 채점한 경우만 비교한다(완전 일치율, ±1 이내 일치율, 이차 가중 카파, 관련/비관련 카파, LLM−사람 평균 차).
"""

from __future__ import annotations

from typing import Any

from app.evaluation.engine import Criteria, Side, compute_metrics


def combine(llm: dict[str, Any], human: dict[str, Any]) -> dict[str, Any]:
    out = dict(llm or {})
    for k, v in (human or {}).items():
        if v and v.get("grade") is not None:
            out[k] = {"grade": int(v["grade"]), "reason": (v.get("note") or "사람 판정"), "human": True}
    return out


def sides_of(case: Any, members: list[dict[str, Any]]) -> list[Side]:
    resp = {r.label: r for r in case.responses}
    out = []
    for m in members:
        r = resp.get(m["label"])
        if r is None:
            continue
        out.append(Side(m["label"], bool(m.get("is_baseline")), r.ok, r.items or [], r.error, r.latency_ms))
    return out


def pool_keys(groups: list[tuple[dict[str, Any], str, list[str]]], sides: list[Side]) -> set[str]:
    """채점이 필요한 항목 key(접두사 포함): 그룹마다 기준 API + 그 그룹 후보의 상위 k."""
    keys: set[str] = set()
    for crit, prefix, labels in groups:
        k = int(crit.get("k") or 5)
        for s in sides:
            if s.ok and (s.is_baseline or s.label in labels):
                keys.update(prefix + it["key"] for it in s.items[:k])
    return keys


def metrics_with(groups: list[tuple[dict[str, Any], str, list[str]]], sides: list[Side], judgments: dict[str, Any]) -> dict[str, Any]:
    """판정 묶음(접두사 포함 key)으로 지표만 다시 계산한다(runs.evaluate_groups 와 같은 규칙)."""
    baseline = next((s for s in sides if s.is_baseline), sides[0] if sides else None)
    if baseline is None:
        return {}
    out: dict[str, Any] = {}
    for i, (c, prefix, labels) in enumerate(groups):
        crit = Criteria.from_dict(c)
        j = {k[len(prefix):]: v for k, v in judgments.items() if k.startswith(prefix)} if prefix else {
            k: v for k, v in judgments.items() if not k.startswith("@")}
        sub = [baseline, *(s for s in sides if s.label in labels)]
        m = compute_metrics(sub, j, crit)
        for label in labels:
            out[label] = m[label]
            if prefix:
                out[f"{baseline.label}@{label}"] = m[baseline.label]
        if not prefix or i == 0:
            out.setdefault(baseline.label, m[baseline.label])
    return out


def case_variants(case: Any, snapshot: dict[str, Any], groups: list[tuple[dict[str, Any], str, list[str]]]) -> dict[str, Any]:
    members = snapshot.get("members", [])
    human = {k: v for k, v in (case.human_judgments or {}).items() if v and v.get("grade") is not None}
    hp = case.human_pairwise or {}
    sides = sides_of(case, members)
    need = pool_keys(groups, sides)
    graded = need & set(human)
    complete = bool(need) and graded == need
    combined = metrics_with(groups, sides, combine(case.item_judgments or {}, human)) if human else (case.metrics or {})
    combined_pw = dict(case.pairwise or {})
    for cand, w in hp.items():
        if w in ("candidate", "baseline", "tie"):
            combined_pw[cand] = {"winner": w, "consistent": True, "human": True}
    return {
        "reviewed": bool(human) or bool(hp),
        "complete": complete,
        "graded": len(graded),
        "needed": len(need),
        "human_metrics": metrics_with(groups, sides, human) if complete else {},
        "human_pairwise": {c: {"winner": w, "consistent": True} for c, w in hp.items() if w in ("candidate", "baseline", "tie")},
        "combined_metrics": combined,
        "combined_pairwise": combined_pw,
    }


def _kappa(pairs: list[tuple[int, int]], cats: list[int], weights: str = "none") -> float | None:
    n = len(pairs)
    if n < 2:
        return None
    idx = {c: i for i, c in enumerate(cats)}
    m = len(cats)
    obs = [[0.0] * m for _ in range(m)]
    for a, b in pairs:
        obs[idx[a]][idx[b]] += 1
    ra = [sum(row) for row in obs]
    rb = [sum(obs[i][j] for i in range(m)) for j in range(m)]

    def w(i: int, j: int) -> float:
        if weights == "quadratic":
            return ((i - j) ** 2) / ((m - 1) ** 2)
        return 0.0 if i == j else 1.0

    po = sum(w(i, j) * obs[i][j] for i in range(m) for j in range(m)) / n
    pe = sum(w(i, j) * ra[i] * rb[j] for i in range(m) for j in range(m)) / (n * n)
    if pe == 0:
        return 1.0 if po == 0 else None
    return 1 - po / pe


def agreement(cases: list[Any], threshold: int = 2) -> dict[str, Any]:
    pairs: list[tuple[int, int]] = []  # (LLM, 사람)
    pw_total = pw_agree = 0
    for c in cases:
        llm = c.item_judgments or {}
        for k, h in (c.human_judgments or {}).items():
            if h and h.get("grade") is not None and k in llm and llm[k].get("grade") is not None:
                pairs.append((int(llm[k]["grade"]), int(h["grade"])))
        for cand, w in (c.human_pairwise or {}).items():
            lp = (c.pairwise or {}).get(cand)
            if lp and w in ("candidate", "baseline", "tie"):
                pw_total += 1
                pw_agree += lp.get("winner") == w
    n = len(pairs)
    confusion = [[0] * 4 for _ in range(4)]
    for a, b in pairs:
        confusion[a][b] += 1
    binary = [(int(a >= threshold), int(b >= threshold)) for a, b in pairs]
    return {
        "items": n,
        "exact": sum(a == b for a, b in pairs) / n if n else None,
        "within1": sum(abs(a - b) <= 1 for a, b in pairs) / n if n else None,
        "kappa_quadratic": _kappa(pairs, [0, 1, 2, 3], "quadratic"),
        "kappa_binary": _kappa(binary, [0, 1]),
        "binary_agree": sum(a == b for a, b in binary) / n if n else None,
        "bias": (sum(a - b for a, b in pairs) / n) if n else None,  # + 면 LLM 이 후함
        "llm_mean": sum(a for a, _ in pairs) / n if n else None,
        "human_mean": sum(b for _, b in pairs) / n if n else None,
        "confusion": confusion,  # [LLM 등급][사람 등급]
        "pairwise_cases": pw_total,
        "pairwise_agree": pw_agree / pw_total if pw_total else None,
    }


# ── 여러 검수자 ───────────────────────────────────────────


def consensus(human_by: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """검수자들의 등급은 중앙값(짝수면 평균을 반올림), 목록 선호는 다수결(동률이면 비슷)로 합친다."""
    grades: dict[str, list[int]] = {}
    prefs: dict[str, list[str]] = {}
    for rv in (human_by or {}).values():
        for k, v in (rv.get("grades") or {}).items():
            if v and v.get("grade") is not None:
                grades.setdefault(k, []).append(int(v["grade"]))
        for c, w in (rv.get("pairwise") or {}).items():
            if w in ("candidate", "baseline", "tie"):
                prefs.setdefault(c, []).append(w)
    hj: dict[str, Any] = {}
    for k, gs in grades.items():
        s = sorted(gs)
        n = len(s)
        med = s[n // 2] if n % 2 else int((s[n // 2 - 1] + s[n // 2]) / 2 + 0.5)
        hj[k] = {"grade": med, "n": n, "note": f"검수자 {n}명 합의" if n > 1 else ""}
    hp: dict[str, Any] = {}
    for c, ws in prefs.items():
        counts = {w: ws.count(w) for w in set(ws)}
        top = max(counts.values())
        winners = [w for w, n in counts.items() if n == top]
        hp[c] = winners[0] if len(winners) == 1 else "tie"
    return hj, hp


def inter_rater(cases: list[Any]) -> dict[str, Any]:
    """검수자 사이 일치도: 같은 항목을 함께 채점한 검수자 쌍마다 이차 가중 카파·완전 일치율을 구해 평균."""
    pairs: dict[tuple[str, str], list[tuple[int, int]]] = {}
    pw_pairs: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for c in cases:
        by = c.human_by or {}
        names = sorted(by)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                ga, gb = by[a].get("grades") or {}, by[b].get("grades") or {}
                for k in set(ga) & set(gb):
                    if ga[k] and gb[k] and ga[k].get("grade") is not None and gb[k].get("grade") is not None:
                        pairs.setdefault((a, b), []).append((int(ga[k]["grade"]), int(gb[k]["grade"])))
                pa, pb = by[a].get("pairwise") or {}, by[b].get("pairwise") or {}
                for cand in set(pa) & set(pb):
                    pw_pairs.setdefault((a, b), []).append((pa[cand], pb[cand]))
    out_pairs = []
    for (a, b), xs in pairs.items():
        out_pairs.append({"a": a, "b": b, "items": len(xs), "kappa": _kappa(xs, [0, 1, 2, 3], "quadratic"),
                          "exact": sum(x == y for x, y in xs) / len(xs)})
    ks = [p["kappa"] for p in out_pairs if p["kappa"] is not None and p["items"] >= 5]
    allpw = [x for xs in pw_pairs.values() for x in xs]
    return {
        "pairs": sorted(out_pairs, key=lambda p: -p["items"]),
        "kappa_avg": sum(ks) / len(ks) if ks else None,
        "items": sum(p["items"] for p in out_pairs),
        "pairwise_agree": sum(x == y for x, y in allpw) / len(allpw) if allpw else None,
        "pairwise_items": len(allpw),
    }


def reviewer_stats(cases: list[Any], threshold: int = 2) -> list[dict[str, Any]]:
    """검수자마다: 본 케이스·항목 수, LLM 과의 일치도, LLM 대비 후한 정도."""
    names = sorted({n for c in cases for n in (c.human_by or {})})
    out = []
    for n in names:
        pseudo = []
        ncases = items = 0
        for c in cases:
            rv = (c.human_by or {}).get(n)
            if not rv:
                continue
            ncases += 1
            items += sum(1 for v in (rv.get("grades") or {}).values() if v and v.get("grade") is not None)
            pseudo.append(type("C", (), {"item_judgments": c.item_judgments, "pairwise": c.pairwise,
                                          "human_judgments": rv.get("grades") or {}, "human_pairwise": rv.get("pairwise") or {}})())
        ag = agreement(pseudo, threshold) if pseudo else {}
        out.append({"reviewer": n, "cases": ncases, "items": items, "kappa_llm": ag.get("kappa_quadratic"), "bias_llm": ag.get("bias"),
                    "exact_llm": ag.get("exact")})
    return out
