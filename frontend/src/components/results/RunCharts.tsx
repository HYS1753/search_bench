import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TermTip } from "@/components/ui/overlay";
import { Section } from "@/components/ui/page";
import { cn, fmt } from "@/lib/format";
import type { Comparison, RunSummary, TargetSummary } from "@/lib/types";

const CANDIDATE_COLORS = ["rgb(var(--accent))", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6"];
export function targetColor(targets: TargetSummary[], label: string): string {
  const t = targets.find((x) => x.label === label);
  if (!t || t.is_baseline) return "rgb(var(--faint))";
  const idx = targets.filter((x) => !x.is_baseline).findIndex((x) => x.label === label);
  return CANDIDATE_COLORS[idx % CANDIDATE_COLORS.length];
}

const GRADE_COLORS: Record<string, string> = { "3": "rgb(var(--good))", "2": "rgb(var(--accent))", "1": "rgb(var(--warn))", "0": "rgb(var(--faint) / 0.4)" };
const GRADE_NAMES: Record<string, string> = { "3": "매우 관련", "2": "관련", "1": "약간 관련", "0": "무관" };
const AXIS = { fontSize: 12, fill: "rgb(var(--muted))" };

function ChartTip({ active, payload, label, unit = "" }: { active?: boolean; payload?: { name?: string; value?: number; color?: string; payload?: Record<string, unknown> }[]; label?: string; unit?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-ink px-3 py-2 text-[12px] text-panel shadow-lg">
      {label && <div className="mb-1 font-semibold">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="opacity-80">{p.name}</span>
          <span className="num ml-auto pl-3 font-semibold">{typeof p.value === "number" ? (unit === "%" ? `${p.value.toFixed(0)}%` : unit === "ms" ? fmt.ms(p.value) : p.value.toFixed(3)) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, term, desc, children, className }: { title: string; term?: string; desc?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 py-6", className)}>
      <div className="flex items-center gap-1.5 text-[15px] font-semibold">
        {title}
        {term && <TermTip term={term} />}
      </div>
      {desc && <div className="mt-1 text-[13px] leading-relaxed text-muted">{desc}</div>}
      <div className="mt-5">{children}</div>
    </div>
  );
}

/** 두 칸을 세로선으로 나눈 차트 줄(좁으면 위아래로 쌓임) */
function Pair({ children }: { children: ReactNode }) {
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
    <div style={{ height: 70 + rows.length * (targets.length * 16 + 22) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barGap={3} barCategoryGap={14}>
          <CartesianGrid horizontal={false} stroke="rgb(var(--line))" />
          <XAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="metric" tick={{ ...AXIS, fill: "rgb(var(--ink))" }} axisLine={false} tickLine={false} width={64} />
          <Tooltip cursor={{ fill: "rgb(var(--subtle))" }} content={<ChartTip />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12.5, paddingTop: 8 }} />
          {targets.map((t) => (
            <Bar key={t.label} dataKey={t.label} name={`${t.label}${t.is_baseline ? " (기준)" : ""}`} fill={targetColor(targets, t.label)} radius={[0, 4, 4, 0]} barSize={14} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OutcomeDonut({ cmp }: { cmp: Comparison }) {
  const data = [
    { name: `${cmp.candidate} 승`, value: cmp.wins, color: "rgb(var(--good))" },
    { name: "무승부", value: cmp.ties, color: "rgb(var(--line))" },
    { name: `${cmp.baseline} 승`, value: cmp.losses, color: "rgb(var(--bad))" },
  ];
  const total = cmp.wins + cmp.ties + cmp.losses;
  if (!total) return <div className="py-10 text-center text-sm text-muted">목록 비교 판정이 없습니다.</div>;
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
      <div className="relative h-[200px] w-[200px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" innerRadius={64} outerRadius={92} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
              {data.map((d) => <Cell key={d.name} fill={d.color} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-[12.5px] text-muted">승률</div>
          <div className="num text-[24px] font-bold">{fmt.pct(cmp.win_rate)}</div>
        </div>
      </div>
      <div className="min-w-[180px] flex-1 divide-y divide-line border-y border-line">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-3 py-3 text-[14px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="num font-semibold">{d.value}</span>
            <span className="num w-12 text-right text-muted">{fmt.pct(d.value / total)}</span>
          </div>
        ))}
        <div className="flex items-center gap-3 py-3 text-[13px] text-muted">
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
    <div style={{ height: 64 + rows.length * 40 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={10}>
          <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" tick={{ ...AXIS, fill: "rgb(var(--ink))" }} axisLine={false} tickLine={false} width={96} />
          <Tooltip cursor={{ fill: "rgb(var(--subtle))" }} content={<ChartTip unit="%" />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12.5, paddingTop: 8 }} />
          {["3", "2", "1", "0"].map((g) => (
            <Bar key={g} dataKey={g} name={`${g} ${GRADE_NAMES[g]}`} stackId="g" fill={GRADE_COLORS[g]} barSize={20} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LatencyBars({ targets }: { targets: TargetSummary[] }) {
  const rows = targets.map((t) => ({ label: t.label, p50: t.latency_p50 ?? 0, p95: t.latency_p95 ?? 0, color: targetColor(targets, t.label) }));
  return (
    <div style={{ height: 64 + rows.length * 44 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barGap={2}>
          <CartesianGrid horizontal={false} stroke="rgb(var(--line))" />
          <XAxis type="number" tickFormatter={(v) => fmt.ms(v)} tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" tick={{ ...AXIS, fill: "rgb(var(--ink))" }} axisLine={false} tickLine={false} width={64} />
          <Tooltip cursor={{ fill: "rgb(var(--subtle))" }} content={<ChartTip unit="ms" />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12.5, paddingTop: 8 }} />
          <Bar dataKey="p50" name="중앙값(p50)" fill="rgb(var(--accent))" radius={[0, 4, 4, 0]} barSize={12} />
          <Bar dataKey="p95" name="느린 5%(p95)" fill="rgb(var(--accent) / 0.35)" radius={[0, 4, 4, 0]} barSize={12} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryBars({ summary, targets }: { summary: RunSummary; targets: TargetSummary[] }) {
  const cats = summary.by_category ?? [];
  const rows = cats.map((c) => ({ category: c.category, ...Object.fromEntries(targets.map((t) => [t.label, c.ndcg[t.label] ?? 0])) }));
  return (
    <div style={{ height: 70 + rows.length * (targets.length * 14 + 20) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barGap={2} barCategoryGap={12}>
          <CartesianGrid horizontal={false} stroke="rgb(var(--line))" />
          <XAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="category" tick={{ ...AXIS, fill: "rgb(var(--ink))" }} axisLine={false} tickLine={false} width={110} />
          <Tooltip cursor={{ fill: "rgb(var(--subtle))" }} content={<ChartTip />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12.5, paddingTop: 8 }} />
          {targets.map((t) => (
            <Bar key={t.label} dataKey={t.label} name={`${t.label} nDCG`} fill={targetColor(targets, t.label)} radius={[0, 4, 4, 0]} barSize={12} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RunCharts({ summary, k, cmp }: { summary: RunSummary; k: number; cmp: Comparison }) {
  const targets = summary.targets ?? [];
  const dist = summary.grade_distribution;
  return (
    <>
      <Section title="한눈에 보기" description="막대가 길수록 좋은 지표입니다. 회색이 기준, 색이 있는 막대가 후보입니다.">
        <Pair>
          <Panel title="지표 비교" term="ndcg" desc="0~1 사이 값입니다. 같은 지표끼리 막대 길이를 비교하세요.">
            <MetricBars targets={targets} k={k} />
          </Panel>
          <Panel title="목록 비교 결과" term="pairwise" desc="두 결과 목록을 통째로 보고 어느 쪽이 더 유용한지 판정한 결과입니다.">
            <OutcomeDonut cmp={cmp} />
          </Panel>
        </Pair>
      </Section>
      {dist && (
        <Section title="결과의 질" description="판정 모델이 매긴 관련도 등급의 비율입니다. 초록(매우 관련)과 파랑(관련)이 넓을수록 좋습니다.">
          <Pair>
            <Panel title="1위 결과의 등급" term="hit1" desc="사용자가 가장 먼저 보는 결과가 얼마나 정확한가">
              <GradeBars dist={dist} targets={targets} which="top1" />
            </Panel>
            <Panel title={`상위 ${k}개 전체의 등급`} term="grade" desc="보여 주는 결과 전체에 잡음이 얼마나 섞였나">
              <GradeBars dist={dist} targets={targets} which="items" />
            </Panel>
          </Pair>
        </Section>
      )}
      <Section title="속도와 안정성" description="품질 차이가 장애나 속도 문제와 얽혀 있지 않은지 확인합니다.">
        <Pair>
          <Panel title="응답 시간" term="latency" desc="성공한 호출 기준. 막대가 짧을수록 빠릅니다.">
            <LatencyBars targets={targets} />
          </Panel>
          <Panel title="호출 실패 · 결과 없음" term="error_rate" desc="0%가 정상입니다.">
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
          </Panel>
        </Pair>
      </Section>
    </>
  );
}
