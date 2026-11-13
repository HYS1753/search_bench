"""실행 결과를 한 장짜리 HTML 보고서로 — 결과 화면(요약)과 같은 순서·톤으로, 파일 하나만으로 열리고 인쇄된다.

외부 리소스(글꼴·스크립트·이미지)를 쓰지 않는다. 차트는 CSS 막대와 인라인 SVG 로 그린다.
"""

from __future__ import annotations

from datetime import datetime, timezone
from html import escape
from typing import Any

from app.evaluation.prompts import GRADE_LABELS
from app.models import Run, RunCase
from app.evaluation.details import run_details
from app.runs import member_prefix

WINNER_KO = {"candidate": "후보 승", "baseline": "기준 승", "tie": "무승부"}
STATUS_KO = {"done": "완료", "running": "진행 중", "queued": "대기", "failed": "실패", "cancelled": "취소", "interrupted": "중단"}
VERDICT_TONE = {"improved": "good", "regressed": "bad", "mixed": "warn", "insufficient": "warn"}
SERIES = ["#5b6bf0", "#38b2a0", "#e2a048", "#de709c", "#54a0de", "#9678e6"]
GRADE_COLORS = {"3": "rgba(91,107,240,1)", "2": "rgba(91,107,240,.62)", "1": "rgba(91,107,240,.3)", "0": "rgba(152,160,174,.25)"}


def e(v: Any) -> str:
    return escape("" if v is None else str(v))


def num(v: Any, d: int = 3) -> str:
    return "–" if v is None else f"{v:.{d}f}"


def signed(v: Any, d: int = 3) -> str:
    return "–" if v is None else f"{v:+.{d}f}"


def pct(v: Any, d: int = 0) -> str:
    return "–" if v is None else f"{v * 100:.{d}f}%"


def pval(p: Any) -> str:
    return "–" if p is None else ("<0.001" if p < 0.001 else f"{p:.3f}")


def tone_of(v: float | None) -> str:
    return "" if v is None or abs(v) < 1e-9 else ("good" if v > 0 else "bad")


