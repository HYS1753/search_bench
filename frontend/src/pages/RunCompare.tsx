import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowLeft, ArrowUpRight, Columns3, Minus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, ErrorBar, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { VerdictBadge, WinBar } from "@/components/results/Verdict";
import { ANIM, AXIS_TICK, BAD, CATEGORY_TICK, CURSOR_FILL, ChartTooltip, GOOD, GRID, NEUTRAL } from "@/components/ui/chart";
import { PageHeader, Section, Segmented, Stat, StatRow } from "@/components/ui/page";
import { Alert, Badge, PageSkeleton, Select } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { Comparison, TargetSummary } from "@/lib/types";

interface RunCol {
  id: number;
  name: string;
  status: string;
  created_at: string;
  suite_name: string;
  dataset_name: string;
  dataset_id: number | null;
  dataset_version?: number | null;
  judge_model: string;
  criteria: { name: string; k: number; relevant_threshold: number; custom_prompt: boolean };
  batch_size: number;
  baseline: string;
  candidate: string;
  candidate_target: string;
  baseline_target: string;
  cases: number;
  total: number;
  cost: number;
  judge_calls: number;
  comparison: Comparison | null;
  base_metrics: TargetSummary | null;
  cand_metrics: TargetSummary | null;
  base_top1: number | null;
  cand_top1: number | null;
  agreement: number | null;
}
interface CaseRow {
  row_index: number;
  case_key: string;
  category: string;
  query: unknown;
  delta: number | null;
  a: { case_id: number; diff: number | null; winner: string | null };
  b: { case_id: number; diff: number | null; winner: string | null };
}
interface Data {
  candidate: string;
  candidates: string[];
  runs: RunCol[];
  differs: string[];
  case_diff: { matched: number; better: number; worse: number; same: number; flipped: number; rows: CaseRow[] } | null;
}

/** 지표 한 줄: 실행마다 값, 가장 좋은 값 강조 */
function MetricRow({ label, values, fmtV, better = "high", hint }: {
  label: ReactNode; values: (number | null | undefined)[]; fmtV: (v: number | null | undefined) => string; better?: "high" | "low" | "none"; hint?: string;
}) {
  const nums = values.filter((v): v is number => v !== null && v !== undefined);
  const best = better === "none" || nums.length < 2 ? null : better === "high" ? Math.max(...nums) : Math.min(...nums);
  return (
    <tr className="border-t border-line">
      <th className="sticky left-0 z-[1] bg-bg py-3 pr-4 text-left text-[13px] font-medium text-muted">
        {label}{hint && <span className="block text-[11.5px] font-normal text-faint">{hint}</span>}
      </th>
      {values.map((v, i) => (
        <td key={i} className={cn("num px-4 py-3 text-right text-[14px]", best !== null && v === best && "font-bold text-good")}>{fmtV(v)}</td>
      ))}
    </tr>
  );
}

const WINNER: Record<string, string> = { candidate: "후보 승", baseline: "기준 승", tie: "무" };

