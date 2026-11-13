import { AlertTriangle, ArrowRight, Info } from "lucide-react";
import { hint } from "@/lib/glossary";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { ANIM, AXIS_TICK, BAD, CURSOR_FILL, ChartEmpty, ChartTooltip, GOOD, GRID, NEUTRAL } from "@/components/ui/chart";
import { MetricTitle, TermTip } from "@/components/ui/overlay";
import { Link } from "react-router-dom";
import { Collapsible, Section, Stat, StatRow } from "@/components/ui/page";
import { Alert, Badge, Card } from "@/components/ui/primitives";
import { cn, fmt } from "@/lib/format";
import type { CaseRow, Comparison, RunSummary, TargetSummary } from "@/lib/types";
import { CategoryBars, RunCharts } from "./RunCharts";
import { MetricDetails } from "./MetricDetails";
import { VERDICT_TONE, VerdictIcon, WinBar } from "./Verdict";

const NEXT_STEP: Record<string, string> = {
  improved: "개선이 확인되었습니다. ‘기준 승’ 케이스가 있다면 어떤 질의에서 나빠졌는지 먼저 확인한 뒤 배포를 검토하세요.",
  regressed: "후보가 더 나쁩니다. 케이스 탭에서 ‘기준 승’ 필터로 나빠진 질의를 모아 원인을 찾으세요.",
  no_difference: "지금 데이터로는 차이를 단정할 수 없습니다. 케이스를 늘리거나, 변경이 영향을 주는 입력 위주로 테스트 데이터를 보강하세요.",
  inconclusive: "케이스가 적어 결론을 낼 수 없습니다. 30건 이상으로 다시 실행하는 것을 권장합니다.",
  no_data: "위 경고를 확인하세요. 대상 호출이 실패했다면 검색 API 의 주소·키·네트워크를 점검한 뒤 다시 실행하세요.",
};

function VerdictBanner({ cmp, onShow }: { cmp: Comparison; onShow?: (outcome: "win" | "loss") => void }) {
  const v = cmp.verdict;
  const tone = VERDICT_TONE[v.code].tone;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-x-5 gap-y-4 py-7">
        <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
          tone === "good" ? "bg-good-soft text-good" : tone === "bad" ? "bg-bad-soft text-bad" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-subtle text-muted")}>
          <VerdictIcon code={v.code} className="h-6 w-6" />
        </div>
        <div className="min-w-0 grow basis-[260px]">
          <div className="flex items-center gap-2 text-[13px] text-muted">
            결론 · {cmp.candidate} vs {cmp.baseline}(기준)
            <TermTip term="verdict" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[22px] font-bold tracking-tight">
            {v.title}
            {v.weak && <Badge tone="warn">근거 약함 · 케이스 {cmp.ndcg_cases}건</Badge>}
          </div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink/80">{v.detail}</p>
          <p className="mt-3 flex gap-2 text-[13.5px] leading-relaxed text-muted">
            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0" />
            {NEXT_STEP[v.code]}
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {onShow && cmp.losses > 0 && <button onClick={() => onShow("loss")} className="rounded-lg bg-bad-soft px-3 py-1.5 text-[13px] font-medium text-bad">기준 승 {cmp.losses}건 보기</button>}
          {onShow && cmp.wins > 0 && <button onClick={() => onShow("win")} className="rounded-lg bg-good-soft px-3 py-1.5 text-[13px] font-medium text-good">후보 승 {cmp.wins}건 보기</button>}
        </div>
      </div>
    </Card>
  );
}

function better(a: number | null, b: number | null, higherIsBetter = true): "good" | "bad" | undefined {
  if (a === null || b === null || Math.abs(a - b) < 1e-9) return undefined;
  return (a > b) === higherIsBetter ? "good" : "bad";
}

