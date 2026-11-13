import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { ANIM, AXIS_TICK, BAD, CURSOR_FILL, CURSOR_LINE, ChartEmpty, ChartTooltip, GOOD, GRID, LEGEND_STYLE, NEUTRAL } from "@/components/ui/chart";
import { api, qs } from "@/lib/api";
import { Section } from "@/components/ui/page";
import { cn, fmt } from "@/lib/format";
import type { CaseRow, Comparison, RunDetails, RunSummary } from "@/lib/types";
import { Pair, Panel, SectionTitle, targetColor } from "./RunCharts";

/*
 * 지표 상세 — 요약 숫자 뒤의 분포를 본다. 모두 케이스별 지표(cases[].metrics)로 화면에서 계산한다.
 *  1) ΔMetrics: 지표마다 (후보 − 기준) 평균과 95% 신뢰구간(포레스트 플롯)
 *  2) nDCG 산점도: 케이스마다 기준(x) vs 후보(y), 대각선 위 = 후보가 좋음
 *  3) nDCG 분포: 0~1 을 10칸으로 나눈 히스토그램
 *  4) 첫 관련 결과 순위 분포: MRR·Hit@1 이 어디서 나오는지
 *  5) 1위 등급 변화: 기준 1위 등급 → 후보 1위 등급 행렬
 */

type Pt = { id: number; key: string; base: number; cand: number };

