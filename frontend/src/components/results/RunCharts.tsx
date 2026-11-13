import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ANIM, AXIS_TICK, BAD, BASELINE_COLOR, CATEGORY_TICK, CURSOR_FILL, ChartEmpty, ChartTooltip, GOOD, GRID, LEGEND_STYLE, NEUTRAL, seriesColor,
} from "@/components/ui/chart";
import { MetricTitle, TermTip } from "@/components/ui/overlay";
import { Section } from "@/components/ui/page";
import { cn, fmt } from "@/lib/format";
import type { Comparison, RunSummary, TargetSummary } from "@/lib/types";

/** 기준은 무채색, 후보는 계열 색 순서대로 */
export function targetColor(targets: TargetSummary[], label: string): string {
  const t = targets.find((x) => x.label === label);
  if (!t || t.is_baseline) return BASELINE_COLOR;
  return seriesColor(targets.filter((x) => !x.is_baseline).findIndex((x) => x.label === label));
}

/* 관련도 등급: 한 색(강조색)의 진하기로 — 진할수록 관련도가 높다. 무관은 회색. */
const GRADE_COLORS: Record<string, string> = { "3": "rgb(var(--accent))", "2": "rgb(var(--accent) / 0.62)", "1": "rgb(var(--accent) / 0.3)", "0": "rgb(var(--faint) / 0.22)" };
const GRADE_NAMES: Record<string, string> = { "3": "매우 관련", "2": "관련", "1": "약간 관련", "0": "무관" };

type TipPayload = { name?: string; value?: number; color?: string; payload?: Record<string, unknown> }[];
function ChartTip({ active, payload, label, unit = "" }: { active?: boolean; payload?: TipPayload; label?: string; unit?: string }) {
  if (!active || !payload?.length) return null;
  const v = (x: unknown) => (typeof x === "number" ? (unit === "%" ? `${x.toFixed(0)}%` : unit === "ms" ? fmt.ms(x) : x.toFixed(3)) : String(x ?? ""));
  return <ChartTooltip title={label} rows={payload.map((p) => ({ color: p.color, name: p.name, value: v(p.value) }))} />;
}

/** 차트 한 칸. 제목은 정식 지표 이름 + 한국어 이름, ‘무엇을 보는지’ 설명은 (i) 안에 */
export function Panel({ name, ko, term, hint, children, className }: { name: ReactNode; ko?: ReactNode; term?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 py-6", className)}>
      <MetricTitle name={name} ko={ko} term={term} hint={hint} className="text-[15px]" />
      <div className="mt-5">{children}</div>
    </div>
  );
}

/** 섹션 제목 옆 (i) — 섹션 설명 문단 대신 */
export function SectionTitle({ children, hint }: { children: ReactNode; hint: ReactNode }) {
  return <span className="inline-flex items-center gap-2">{children}<TermTip hint={hint} /></span>;
}

/** 두 칸을 세로선으로 나눈 차트 줄(좁으면 위아래로 쌓임) */
export function Pair({ children }: { children: ReactNode }) {
  return <div className="grid border-y border-line lg:grid-cols-2 lg:divide-x lg:divide-line [&>*]:lg:px-8 [&>*:first-child]:lg:pl-0 [&>*:last-child]:lg:pr-0 max-lg:divide-y max-lg:divide-line">{children}</div>;
}

