"""검색 지표와 통계.

- nDCG@k: 등급 관련도(0~3)를 순위 가중으로 합산, 같은 케이스에서 모든 대상이 찾은 항목을 모은 '풀'의 이상적 순서로 정규화
- Hit@1: 1위 항목이 관련(등급 ≥ 기준) 인지
- MRR: 첫 관련 항목 순위의 역수
- Precision@k: 상위 k 중 관련 항목 비율 (분모는 항상 k)
- 호출 실패는 0점으로 계산한다(사용자는 아무 결과도 받지 못했으므로). 실패율은 따로 보고한다.
"""

from __future__ import annotations

import math
import random
from statistics import mean, median
from typing import Any


def dcg(grades: list[int]) -> float:
    return sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(grades))


def case_metrics(
    grades: list[int], pool_grades: list[int], *, k: int, threshold: int
) -> dict[str, float | None]:
    top = grades[:k]
    ideal = sorted(pool_grades, reverse=True)[:k]
    idcg = dcg(ideal)
    first = next((i for i, g in enumerate(top) if g >= threshold), None)
    return {
        "ndcg": (dcg(top) / idcg) if idcg > 0 else None,
        "hit1": 1.0 if top and top[0] >= threshold else 0.0,
        "mrr": 1.0 / (first + 1) if first is not None else 0.0,
        "precision": sum(1 for g in top if g >= threshold) / k if k else 0.0,
        "top1_grade": float(top[0]) if top else None,
        "count": float(len(grades)),
    }


def failed_metrics() -> dict[str, float | None]:
    return {"ndcg": 0.0, "hit1": 0.0, "mrr": 0.0, "precision": 0.0, "top1_grade": None, "count": 0.0}


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def bootstrap_ci(diffs: list[float], *, iterations: int = 2000, alpha: float = 0.05, seed: int = 7) -> tuple[float, float] | None:
    """대응 차이의 평균에 대한 퍼센타일 부트스트랩 신뢰구간."""
    if len(diffs) < 2:
        return None
    rng = random.Random(seed)
    n = len(diffs)
    means = sorted(sum(rng.choices(diffs, k=n)) / n for _ in range(iterations))
    return means[int(iterations * alpha / 2)], means[int(iterations * (1 - alpha / 2)) - 1]


def permutation_test_p(diffs: list[float], *, iterations: int = 5000, seed: int = 11) -> float | None:
    """대응 무작위화(부호 뒤집기) 검정, 양측. IR 에서 권장되는 유의성 검정(Smucker et al., 2007).

    케이스 16건 이하면 모든 경우(2^n)를 다 세고, 300건 이하면 무작위로 iterations 번 뽑고,
    그보다 많으면 부호를 뒤집은 합의 분포가 정규분포에 매우 가깝다는 사실(중심극한정리)로 계산한다.
    """
    xs = [d for d in diffs if d is not None]
    n = len(xs)
    if n < 2:
        return None
    obs = abs(sum(xs))
    if obs == 0:
        return 1.0
    eps = 1e-12
    if n <= 16:
        hits = 0
        for mask in range(1 << n):
            s = sum(x if (mask >> i) & 1 else -x for i, x in enumerate(xs))
            hits += abs(s) >= obs - eps
        return hits / (1 << n)
    if n > 300:
        sd = math.sqrt(sum(x * x for x in xs))
        z = obs / sd
        return max(0.0, min(1.0, math.erfc(z / math.sqrt(2))))
    rng = random.Random(seed)
    total = sum(xs)
    hits = 0
    for _ in range(iterations):
        bits = rng.getrandbits(n)
        flipped = sum(x for i, x in enumerate(xs) if (bits >> i) & 1)
        hits += abs(total - 2 * flipped) >= obs - eps
    return (hits + 1) / (iterations + 1)


def effect_size_dz(diffs: list[float]) -> float | None:
    """대응 효과 크기 Cohen's d_z = 평균 차 / 차의 표준편차. 0.2 작음 · 0.5 중간 · 0.8 큼."""
    if len(diffs) < 2:
        return None
    m = mean(diffs)
    sd = math.sqrt(sum((d - m) ** 2 for d in diffs) / (len(diffs) - 1))
    return m / sd if sd > 0 else None


