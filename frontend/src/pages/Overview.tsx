import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, CheckCircle2, Circle, Compass, GitCompareArrows, PlayCircle, Plus, Scale, Sparkles, Wallet } from "lucide-react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { ANIM, AXIS_TICK, CURSOR_LINE, ChartTooltip, FadeGradient, GRID, seriesColor } from "@/components/ui/chart";
import { StatusBadge, VerdictBadge, WinBar } from "@/components/results/Verdict";
import { PageHeader, Section, Stat, StatRow } from "@/components/ui/page";
import { CountUp } from "@/components/ui/motion";
import { Button, Card, PageSkeleton, Progress } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { CostReport, Overview as OverviewData } from "@/lib/types";

const FLOW = [
  { icon: <Scale className="h-5 w-5" />, title: "1. 연결하고 정하기", body: "비교할 API(ASIS·TOBE)를 예시 요청으로 연결하고, 판정 모델과 ‘좋은 결과’의 기준을 정합니다." },
  { icon: <GitCompareArrows className="h-5 w-5" />, title: "2. 결과 나란히 보기", body: "단건 검색 비교로 같은 입력을 동시에 보내 결과를 나란히 봅니다." },
  { icon: <PlayCircle className="h-5 w-5" />, title: "3. 여러 입력으로 판정하기", body: "평가로 여러 입력을 채점해 개선·저하를 통계적으로 결론 냅니다." },
];

const shortDate = (iso?: string | null) => (iso ? `${new Date(iso).getMonth() + 1}/${new Date(iso).getDate()}` : "");