function MetricBars({ targets, k }: { targets: TargetSummary[]; k: number }) {
  const rows = [
    { metric: `nDCG@${k}`, key: "ndcg" as const },
    { metric: "Hit@1", key: "hit1" as const },
    { metric: "MRR", key: "mrr" as const },
    { metric: `P@${k}`, key: "precision" as const },
  ].map((m) => ({ metric: m.metric, ...Object.fromEntries(targets.map((t) => [t.label, t[m.key] ?? 0])) }));
  return (
    <div style={{ height: 76 + rows.length * (targets.length * 13 + 26) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barGap={3} barCategoryGap={16}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="metric" tick={CATEGORY_TICK} axisLine={false} tickLine={false} width={64} />
          <Tooltip cursor={CURSOR_FILL} content={<ChartTip />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
          {targets.map((t) => (
            <Bar key={t.label} dataKey={t.label} name={`${t.label}${t.is_baseline ? " (기준)" : ""}`} fill={targetColor(targets, t.label)} radius={[0, 6, 6, 0]} barSize={10} {...ANIM} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 목록 비교 결과: 큰 승률 + 한 줄짜리 비율 막대(승 | 무 | 패). 무승부가 대부분이어도 승·패 비율이 묻히지 않는다. */
function OutcomeSplit({ cmp }: { cmp: Comparison }) {
  const data = [
    { name: `${cmp.candidate} 승`, value: cmp.wins, color: GOOD },
    { name: "무승부", value: cmp.ties, color: NEUTRAL },
    { name: `${cmp.baseline} 승`, value: cmp.losses, color: BAD },
  ];
  const total = cmp.wins + cmp.ties + cmp.losses;
  if (!total) return <ChartEmpty>목록 비교 판정이 없습니다.</ChartEmpty>;
  const decided = cmp.wins + cmp.losses;
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[12.5px] text-muted">승률 (무승부 제외)</div>
          <div className="num mt-1 text-[34px] font-bold leading-none tracking-tight">{fmt.pct(cmp.win_rate)}</div>
        </div>
        <div className="num text-right text-[12.5px] text-muted">승부가 난 {decided}건 중 {cmp.wins}승<br />전체 {total}건</div>
      </div>
      <div className="mt-5 flex h-3 gap-[3px] overflow-hidden rounded-full">
        {data.filter((d) => d.value > 0).map((d) => (
          <span key={d.name} title={`${d.name} ${d.value}건`} className="h-full origin-left animate-[bar-x_0.7s_var(--ease-out)_both] rounded-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(d.value / total) * 100}%`, background: d.color }} />
        ))}
      </div>
      <div className="mt-5 divide-y divide-line border-y border-line">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-3 py-2.5 text-[14px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="num font-semibold">{d.value}</span>
            <span className="num w-12 text-right text-muted">{fmt.pct(d.value / total)}</span>
          </div>
        ))}
        <div className="flex items-center gap-3 py-2.5 text-[13px] text-muted">
          <span className="min-w-0 flex-1">순서를 바꾸자 판정이 달라진 케이스</span>
          <span className="num">{cmp.inconsistent}</span>
        </div>
      </div>
    </div>
  );
}

function GradeBars({ dist, targets, which }: { dist: NonNullable<RunSummary["grade_distribution"]>; targets: TargetSummary[]; which: "items" | "top1" }) {
  const rows = targets.map((t) => {
    const d = dist[t.label]?.[which] ?? {};
    const total = ["3", "2", "1", "0"].reduce((a, g) => a + (d[g] ?? 0), 0) || 1;
    return { label: `${t.label}${t.is_baseline ? " (기준)" : ""}`, ...Object.fromEntries(["3", "2", "1", "0"].map((g) => [g, ((d[g] ?? 0) / total) * 100])) };
  });
  return (
    <div style={{ height: 70 + rows.length * 38 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={12}>
          <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" tick={CATEGORY_TICK} axisLine={false} tickLine={false} width={96} />
          <Tooltip cursor={CURSOR_FILL} content={<ChartTip unit="%" />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
          {["3", "2", "1", "0"].map((g, i) => (
            <Bar key={g} dataKey={g} name={`${g} ${GRADE_NAMES[g]}`} stackId="g" fill={GRADE_COLORS[g]} barSize={14}
              radius={i === 0 ? [6, 0, 0, 6] : i === 3 ? [0, 6, 6, 0] : 0} {...ANIM} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LatencyBars({ targets }: { targets: TargetSummary[] }) {
  const rows = targets.map((t) => ({ label: t.label, p50: t.latency_p50 ?? 0, p95: t.latency_p95 ?? 0 }));
  if (!rows.some((r) => r.p50 > 0 || r.p95 > 0)) return <ChartEmpty height={140}>기록된 응답 시간이 없습니다.</ChartEmpty>;
  return (
    <div style={{ height: 70 + rows.length * 40 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barGap={2}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => fmt.ms(v)} tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" tick={CATEGORY_TICK} axisLine={false} tickLine={false} width={64} />
          <Tooltip cursor={CURSOR_FILL} content={<ChartTip unit="ms" />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
          <Bar dataKey="p50" name="중앙값(p50)" fill="rgb(var(--accent))" radius={[0, 6, 6, 0]} barSize={9} {...ANIM} />
          <Bar dataKey="p95" name="느린 5%(p95)" fill="rgb(var(--accent) / 0.3)" radius={[0, 6, 6, 0]} barSize={9} {...ANIM} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * 분류별: 후보 nDCG − 기준 nDCG. 값이 모두 0.8 근처라 0~1 축에서는 차이가 안 보이므로,
 * 0 을 가운데 두고 차이만 보여 준다. 막대 끝에 값을 붙인다.
 */
export function CategoryBars({ summary, targets, candidate }: { summary: RunSummary; targets: TargetSummary[]; candidate: string }) {
  const base = targets.find((t) => t.is_baseline)?.label;
  const rows = (summary.by_category ?? [])
    .map((c) => ({
      category: c.category,
      cases: c.cases,
      diff: base && c.ndcg[candidate] !== undefined && c.ndcg[base] !== undefined ? c.ndcg[candidate] - c.ndcg[base] : 0,
      cand: c.ndcg[candidate],
      base: base ? c.ndcg[base] : undefined,
    }))
    .sort((a, b) => b.diff - a.diff);
  const m = Math.max(0.02, ...rows.map((r) => Math.abs(r.diff)));
  const lim = Math.ceil(m * 1.25 * 100) / 100;
  return (
    <div style={{ height: 40 + rows.length * 34 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }} barCategoryGap={9}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" domain={[-lim, lim]} tickFormatter={(v) => fmt.signed(v, 2)} tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="category" tick={CATEGORY_TICK} axisLine={false} tickLine={false} width={96} />
          <ReferenceLine x={0} stroke="rgb(var(--faint) / 0.6)" />
          <Tooltip cursor={CURSOR_FILL} content={({ active, payload }) => {
            const p = active ? (payload?.[0]?.payload as (typeof rows)[number] | undefined) : undefined;
            return p ? <ChartTooltip title={`${p.category} · ${p.cases}건`} rows={[
              { color: BASELINE_COLOR, name: `${base} nDCG`, value: fmt.num(p.base) },
              { color: seriesColor(0), name: `${candidate} nDCG`, value: fmt.num(p.cand) },
              { name: "차이", value: fmt.signed(p.diff) },
            ]} /> : null;
          }} />
          <Bar dataKey="diff" barSize={12} radius={6} {...ANIM}>
            {rows.map((r) => <Cell key={r.category} fill={r.diff > 1e-9 ? GOOD : r.diff < -1e-9 ? BAD : NEUTRAL} />)}
            <LabelList dataKey="diff" position="right" formatter={(v: number) => fmt.signed(v, 3)} style={{ fontSize: 11.5, fill: "rgb(var(--muted))" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RunCharts({ summary, k, cmp }: { summary: RunSummary; k: number; cmp: Comparison }) {
  const targets = summary.targets ?? [];
  const dist = summary.grade_distribution;
  const allHealthy = targets.every((t) => !(t.error_rate ?? 0) && !(t.empty_rate ?? 0));
  return (
    <>
      <Section title={<SectionTitle hint="막대가 길수록 좋은 지표입니다. 회색이 기준, 색이 있는 막대가 후보입니다.">한눈에 보기</SectionTitle>}>
        <Pair>
          <Panel name={`nDCG@${k} · Hit@1 · MRR · P@${k}`} ko="순위 지표 비교" term="ndcg" hint="모두 0~1 사이 값입니다. 같은 지표끼리 막대 길이를 비교하세요.">
            <MetricBars targets={targets} k={k} />
          </Panel>
          <Panel name="Win rate" ko="목록 비교 승률" term="pairwise" hint="두 결과 목록을 통째로 보고 어느 쪽이 더 유용한지 판정한 결과입니다. 승률은 무승부를 뺀 승/(승+패).">
            <OutcomeSplit cmp={cmp} />
          </Panel>
        </Pair>
      </Section>
      {dist && (
        <Section title={<SectionTitle hint="판정 모델이 매긴 관련도 등급(0~3)의 비율입니다. 진한 색(매우 관련·관련)이 넓을수록 좋습니다.">결과의 질</SectionTitle>}>
          <Pair>
            <Panel name="Hit@1" ko="1위 결과의 등급 분포" term="hit1" hint="사용자가 가장 먼저 보는 1위 결과가 얼마나 정확한지 봅니다. Hit@1 은 1위가 ‘관련’ 이상인 비율입니다.">
              <GradeBars dist={dist} targets={targets} which="top1" />
            </Panel>
            <Panel name={`P@${k}`} ko={`상위 ${k}개 등급 분포`} term="precision" hint={`보여 주는 상위 ${k}개 전체에 관련 없는 결과(잡음)가 얼마나 섞였는지 봅니다. P@${k} 는 ‘관련’ 이상 항목의 비율입니다.`}>
              <GradeBars dist={dist} targets={targets} which="items" />
            </Panel>
          </Pair>
        </Section>
      )}
      <Section title={<SectionTitle hint="품질 차이가 장애나 속도 문제와 얽혀 있지 않은지 확인합니다.">속도와 안정성</SectionTitle>}>
        <Pair>
          <Panel name="Latency p50 · p95" ko="응답 시간" term="latency" hint="성공한 호출 기준입니다. 막대가 짧을수록 빠릅니다.">
            <LatencyBars targets={targets} />
          </Panel>
          <Panel name="Error rate · Empty rate" ko="호출 실패율 · 0건 비율" term="error_rate" hint="0%가 정상입니다.">
            {allHealthy ? (
              <div className="flex items-center gap-2.5 border-y border-line py-4 text-[14px]">
                <CheckCircle2 className="h-5 w-5 text-good" />
                <span>모든 대상이 정상입니다 <span className="text-muted">— 실패 0% · 결과 0건 0%</span></span>
              </div>
            ) : (
              <div className="divide-y divide-line border-y border-line">
                {targets.map((t) => (
                  <div key={t.label} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3.5 text-[14px]">
                    <span className="flex w-28 items-center gap-2 font-semibold">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: targetColor(targets, t.label) }} />
                      {t.label}
                    </span>
                    <span className={cn("num", (t.error_rate ?? 0) > 0 ? "text-bad" : "text-muted")}>실패 {fmt.pct(t.error_rate, 1)}</span>
                    <span className={cn("num", (t.empty_rate ?? 0) > 0 ? "text-warn" : "text-muted")}>결과 0건 {fmt.pct(t.empty_rate, 1)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </Pair>
      </Section>
    </>
  );
}