def needed_cases(diffs: list[float], *, z_alpha: float = 1.96, z_power: float = 0.8416) -> int | None:
    """지금 관측한 차이·분산이라면 유의수준 5%·검정력 80%로 확인하는 데 필요한 케이스 수(정규 근사)."""
    if len(diffs) < 2:
        return None
    m = mean(diffs)
    sd = math.sqrt(sum((d - m) ** 2 for d in diffs) / (len(diffs) - 1))
    if sd == 0 or abs(m) < 1e-9:
        return None
    return math.ceil(((z_alpha + z_power) * sd / abs(m)) ** 2)


def wilson_ci(successes: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """비율의 윌슨 95% 구간(목록 비교 승률에 사용)."""
    if n == 0:
        return None
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def holm(pvalues: list[float | None]) -> list[float | None]:
    """Holm–Bonferroni 보정(후보가 여럿일 때 우연히 '개선'이 나올 확률을 묶어서 5%로 관리)."""
    idx = sorted((p, i) for i, p in enumerate(pvalues) if p is not None)
    m = len(idx)
    out: list[float | None] = [None] * len(pvalues)
    running = 0.0
    for rank, (p, i) in enumerate(idx):
        running = max(running, min(1.0, (m - rank) * p))
        out[i] = running
    return out


def sign_test_p(wins: int, losses: int) -> float | None:
    """무승부를 제외한 양측 부호 검정 p-값(정확 이항)."""
    n = wins + losses
    if n == 0:
        return None
    k = min(wins, losses)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * p)


def _avg(values: list[float | None]) -> float | None:
    vals = [v for v in values if v is not None]
    return mean(vals) if vals else None


MIN_CASES_FOR_VERDICT = 10