export default function Overview() {
  const { data, isLoading } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<OverviewData>("/overview"),
    refetchInterval: (q) => (q.state.data?.active.length ? 4000 : false),
  });
  const costs = useQuery({ queryKey: ["costs", "month"], queryFn: () => api.get<CostReport>("/costs?period=month") });
  if (isLoading || !data) return <PageSkeleton />;
  const pending = data.onboarding.filter((o) => !o.done);
  const doneCount = data.onboarding.length - pending.length;
  const next = pending[0];
  const firstTime = data.counts.runs === 0;
  // 평가를 시작하려면 판정 모델·비교 세트가 있어야 한다. 없으면 '새 평가' 대신 다음 준비 단계로 안내
  const canRun = (data.counts.judge_models ?? 0) > 0 && (data.counts.suites ?? 0) > 0;
  const c = costs.data;
  const spent = (c?.models ?? []).filter((m) => m.cost > 0);
  const costSection = (
    <Section title="이번 달" description="전체 비용을 먼저 보고, 각 숫자를 누르면 해당 화면으로 이동합니다.">
      <Link to="/costs" className="group relative mb-6 block overflow-hidden rounded-3xl border border-line bg-panel/80 p-7 shadow-soft transition-shadow hover:shadow-[0_12px_32px_-16px_rgb(16_24_40/0.25)]">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative grid items-end gap-6 md:grid-cols-[auto_minmax(0,1fr)]">
          <div>
            <div className="flex items-center gap-2 text-[13.5px] font-medium text-muted"><Wallet className="h-4 w-4" />이번 달 추정 비용 (전체 판정 모델)</div>
            <div className="num mt-3 text-[44px] font-bold leading-none tracking-tight"><CountUp value={c?.totals.cost ?? data.month.cost} format={(n) => fmt.usd(n)} /></div>
            <div className="mt-3 text-[13px] text-muted">
              {c?.totals.change !== null && c?.totals.change !== undefined && Number.isFinite(c.totals.change)
                ? <>지난달 대비 <b className={cn("num", c.totals.change > 0 ? "text-warn" : "text-good")}>{c.totals.change > 0 ? "+" : ""}{(c.totals.change * 100).toFixed(0)}%</b> · </>
                : null}
              누적 <b className="num text-ink">{fmt.usd(c?.all_time_cost ?? 0)}</b>
            </div>
            {!!c?.unpriced.length && (
              <div className="mt-2 text-[12.5px] font-medium text-warn">단가가 비어 있어 $0 으로 계산되는 모델: {c.unpriced.join(", ")} — 판정 모델에서 단가를 넣으세요.</div>
            )}
          </div>
          <div className="min-w-0">
            {/* 모델이 하나면 100% 막대는 정보가 없으므로 생략 */}
            {spent.length > 1 && (
              <div className="mb-3 flex h-2.5 gap-[3px] overflow-hidden rounded-full">
                {spent.map((m, i) => <span key={m.key} className="h-full origin-left animate-[bar-x_0.7s_var(--ease-out)_both] rounded-full" style={{ width: `${m.share * 100}%`, background: seriesColor(i) }} />)}
              </div>
            )}
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px]">
              {spent.length ? spent.map((m, i) => (
                <span key={m.key} className="inline-flex items-center gap-1.5 text-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
                  {m.name} <b className="num font-semibold text-ink">{fmt.usd(m.cost)}</b>
                </span>
              )) : <span className="text-muted">이번 달에는 아직 판정 비용이 없습니다.</span>}
            </div>
          </div>
        </div>
        <span className="absolute right-6 top-6 inline-flex items-center gap-1 text-[13px] font-medium text-accent">
          비용 자세히<ArrowUpRight className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </span>
      </Link>
      <StatRow min={200}>
        <Stat to="/runs" label="평가 실행" value={<><CountUp value={data.month.runs} />건</>} sub="이번 달 시작한 평가 → 평가 실행 기록" />
        <Stat to="/costs" label="판정 호출" value={<CountUp value={data.month.judge_calls} />} sub="평가·데이터 생성의 LLM 호출 수 → 비용" />
        <Stat to="/settings/models" label="판정 모델" value={<><CountUp value={data.counts.judge_models ?? 0} />개</>} sub="연결된 모델 → 판정 모델" />
        <Stat to="/runs" label="진행 중" value={<><CountUp value={data.active.length} />건</>} tone={data.active.length ? "accent" : undefined} sub="브라우저를 닫아도 계속 진행" />
      </StatRow>
    </Section>
  );
  return (
    <>
      <PageHeader
        title="개요"
        description="새로 바꾼 검색(후보)이 지금 쓰는 검색(기준)보다 나은지, LLM 판정으로 비교하고 근거와 함께 결론을 냅니다."
        actions={
          <>
            <Link to="/guide/start">
              <Button variant={firstTime ? "secondary" : "ghost"} icon={<Compass className="h-4 w-4" />}>처음 사용하시나요?</Button>
            </Link>
            {canRun ? (
              <Link to="/runs/new">
                <Button variant="primary" icon={<Plus className="h-4 w-4" />}>새 평가</Button>
              </Link>
            ) : next ? (
              <Link to={next.to}>
                <Button variant="primary" icon={<ArrowRight className="h-4 w-4" />}>다음: {next.title}</Button>
              </Link>
            ) : null}
          </>
        }
      />

      {pending.length > 0 && (
        <section className="relative mb-14 overflow-hidden rounded-3xl border border-line bg-panel/80 shadow-soft">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <div className="relative border-b border-line p-7 lg:border-b-0 lg:border-r">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-accent">
                <Sparkles className="h-3.5 w-3.5" />시작하기
              </div>
              <h2 className="mt-4 break-keep text-[22px] font-bold leading-snug tracking-tight">
                {doneCount === 0 ? "첫 평가까지 6단계면 됩니다" : `거의 다 왔어요 — ${pending.length}단계 남음`}
              </h2>
              <p className="mt-2 break-keep text-[14px] leading-relaxed text-muted">연결 → 평가 구성 → 평가 순서로 준비합니다. 단계마다 무엇을 하는지는 시작 가이드에 자세히 있습니다.</p>
              <div className="mt-6">
                <div className="mb-2 flex justify-between text-[12.5px] text-muted"><span>준비 상태</span><span className="num">{doneCount}/{data.onboarding.length}</span></div>
                <Progress value={doneCount} max={data.onboarding.length} className="h-2" />
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                {next && <Link to={next.to}><Button variant="primary" size="sm">다음: {next.title}<ArrowRight className="h-3.5 w-3.5" /></Button></Link>}
                <Link to="/guide/start"><Button size="sm" icon={<Compass className="h-3.5 w-3.5" />}>시작 가이드 보기</Button></Link>
              </div>
            </div>
            <div className="stagger divide-y divide-line">
              {data.onboarding.map((o) => (
                <Link key={o.key} to={o.to} className={cn("row-link flex items-center gap-4 px-6 py-3.5 hover:bg-subtle/60", o.key === next?.key && "bg-accent-soft/40")}>
                  {o.done ? <CheckCircle2 className="animate-check h-5 w-5 shrink-0 text-good" /> : <Circle className={cn("h-5 w-5 shrink-0", o.key === next?.key ? "text-accent" : "text-faint")} />}
                  <div className="min-w-0 flex-1">
                    <div className={cn("text-[14.5px] font-medium", o.done && "text-muted line-through decoration-line")}>{o.title}</div>
                    {!o.done && <div className="mt-0.5 truncate text-[12.5px] text-muted">{o.hint}</div>}
                  </div>
                  {!o.done && <ArrowRight className="row-arrow h-4 w-4 text-faint" />}
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {costSection}

      {data.active.length > 0 && (
        <Section title="진행 중인 평가">
          <div className="grid gap-x-10 md:grid-cols-2">
            {data.active.map((r) => (
              <Link key={r.id} to={`/runs/${r.id}`}>
                <Card className="border-b-0 py-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate font-medium"><span className="num mr-1.5 text-faint">#{r.id}</span>{r.name}</div>
                    <StatusBadge status={r.status} />
                  </div>
                  <Progress className="mt-3" value={r.completed} max={r.total} />
                  <div className="num mt-2 text-[12.5px] text-muted">{r.completed} / {r.total}</div>
                </Card>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {data.trend.length > 1 && (
        <Section title="최근 결과 추이" description="완료된 실행마다 후보의 nDCG 차이입니다. 0 위면 기준보다 좋았고, 점에 올리면 실행을 볼 수 있습니다.">
          <div className="border-y border-line py-6">
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.trend} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
                  <defs><FadeGradient id="trend-fill" color={seriesColor(0)} /></defs>
                  <CartesianGrid {...GRID} vertical={false} />
                  {/* 같은 날 여러 번 돌리면 날짜가 겹치므로, 앞 점과 날짜가 다를 때만 표시 */}
                  <XAxis dataKey="id" interval={0} tick={AXIS_TICK} axisLine={false} tickLine={false} tickMargin={8}
                    tickFormatter={(_, i) => {
                      const d = shortDate(data.trend[i]?.finished_at);
                      return i > 0 && shortDate(data.trend[i - 1]?.finished_at) === d ? "" : d;
                    }} />
                  <YAxis tickFormatter={(v) => fmt.signed(v, 2)} tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
                  <ReferenceLine y={0} stroke="rgb(var(--faint) / 0.6)" />
                  <RTooltip cursor={CURSOR_LINE} content={({ active, payload }) => active && payload?.[0] ? (
                    <ChartTooltip title={<><span className="num mr-1 text-faint">#{String(payload[0].payload.id)}</span>{String(payload[0].payload.name)}</>}
                      rows={[{ color: seriesColor(0), name: "nDCG 차이", value: fmt.signed(payload[0].payload.ndcg_diff as number) }]}
                      footer={fmt.date(String(payload[0].payload.finished_at))} />) : null} />
                  <Area type="monotone" dataKey="ndcg_diff" stroke={seriesColor(0)} strokeWidth={2} fill="url(#trend-fill)"
                    dot={({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { id: number; ndcg_diff: number } }) => (
                      <circle key={payload?.id} cx={cx} cy={cy} r={3.5} strokeWidth={2} stroke="rgb(var(--panel))"
                        fill={(payload?.ndcg_diff ?? 0) >= 0 ? "rgb(var(--good))" : "rgb(var(--bad))"} />
                    )}
                    activeDot={{ r: 5, strokeWidth: 2, stroke: "rgb(var(--panel))" }} {...ANIM} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Section>
      )}

      <Section title="최근 실행" actions={<Link to="/runs" className="text-[13px] font-medium text-accent">전체 보기 →</Link>}>
        {data.recent.length ? (
          <Card className="stagger divide-y divide-line">
            {data.recent.map((r) => (
              <Link key={r.id} to={`/runs/${r.id}`} className="row-link -mx-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-3 py-4 hover:bg-panel/60">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.name}</div>
                  <div className="mt-0.5 text-[12.5px] text-muted">{r.members.map((m) => m.label).join(" vs ")} · {fmt.int(r.total)}건 · {fmt.ago(r.created_at)}</div>
                </div>
                {r.status !== "done" && <StatusBadge status={r.status} />}
                <VerdictBadge verdict={r.headline?.verdict} />
                <span className={cn("num w-16 text-right text-sm font-semibold", (r.headline?.ndcg_diff ?? 0) > 0 ? "text-good" : (r.headline?.ndcg_diff ?? 0) < 0 ? "text-bad" : "text-muted")}>{fmt.signed(r.headline?.ndcg_diff)}</span>
                <div className="w-28">{r.headline?.wins !== null && r.headline?.wins !== undefined && <WinBar wins={r.headline.wins} ties={r.headline.ties ?? 0} losses={r.headline.losses ?? 0} />}</div>
                <ArrowRight className="row-arrow hidden h-4 w-4 text-faint sm:block" />
              </Link>
            ))}
          </Card>
        ) : (
          <div className="stagger grid gap-x-10 md:grid-cols-3">
            {FLOW.map((f) => (
              <Card key={f.title} className="border-b-0 py-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">{f.icon}</div>
                <div className="mt-4 font-semibold">{f.title}</div>
                <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{f.body}</p>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