/** 시드 고정 난수 — 다시 그려도 신뢰구간이 흔들리지 않게 */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 짝지은 차이의 평균과 부트스트랩 95% 구간 */
function bootstrap(diffs: number[], n = 1000): { mean: number; ci: [number, number] } | null {
  if (diffs.length < 2) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const r = rng(42);
  const means: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(r() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { mean, ci: [means[Math.floor(n * 0.025)], means[Math.floor(n * 0.975)]] };
}

function Forest({ rows }: { rows: { name: string; ko: string; mean: number | null; ci: [number, number] | null }[] }) {
  const valid = rows.filter((r) => r.mean !== null);
  if (!valid.length) return <ChartEmpty>비교할 케이스가 부족합니다.</ChartEmpty>;
  const m = Math.max(0.05, ...valid.flatMap((r) => [Math.abs(r.mean!), ...(r.ci ? r.ci.map(Math.abs) : [])]));
  const lim = Math.ceil(m * 1.15 * 100) / 100;
  const pos = (v: number) => `${((v + lim) / (2 * lim)) * 100}%`;
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim];
  return (
    <div className="text-[13px]">
      <div className="grid grid-cols-[minmax(120px,170px)_1fr_minmax(150px,190px)] items-end gap-x-4 pb-2 text-[11.5px] text-faint">
        <span />
        <div className="relative h-4">
          {ticks.map((t) => <span key={t} className="num absolute -translate-x-1/2" style={{ left: pos(t) }}>{fmt.signed(t, 2)}</span>)}
        </div>
        <span className="text-right">평균 [95% 구간]</span>
      </div>
      <div className="divide-y divide-line border-y border-line">
        {rows.map((r) => {
          const tone = r.ci ? (r.ci[0] > 0 ? "good" : r.ci[1] < 0 ? "bad" : "neutral") : "neutral";
          const col = tone === "good" ? GOOD : tone === "bad" ? BAD : "rgb(var(--faint))";
          return (
            <div key={r.name} className="grid grid-cols-[minmax(120px,170px)_1fr_minmax(150px,190px)] items-center gap-x-4 py-3">
              <span className="min-w-0"><span className="font-semibold">{r.name}</span> <span className="text-muted">{r.ko}</span></span>
              <div className="relative h-6">
                {ticks.map((t) => <span key={t} className={cn("absolute inset-y-0 w-px", t === 0 ? "bg-faint/60" : "bg-line")} style={{ left: pos(t) }} />)}
                {r.mean !== null && r.ci && (
                  <span className="absolute top-1/2 h-[3px] -translate-y-1/2 origin-center animate-[bar-x_0.6s_var(--ease-out)_both] rounded-full" style={{ left: pos(r.ci[0]), width: `calc(${pos(r.ci[1])} - ${pos(r.ci[0])})`, background: col, opacity: 0.55 }} />
                )}
                {r.mean !== null && (
                  <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel shadow-sm" style={{ left: pos(r.mean), background: col }} />
                )}
              </div>
              <span className={cn("num text-right", tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-muted")}>
                <b className="font-semibold">{fmt.signed(r.mean)}</b> {r.ci ? `[${fmt.signed(r.ci[0])}, ${fmt.signed(r.ci[1])}]` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NdcgScatter({ pts, baseline, candidate, onOpen }: { pts: Pt[]; baseline: string; candidate: string; onOpen: (id: number) => void }) {
  if (!pts.length) return <ChartEmpty>비교할 케이스가 없습니다.</ChartEmpty>;
  const groups = [
    { name: `${candidate} 우세`, data: pts.filter((p) => p.cand - p.base > 1e-9), fill: GOOD },
    { name: "같음", data: pts.filter((p) => Math.abs(p.cand - p.base) <= 1e-9), fill: NEUTRAL },
    { name: `${baseline} 우세`, data: pts.filter((p) => p.base - p.cand > 1e-9), fill: BAD },
  ];
  return (
    <div className="h-[280px]">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis type="number" dataKey="base" name={baseline} domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={AXIS_TICK} axisLine={false} tickLine={false}
            label={{ value: `${baseline} (기준)`, position: "insideBottomRight", offset: -4, fontSize: 11.5, fill: "rgb(var(--muted))" }} />
          <YAxis type="number" dataKey="cand" name={candidate} domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40}
            label={{ value: candidate, angle: -90, position: "insideTopLeft", offset: 12, fontSize: 11.5, fill: "rgb(var(--muted))" }} />
          <ZAxis range={[46, 46]} />
          <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="rgb(var(--faint) / 0.6)" strokeDasharray="4 4" ifOverflow="extendDomain" />
          <Tooltip cursor={{ strokeDasharray: "3 3", stroke: "rgb(var(--faint) / 0.5)" }} content={({ active, payload }) => {
            const p = active ? (payload?.[0]?.payload as Pt | undefined) : undefined;
            return p ? <ChartTooltip title={p.key} rows={[
              { name: `${baseline} nDCG`, value: fmt.num(p.base) },
              { name: `${candidate} nDCG`, value: fmt.num(p.cand) },
              { name: "차이", value: fmt.signed(p.cand - p.base) },
            ]} footer="눌러서 케이스 보기" /> : null;
          }} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
          {groups.map((g) => (
            <Scatter key={g.name} name={`${g.name} ${g.data.length}`} data={g.data} fill={g.fill} fillOpacity={0.75} className="cursor-pointer"
              onClick={(d: { payload?: Pt }) => d.payload && onOpen(d.payload.id)} {...ANIM} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function GroupedBars({ data, series, unit = "%", height = 260 }: { data: Record<string, number | string>[]; series: { key: string; name: string; color: string }[]; unit?: string; height?: number }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="bin" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} tickMargin={6} />
          <YAxis tickFormatter={(v) => `${v}${unit}`} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
          <Tooltip cursor={CURSOR_FILL} content={({ active, payload, label }) => active && payload?.length ? (
            <ChartTooltip title={String(label)} rows={payload.map((p) => ({ color: String(p.color), name: String(p.name), value: `${Number(p.value).toFixed(0)}${unit}` }))} />
          ) : null} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
          {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[5, 5, 0, 0]} maxBarSize={18} {...ANIM} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const GRADES = [3, 2, 1, 0, -1] as const;
const GRADE_TEXT: Record<number, string> = { 3: "3 매우 관련", 2: "2 관련", 1: "1 약간", 0: "0 무관", [-1]: "결과 없음" };

function Transition({ cases, baseline, candidate }: { cases: CaseRow[]; baseline: string; candidate: string }) {
  const g = (v: number | null | undefined) => (v === null || v === undefined ? -1 : Math.round(v));
  const counts = new Map<string, number>();
  let up = 0, same = 0, down = 0;
  for (const c of cases) {
    const a = c.metrics?.[baseline], b = c.metrics?.[candidate];
    if (!a || !b) continue;
    const ga = g(a.top1_grade), gb = g(b.top1_grade);
    counts.set(`${ga}:${gb}`, (counts.get(`${ga}:${gb}`) ?? 0) + 1);
    if (gb > ga) up++; else if (gb < ga) down++; else same++;
  }
  const total = up + same + down;
  if (!total) return <ChartEmpty>비교할 케이스가 없습니다.</ChartEmpty>;
  const max = Math.max(...counts.values());
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
        <span className="text-good">좋아짐 {up}</span><span className="text-muted">같음 {same}</span><span className="text-bad">나빠짐 {down}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[360px] border-separate border-spacing-1 text-[12px]">
          <thead>
            <tr>
              <th className="text-left font-normal text-faint">{baseline} ↓ · {candidate} →</th>
              {GRADES.map((c) => <th key={c} className="px-1 text-center font-medium text-muted">{GRADE_TEXT[c]}</th>)}
            </tr>
          </thead>
          <tbody>
            {GRADES.map((r) => (
              <tr key={r}>
                <th className="whitespace-nowrap pr-2 text-left font-medium text-muted">{GRADE_TEXT[r]}</th>
                {GRADES.map((c) => {
                  const n = counts.get(`${r}:${c}`) ?? 0;
                  const a = n ? 0.12 + (n / max) * 0.6 : 0;
                  const bg = !n ? "rgb(var(--subtle) / 0.6)" : c > r ? `rgb(var(--good) / ${a})` : c < r ? `rgb(var(--bad) / ${a})` : `rgb(var(--faint) / ${a * 0.7})`;
                  return (
                    <td key={c} title={`${baseline} ${GRADE_TEXT[r]} → ${candidate} ${GRADE_TEXT[c]}: ${n}건`}
                      className={cn("num h-9 rounded-lg text-center font-semibold transition-colors", n ? "text-ink" : "text-faint/60")} style={{ background: bg }}>
                      {n || "·"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── 서버에서 계산한 상세 지표(/runs/{id}/details)로 그리는 패널 ── */

function BigNums({ items }: { items: { label: string; value: string; sub?: string; tone?: "good" | "bad" }[] }) {
  return (
    <div className="grid grid-cols-3 border-y border-line">
      {items.map((it, i) => (
        <div key={it.label} className={cn("min-w-0 py-3.5", i > 0 && "border-l border-line pl-4")}>
          <div className="truncate text-[12px] text-muted">{it.label}</div>
          <div className={cn("num mt-1 text-[22px] font-bold leading-none tracking-tight", it.tone === "good" ? "text-good" : it.tone === "bad" ? "text-bad" : "")}>{it.value}</div>
          {it.sub && <div className="mt-1 truncate text-[11.5px] text-muted">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function OverlapPanel({ d }: { d: RunDetails }) {
  const o = d.overlap;
  if (!o.cases) return <ChartEmpty>비교할 결과 목록이 없습니다.</ChartEmpty>;
  const labels = ["0–0.2", "0.2–0.4", "0.4–0.6", "0.6–0.8", "0.8–1"];
  const data = o.hist.map((n, i) => ({ bin: labels[i], cand: (n / o.cases) * 100 }));
  return (
    <div className="space-y-5">
      <BigNums items={[
        { label: "평균 겹침 (Jaccard)", value: fmt.num(o.mean_jaccard, 2), sub: "1 이면 같은 결과 집합" },
        { label: "1위 동일", value: fmt.pct(o.top1_same_rate), sub: `${o.cases}건 중` },
        { label: "순서까지 동일", value: fmt.pct(o.identical_rate), sub: "변경이 영향 없음" },
      ]} />
      <GroupedBars height={190} data={data} series={[{ key: "cand", name: "케이스 비율 (Jaccard 구간별)", color: "rgb(var(--accent) / 0.75)" }]} />
      <div className="text-[12.5px] text-muted">
        평균 결과 수 {d.baseline} {fmt.num(o.mean_filled.baseline, 1)} · {d.candidate} {fmt.num(o.mean_filled.candidate, 1)} / {d.k}
        {((o.short_rate.baseline ?? 0) > 0 || (o.short_rate.candidate ?? 0) > 0) && <> · {d.k}개 미만 반환 {fmt.pct(o.short_rate.baseline)} → {fmt.pct(o.short_rate.candidate)}</>}
      </div>
    </div>
  );
}

function RankGradePanel({ d, colors }: { d: RunDetails; colors: { base: string; cand: string } }) {
  const data = d.grade_by_rank.baseline.map((r, i) => ({ bin: `${r.rank}위`, base: r.mean, cand: d.grade_by_rank.candidate[i]?.mean ?? null, nb: r.n, nc: d.grade_by_rank.candidate[i]?.n ?? 0 }));
  if (!data.some((r) => r.base !== null || r.cand !== null)) return <ChartEmpty>판정된 항목이 없습니다.</ChartEmpty>;
  return (
    <div className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="bin" tick={AXIS_TICK} axisLine={false} tickLine={false} tickMargin={6} />
          <YAxis domain={[0, 3]} ticks={[0, 1, 2, 3]} tick={AXIS_TICK} axisLine={false} tickLine={false} width={28} />
          <ReferenceLine y={d.relevant_threshold} stroke="rgb(var(--good) / 0.5)" strokeDasharray="4 4"
            label={{ value: `관련 기준 ${d.relevant_threshold}`, position: "insideTopRight", fontSize: 11, fill: "rgb(var(--good))" }} />
          <Tooltip cursor={CURSOR_LINE} content={({ active, payload, label }) => active && payload?.length ? (
            <ChartTooltip title={String(label)} rows={payload.map((p) => ({ color: String(p.color), name: String(p.name), value: p.value === null || p.value === undefined ? "–" : Number(p.value).toFixed(2) }))} />
          ) : null} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
          <Line type="monotone" dataKey="base" name={`${d.baseline} (기준)`} stroke={colors.base} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: colors.base }} connectNulls {...ANIM} />
          <Line type="monotone" dataKey="cand" name={d.candidate} stroke={colors.cand} strokeWidth={2.5} dot={{ r: 3.5, strokeWidth: 0, fill: colors.cand }} connectNulls {...ANIM} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RelevantFoundPanel({ d }: { d: RunDetails }) {
  const { items, cases } = d.relevant_found;
  const total = items.both + items.baseline_only + items.candidate_only;
  if (!total) return <ChartEmpty>‘관련’ 이상으로 판정된 결과가 없습니다.</ChartEmpty>;
  const parts = [
    { key: "base", name: `${d.baseline} 만 찾음`, n: items.baseline_only, color: BAD },
    { key: "both", name: "양쪽 모두", n: items.both, color: NEUTRAL },
    { key: "cand", name: `${d.candidate} 만 찾음`, n: items.candidate_only, color: GOOD },
  ];
  const c = cases.gain + cases.same + cases.loss || 1;
  return (
    <div className="space-y-5">
      <div className="flex h-3.5 gap-[3px] overflow-hidden rounded-full">
        {parts.filter((p) => p.n).map((p) => (
          <span key={p.key} title={`${p.name} ${p.n}개`} className="h-full origin-left animate-[bar-x_0.7s_var(--ease-out)_both] rounded-full" style={{ width: `${(p.n / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="divide-y divide-line border-y border-line">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center gap-3 py-2.5 text-[13.5px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="num font-semibold">{p.n}개</span>
            <span className="num w-12 text-right text-muted">{fmt.pct(p.n / total)}</span>
          </div>
        ))}
      </div>
      <div className="text-[12.5px] text-muted">
        케이스별 관련 결과 수 <span className="text-good">늘어남 {cases.gain}</span> · 같음 {cases.same} · <span className="text-bad">줄어듦 {cases.loss}</span>
        <span className="text-faint"> (늘어난 비율 {fmt.pct(cases.gain / c)})</span>
      </div>
    </div>
  );
}

function AgreementPanel({ d }: { d: RunDetails }) {
  const a = d.agreement;
  if (!a.cases) return <ChartEmpty>목록 비교 판정이 없습니다.</ChartEmpty>;
  const rows = [
    { key: "candidate" as const, label: `${d.candidate} 승` },
    { key: "tie" as const, label: "무승부" },
    { key: "baseline" as const, label: `${d.baseline} 승` },
  ];
  const cols = [{ key: "up" as const, label: "nDCG ↑" }, { key: "same" as const, label: "nDCG =" }, { key: "down" as const, label: "nDCG ↓" }];
  const max = Math.max(1, ...rows.flatMap((r) => cols.map((c) => a.matrix[r.key][c.key])));
  const agrees = (r: string, c: string) => (r === "candidate" && c === "up") || (r === "baseline" && c === "down") || (r === "tie" && c === "same");
  const opposite = (r: string, c: string) => (r === "candidate" && c === "down") || (r === "baseline" && c === "up");
  const conf = a.confidence;
  const confTotal = conf.high + conf.medium + conf.low;
  return (
    <div className="space-y-4">
      <BigNums items={[
        { label: "같은 방향", value: fmt.pct(a.agree_rate), tone: "good" },
        { label: "반대 방향", value: fmt.pct(a.opposite_rate), tone: (a.opposite_rate ?? 0) > 0.2 ? "bad" : undefined },
        { label: "판정 확신도 high", value: confTotal ? fmt.pct(conf.high / confTotal) : "–", sub: `medium ${conf.medium} · low ${conf.low}` },
      ]} />
      <table className="w-full border-separate border-spacing-1 text-[12px]">
        <thead>
          <tr><th className="text-left font-normal text-faint">목록 비교 ↓ · ΔnDCG →</th>{cols.map((c) => <th key={c.key} className="text-center font-medium text-muted">{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th className="whitespace-nowrap pr-2 text-left font-medium text-muted">{r.label}</th>
              {cols.map((c) => {
                const n = a.matrix[r.key][c.key];
                const alpha = n ? 0.12 + (n / max) * 0.55 : 0;
                const bg = !n ? "rgb(var(--subtle) / 0.6)" : agrees(r.key, c.key) ? `rgb(var(--good) / ${alpha})` : opposite(r.key, c.key) ? `rgb(var(--bad) / ${alpha})` : `rgb(var(--faint) / ${alpha * 0.7})`;
                return <td key={c.key} className={cn("num h-9 rounded-lg text-center font-semibold", n ? "text-ink" : "text-faint/60")} style={{ background: bg }} title={`${r.label} · ${c.label}: ${n}건`}>{n || "·"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricDetails({ runId, summary, cases, candidate, baseline, cmp, k, onOpenCase }: {
  runId?: number; summary: RunSummary; cases: CaseRow[]; candidate: string; baseline: string; cmp: Comparison; k: number; onOpenCase: (id: number) => void;
}) {
  const targets = summary.targets ?? [];
  const details = useQuery({
    queryKey: ["run-details", runId, candidate, summary.cases],
    queryFn: () => api.get<RunDetails>(`/runs/${runId}/details${qs({ candidate })}`),
    enabled: !!runId,
  });
  const d = details.data;
  const paired = useMemo(() => cases.filter((c) => c.status === "done" && c.metrics?.[baseline]?.ok !== false && c.metrics?.[candidate]?.ok !== false
    && c.metrics?.[baseline] && c.metrics?.[candidate]), [cases, baseline, candidate]);

  const forest = useMemo(() => {
    const diff = (key: "mrr" | "precision") => bootstrap(paired.map((c) => (c.metrics[candidate][key] ?? 0) - (c.metrics[baseline][key] ?? 0)));
    const mrr = diff("mrr");
    const p = diff("precision");
    return [
      { name: `ΔnDCG@${k}`, ko: "순위 품질", mean: cmp.ndcg_diff, ci: cmp.ndcg_ci },
      { name: "ΔHit@1", ko: "1위 정답률", mean: cmp.hit1_diff, ci: cmp.hit1_ci ?? null },
      { name: "ΔMRR", ko: "첫 정답 순위", mean: mrr?.mean ?? null, ci: mrr?.ci ?? null },
      { name: `ΔP@${k}`, ko: "정밀도", mean: p?.mean ?? null, ci: p?.ci ?? null },
    ];
  }, [paired, cmp, k, baseline, candidate]);

  const pts: Pt[] = useMemo(() => paired
    .filter((c) => c.metrics[baseline].ndcg !== null && c.metrics[candidate].ndcg !== null && c.metrics[baseline].ndcg !== undefined && c.metrics[candidate].ndcg !== undefined)
    .map((c) => ({ id: c.id, key: c.case_key, base: c.metrics[baseline].ndcg as number, cand: c.metrics[candidate].ndcg as number })), [paired, baseline, candidate]);

  const hist = useMemo(() => {
    const bins = Array.from({ length: 10 }, (_, i) => ({ bin: `${(i / 10).toFixed(1)}`, base: 0, cand: 0 }));
    for (const p of pts) {
      bins[Math.min(9, Math.floor(p.base * 10))].base++;
      bins[Math.min(9, Math.floor(p.cand * 10))].cand++;
    }
    const n = pts.length || 1;
    return bins.map((b) => ({ ...b, base: (b.base / n) * 100, cand: (b.cand / n) * 100 }));
  }, [pts]);

  // 첫 관련 결과 순위 = 1/MRR (케이스별 MRR 은 1/첫 관련 순위, 없으면 0)
  const ranks = useMemo(() => {
    const labels = [...Array.from({ length: k }, (_, i) => `${i + 1}위`), "없음"];
    const rows = labels.map((bin) => ({ bin, base: 0, cand: 0 }));
    for (const c of paired) {
      for (const [side, label] of [["base", baseline], ["cand", candidate]] as const) {
        const m = c.metrics[label].mrr ?? 0;
        const r = m > 0 ? Math.min(k, Math.round(1 / m)) : 0;
        rows[r > 0 ? r - 1 : k][side]++;
      }
    }
    const n = paired.length || 1;
    return rows.map((r) => ({ ...r, base: (r.base / n) * 100, cand: (r.cand / n) * 100 }));
  }, [paired, k, baseline, candidate]);

  const series = [
    { key: "base", name: `${baseline} (기준)`, color: targetColor(targets, baseline) },
    { key: "cand", name: candidate, color: targetColor(targets, candidate) },
  ];

  return (
    <Section title={<SectionTitle hint="요약 숫자 뒤의 분포를 봅니다. 평균이 같아도 일부 케이스가 크게 나빠졌는지, 어느 순위·등급에서 차이가 나는지 확인할 수 있습니다.">지표 상세</SectionTitle>}>
      <div className="border-y border-line py-6">
        <div className="mb-5"><Panel name="ΔMetrics" ko={`지표별 차이 · ${candidate} − ${baseline}`} term="ndcg_diff" className="py-0"
          hint="점은 케이스 평균 차이, 선은 95% 신뢰구간입니다. 선 전체가 0 오른쪽이면 확실한 개선(초록), 왼쪽이면 확실한 저하(빨강), 0 을 걸치면 우연일 수 있는 차이(회색)입니다. nDCG·Hit@1 은 서버 계산값, MRR·P@k 는 부트스트랩(1,000회).">
          <Forest rows={forest} />
        </Panel></div>
      </div>
      <Pair>
        <Panel name={`nDCG@${k} scatter`} ko="케이스별 기준 vs 후보" term="ndcg"
          hint={`점 하나가 케이스 하나입니다. 점선(대각선) 위면 ${candidate} 가, 아래면 기준이 더 좋습니다. 점을 누르면 케이스 상세가 열립니다.`}>
          <NdcgScatter pts={pts} baseline={baseline} candidate={candidate} onOpen={onOpenCase} />
        </Panel>
        <Panel name={`nDCG@${k} distribution`} ko="nDCG 분포" term="ndcg"
          hint="케이스의 nDCG 를 0.1 단위 구간으로 나눈 비율입니다. 오른쪽(1 에 가까운 구간)에 많을수록 좋고, 왼쪽 꼬리가 길면 크게 실패하는 질의가 있다는 뜻입니다.">
          {pts.length ? <GroupedBars data={hist} series={series} /> : <ChartEmpty>비교할 케이스가 없습니다.</ChartEmpty>}
        </Panel>
      </Pair>
      <Pair>
        <Panel name="MRR · First relevant rank" ko="첫 관련 결과의 순위 분포" term="mrr"
          hint={`처음으로 ‘관련’ 이상이 나온 순위의 비율입니다. 1위 비율이 곧 Hit@1 이고, MRR 은 1/순위의 평균입니다. ‘없음’은 상위 ${k}개 안에 관련 결과가 없던 케이스입니다.`}>
          {paired.length ? <GroupedBars data={ranks} series={series} /> : <ChartEmpty>비교할 케이스가 없습니다.</ChartEmpty>}
        </Panel>
        <Panel name="Top-1 grade transition" ko="1위 등급 변화" term="grade"
          hint={`기준 1위 결과의 등급(행)이 ${candidate} 에서 어떻게 바뀌었는지(열) 케이스 수로 봅니다. 대각선 오른쪽 위(초록)는 좋아진 케이스, 왼쪽 아래(빨강)는 나빠진 케이스입니다.`}>
          <Transition cases={paired} baseline={baseline} candidate={candidate} />
        </Panel>
      </Pair>
      {d && (
        <>
          <Pair>
            <Panel name={`Overlap@${k}`} ko="결과 겹침"
              hint={`기준과 ${candidate} 의 상위 ${k}개가 얼마나 같은지 봅니다(Jaccard = 공통 결과 수 ÷ 합친 결과 수). 1에 가까우면 변경이 결과를 거의 바꾸지 않았다는 뜻이라, 품질 차이가 작게 나오는 이유가 됩니다. 0에 가까우면 완전히 다른 결과를 보여 줍니다.`}>
              <OverlapPanel d={d} />
            </Panel>
            <Panel name="Graded relevance by rank" ko="순위별 평균 등급" term="grade"
              hint={`각 순위에 놓인 결과의 평균 관련도 등급(0~3)입니다. 1위부터 빨리 떨어지면 상위 몇 개만 쓸 만하다는 뜻이고, 점선(관련 기준 ${d.relevant_threshold}) 위에 오래 머물수록 좋습니다.`}>
              <RankGradePanel d={d} colors={{ base: targetColor(targets, baseline), cand: targetColor(targets, candidate) }} />
            </Panel>
          </Pair>
          <Pair>
            <Panel name="Relevant coverage" ko="관련 결과 발견"
              hint={`상위 ${k}개 안의 ‘관련’(${d.relevant_threshold} 이상) 결과를 기준만 찾았는지, ${candidate} 만 찾았는지, 둘 다 찾았는지 셉니다. 초록(후보만)이 크면 새로 찾아낸 정답이 많고, 빨강(기준만)이 크면 놓친 정답이 많습니다.`}>
              <RelevantFoundPanel d={d} />
            </Panel>
            <Panel name="Pairwise ↔ ΔnDCG" ko="목록 비교와 nDCG 일치도" term="pairwise"
              hint="LLM 이 목록을 통째로 본 판정(행)과 항목 등급으로 계산한 nDCG 차이의 방향(열)이 같은지 봅니다. 같은 방향(초록)이 많을수록 두 지표가 같은 결론을 가리켜 믿을 만합니다. 반대 방향(빨강)이 많으면 판정 기준이나 평가 범위를 확인하세요. 판정 확신도는 두 번의 목록 비교에서 모델이 답한 확신 수준입니다.">
              <AgreementPanel d={d} />
            </Panel>
          </Pair>
        </>
      )}
    </Section>
  );
}