def summarize(cases: list[dict[str, Any]], members: list[dict[str, Any]]) -> dict[str, Any]:
    """완료된 케이스 목록 → 실행 요약.

    cases: [{category, metrics:{label:{...,"ok","latency_ms","empty"}}, pairwise:{cand:{winner,consistent}}}]
    members: [{label, is_baseline}]
    """
    baseline = next((m["label"] for m in members if m.get("is_baseline")), members[0]["label"] if members else "")
    targets = []
    for m in members:
        label = m["label"]
        rows = [c["metrics"].get(label) for c in cases if c["metrics"].get(label)]
        latencies = [r["latency_ms"] for r in rows if r.get("ok") and r.get("latency_ms") is not None]
        targets.append({
            "label": label,
            "is_baseline": label == baseline,
            "cases": len(rows),
            "ndcg": _avg([r.get("ndcg") for r in rows]),
            "hit1": _avg([r.get("hit1") for r in rows]),
            "mrr": _avg([r.get("mrr") for r in rows]),
            "precision": _avg([r.get("precision") for r in rows]),
            "error_rate": (sum(1 for r in rows if not r.get("ok")) / len(rows)) if rows else None,
            "empty_rate": (sum(1 for r in rows if r.get("ok") and r.get("empty")) / len(rows)) if rows else None,
            "latency_p50": median(latencies) if latencies else None,
            "latency_p95": percentile(latencies, 0.95),
        })

    comparisons = []
    for m in members:
        cand = m["label"]
        if cand == baseline:
            continue
        diffs: list[float] = []
        hit_diffs: list[float] = []
        wins = losses = ties = inconsistent = judged = 0
        base_rows: list[dict[str, Any]] = []
        for c in cases:
            # 후보마다 평가 기준이 다르면 그 기준으로 판정한 기준 API 지표가 "{기준}@{후보}" 에 있다
            a, b = c["metrics"].get(cand), c["metrics"].get(f"{baseline}@{cand}") or c["metrics"].get(baseline)
            if b:
                base_rows.append(b)
            if a and b and not a.get("ok") and not b.get("ok"):
                continue  # 둘 다 호출 실패 — 품질 비교에서 제외(실패율로 따로 보고)
            if a and b and a.get("ndcg") is not None and b.get("ndcg") is not None:
                diffs.append(a["ndcg"] - b["ndcg"])
            if a and b:
                hit_diffs.append((a.get("hit1") or 0) - (b.get("hit1") or 0))
            pw = (c.get("pairwise") or {}).get(cand)
            if pw:
                judged += 1
                if pw["winner"] == "candidate":
                    wins += 1
                elif pw["winner"] == "baseline":
                    losses += 1
                else:
                    ties += 1
                if pw.get("consistent") is False:
                    inconsistent += 1
        ci = bootstrap_ci(diffs)
        hit_ci = bootstrap_ci(hit_diffs)
        diff = mean(diffs) if diffs else None
        perm_p = permutation_test_p(diffs)
        comparisons.append({
            "candidate": cand,
            "baseline": baseline,
            "ndcg_cases": len(diffs),
            # 이 후보의 평가 기준으로 본 기준 API 평균(후보마다 기준이 다를 수 있음)
            "baseline_ndcg": _avg([r.get("ndcg") for r in base_rows]),
            "baseline_hit1": _avg([r.get("hit1") for r in base_rows]),
            "ndcg_diff": diff,
            "ndcg_ci": list(ci) if ci else None,
            "hit1_diff": mean(hit_diffs) if hit_diffs else None,
            "hit1_ci": list(hit_ci) if hit_ci else None,
            "permutation_p": perm_p,
            "effect_size": effect_size_dz(diffs),
            "needed_cases": needed_cases(diffs),
            "ndcg_sd": (math.sqrt(sum((d - mean(diffs)) ** 2 for d in diffs) / (len(diffs) - 1)) if len(diffs) > 1 else None),
            "improved_cases": sum(1 for d in diffs if d > 1e-9),
            "regressed_cases": sum(1 for d in diffs if d < -1e-9),
            "same_cases": sum(1 for d in diffs if abs(d) <= 1e-9),
            "pairwise_cases": judged,
            "wins": wins,
            "losses": losses,
            "ties": ties,
            "inconsistent": inconsistent,
            "win_rate": wins / (wins + losses) if wins + losses else None,
            "win_rate_ci": list(wilson_ci(wins, wins + losses)) if wins + losses else None,
            "win_rate_with_ties": (wins + 0.5 * ties) / judged if judged else None,
            "sign_test_p": sign_test_p(wins, losses),
            "verdict": verdict(diff, ci, len(diffs), wins, losses, judged),
        })

    # 후보가 여럿이면 순열 검정 p 를 Holm 으로 보정하고, 결론도 보정된 p 로 한 번 더 거른다
    adjusted = holm([c["permutation_p"] for c in comparisons])
    for c, p_adj in zip(comparisons, adjusted, strict=True):
        c["permutation_p_holm"] = p_adj if len(comparisons) > 1 else c["permutation_p"]
        c["multiple_comparisons"] = len(comparisons)
        if len(comparisons) > 1 and c["verdict"]["code"] in ("improved", "regressed") and p_adj is not None and p_adj >= 0.05:
            c["verdict"] = {
                "code": "no_difference",
                "title": "후보가 여럿이라 보정하면 의미 있는 차이가 아닙니다",
                "detail": f"신뢰구간은 0을 벗어났지만, 후보 {len(comparisons)}개를 함께 비교한 것을 감안한 보정 p={p_adj:.3f} 가 0.05 이상입니다. "
                          "케이스를 늘려 다시 확인하세요.",
            }

    categories: dict[str, dict[str, Any]] = {}
    for c in cases:
        cat = c.get("category") or "(미분류)"
        bucket = categories.setdefault(cat, {"category": cat, "cases": 0, "ndcg": {}, "wins": {}, "losses": {}})
        bucket["cases"] += 1
        for m in members:
            r = c["metrics"].get(m["label"])
            if r and r.get("ndcg") is not None:
                bucket["ndcg"].setdefault(m["label"], []).append(r["ndcg"])
        for cand, pw in (c.get("pairwise") or {}).items():
            if pw["winner"] == "candidate":
                bucket["wins"][cand] = bucket["wins"].get(cand, 0) + 1
            elif pw["winner"] == "baseline":
                bucket["losses"][cand] = bucket["losses"].get(cand, 0) + 1
    by_category = []
    for bucket in sorted(categories.values(), key=lambda b: -b["cases"]):
        by_category.append({
            "category": bucket["category"],
            "cases": bucket["cases"],
            "ndcg": {k: mean(v) for k, v in bucket["ndcg"].items()},
            "wins": bucket["wins"],
            "losses": bucket["losses"],
        })

    no_relevant = sum(
        1 for c in cases if c["metrics"] and all(r.get("ndcg") is None for r in c["metrics"].values() if r.get("ok"))
        and any(r.get("ok") for r in c["metrics"].values())
    )
    warnings = []
    for t in targets:
        if t["error_rate"] and t["error_rate"] >= 0.1:
            warnings.append(
                f"{t['label']} 호출 실패율이 {t['error_rate'] * 100:.0f}% 입니다. 실패한 케이스는 0점으로 계산되므로 "
                "품질 차이가 아니라 장애·설정 문제일 수 있습니다. 검색 API 설정(주소·키)을 확인하세요."
            )
    if cases and no_relevant >= max(1, len(cases) // 2):
        warnings.append(
            f"절반 이상의 케이스({no_relevant}건)에서 어느 대상도 관련 항목을 찾지 못했습니다. "
            "데이터셋 질의가 검색 범위 밖이거나 평가 기준이 너무 엄격할 수 있습니다."
        )
    return {
        "baseline": baseline,
        "cases": len(cases),
        "warnings": warnings,
        "no_relevant_cases": no_relevant,
        "targets": targets,
        "comparisons": comparisons,
        "by_category": by_category,
    }


RECOMMENDED_CASES = 30


def verdict(
    diff: float | None, ci: tuple[float, float] | None, n: int, wins: int, losses: int, judged: int
) -> dict[str, Any]:
    v = _verdict(diff, ci, n, wins, losses, judged)
    # 결론은 냈지만 케이스가 권장(30건)보다 적으면 '근거 약함'으로 표시한다
    if v["code"] in ("improved", "regressed", "no_difference") and n < RECOMMENDED_CASES:
        v["weak"] = True
        v["detail"] += f" 다만 케이스가 {n}건으로 권장 {RECOMMENDED_CASES}건보다 적어 근거가 약합니다."
    return v


def _verdict(
    diff: float | None, ci: tuple[float, float] | None, n: int, wins: int, losses: int, judged: int
) -> dict[str, Any]:
    """사람이 바로 읽을 결론. 주 근거는 nDCG 차이의 95% 신뢰구간, 보조 근거는 목록 비교 승패."""
    if n == 0 and judged == 0:
        return {"code": "no_data", "title": "판단할 데이터가 없습니다", "detail": "비교할 수 있는 케이스가 없습니다. 아직 완료된 케이스가 없거나, 모든 케이스에서 대상 호출이 실패했습니다."}
    if n < MIN_CASES_FOR_VERDICT or ci is None:
        return {
            "code": "inconclusive",
            "title": "케이스가 부족해 판단을 보류합니다",
            "detail": f"관련 항목이 있는 케이스가 {n}건입니다. 신뢰할 만한 결론에는 {MIN_CASES_FOR_VERDICT}건 이상, 가능하면 30건 이상이 필요합니다.",
        }
    lo, hi = ci
    pair = f"목록 비교는 {wins}승 {losses}패" if judged else "목록 비교 판정 없음"
    if lo > 0:
        return {
            "code": "improved",
            "title": "후보가 기준보다 개선되었습니다",
            "detail": f"nDCG 차이 +{diff:.3f} (95% 신뢰구간 {lo:+.3f} ~ {hi:+.3f})로 0보다 확실히 큽니다. {pair}.",
        }
    if hi < 0:
        return {
            "code": "regressed",
            "title": "후보가 기준보다 나빠졌습니다",
            "detail": f"nDCG 차이 {diff:.3f} (95% 신뢰구간 {lo:+.3f} ~ {hi:+.3f})로 0보다 확실히 작습니다. {pair}.",
        }
    return {
        "code": "no_difference",
        "title": "의미 있는 차이가 없습니다",
        "detail": f"nDCG 차이 {diff:+.3f} 이지만 95% 신뢰구간({lo:+.3f} ~ {hi:+.3f})이 0을 포함해 우연일 수 있습니다. {pair}.",
    }