export default function RunCompare() {
  const [sp, setSp] = useSearchParams();
  const ids = sp.get("ids") ?? "";
  const cand = sp.get("candidate") ?? "";
  const [caseFilter, setCaseFilter] = useState<"all" | "better" | "worse" | "flipped">("all");
  const { data, isLoading, error } = useQuery({
    queryKey: ["runs-compare", ids, cand],
    queryFn: () => api.get<Data>(`/runs/compare?ids=${ids}${cand ? `&candidate=${encodeURIComponent(cand)}` : ""}`),
  });
  if (isLoading) return <PageSkeleton />;
  if (error || !data) return <Alert tone="bad">{(error as Error)?.message ?? "비교할 수 없습니다."}</Alert>;
  const runs = data.runs;
  const chart = runs.map((r) => {
    const c = r.comparison;
    const ci = c?.ndcg_ci;
    return { name: `#${r.id}`, full: r.name, diff: c?.ndcg_diff ?? 0, err: ci && c?.ndcg_diff !== null && c?.ndcg_diff !== undefined ? [c.ndcg_diff - ci[0], ci[1] - c.ndcg_diff] : [0, 0], ci };
  });
  const cd = data.case_diff;
  const rows = (cd?.rows ?? []).filter((r) =>
    caseFilter === "better" ? (r.delta ?? 0) > 1e-9 : caseFilter === "worse" ? (r.delta ?? 0) < -1e-9 : caseFilter === "flipped" ? r.a.winner && r.b.winner && r.a.winner !== r.b.winner : true);

  return (
    <>
      <Link to="/runs" className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />평가 실행 기록</Link>
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><Columns3 className="h-3.5 w-3.5" />평가</span>}
        title={`실행 ${runs.length}개 나란히 비교`}
        description="같은 후보를 실행마다 기준과 비교한 결과를 나란히 봅니다. 개선안을 여러 번 고쳐 가며 평가했을 때 어느 버전이 가장 나았는지, 조건을 바꿔 결과가 흔들리는지 확인하세요."
        actions={data.candidates.length > 1 ? (
          <Select className="h-9 w-auto" value={data.candidate} onChange={(e) => setSp((p) => { p.set("candidate", e.target.value); return p; })}>
            {data.candidates.map((c) => <option key={c} value={c}>{c} 기준으로 보기</option>)}
          </Select>
        ) : undefined}
      />

      {data.differs.length > 0 && (
        <Alert tone="warn" className="mb-8" icon={<AlertTriangle className="h-4 w-4" />} title={`조건이 다른 실행이 섞여 있습니다: ${data.differs.join(", ")}`}>
          조건이 다르면 점수 차이가 시스템 차이 때문인지 조건 차이 때문인지 구분하기 어렵습니다. 특히 테스트 데이터·평가 기준·판정 모델이 다르면 nDCG 값을 직접 비교하지 말고 결론(개선/저하)의 방향만 보세요.
        </Alert>
      )}

      {/* 실행 머리 */}
      <div className="scroll-thin mb-10 overflow-x-auto">
        <div className="grid min-w-fit gap-3" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(220px, 1fr))` }}>
          {runs.map((r) => (
            <Link key={r.id} to={`/runs/${r.id}`} className="lift rounded-2xl border border-line bg-panel/70 p-4">
              <div className="flex items-center gap-2 text-[12px] text-muted"><span className="num font-semibold text-faint">#{r.id}</span>{fmt.date(r.created_at)}</div>
              <div className="mt-1 line-clamp-2 break-keep text-[14.5px] font-semibold">{r.name}</div>
              <div className="mt-2 text-[12px] text-muted">{r.baseline} → <b className="text-ink">{r.candidate}</b> · {r.candidate_target}</div>
              <div className="mt-2.5"><VerdictBadge verdict={r.comparison?.verdict} /></div>
            </Link>
          ))}
        </div>
      </div>

      <Section title="nDCG 차이 (95% 신뢰구간)" description="막대는 후보 − 기준의 nDCG 평균 차이, 가는 선은 신뢰구간입니다. 선이 0을 넘지 않고 위에 있으면 확실한 개선입니다.">
        <div className="h-[260px] border-y border-line py-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid {...GRID} vertical={false} />
              <XAxis dataKey="name" tick={CATEGORY_TICK} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => fmt.signed(v, 2)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
              <ReferenceLine y={0} stroke="rgb(var(--faint) / 0.6)" />
              <RTooltip cursor={CURSOR_FILL} content={({ active, payload }) => active && payload?.[0] ? (
                <ChartTooltip title={String(payload[0].payload.full)} rows={[
                  { name: "nDCG 차이", value: fmt.signed(payload[0].payload.diff as number) },
                  { name: "95% 구간", value: payload[0].payload.ci ? `${fmt.signed(payload[0].payload.ci[0])} ~ ${fmt.signed(payload[0].payload.ci[1])}` : "–" },
                ]} />) : null} />
              <Bar dataKey="diff" radius={6} maxBarSize={44} {...ANIM}>
                {chart.map((c) => <Cell key={c.name} fill={c.ci && c.ci[0] > 0 ? GOOD : c.ci && c.ci[1] < 0 ? BAD : NEUTRAL} />)}
                <ErrorBar dataKey="err" width={6} strokeWidth={1.5} stroke="rgb(var(--ink) / 0.55)" direction="y" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      <Section title="지표 비교" description="실행마다 같은 지표를 나란히 둡니다. 초록 굵은 글씨가 가장 좋은 값입니다.">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-[1] bg-bg pb-2 pr-4 text-left text-[12px] font-medium text-faint">지표</th>
                {runs.map((r) => <th key={r.id} className="num px-4 pb-2 text-right text-[12.5px] font-semibold">#{r.id}</th>)}
              </tr>
            </thead>
            <tbody>
              <MetricRow label="nDCG 차이" values={runs.map((r) => r.comparison?.ndcg_diff)} fmtV={(v) => fmt.signed(v)} />
              <MetricRow label="후보 nDCG" hint="기준 대비 상대값" values={runs.map((r) => r.cand_metrics?.ndcg)} fmtV={(v) => fmt.num(v)} />
              <MetricRow label="후보 Hit@1" values={runs.map((r) => r.cand_metrics?.hit1)} fmtV={(v) => fmt.pct(v)} />
              <MetricRow label="후보 1위 평균 등급" hint="0~3, 절대 품질" values={runs.map((r) => r.cand_top1)} fmtV={(v) => fmt.num(v, 2)} />
              <MetricRow label="목록 비교 승률" values={runs.map((r) => r.comparison?.win_rate)} fmtV={(v) => fmt.pct(v)} />
              <MetricRow label="순열 검정 p" better="low" values={runs.map((r) => r.comparison?.permutation_p)} fmtV={(v) => (v === null || v === undefined ? "–" : v < 0.001 ? "<0.001" : v.toFixed(3))} />
              <MetricRow label="효과 크기" values={runs.map((r) => r.comparison?.effect_size)} fmtV={(v) => fmt.num(v, 2)} />
              <MetricRow label="후보 실패율" better="low" values={runs.map((r) => r.cand_metrics?.error_rate)} fmtV={(v) => fmt.pct(v)} />
              <MetricRow label="후보 응답 p50" better="low" values={runs.map((r) => r.cand_metrics?.latency_p50)} fmtV={(v) => fmt.ms(v ?? null)} />
              <MetricRow label="케이스" better="none" values={runs.map((r) => r.cases)} fmtV={(v) => `${fmt.int(v ?? 0)}건`} />
              <MetricRow label="비용" better="none" values={runs.map((r) => r.cost)} fmtV={(v) => fmt.usd(v)} />
              <tr className="border-t border-line">
                <th className="sticky left-0 z-[1] bg-bg py-3 pr-4 text-left text-[13px] font-medium text-muted">승·무·패</th>
                {runs.map((r) => (
                  <td key={r.id} className="px-4 py-3">
                    {r.comparison ? <div className="ml-auto w-32"><WinBar wins={r.comparison.wins} ties={r.comparison.ties} losses={r.comparison.losses} /><div className="num mt-1 text-right text-[11.5px] text-muted">{r.comparison.wins}승 {r.comparison.ties}무 {r.comparison.losses}패</div></div> : "–"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="조건" description="실행 당시 설정입니다. 다른 칸은 주황색입니다.">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13.5px]">
            <tbody>
              {([
                ["테스트 데이터", (r: RunCol) => `${r.dataset_name}${r.dataset_version ? ` v${r.dataset_version}` : ""}`],
                ["기준 API", (r: RunCol) => r.baseline_target],
                ["후보 API", (r: RunCol) => r.candidate_target],
                ["평가 기준", (r: RunCol) => `${r.criteria.name} · 상위 ${r.criteria.k}${r.criteria.custom_prompt ? " · 프롬프트 수정" : ""}`],
                ["판정 모델", (r: RunCol) => r.judge_model],
                ["판정 묶음", (r: RunCol) => `${r.batch_size}개씩`],
              ] as [string, (r: RunCol) => string][]).map(([label, get]) => {
                const vals = runs.map(get);
                const diff = new Set(vals).size > 1;
                return (
                  <tr key={label} className="border-t border-line">
                    <th className="sticky left-0 z-[1] bg-bg py-2.5 pr-4 text-left font-medium text-muted">{label}</th>
                    {vals.map((v, i) => <td key={i} className={cn("px-4 py-2.5 text-right", diff && "font-medium text-warn")}>{v}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {cd ? (
        <Section title="케이스별 변화 (#앞 → #뒤)" description={`같은 테스트 데이터의 ${cd.matched}건을 짝지어, 후보가 기준보다 나은 정도(nDCG 차이)가 두 실행 사이에 어떻게 바뀌었는지 봅니다. 많이 바뀐 순서입니다.`}>
          <StatRow min={170}>
            <Stat label="나아진 케이스" tone="good" value={`${cd.better}건`} />
            <Stat label="나빠진 케이스" tone={cd.worse ? "bad" : undefined} value={`${cd.worse}건`} />
            <Stat label="그대로" value={`${cd.same}건`} />
            <Stat label="목록 비교 결과가 바뀜" value={`${cd.flipped}건`} sub="후보 승 ↔ 기준 승·무" />
          </StatRow>
          <div className="mb-3 mt-6">
            <Segmented value={caseFilter} onChange={setCaseFilter} items={[
              { value: "all", label: "전체" }, { value: "better", label: "나아짐" }, { value: "worse", label: "나빠짐" }, { value: "flipped", label: "판정 바뀜" },
            ]} />
          </div>
          <div className="scroll-thin overflow-x-auto border-y border-line">
            <table className="w-full min-w-[720px] text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-muted">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium">케이스</th>
                  <th className="px-3 py-2.5 text-left font-medium">질의</th>
                  <th className="px-3 py-2.5 text-right font-medium">#{runs[0].id} 차이</th>
                  <th className="px-3 py-2.5 text-right font-medium">#{runs[1].id} 차이</th>
                  <th className="px-3 py-2.5 text-right font-medium">변화</th>
                  <th className="px-3 py-2.5 text-left font-medium">목록 비교</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.row_index} className="hover:bg-subtle/50">
                    <td className="px-3 py-2.5"><div className="font-medium">{r.case_key}</div>{r.category && <div className="text-[12px] text-muted">{r.category}</div>}</td>
                    <td className="max-w-[320px] truncate px-3">{fmt.inputs(r.query)}</td>
                    <td className="num px-3 text-right"><Link to={`/runs/${runs[0].id}?tab=cases`} className="hover:underline">{fmt.signed(r.a.diff, 2)}</Link></td>
                    <td className="num px-3 text-right"><Link to={`/runs/${runs[1].id}?tab=cases`} className="hover:underline">{fmt.signed(r.b.diff, 2)}</Link></td>
                    <td className={cn("num px-3 text-right font-semibold", (r.delta ?? 0) > 1e-9 ? "text-good" : (r.delta ?? 0) < -1e-9 ? "text-bad" : "text-muted")}>
                      <span className="inline-flex items-center gap-0.5">
                        {(r.delta ?? 0) > 1e-9 ? <ArrowUpRight className="h-3.5 w-3.5" /> : (r.delta ?? 0) < -1e-9 ? <ArrowDownRight className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                        {fmt.signed(r.delta, 2)}
                      </span>
                    </td>
                    <td className="px-3 text-[12.5px]">
                      {r.a.winner || r.b.winner ? (
                        <span className={cn(r.a.winner !== r.b.winner && "font-semibold text-warn")}>{WINNER[r.a.winner ?? ""] ?? "–"} → {WINNER[r.b.winner ?? ""] ?? "–"}</span>
                      ) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <div className="py-10 text-center text-sm text-muted">해당하는 케이스가 없습니다.</div>}
          </div>
        </Section>
      ) : runs.length === 2 ? (
        <Alert className="mb-10">두 실행의 테스트 데이터가 달라 케이스별 변화는 볼 수 없습니다. 같은 테스트 데이터로 다시 평가하면 질의마다 무엇이 바뀌었는지 볼 수 있습니다.</Alert>
      ) : (
        <div className="mb-10 text-[13px] text-muted"><Badge tone="outline">팁</Badge> 같은 테스트 데이터로 돌린 실행 2개를 고르면 케이스별 변화도 볼 수 있습니다.</div>
      )}
    </>
  );
}