function TargetTable({ targets, k, candidate }: { targets: TargetSummary[]; k: number; candidate: string }) {
  const base = targets.find((t) => t.is_baseline);
  const cols: { key: keyof TargetSummary; label: string; ko: string; term: string; fmt: (v: number | null) => string; higher: boolean }[] = [
    { key: "ndcg", label: `nDCG@${k}`, ko: "순위 품질", term: "ndcg", fmt: (v) => fmt.num(v), higher: true },
    { key: "hit1", label: "Hit@1", ko: "1위 정답률", term: "hit1", fmt: (v) => fmt.pct(v), higher: true },
    { key: "mrr", label: "MRR", ko: "첫 정답 순위", term: "mrr", fmt: (v) => fmt.num(v), higher: true },
    { key: "precision", label: `P@${k}`, ko: "정밀도", term: "precision", fmt: (v) => fmt.num(v), higher: true },
    { key: "error_rate", label: "Error", ko: "호출 실패율", term: "error_rate", fmt: (v) => fmt.pct(v, 1), higher: false },
    { key: "empty_rate", label: "Empty", ko: "0건 비율", term: "error_rate", fmt: (v) => fmt.pct(v, 1), higher: false },
    { key: "latency_p50", label: "p50", ko: "응답 시간", term: "latency", fmt: (v) => fmt.ms(v), higher: false },
    { key: "latency_p95", label: "p95", ko: "응답 시간", term: "latency", fmt: (v) => fmt.ms(v), higher: false },
  ];
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="border-b border-line text-[12px] text-muted">
          <tr>
            <th className="px-5 py-3 text-left font-medium">대상</th>
            {cols.map((c) => (
              <th key={c.key} className="px-3 py-3 text-right font-medium">
                <span className="inline-flex items-center gap-1 font-semibold text-ink/80">{c.label}<TermTip term={c.term} /></span>
                <div className="text-[11px] font-normal text-faint">{c.ko}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {targets.map((t) => (
            <tr key={t.label} className={cn(t.label === candidate && "bg-accent-soft/30")}>
              <td className="px-5 py-3">
                <span className="font-semibold">{t.label}</span>
                {t.is_baseline && <Badge tone="outline" className="ml-2">기준</Badge>}
              </td>
              {cols.map((c) => {
                const v = t[c.key] as number | null;
                const tone = !t.is_baseline && base ? better(v, base[c.key] as number | null, c.higher) : undefined;
                return (
                  <td key={c.key} className={cn("num px-3 text-right", tone === "good" && "font-semibold text-good", tone === "bad" && "font-semibold text-bad")}>
                    {c.fmt(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function DiffChart({ cases, onOpen }: { cases: CaseRow[]; onOpen: (id: number) => void }) {
  const data = cases.filter((c) => c.ndcg_diff !== null).map((c) => ({ id: c.id, key: c.case_key, diff: c.ndcg_diff as number })).sort((a, b) => b.diff - a.diff);
  if (!data.length) return <ChartEmpty>비교할 케이스가 아직 없습니다.</ChartEmpty>;
  // 축을 데이터 범위에 맞춘다(고정 −1~1 이면 대부분 비어 보인다). 0.25 단위로 올림.
  const lim = Math.min(1, Math.max(0.25, Math.ceil(Math.max(...data.map((d) => Math.abs(d.diff))) * 4) / 4));
  return (
    <div className="h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }} barCategoryGap="18%">
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="key" tick={false} axisLine={false} height={4} />
          <YAxis domain={[-lim, lim]} ticks={[-lim, -lim / 2, 0, lim / 2, lim]} tickFormatter={(v) => fmt.signed(v, 2)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
          <ReferenceLine y={0} stroke="rgb(var(--faint) / 0.6)" />
          <RTooltip
            cursor={CURSOR_FILL}
            content={({ active, payload }) =>
              active && payload?.[0] ? (
                <ChartTooltip title={String(payload[0].payload.key)} rows={[{ name: "nDCG 차이", value: fmt.signed(payload[0].payload.diff as number) }]} footer="눌러서 케이스 보기" />
              ) : null
            }
          />
          <Bar dataKey="diff" radius={3} maxBarSize={14} onClick={(d: { id?: number }) => d.id && onOpen(d.id)} className="cursor-pointer" {...ANIM}>
            {data.map((d) => <Cell key={d.id} fill={d.diff > 1e-9 ? GOOD : d.diff < -1e-9 ? BAD : NEUTRAL} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 구간 값: 큰 숫자 칸 안에서 줄바꿈 없이 작게 */
const Range = ({ a, b }: { a: string; b: string }) => (
  <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-[22px]">{a}<span className="text-[15px] font-medium text-faint">~</span>{b}</span>
);
const pval = (p: number | null | undefined) => (p === null || p === undefined ? "–" : p < 0.001 ? "<0.001" : p.toFixed(3));
const effectLabel = (d: number | null | undefined) => {
  if (d === null || d === undefined) return "계산 불가";
  const a = Math.abs(d);
  return `${a >= 0.8 ? "큰" : a >= 0.5 ? "중간" : a >= 0.2 ? "작은" : "아주 작은"} 효과 · ${d > 0 ? "후보 쪽" : d < 0 ? "기준 쪽" : "차이 없음"}`;
};

export function RunSummaryView({
  summary,
  k,
  candidate,
  cases,
  onOpenCase,
  onShowOutcome,
  live,
  runId,
}: {
  runId?: number;
  summary: RunSummary;
  k: number;
  candidate: string;
  cases: CaseRow[];
  onOpenCase: (id: number) => void;
  onShowOutcome?: (outcome: "win" | "loss") => void;
  live: boolean;
}) {
  const [statsOpen, setStatsOpen] = useState(false);
  const cmp = summary.comparisons?.find((c) => c.candidate === candidate);
  const targets = summary.targets ?? [];
  const cand = targets.find((t) => t.label === candidate);
  const baseT = targets.find((t) => t.is_baseline);
  // 후보마다 평가 기준이 다를 수 있으므로 기준 API 값은 이 후보의 기준으로 본 값을 우선
  const base = baseT && cmp ? { ...baseT, ndcg: cmp.baseline_ndcg ?? baseT.ndcg, hit1: cmp.baseline_hit1 ?? baseT.hit1 } : baseT;
  if (!cmp || !summary.cases)
    return <Alert icon={<Info className="h-4 w-4" />}>완료된 케이스가 생기면 여기에 결과가 나타납니다.</Alert>;
  const ci = cmp.ndcg_ci;
  // 1위 항목의 평균 등급(0~3) — 순위와 무관한 '절대' 품질
  const top1Avg = (label?: string) => {
    const t = label ? summary.grade_distribution?.[label]?.top1 : undefined;
    if (!t) return null;
    const n = ["0", "1", "2", "3"].reduce((a, g) => a + (t[g] ?? 0), 0);
    return n ? ["0", "1", "2", "3"].reduce((a, g) => a + Number(g) * (t[g] ?? 0), 0) / n : null;
  };
  const baseTop1 = top1Avg(base?.label);
  const candTop1 = top1Avg(candidate);
  const ndcgHighHitLow = (cand?.ndcg ?? 0) >= 0.8 && (base?.ndcg ?? 0) >= 0.8 && Math.max(cand?.hit1 ?? 0, base?.hit1 ?? 0) < 0.5;
  return (
    <>
      {live && <Alert tone="accent" className="mb-4">진행 중입니다. 지금까지 완료된 {summary.cases}건으로 계산한 중간 결과이며, 끝까지 가면 바뀔 수 있습니다.</Alert>}
      {(summary.warnings ?? []).map((w) => (
        <Alert key={w} tone="warn" className="mb-4" icon={<AlertTriangle className="h-4 w-4" />}>{w}</Alert>
      ))}
      <div className="mb-8"><VerdictBanner cmp={cmp} onShow={onShowOutcome} /></div>
      <Section title="핵심 지표" description={cmp.criteria?.name ? `평가 기준 · ${cmp.criteria.name} (상위 ${cmp.criteria.k}개) · ${candidate} vs ${cmp.baseline}` : undefined}>
        <StatRow>
          <Stat label={<MetricTitle name={`ΔnDCG@${k}`} ko="순위 품질 차이" />} term="ndcg_diff" value={fmt.signed(cmp.ndcg_diff)}
            tone={cmp.verdict.code === "improved" ? "good" : cmp.verdict.code === "regressed" ? "bad" : undefined}
            sub={<>95% 신뢰구간 {ci ? `${fmt.signed(ci[0])} ~ ${fmt.signed(ci[1])}` : "–"}<br />{fmt.num(base?.ndcg)} → {fmt.num(cand?.ndcg)} · {cmp.ndcg_cases}건</>} />
          <Stat label={<MetricTitle name="Win rate" ko="목록 비교 승률" />} term="pairwise" value={fmt.pct(cmp.win_rate)}
            sub={<>
              <WinBar wins={cmp.wins} ties={cmp.ties} losses={cmp.losses} className="my-1.5 w-40" />
              {cmp.wins}승 {cmp.ties}무 {cmp.losses}패 · 부호 검정 p={cmp.sign_test_p === null ? "–" : cmp.sign_test_p < 0.001 ? "<0.001" : cmp.sign_test_p.toFixed(3)}
            </>} />
          <Stat label={<MetricTitle name="Hit@1" ko="1위 정답률" />} term="hit1" value={fmt.pct(cand?.hit1)} sub={<>기준 {fmt.pct(base?.hit1)} · 차이 {fmt.signedPct(cmp.hit1_diff)}<br />1위 평균 등급 {fmt.num(baseTop1, 1)} → {fmt.num(candTop1, 1)} / 3</>} />
          <Stat label={<MetricTitle name="Consistency" ko="판정 일관성" />} term="inconsistent" hint={hint("consistency")}
            value={cmp.pairwise_cases ? fmt.pct(1 - cmp.inconsistent / cmp.pairwise_cases) : "–"}
            sub={<>순서 불일치 {cmp.inconsistent}건 / {cmp.pairwise_cases}건</>} />
        </StatRow>
      </Section>
      {ndcgHighHitLow && (
        <Alert className="-mt-6 mb-14" icon={<Info className="h-4 w-4" />} title="nDCG 는 높은데 Hit@1 이 낮은 이유">
          nDCG 는 ‘이번에 두 API 가 찾은 결과 중 가장 좋은 순서’에 얼마나 가까운지를 봅니다. 양쪽 모두 정말 맞는 결과가 적으면 서로 비슷하게 높게 나옵니다.
          검색 품질 자체는 <b>Hit@1</b>(1위가 맞는 비율)과 <b>1위 평균 등급</b>({fmt.num(baseTop1, 1)} → {fmt.num(candTop1, 1)} / 3)으로 보세요. 두 API 모두 낮다면 테스트 질의가 검색 범위 밖이거나 평가 기준이 엄격한 것일 수 있습니다.
        </Alert>
      )}
      <Collapsible className="mb-14" title="통계 상세" open={statsOpen} onOpenChange={setStatsOpen}
        summary={<>순열 검정 p {pval((cmp.multiple_comparisons ?? 1) > 1 ? cmp.permutation_p_holm : cmp.permutation_p)} · 효과 크기 {fmt.num(cmp.effect_size, 2)} · 필요한 케이스 {cmp.needed_cases ? `${fmt.int(cmp.needed_cases)}건` : "–"}</>}>
        <p className="mb-4 text-[13.5px] text-muted">결론을 여러 방법으로 교차 확인합니다. 모두 같은 방향이면 믿을 만합니다.</p>
        <StatRow min={200}>
          <Stat label={<MetricTitle name={(cmp.multiple_comparisons ?? 1) > 1 ? "Permutation p (Holm)" : "Permutation p"} ko="순열 검정" />} term={(cmp.multiple_comparisons ?? 1) > 1 ? "holm" : "permutation"}
            value={pval((cmp.multiple_comparisons ?? 1) > 1 ? cmp.permutation_p_holm : cmp.permutation_p)}
            tone={(cmp.permutation_p_holm ?? 1) < 0.05 ? (cmp.ndcg_diff ?? 0) > 0 ? "good" : "bad" : undefined}
            sub={(cmp.multiple_comparisons ?? 1) > 1 ? `보정 전 ${pval(cmp.permutation_p)} · 후보 ${cmp.multiple_comparisons}개` : "0.05 미만이면 우연으로 보기 어려움"} />
          <Stat label={<MetricTitle name={<>Cohen's d<sub>z</sub></>} ko="효과 크기" />} term="effect_size" value={fmt.num(cmp.effect_size, 2)} sub={effectLabel(cmp.effect_size)} />
          <Stat label={<MetricTitle name="Required n" ko="필요 케이스 수" />} term="needed_cases" value={cmp.needed_cases ? `${fmt.int(cmp.needed_cases)}건` : "–"}
            tone={cmp.needed_cases && cmp.needed_cases > cmp.ndcg_cases ? "warn" : undefined}
            sub={cmp.needed_cases ? (cmp.needed_cases > cmp.ndcg_cases ? `지금 ${cmp.ndcg_cases}건 — 더 필요` : `지금 ${cmp.ndcg_cases}건 — 충분`) : "차이가 0 이거나 흔들림이 없어 계산 불가"} />
          <Stat label={<MetricTitle name="Win rate 95% CI" ko="승률 신뢰구간" />} term="win_rate_ci" value={cmp.win_rate_ci ? <Range a={fmt.pct(cmp.win_rate_ci[0])} b={fmt.pct(cmp.win_rate_ci[1])} /> : "–"}
            sub={`무승부를 반으로 친 승률 ${fmt.pct(cmp.win_rate_with_ties)}`} />
          <Stat label={<MetricTitle name="ΔHit@1 95% CI" ko="1위 정답률 차이 구간" />} term="hit1" value={cmp.hit1_ci ? <Range a={fmt.signedPct(cmp.hit1_ci[0])} b={fmt.signedPct(cmp.hit1_ci[1])} /> : "–"}
            sub={`nDCG 차이 표준편차 ${fmt.num(cmp.ndcg_sd, 3)}`} />
        </StatRow>
      </Collapsible>
      <RunCharts summary={summary} k={k} cmp={cmp} />
      <MetricDetails runId={runId} summary={summary} cases={cases} candidate={candidate} baseline={cmp.baseline} cmp={cmp} k={k} onOpenCase={onOpenCase} />
      <Collapsible className="mb-14" title="대상별 지표 숫자로 보기" summary="위 차트의 값을 표로 봅니다. 후보가 기준보다 좋으면 초록, 나쁘면 빨강.">
        <TargetTable targets={targets} k={k} candidate={candidate} />
        {(summary.no_relevant_cases ?? 0) > 0 && (
          <div className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
            <Info className="h-3.5 w-3.5" />어느 대상도 관련 항목을 찾지 못한 케이스 {summary.no_relevant_cases}건은 nDCG 평균에서 제외했습니다. <TermTip term="no_relevant" />
          </div>
        )}
      </Collapsible>
      <Section title={<MetricTitle name={`ΔnDCG@${k} by case`} ko="케이스별 nDCG 차이" term="ndcg_diff"
        hint={hint("case_diff", { candidate })} />}
        actions={<div className="flex gap-3 text-[12.5px] text-muted"><span className="text-good">개선 {cmp.improved_cases}</span><span>같음 {cmp.same_cases}</span><span className="text-bad">저하 {cmp.regressed_cases}</span></div>}>
        <Card className="py-5"><DiffChart cases={cases} onOpen={onOpenCase} /></Card>
      </Section>
      {(summary.by_category?.length ?? 0) > 1 && (
        <Section title={<MetricTitle name={`ΔnDCG@${k} by category`} ko="분류별 nDCG 차이" term="ndcg_diff"
          hint={hint("category_diff", { candidate })} />}>
          <div className="mb-6 border-y border-line py-6"><CategoryBars summary={summary} targets={targets} candidate={candidate} /></div>
          <Collapsible title="분류별 숫자로 보기">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line text-[12px] text-muted">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">분류</th>
                  <th className="px-3 py-3 text-right font-medium">케이스</th>
                  {targets.map((t) => <th key={t.label} className="px-3 py-3 text-right font-medium">{t.label} nDCG</th>)}
                  <th className="px-3 py-3 text-right font-medium">차이</th>
                  <th className="px-5 py-3 text-left font-medium">승·패</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {summary.by_category!.map((c) => {
                  const d = c.ndcg[candidate] !== undefined && base && c.ndcg[base.label] !== undefined ? c.ndcg[candidate] - c.ndcg[base.label] : null;
                  return (
                    <tr key={c.category}>
                      <td className="px-5 py-3 font-medium">{c.category}</td>
                      <td className="num px-3 text-right text-muted">{c.cases}</td>
                      {targets.map((t) => <td key={t.label} className="num px-3 text-right">{fmt.num(c.ndcg[t.label])}</td>)}
                      <td className={cn("num px-3 text-right font-semibold", d && d > 0 ? "text-good" : d && d < 0 ? "text-bad" : "")}>{fmt.signed(d)}</td>
                      <td className="num px-5 text-[12.5px] text-muted">{c.wins[candidate] ?? 0}승 {c.losses[candidate] ?? 0}패</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </Collapsible>
        </Section>
      )}
      <p className="text-[13px] text-muted">
        지표마다 답하는 질문이 다릅니다. 이름 옆 <span className="font-medium">?</span> 를 누르거나 <Link to="/guide" className="font-medium text-accent hover:underline">도움말 › 평가 방법</Link>에서 읽는 법을 볼 수 있습니다.
      </p>
    </>
  );
}