def dt(v: datetime | None) -> str:
    if not v:
        return "–"
    # DB 시각은 UTC(naive) — 보고서는 한국 시간으로 표시
    from zoneinfo import ZoneInfo

    return v.replace(tzinfo=timezone.utc).astimezone(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d %H:%M")


def duration(a: datetime | None, b: datetime | None) -> str:
    if not a or not b:
        return "–"
    s = int((b - a).total_seconds())
    return f"{s // 3600}시간 {s % 3600 // 60}분" if s >= 3600 else f"{s // 60}분 {s % 60}초" if s >= 60 else f"{s}초"


def _inputs_text(v: Any) -> str:
    return ", ".join(map(str, v)) if isinstance(v, list) else ("" if v is None else str(v))


def _section(title: str, desc: str, body: str, ko: str = "") -> str:
    d = f'<p class="desc">{e(desc)}</p>' if desc else ""
    k = f' <span class="ko">{e(ko)}</span>' if ko else ""
    return f'<section><h2>{e(title)}{k}</h2>{d}{body}</section>'


def _mt(name: str, ko: str) -> str:
    """지표 이름: 정식 명칭 + 한국어 이름"""
    return f'<b>{name}</b> <span class="ko">{e(ko)}</span>'


def _bootstrap(diffs: list[float], n: int = 1000) -> tuple[float, tuple[float, float]] | None:
    import random

    if len(diffs) < 2:
        return None
    rnd = random.Random(42)
    mean = sum(diffs) / len(diffs)
    means = sorted(sum(rnd.choice(diffs) for _ in diffs) / len(diffs) for _ in range(n))
    return mean, (means[int(n * 0.025)], means[int(n * 0.975)])


def _forest(c: dict[str, Any], cases: list[RunCase], k: int) -> str:
    cand, base = c["candidate"], c["baseline"]

    def paired(key: str) -> list[float]:
        out = []
        for x in cases:
            m = x.metrics or {}
            a, b = (m.get(cand) or {}), (m.get(base) or {})
            if a.get(key) is not None and b.get(key) is not None and a.get("ok", True) and b.get("ok", True):
                out.append(a[key] - b[key])
        return out

    rows = [(f"ΔnDCG@{k}", "순위 품질", c.get("ndcg_diff"), c.get("ndcg_ci")), ("ΔHit@1", "1위 정답률", c.get("hit1_diff"), c.get("hit1_ci"))]
    for key, name, ko in (("mrr", "ΔMRR", "첫 정답 순위"), ("precision", f"ΔP@{k}", "정밀도")):
        b = _bootstrap(paired(key))
        rows.append((name, ko, b[0] if b else None, list(b[1]) if b else None))
    vals = [abs(v) for _, _, m, ci in rows for v in ([m] if m is not None else []) + (list(ci) if ci else [])]
    lim = max(0.05, *vals) * 1.15 if vals else 0.05
    pos = lambda v: (v + lim) / (2 * lim) * 100  # noqa: E731
    ticks = [-lim, -lim / 2, 0, lim / 2, lim]
    axis = "".join(f'<span style="left:{pos(t):.2f}%">{signed(t, 2)}</span>' for t in ticks)
    lines = "".join(f'<i style="left:{pos(t):.2f}%"{" class=z" if t == 0 else ""}></i>' for t in ticks)
    out = [f'<div class="frow fhead"><span></span><div class="faxis">{axis}</div><span class="r">평균 [95% 구간]</span></div>']
    for name, ko, m, ci in rows:
        tone = "good" if ci and ci[0] > 0 else "bad" if ci and ci[1] < 0 else "neutral"
        seg = f'<span class="fci {tone}" style="left:{pos(ci[0]):.2f}%;width:{pos(ci[1]) - pos(ci[0]):.2f}%"></span>' if ci and m is not None else ""
        dot = f'<span class="fdot {tone}" style="left:{pos(m):.2f}%"></span>' if m is not None else ""
        txt = f'<b>{signed(m)}</b> [{signed(ci[0])}, {signed(ci[1])}]' if ci and m is not None else signed(m)
        out.append(f'<div class="frow"><span>{_mt(name, ko)}</span><div class="ftrack">{lines}{seg}{dot}</div>'
                   f'<span class="r num {"" if tone == "neutral" else tone}">{txt}</span></div>')
    return f'<h3>{e(cand)} − {e(base)}</h3><div class="forest">{"".join(out)}</div>'


def _target_color(targets: list[dict[str, Any]], label: str) -> str:
    cands = [t["label"] for t in targets if not t.get("is_baseline")]
    return "#b4bac6" if label not in cands else SERIES[cands.index(label) % len(SERIES)]


def _verdicts(comparisons: list[dict[str, Any]]) -> str:
    out = []
    for c in comparisons:
        v = c.get("verdict") or {}
        tone = VERDICT_TONE.get(v.get("code", ""), "neutral")
        out.append(
            f'<div class="verdict {tone}"><div class="eyebrow">결론 · {e(c["candidate"])} vs {e(c["baseline"])}(기준)</div>'
            f'<div class="vtitle">{e(v.get("title"))}</div><p>{e(v.get("detail"))}</p></div>'
        )
    return "".join(out)


def _key_stats(c: dict[str, Any], targets: dict[str, dict[str, Any]], k: int) -> str:
    ci = c.get("ndcg_ci")
    cand, base = targets.get(c["candidate"], {}), targets.get(c["baseline"], {})
    decided = c["wins"] + c["losses"]
    total = decided + c["ties"]
    stats = [
        (_mt(f"ΔnDCG@{k}", "순위 품질 차이"), signed(c.get("ndcg_diff")), tone_of(c.get("ndcg_diff")),
         f"95% 신뢰구간 {signed(ci[0])} ~ {signed(ci[1])}<br>{num(base.get('ndcg'))} → {num(cand.get('ndcg'))} · {c.get('ndcg_cases')}건" if ci else ""),
        (_mt("Win rate", "목록 비교 승률"), pct(c.get("win_rate")), "",
         f"{c['wins']}승 {c['ties']}무 {c['losses']}패 · 부호 검정 p {pval(c.get('sign_test_p'))}"),
        (_mt("Hit@1", "1위 정답률"), pct(cand.get("hit1")), tone_of(c.get("hit1_diff")),
         f"기준 {pct(base.get('hit1'))} · 차이 {signed((c.get('hit1_diff') or 0) * 100, 0)}%p"),
        (_mt("Consistency", "판정 일관성"), pct(1 - c["inconsistent"] / total) if total else "–", "",
         f"순서를 바꿔도 같은 판정 · 불일치 {c['inconsistent']}건"),
    ]
    cells = "".join(f'<div class="stat"><div class="label">{lb}</div><div class="value {t}">{v}</div><div class="sub">{s}</div></div>' for lb, v, t, s in stats)
    holm = (c.get("multiple_comparisons") or 1) > 1
    extra = (f'<div class="statline">Permutation p{" (Holm)" if holm else ""} 순열 검정 {pval(c.get("permutation_p_holm") if holm else c.get("permutation_p"))} · '
             f"Cohen's d<sub>z</sub> 효과 크기 {num(c.get('effect_size'), 2)} · Required n 필요 케이스 {e(c.get('needed_cases') or '–')}건</div>")
    return f'<h3>{e(c["candidate"])} vs {e(c["baseline"])}</h3><div class="stats">{cells}</div>{extra}'


def _metric_table(targets: list[dict[str, Any]], k: int) -> str:
    base = next((t for t in targets if t.get("is_baseline")), None)
    cols = [("ndcg", f"nDCG@{k}", 3), ("hit1", "Hit@1", None), ("mrr", "MRR", 3), ("precision", f"P@{k}", 3)]
    kos = {"ndcg": "순위 품질", "hit1": "1위 정답률", "mrr": "첫 정답 순위", "precision": "정밀도"}
    th = lambda name, ko: f"<th class='r'>{e(name)}<div class='thko'>{e(ko)}</div></th>"  # noqa: E731
    head = "".join(th(lb, kos[key]) for key, lb, _ in cols) + th("Error", "호출 실패율") + th("Empty", "0건 비율") + th("p50", "응답 시간") + th("p95", "응답 시간")
    rows = []
    for t in targets:
        cells = []
        for key, _, d in cols:
            v = t.get(key)
            tn = "" if t.get("is_baseline") or not base else tone_of((v or 0) - (base.get(key) or 0))
            text = pct(v) if d is None else num(v, d)
            bar = f'<span class="mbar"><span style="width:{(v or 0) * 100:.1f}%;background:{_target_color(targets, t["label"])}"></span></span>' if key == "ndcg" else ""
            cells.append(f"<td class='r num {tn}'>{bar}{text}</td>")
        badge = ' <span class="chip">기준</span>' if t.get("is_baseline") else ""
        dot = f'<span class="dot" style="background:{_target_color(targets, t["label"])}"></span>'
        rows.append(
            f"<tr><td class='b'>{dot}{e(t['label'])}{badge}</td>{''.join(cells)}"
            f"<td class='r num {'bad' if t.get('error_rate') else 'muted'}'>{pct(t.get('error_rate'), 1)}</td>"
            f"<td class='r num {'warn' if t.get('empty_rate') else 'muted'}'>{pct(t.get('empty_rate'), 1)}</td>"
            f"<td class='r num muted'>{num(t.get('latency_p50'), 0)}ms</td><td class='r num muted'>{num(t.get('latency_p95'), 0)}ms</td></tr>"
        )
    return f'<div class="tablewrap"><table><thead><tr><th>대상</th>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'


def _split_bars(comparisons: list[dict[str, Any]]) -> str:
    out = []
    for c in comparisons:
        total = c["wins"] + c["ties"] + c["losses"]
        if not total:
            continue
        parts = [(c["wins"], "var(--good-s)", f"{c['candidate']} 승"), (c["ties"], "var(--neutral-s)", "무승부"), (c["losses"], "var(--bad-s)", f"{c['baseline']} 승")]
        bar = "".join(f'<span style="width:{n / total * 100:.2f}%;background:{col}" title="{e(lb)} {n}건"></span>' for n, col, lb in parts if n)
        legend = "".join(f'<span><i style="background:{col}"></i>{e(lb)} <b class="num">{n}</b> <span class="muted num">{pct(n / total)}</span></span>' for n, col, lb in parts)
        out.append(f'<div class="split"><div class="splithead"><b>{e(c["candidate"])} vs {e(c["baseline"])}</b><span class="muted">승률(무승부 제외) <b class="num ink">{pct(c.get("win_rate"))}</b></span></div>'
                   f'<div class="splitbar">{bar}</div><div class="legend">{legend}</div></div>')
    return "".join(out) or '<p class="muted">목록 비교 판정이 없습니다.</p>'


def _grade_bars(dist: dict[str, Any], targets: list[dict[str, Any]], which: str) -> str:
    rows = []
    for t in targets:
        d = (dist.get(t["label"]) or {}).get(which) or {}
        total = sum(d.get(g, 0) for g in "3210") or 1
        segs = "".join(f'<span style="width:{d.get(g, 0) / total * 100:.2f}%;background:{GRADE_COLORS[g]}" title="{g} {GRADE_LABELS.get(int(g), "")} {d.get(g, 0)}"></span>' for g in "3210" if d.get(g))
        rows.append(f'<div class="grow"><span class="glabel">{e(t["label"])}{" (기준)" if t.get("is_baseline") else ""}</span><span class="gbar">{segs}</span>'
                    f'<span class="gval num">{pct(d.get("3", 0) / total)}</span></div>')
    return "".join(rows)


def _grade_legend() -> str:
    return '<div class="legend">' + "".join(f'<span><i style="background:{GRADE_COLORS[g]}"></i>{g} {e(GRADE_LABELS.get(int(g), ""))}</span>' for g in "3210") + "</div>"


def _category(summary: dict[str, Any], candidate: str, baseline: str) -> str:
    cats = summary.get("by_category") or []
    if len(cats) < 2:
        return ""
    rows = []
    for c in cats:
        b, x = c["ndcg"].get(baseline), c["ndcg"].get(candidate)
        rows.append((c, (x - b) if b is not None and x is not None else 0.0, b, x))
    rows.sort(key=lambda r: -r[1])
    lim = max(0.02, *(abs(r[1]) for r in rows)) * 1.15
    body = []
    for c, d, b, x in rows:
        w = abs(d) / lim * 50
        bar = f'<span class="dbar {"good" if d > 0 else "bad" if d < 0 else ""}" style="{"left:50%" if d >= 0 else f"left:{50 - w:.2f}%"};width:{w:.2f}%"></span>'
        body.append(f'<tr><td class="b">{e(c["category"])}</td><td class="r num muted">{c["cases"]}</td>'
                    f'<td class="r num">{num(b)}</td><td class="r num">{num(x)}</td>'
                    f'<td class="diffcell"><span class="dtrack"><span class="zero"></span>{bar}</span></td>'
                    f'<td class="r num {tone_of(d)}">{signed(d)}</td>'
                    f'<td class="r num muted">{c["wins"].get(candidate, 0)}승 {c["losses"].get(candidate, 0)}패</td></tr>')
    return (f'<div class="tablewrap"><table><thead><tr><th>분류</th><th class="r">케이스</th><th class="r">{e(baseline)} nDCG</th><th class="r">{e(candidate)} nDCG</th>'
            f'<th class="c">차이</th><th></th><th class="r">목록 비교</th></tr></thead><tbody>{"".join(body)}</tbody></table></div>')


def _diff_svg(diffs: list[float]) -> str:
    if not diffs:
        return '<p class="muted">비교할 케이스가 없습니다.</p>'
    diffs = sorted(diffs, reverse=True)
    lim = min(1.0, max(0.25, -(-max(abs(d) for d in diffs) * 4 // 1) / 4))
    w, h, n = 1000, 180, len(diffs)
    step = w / n
    bw = max(1.0, min(12.0, step * 0.72))
    mid = h / 2
    rects = []
    for i, d in enumerate(diffs):
        bh = abs(d) / lim * (mid - 6)
        y = mid - bh if d > 0 else mid
        col = "var(--good-s)" if d > 1e-9 else "var(--bad-s)" if d < -1e-9 else "var(--neutral-s)"
        rects.append(f'<rect x="{i * step + (step - bw) / 2:.2f}" y="{y:.2f}" width="{bw:.2f}" height="{max(bh, 1.5):.2f}" rx="2" fill="{col}"/>')
    grid = "".join(f'<line x1="0" x2="{w}" y1="{mid - f * (mid - 6):.1f}" y2="{mid - f * (mid - 6):.1f}" class="grid"/>' for f in (1, 0.5, -0.5, -1))
    labels = f'<div class="svgaxis"><span>{signed(lim, 2)}</span><span>0</span><span>{signed(-lim, 2)}</span></div>'
    return (f'<div class="svgwrap">{labels}<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" role="img" aria-label="케이스별 nDCG 차이">'
            f'{grid}<line x1="0" x2="{w}" y1="{mid}" y2="{mid}" class="zeroline"/>{"".join(rects)}</svg></div>')


def _cases_table(run: Run, cases: list[RunCase], candidate: str, baseline: str) -> str:
    members = [m["label"] for m in run.snapshot.get("members", [])]
    fields = run.snapshot.get("suite", {}).get("input_fields", [])
    first = next((f["key"] for f in fields if f.get("type") == "text"), fields[0]["key"] if fields else None)
    prefixes = member_prefix(run.snapshot)
    head = "".join(f"<th>{e(m)} 1위</th>" for m in members)
    rows = []
    for c in cases:
        met = c.metrics or {}
        cand_n, base_n = (met.get(candidate) or {}).get("ndcg"), (met.get(baseline) or {}).get("ndcg")
        diff = cand_n - base_n if cand_n is not None and base_n is not None else None
        pw = (c.pairwise or {}).get(candidate)
        pw_html = "–"
        if pw:
            tn = {"candidate": "good", "baseline": "bad"}.get(pw["winner"], "neutral")
            label = f"{candidate} 승" if pw["winner"] == "candidate" else WINNER_KO.get(pw["winner"], "")
            pw_html = f'<span class="pill {tn}">{e(label)}</span>' + ('' if pw.get("consistent") else ' <span class="pill warn">불일치</span>')
        resp = {r.label: r for r in c.responses}
        tops = []
        for m in members:
            r = resp.get(m)
            if not r:
                tops.append("<td class='muted'>–</td>")
            elif not r.ok:
                tops.append("<td class='bad small'>호출 실패</td>")
            elif not r.items:
                tops.append("<td class='muted small'>0건</td>")
            else:
                top = r.items[0]
                g = ((c.item_judgments or {}).get(prefixes.get(m, ("", 0))[0] + top["key"]) or {}).get("grade")
                chip = f' <span class="g g{g}" title="{e(GRADE_LABELS.get(g, ""))}">{g}</span>' if g is not None else ""
                tops.append(f"<td><span class='ell'>{e(top['title'])}</span>{chip}</td>")
        reason = f'<div class="reason">{e(pw.get("reason"))}</div>' if pw and pw.get("reason") else ""
        err = f'<div class="reason bad">{e(c.error)}</div>' if c.error else ""
        rows.append(
            f'<tr><td class="b nowrap">{e(c.case_key)}<div class="muted small">{e(c.category)}</div></td>'
            f'<td class="q">{e(_inputs_text(c.inputs.get(first)) if first else "")}{reason}{err}</td>'
            f'<td class="r num b {tone_of(diff) or "muted"}">{signed(diff, 2)}</td><td class="nowrap">{pw_html}</td>{"".join(tops)}</tr>'
        )
    return (f'<div class="tablewrap"><table class="cases"><thead><tr><th>케이스</th><th>질의 · 판정 근거</th><th class="r">nDCG 차이</th>'
            f'<th>목록 비교</th>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>')


GRADE_ROWS = [3, 2, 1, 0, -1]
GRADE_TXT = {3: "3 매우 관련", 2: "2 관련", 1: "1 약간", 0: "0 무관", -1: "결과 없음"}


def _bars(groups: list[str], series: list[tuple[str, str, list[float]]], unit: str = "%") -> str:
    """세로 묶음 막대(CSS). series = [(이름, 색, 값들)] — 값은 0~100(%)"""
    mx = max([v for _, _, vals in series for v in vals] + [1])
    cols = []
    for i, g in enumerate(groups):
        bars = "".join(f'<span title="{e(name)} {vals[i]:.0f}{unit}" style="height:{vals[i] / mx * 100:.1f}%;background:{col}"></span>' for name, col, vals in series)
        cols.append(f'<div class="vcol"><div class="vbars">{bars}</div><div class="vlab">{e(g)}</div></div>')
    legend = "".join(f'<span><i style="background:{col}"></i>{e(name)}</span>' for name, col, _ in series)
    return f'<div class="vchart">{"".join(cols)}</div><div class="legend" style="margin-top:8px">{legend}</div>'


def _heat(rows: list[tuple[str, Any]], cols: list[tuple[str, Any]], get, tone, corner: str) -> str:
    mx = max([get(r, c) for _, r in rows for _, c in cols] + [1])
    head = "".join(f"<th class='c'>{e(lb)}</th>" for lb, _ in cols)
    body = []
    for lb, r in rows:
        cells = []
        for _, c in cols:
            n = get(r, c)
            a = 0.12 + n / mx * 0.55 if n else 0
            t = tone(r, c)
            bg = "var(--subtle)" if not n else f"rgba(13,148,104,{a:.2f})" if t == "good" else f"rgba(214,64,69,{a:.2f})" if t == "bad" else f"rgba(152,160,174,{a * 0.7:.2f})"
            cells.append(f'<td class="hc num" style="background:{bg}">{n or "·"}</td>')
        body.append(f"<tr><th class='hr'>{e(lb)}</th>{''.join(cells)}</tr>")
    return f'<table class="heat"><thead><tr><th class="hr muted">{e(corner)}</th>{head}</tr></thead><tbody>{"".join(body)}</tbody></table>'


def _nums(items: list[tuple[str, str, str]]) -> str:
    return '<div class="nums">' + "".join(f'<div><div class="label">{e(lb)}</div><div class="nval num {t}">{v}</div></div>' for lb, v, t in items) + "</div>"


def _rank_svg(d: dict[str, Any], cb: str, cc: str) -> str:
    k = d["k"]
    w, h, pad = 600, 200, 28
    xs = lambda i: pad + (w - 2 * pad) * (i / max(1, k - 1))  # noqa: E731
    ys = lambda g: h - pad - (h - 2 * pad) * (g / 3)  # noqa: E731
    lines = []
    for side, col in (("baseline", cb), ("candidate", cc)):
        pts = [(xs(i), ys(r["mean"])) for i, r in enumerate(d["grade_by_rank"][side]) if r["mean"] is not None]
        if pts:
            lines.append(f'<polyline fill="none" stroke="{col}" stroke-width="2.5" stroke-linejoin="round" points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in pts)}"/>')
            lines += [f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="{col}"/>' for x, y in pts]
    grid = "".join(f'<line x1="{pad}" x2="{w - pad}" y1="{ys(g):.1f}" y2="{ys(g):.1f}" class="grid"/><text x="4" y="{ys(g) + 4:.1f}" class="axis">{g}</text>' for g in range(4))
    thr = f'<line x1="{pad}" x2="{w - pad}" y1="{ys(d["relevant_threshold"]):.1f}" y2="{ys(d["relevant_threshold"]):.1f}" stroke="var(--good)" stroke-opacity=".5" stroke-dasharray="4 4"/>'
    xl = "".join(f'<text x="{xs(i):.1f}" y="{h - 6}" text-anchor="middle" class="axis">{i + 1}위</text>' for i in range(k))
    return f'<svg viewBox="0 0 {w} {h}" class="linesvg" role="img" aria-label="순위별 평균 등급">{grid}{thr}{"".join(lines)}{xl}</svg>'


def _details_sections(run: Run, cases: list[RunCase], targets: list[dict[str, Any]]) -> list[str]:
    out = []
    for cand, d in run_details(run, cases).items():
        base, k, n = d["baseline"], d["k"], d["cases"] or 1
        cb, cc = _target_color(targets, base), _target_color(targets, cand)
        if cb == "#b4bac6":
            cb = "#9aa1ad"
        head = f'<h3 class="dhead">{e(cand)} vs {e(base)} <span class="ko">상위 {k}개 · 관련 ≥ {d["relevant_threshold"]} · {d["cases"]}건</span></h3>'
        # 분포 2종
        hist = _bars([f"{i / 10:.1f}" for i in range(10)], [(f"{base} (기준)", cb, [v / n * 100 for v in d["ndcg_hist"]["baseline"]]), (cand, cc, [v / n * 100 for v in d["ndcg_hist"]["candidate"]])])
        ranks = _bars([f"{i + 1}위" for i in range(k)] + ["없음"], [(f"{base} (기준)", cb, [v / n * 100 for v in d["first_rank"]["baseline"]]), (cand, cc, [v / n * 100 for v in d["first_rank"]["candidate"]])])
        tr = d["grade_transition"]
        trans = _heat([(GRADE_TXT[g], g) for g in GRADE_ROWS], [(GRADE_TXT[g], g) for g in GRADE_ROWS], lambda r, c: tr.get(f"{r}:{c}", 0),
                      lambda r, c: "good" if c > r else "bad" if c < r else "", f"{base} ↓ · {cand} →")
        ov = d["overlap"]
        overlap = _nums([("평균 겹침 (Jaccard)", num(ov["mean_jaccard"], 2), ""), ("1위 동일", pct(ov["top1_same_rate"]), ""), ("순서까지 동일", pct(ov["identical_rate"]), "")]) + \
            _bars(["0–0.2", "0.2–0.4", "0.4–0.6", "0.6–0.8", "0.8–1"], [("케이스 비율", "rgba(91,107,240,.75)", [v / (ov["cases"] or 1) * 100 for v in ov["hist"]])]) + \
            f'<p class="desc" style="margin-top:8px">평균 결과 수 {e(base)} {num(ov["mean_filled"]["baseline"], 1)} · {e(cand)} {num(ov["mean_filled"]["candidate"], 1)} / {k}</p>'
        rf = d["relevant_found"]
        tot = sum(rf["items"].values()) or 1
        parts = [(rf["items"]["baseline_only"], "var(--bad-s)", f"{base} 만 찾음"), (rf["items"]["both"], "var(--neutral-s)", "양쪽 모두"), (rf["items"]["candidate_only"], "var(--good-s)", f"{cand} 만 찾음")]
        cover = (f'<div class="splitbar">{"".join(f"<span style=width:{v / tot * 100:.2f}%;background:{col}></span>" for v, col, _ in parts if v)}</div>'
                 f'<div class="legend">{"".join(f"<span><i style=background:{col}></i>{e(lb)} <b class=num>{v}</b></span>" for v, col, lb in parts)}</div>'
                 f'<p class="desc" style="margin-top:8px">케이스별 관련 결과 수 <span class="good">늘어남 {rf["cases"]["gain"]}</span> · 같음 {rf["cases"]["same"]} · <span class="bad">줄어듦 {rf["cases"]["loss"]}</span></p>')
        ag = d["agreement"]
        conf = ag["confidence"]
        ct = sum(conf.values())
        agree = _nums([("같은 방향", pct(ag["agree_rate"]), "good"), ("반대 방향", pct(ag["opposite_rate"]), "bad" if (ag["opposite_rate"] or 0) > 0.2 else ""),
                       ("판정 확신도 high", pct(conf["high"] / ct) if ct else "–", "")]) + \
            _heat([(f"{cand} 승", "candidate"), ("무승부", "tie"), (f"{base} 승", "baseline")], [("nDCG ↑", "up"), ("nDCG =", "same"), ("nDCG ↓", "down")],
                  lambda r, c: ag["matrix"][r][c],
                  lambda r, c: "good" if (r, c) in (("candidate", "up"), ("baseline", "down"), ("tie", "same")) else "bad" if (r, c) in (("candidate", "down"), ("baseline", "up")) else "",
                  "목록 비교 ↓ · ΔnDCG →")
        rank_legend = f'<div class="legend"><span><i style="background:{cb}"></i>{e(base)} (기준)</span><span><i style="background:{cc}"></i>{e(cand)}</span></div>'
        out.append(
            f'<section>{head}'
            f'<div class="pair"><div><h3>{_mt(f"nDCG@{k} distribution", "nDCG 분포")}</h3>{hist}</div>'
            f'<div><h3>{_mt("MRR · First relevant rank", "첫 관련 결과의 순위 분포")}</h3>{ranks}</div></div>'
            f'<div class="pair"><div><h3>{_mt("Top-1 grade transition", "1위 등급 변화")}</h3>{trans}</div>'
            f'<div><h3>{_mt("Graded relevance by rank", "순위별 평균 등급")}</h3>{_rank_svg(d, cb, cc)}{rank_legend}</div></div>'
            f'<div class="pair"><div><h3>{_mt(f"Overlap@{k}", "결과 겹침")}</h3>{overlap}</div>'
            f'<div><h3>{_mt("Relevant coverage", "관련 결과 발견")}</h3>{cover}</div></div>'
            f'<div class="pair"><div><h3>{_mt("Pairwise ↔ ΔnDCG", "목록 비교와 nDCG 일치도")}</h3>{agree}</div><div></div></div>'
            f'</section>'
        )
    return out


def _settings(run: Run) -> str:
    snap = run.snapshot
    crit = snap.get("criteria", {})
    jm = snap.get("judge_model", {})
    kv = [
        ("비교 세트", snap.get("suite", {}).get("name")),
        ("판정 모델", f"{jm.get('name', '–')} ({jm.get('model', '')})"),
        ("평가 기준", crit.get("name")),
        ("평가 범위", f"상위 {crit.get('k')}개 · 관련 ≥ {crit.get('relevant_threshold')} · {'목록 비교 포함' if crit.get('pairwise_enabled') else '항목 판정만'}"),
        ("검색 목적", crit.get("task_context") or "(공용 문장)"),
        ("사용자 요구사항", crit.get("user_requirements") or "없음"),
        ("판정 호출 · 토큰", f"{run.judge_calls:,}회 · 입력 {run.tokens_input:,} / 출력 {run.tokens_output:,}"),
        ("추정 비용", f"${run.cost_estimate:.4f}"),
    ]
    for m in snap.get("members", []):
        t = m.get("target", {})
        kv.append((f"대상 {m['label']}{' (기준)' if m.get('is_baseline') else ''}", f"{t.get('method', '')} {t.get('base_url', '')}{t.get('path', '')}"))
    return '<dl class="kv">' + "".join(f"<dt>{e(k)}</dt><dd>{e(v)}</dd>" for k, v in kv) + "</dl>"


CSS = """
:root{--bg:#f7f8fa;--panel:#fff;--subtle:#f2f4f7;--line:#e6e8ec;--ink:#141821;--muted:#666e7c;--faint:#98a0ae;--accent:#5b6bf0;
--good:#0d9468;--bad:#d64045;--warn:#c48006;--good-s:rgba(13,148,104,.78);--bad-s:rgba(214,64,69,.72);--neutral-s:rgba(152,160,174,.32);
--good-bg:#e5f7ef;--bad-bg:#fdeded;--warn-bg:#fef6de;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1015;--panel:#161920;--subtle:#1e222b;--line:#2a2f3a;--ink:#e8ebf0;--muted:#a0a8b6;--faint:#707887;
--accent:#8491ff;--good:#34c78c;--bad:#ff7676;--warn:#f0b446;--good-s:rgba(52,199,140,.8);--bad-s:rgba(255,118,118,.75);--neutral-s:rgba(112,120,135,.4);
--good-bg:#122e24;--bad-bg:#3c1a1c;--warn-bg:#382c12;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
.page{max-width:1080px;margin:0 auto;padding:48px 32px 72px}
.num{font-variant-numeric:tabular-nums}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;color:var(--muted);margin-bottom:28px}
.brand b{color:var(--ink)}.brand em{font-style:normal;color:var(--accent)}
.logo{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#7b87ff,#5b6bf0);display:inline-flex;align-items:flex-end;justify-content:center;gap:2px;padding:5px}
.logo i{display:block;width:3px;background:#fff;border-radius:1px}
h1{font-size:28px;line-height:1.25;margin:0;letter-spacing:-.02em;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.meta{color:var(--muted);margin:10px 0 0;font-size:13.5px}
.status{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;background:var(--good-bg);color:var(--good)}
section{margin-top:48px}
h2{font-size:19px;margin:0;letter-spacing:-.02em}
h3{font-size:15px;margin:22px 0 10px}
.desc{color:var(--muted);margin:4px 0 16px;font-size:13.5px}
.verdict{border:1px solid var(--line);border-left:4px solid var(--faint);background:var(--panel);border-radius:14px;padding:18px 22px;margin-top:12px}
.verdict.good{border-left-color:var(--good)}.verdict.bad{border-left-color:var(--bad)}.verdict.warn{border-left-color:var(--warn)}
.verdict .eyebrow{font-size:12.5px;color:var(--muted)}.verdict .vtitle{font-size:20px;font-weight:700;margin:2px 0 4px;letter-spacing:-.02em}
.verdict p{margin:0;color:var(--muted);font-size:13.5px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line)}
.stat{padding:18px 20px;border-bottom:1px solid var(--line);border-left:1px solid var(--line)}.stat:first-child{border-left:0;padding-left:0}
.stat .label{font-size:13px;color:var(--muted)}.stat .value{font-size:28px;font-weight:700;line-height:1.1;margin-top:8px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat .sub{font-size:12.5px;color:var(--muted);margin-top:8px;line-height:1.45}
.statline{font-size:12.5px;color:var(--muted);padding:10px 0;border-bottom:1px solid var(--line)}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}.ink{color:var(--ink)}.small{font-size:12px}.b{font-weight:600}.nowrap{white-space:nowrap}
.tablewrap{overflow-x:auto;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{font-weight:500;color:var(--muted);font-size:12.5px;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:0}
th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}
.r{text-align:right}.c{text-align:center}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;vertical-align:1px}
.chip{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:0 7px;margin-left:6px}
.mbar{display:inline-block;width:70px;height:6px;border-radius:99px;background:var(--subtle);margin-right:10px;vertical-align:2px;overflow:hidden}.mbar span{display:block;height:100%;border-radius:99px}
.split{padding:14px 0;border-bottom:1px solid var(--line)}.split:first-child{border-top:1px solid var(--line)}
.splithead{display:flex;justify-content:space-between;gap:12px;font-size:13.5px}
.splitbar{display:flex;gap:3px;height:12px;margin:10px 0}.splitbar span{border-radius:99px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:var(--ink)}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:0 40px}
.grow{display:flex;align-items:center;gap:12px;padding:6px 0}.glabel{width:110px;flex:none;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gbar{flex:1;display:flex;height:12px;border-radius:99px;overflow:hidden;gap:2px}.gval{width:42px;text-align:right;font-size:12.5px;color:var(--muted)}
.diffcell{width:32%;min-width:160px}.dtrack{position:relative;display:block;height:12px}.zero{position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--faint)}
.dbar{position:absolute;top:2px;height:8px;border-radius:99px;background:var(--neutral-s)}.dbar.good{background:var(--good-s)}.dbar.bad{background:var(--bad-s)}
.svgwrap{position:relative;padding-left:48px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding-top:14px;padding-bottom:14px}
.svgwrap svg{width:100%;height:180px;display:block}.svgaxis{position:absolute;left:0;top:14px;bottom:14px;display:flex;flex-direction:column;justify-content:space-between;font-size:11.5px;color:var(--faint)}
.grid{stroke:var(--line);stroke-dasharray:3 5}.zeroline{stroke:var(--faint);stroke-opacity:.6}
.counts{font-size:12.5px;display:flex;gap:14px;margin:-6px 0 12px}
.pill{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:1px 8px;background:var(--subtle);color:var(--muted)}
.pill.good{background:var(--good-bg);color:var(--good)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
.g{display:inline-flex;min-width:20px;justify-content:center;font-size:11px;font-weight:700;border-radius:999px;padding:0 6px;margin-left:6px;background:var(--subtle);color:var(--muted)}
.g3{background:var(--good-bg);color:var(--good)}.g2{background:rgba(91,107,240,.12);color:var(--accent)}.g1{background:var(--warn-bg);color:var(--warn)}
.cases td.q{max-width:340px}.reason{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5}
.ell{display:inline-block;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.kv{display:grid;grid-template-columns:180px 1fr;margin:0;border-top:1px solid var(--line)}
.kv dt,.kv dd{margin:0;padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px}.kv dt{color:var(--muted)}.kv dd{white-space:pre-line;word-break:break-all}
.warnbox{margin-top:16px;border-radius:12px;background:var(--warn-bg);color:var(--warn);padding:12px 16px;font-size:13px}
h2 .ko,h3 .ko,.label .ko{font-weight:400;color:var(--muted)}h2 .ko{font-size:15px}.label b{color:var(--ink)}
.thko{font-size:11px;font-weight:400;color:var(--faint)}th .thko{margin-top:1px}
.forest{border-top:1px solid var(--line)}.frow{display:grid;grid-template-columns:minmax(150px,200px) 1fr minmax(170px,210px);gap:16px;align-items:center;padding:11px 0;border-bottom:1px solid var(--line);font-size:13px}
.fhead{padding:6px 0;font-size:11.5px;color:var(--faint);border-bottom:0}.faxis{position:relative;height:16px}.faxis span{position:absolute;transform:translateX(-50%)}
.ftrack{position:relative;height:22px}.ftrack i{position:absolute;top:0;bottom:0;width:1px;background:var(--line)}.ftrack i.z{background:var(--faint)}
.fci{position:absolute;top:50%;height:3px;margin-top:-1.5px;border-radius:99px;background:var(--faint);opacity:.55}.fci.good{background:var(--good)}.fci.bad{background:var(--bad)}
.fdot{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid var(--panel);background:var(--faint)}.fdot.good{background:var(--good)}.fdot.bad{background:var(--bad)}
.dhead{font-size:16px;margin:8px 0 4px}.vchart{display:flex;align-items:flex-end;gap:6px;height:150px;border-bottom:1px solid var(--line);padding-top:6px}
.vcol{flex:1;display:flex;flex-direction:column;align-items:stretch;height:100%;min-width:0}.vbars{flex:1;display:flex;align-items:flex-end;justify-content:center;gap:2px}
.vbars span{display:block;width:40%;max-width:14px;border-radius:4px 4px 0 0;min-height:1px}.vlab{font-size:10.5px;color:var(--faint);text-align:center;padding-top:4px;white-space:nowrap}
.heat{border-collapse:separate;border-spacing:3px;font-size:12px;width:100%}.heat th{border:0;padding:2px 4px;font-weight:500;color:var(--muted);font-size:11.5px}.heat .hr{text-align:left;white-space:nowrap}
.hc{height:32px;text-align:center;font-weight:600;border-radius:8px;border:0;padding:0}
.nums{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:12px}.nums>div{padding:10px 0}.nums>div+div{border-left:1px solid var(--line);padding-left:12px}
.nums .label{font-size:12px;color:var(--muted)}.nval{font-size:22px;font-weight:700;letter-spacing:-.02em;margin-top:2px}
.linesvg{width:100%;height:auto;display:block}.linesvg .axis{font-size:11px;fill:var(--faint)}.linesvg .grid{stroke:var(--line);stroke-dasharray:3 5}
.pair+.pair{margin-top:18px}
footer{margin-top:56px;color:var(--faint);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
@media (max-width:760px){.frow{grid-template-columns:1fr;gap:4px}.fhead{display:none}.page{padding:28px 16px 48px}.stats{grid-template-columns:1fr 1fr}.stat:nth-child(3){border-left:0;padding-left:0}.pair{grid-template-columns:1fr}.kv{grid-template-columns:1fr}.kv dt{border-bottom:0;padding-bottom:0}}
@media print{body{background:#fff}.page{padding:0;max-width:none}section{break-inside:avoid-page}.cases tr{break-inside:avoid}.tablewrap{overflow:visible}
@page{margin:14mm}}
"""


def to_html(run: Run, cases: list[RunCase]) -> str:
    s = run.summary or {}
    snap = run.snapshot
    targets = s.get("targets") or []
    by_label = {t["label"]: t for t in targets}
    comparisons = s.get("comparisons") or []
    k = snap.get("criteria", {}).get("k") or 5
    members = snap.get("members", [])
    dataset = snap.get("dataset", {}) if isinstance(snap.get("dataset"), dict) else {}
    jm = snap.get("judge_model", {})
    meta = " · ".join(filter(None, [
        f"#{run.id}",
        " vs ".join(f"{m['label']}{'(기준)' if m.get('is_baseline') else ''}" for m in members),
        dataset.get("name"),
        f"판정 {jm.get('name', '–')} ({jm.get('model', '')})",
        f"시작 {dt(run.started_at or run.created_at)}",
        f"소요 {duration(run.started_at, run.finished_at)}",
    ]))

    parts: list[str] = []
    if comparisons:
        parts.append(_verdicts(comparisons))
    for w in s.get("warnings") or []:
        parts.append(f'<div class="warnbox">{e(w if isinstance(w, str) else w.get("text") or w.get("message") or w)}</div>')
    if comparisons:
        parts.append(_section("핵심 지표", f"평가 기준 · {snap.get('criteria', {}).get('name', '')} (상위 {k}개)",
                              "".join(_key_stats(c, by_label, k) for c in comparisons)))
        parts.append(_section("ΔMetrics", "점은 케이스 평균 차이, 선은 95% 신뢰구간. 선 전체가 0 오른쪽이면 확실한 개선(초록), 왼쪽이면 확실한 저하(빨강), 0 을 걸치면 우연일 수 있는 차이입니다.",
                              "".join(_forest(c, cases, k) for c in comparisons), ko="지표별 차이와 신뢰구간"))
    if targets:
        parts.append(_section("Metrics by target", "후보 행에서 기준보다 좋은 값은 초록, 나쁜 값은 빨강으로 표시합니다. 막대는 nDCG.", _metric_table(targets, k), ko="대상별 지표"))
    if comparisons:
        parts.append(_section("Win rate", "두 결과 목록을 통째로 보고 어느 쪽이 더 유용한지 판정한 결과입니다.", _split_bars(comparisons), ko="목록 비교 승률"))
    dist = s.get("grade_distribution")
    if dist and targets:
        parts.append(_section(
            "결과의 질", "판정 모델이 매긴 관련도 등급의 비율입니다. 진한 색(매우 관련·관련)이 넓을수록 좋습니다. 오른쪽 숫자는 ‘매우 관련’ 비율.",
            f'<div class="pair"><div><h3>{_mt("Hit@1", "1위 결과의 등급 분포")}</h3>{_grade_bars(dist, targets, "top1")}</div>'
            f'<div><h3>{_mt(f"P@{k}", f"상위 {k}개 등급 분포")}</h3>{_grade_bars(dist, targets, "items")}</div></div><div style="margin-top:12px">{_grade_legend()}</div>'))
    primary = comparisons[0] if comparisons else None
    if primary:
        cand, base = primary["candidate"], primary["baseline"]
        diffs = []
        for c in cases:
            m = c.metrics or {}
            a, b = (m.get(cand) or {}).get("ndcg"), (m.get(base) or {}).get("ndcg")
            if a is not None and b is not None:
                diffs.append(a - b)
        counts = (f'<div class="counts"><span class="good">개선 {primary.get("improved_cases", 0)}</span>'
                  f'<span class="muted">같음 {primary.get("same_cases", 0)}</span><span class="bad">저하 {primary.get("regressed_cases", 0)}</span></div>')
        parts.append(_section(f"ΔnDCG@{k} by case", f"막대 하나가 케이스 하나이고, 높이는 {cand} − {base} 의 nDCG 차이입니다. 위 결론의 승·패는 ‘목록 비교’ 판정이라 개수가 다를 수 있습니다.",
                              counts + _diff_svg(diffs), ko="케이스별 nDCG 차이"))
        details = _details_sections(run, cases, targets)
        if details:
            parts.append(_section("지표 상세", "요약 숫자 뒤의 분포와 결과 변화입니다. 후보마다 기준과 비교합니다.", ""))
            parts.extend(details)
        cat = _category(s, cand, base)
        if cat:
            parts.append(_section(f"ΔnDCG@{k} by category", f"분류마다 {cand} 가 기준보다 nDCG 가 얼마나 높은지(초록)·낮은지(빨강) 봅니다.", cat, ko="분류별 nDCG 차이"))
        parts.append(_section("케이스", f"전체 {len(cases)}건 · 차이와 목록 비교는 {cand} vs {base} 기준. 1위 옆 숫자는 관련도 등급(3 매우 관련 ~ 0 무관).",
                              _cases_table(run, cases, cand, base)))
    parts.append(_section("실행 설정", "실행 시점의 설정 사본입니다.", _settings(run)))

    status = STATUS_KO.get(run.status, run.status)
    status_style = "" if run.status == "done" else ' style="background:var(--warn-bg);color:var(--warn)"'
    generated = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(run.name)} · 평가 결과 #{run.id}</title><style>{CSS}</style></head>
<body><main class="page">
<div class="brand"><span class="logo"><i style="height:5px"></i><i style="height:8px"></i><i style="height:12px"></i></span><span><b>Search</b><em>Bench</em> · 평가 결과 보고서</span></div>
<h1>{e(run.name)} <span class="status"{status_style}>{e(status)}</span></h1>
<p class="meta">{e(meta)}</p>
{"".join(parts)}
<footer>SearchBench에서 {generated}에 내보냄 · 추정 비용과 판정은 실행 당시 설정 기준입니다.</footer>
</main></body></html>"""
