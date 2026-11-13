import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Bot, Coins, Info, Settings2, Wallet } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { StatusBadge } from "@/components/results/Verdict";
import { CountUp } from "@/components/ui/motion";
import { PageHeader, Section, Segmented, Stat, StatRow } from "@/components/ui/page";
import { Alert, Badge, Button, Empty, PageSkeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { PROVIDER_LABEL, cn, fmt } from "@/lib/format";
import type { CostReport } from "@/lib/types";

type Period = CostReport["period"];
const PERIODS: { value: Period; label: string }[] = [
  { value: "7d", label: "7일" },
  { value: "30d", label: "30일" },
  { value: "90d", label: "90일" },
  { value: "month", label: "이번 달" },
  { value: "all", label: "전체" },
];
const PERIOD_TEXT: Record<Period, string> = { "7d": "최근 7일", "30d": "최근 30일", "90d": "최근 90일", month: "이번 달", all: "전체 기간" };
const PALETTE = ["rgb(var(--accent))", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6", "#0ea5e9", "#84cc16", "#f97316"];

export const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString("ko-KR");

function ChangeBadge({ change, prevLabel }: { change: number | null; prevLabel: string }) {
  if (change === null || !Number.isFinite(change)) return <span className="text-[13px] text-muted">이전 기간 비교 없음</span>;
  const up = change > 0;
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
      <span className={cn("inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-semibold", up ? "bg-warn-soft text-warn" : "bg-good-soft text-good")}>
        {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
        {Math.abs(change * 100).toFixed(0)}%
      </span>
      {prevLabel} 대비
    </span>
  );
}

export default function Costs() {
  const [period, setPeriod] = useState<Period>("30d");
  const { data, isLoading } = useQuery({
    queryKey: ["costs", period],
    queryFn: () => api.get<CostReport>(`/costs?period=${period}`),
    placeholderData: (prev) => prev,
  });
  if (isLoading || !data) return <PageSkeleton />;

  const t = data.totals;
  const color = (name: string) => PALETTE[Math.max(0, data.series.indexOf(name)) % PALETTE.length];
  const used = data.models.filter((m) => m.cost > 0 || m.judge_calls > 0);
  const chartDaily = data.daily.map((d) => ({ date: d.date, ...d.by_model, total: d.total }));
  const tick = (d: string) => {
    const [, m, day] = d.split("-");
    return `${Number(m)}/${Number(day)}`;
  };
  const prevLabel = period === "month" ? "지난달" : "이전 같은 기간";

  return (
    <>
      <PageHeader
        eyebrow="운영"
        title="비용"
        description="판정 모델별로 쓴 토큰과 추정 비용입니다. 실행마다 기록한 토큰 수에 판정 모델의 단가(100만 토큰당)를 곱해 계산합니다."
        actions={
          <>
            <Segmented value={period} onChange={setPeriod} items={PERIODS} />
            <Link to="/settings/models"><Button variant="ghost" size="sm" icon={<Settings2 className="h-4 w-4" />}>단가 설정</Button></Link>
          </>
        }
      />

      {data.unpriced.length > 0 && (
        <Alert tone="warn" className="mb-8" icon={<AlertTriangle className="h-4 w-4" />} title="단가가 비어 있는 판정 모델이 있습니다">
          토큰을 썼지만 단가가 0이라 비용이 $0 으로 계산되는 모델: <b>{data.unpriced.join(", ")}</b>. <Link to="/settings/models" className="font-medium text-accent">판정 모델에서 단가 입력 →</Link>
        </Alert>
      )}

      {/* 총 비용 */}
      <section className="relative mb-14 overflow-hidden rounded-3xl border border-line bg-panel/80 shadow-soft">
        <div className="pointer-events-none absolute -left-20 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="relative border-b border-line p-7 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-2 text-[13.5px] font-medium text-muted"><Wallet className="h-4 w-4" />{PERIOD_TEXT[period]} 추정 비용</div>
            <div className="num mt-3 text-[44px] font-bold leading-none tracking-tight">
              <CountUp value={t.cost} format={(n) => fmt.usd(n)} />
            </div>
            <div className="mt-3"><ChangeBadge change={t.change} prevLabel={prevLabel} /></div>
            <div className="mt-6 space-y-2.5">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-subtle">
                {used.filter((m) => m.cost > 0).map((m) => (
                  <span key={m.key} className="h-full transition-[width] duration-700" style={{ width: `${m.share * 100}%`, background: color(m.name) }} title={`${m.name} ${fmt.pct(m.share)}`} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
                {used.filter((m) => m.cost > 0).map((m) => (
                  <span key={m.key} className="inline-flex items-center gap-1.5 text-muted">
                    <span className="h-2 w-2 rounded-full" style={{ background: color(m.name) }} />
                    {m.name} <b className="num font-semibold text-ink">{fmt.pct(m.share)}</b>
                  </span>
                ))}
                {!used.some((m) => m.cost > 0) && <span className="text-muted">이 기간에 쓴 비용이 없습니다.</span>}
              </div>
            </div>
            <div className="mt-6 text-[12.5px] text-muted">누적 전체 <b className="num text-ink">{fmt.usd(data.all_time_cost)}</b></div>
          </div>
          <div className="p-5 sm:p-7">
            <div className="mb-3 flex items-center justify-between text-[13.5px]">
              <span className="font-semibold">날짜별 비용</span>
              <span className="text-muted">모델별로 쌓아서 표시</span>
            </div>
            <div className="h-[230px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartDaily} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickFormatter={tick} tick={{ fontSize: 11, fill: "rgb(var(--faint))" }} axisLine={false} tickLine={false} minTickGap={18} />
                  <YAxis tickFormatter={(v) => `$${Number(v) < 1 ? Number(v).toFixed(2) : Number(v).toFixed(0)}`} tick={{ fontSize: 11, fill: "rgb(var(--faint))" }} axisLine={false} tickLine={false} width={48} />
                  <RTooltip
                    cursor={{ fill: "rgb(var(--subtle))" }}
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="min-w-[160px] rounded-xl bg-ink px-3 py-2.5 text-[12px] text-panel shadow-lg">
                          <div className="mb-1.5 font-semibold">{String(label)}</div>
                          {payload.filter((p) => Number(p.value) > 0).map((p) => (
                            <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
                              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: String(p.color) }} />{String(p.dataKey)}</span>
                              <span className="num">{fmt.usd(Number(p.value))}</span>
                            </div>
                          ))}
                          <div className="mt-1.5 flex justify-between border-t border-white/15 pt-1.5"><span>합계</span><span className="num font-semibold">{fmt.usd(Number(payload[0].payload.total))}</span></div>
                        </div>
                      ) : null
                    }
                  />
                  {data.series.map((s, i) => (
                    <Bar key={s} dataKey={s} stackId="c" fill={color(s)} maxBarSize={22} radius={i === data.series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} animationDuration={700} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </section>

      <Section title={`${PERIOD_TEXT[period]} 사용량`}>
        <StatRow min={190}>
          <Stat label="평가 실행" value={<><CountUp value={t.runs} />건</>} sub={<Link to="/runs" className="text-accent hover:underline">평가 실행 기록 →</Link>} />
          <Stat label="판정 호출" value={<CountUp value={t.judge_calls} />} sub={`케이스 ${fmt.int(t.cases)}건`} />
          <Stat label="입력 토큰" value={<CountUp value={t.tokens_input} format={compact} />} sub="판정 모델에 보낸 양" />
          <Stat label="출력 토큰" value={<CountUp value={t.tokens_output} format={compact} />} sub="판정 모델이 쓴 양" />
          <Stat label="케이스당 평균" value={fmt.usd(t.avg_cost_per_case)} sub={`실행당 ${fmt.usd(t.avg_cost_per_run)}`} />
        </StatRow>
      </Section>

      <Section title="판정 모델별" description="모델마다 단가·사용량·비용입니다. 막대는 전체 비용에서 차지하는 비율(진한 부분 = 입력, 옅은 부분 = 출력)입니다."
        actions={<Link to="/settings/models" className="text-[13px] font-medium text-accent">판정 모델 관리 →</Link>}>
        {data.models.length === 0 ? (
          <Empty icon={<Bot className="h-7 w-7" />} title="판정 모델이 없습니다" action={<Link to="/settings/models"><Button variant="primary">판정 모델 연결</Button></Link>}>
            판정 모델을 연결하고 평가를 실행하면 여기에서 비용을 볼 수 있습니다.
          </Empty>
        ) : (
          <div className="stagger divide-y divide-line border-y border-line">
            {data.models.map((m) => {
              const c = color(m.name);
              return (
                <div key={m.key} className="grid gap-x-8 gap-y-4 py-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(140px,0.6fr)]">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-1 h-3 w-3 shrink-0 rounded-full ring-4 ring-subtle" style={{ background: m.cost > 0 ? c : "rgb(var(--line))" }} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[15px] font-semibold">{m.name}</span>
                        {m.is_default && <Badge tone="accent">기본</Badge>}
                        {!m.exists && <Badge tone="outline">삭제됨</Badge>}
                        {m.exists && !m.priced && <Badge tone="warn">단가 없음</Badge>}
                      </div>
                      <div className="mt-0.5 truncate text-[12.5px] text-muted">{PROVIDER_LABEL[m.provider] ?? m.provider} · {m.model}</div>
                      <div className="num mt-2 text-[12.5px] text-muted">
                        {m.price_input_per_mtok === null ? "단가 정보 없음" : <>입력 ${m.price_input_per_mtok} · 출력 ${m.price_output_per_mtok} <span className="text-faint">/ 100만 토큰</span></>}
                      </div>
                    </div>
                  </div>
                  <div className="min-w-0 self-center">
                    <div className="mb-2 flex justify-between text-[12.5px] text-muted">
                      <span className="num">실행 {fmt.int(m.runs)} · 호출 {fmt.int(m.judge_calls)} · 토큰 {compact(m.tokens_input)} / {compact(m.tokens_output)}</span>
                      <span className="num font-semibold text-ink">{fmt.pct(m.share)}</span>
                    </div>
                    <div className="flex h-2 overflow-hidden rounded-full bg-subtle">
                      <span className="h-full transition-[width] duration-700" style={{ width: `${(m.cost ? m.cost_input / m.cost : 0) * m.share * 100}%`, background: c }} />
                      <span className="h-full opacity-40 transition-[width] duration-700" style={{ width: `${(m.cost ? m.cost_output / m.cost : 0) * m.share * 100}%`, background: c }} />
                    </div>
                    <div className="mt-1.5 text-[12px] text-faint">{m.last_used_at ? `마지막 사용 ${fmt.ago(m.last_used_at)}` : "이 기간에 사용 없음"}</div>
                  </div>
                  <div className="flex items-center justify-between gap-4 lg:block lg:text-right">
                    <div className="num text-[24px] font-bold tracking-tight">{fmt.usd(m.cost)}</div>
                    <div className="num text-[12.5px] text-muted">케이스당 {fmt.usd(m.avg_cost_per_case)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] [&>*]:min-w-0">
        <Section title="비율">
          {used.some((m) => m.cost > 0) ? (
            <div className="relative h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={used.filter((m) => m.cost > 0)} dataKey="cost" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={used.filter((m) => m.cost > 0).length > 1 ? 2 : 0} stroke="none" animationDuration={700}>
                    {used.filter((m) => m.cost > 0).map((m) => <Cell key={m.key} fill={color(m.name)} />)}
                  </Pie>
                  <RTooltip content={({ active, payload }) => active && payload?.[0] ? (
                    <div className="rounded-xl bg-ink px-3 py-2 text-[12px] text-panel shadow-lg">{String(payload[0].name)} · <span className="num">{fmt.usd(Number(payload[0].value))}</span></div>
                  ) : null} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[12px] text-muted">모델 {used.filter((m) => m.cost > 0).length}개</span>
                <span className="num text-[20px] font-bold">{fmt.usd(t.cost)}</span>
              </div>
            </div>
          ) : (
            <div className="flex h-[240px] items-center justify-center border-y border-line text-sm text-muted">표시할 비용이 없습니다.</div>
          )}
        </Section>

        <Section title="비용이 큰 평가" actions={<Link to="/runs" className="text-[13px] font-medium text-accent">전체 기록 →</Link>}>
          {data.top_runs.length ? (
            <div className="divide-y divide-line border-y border-line">
              {data.top_runs.map((r, i) => (
                <Link key={r.id} to={`/runs/${r.id}`} className="row-link -mx-3 flex items-center gap-4 rounded-xl px-3 py-3.5 hover:bg-panel/60">
                  <span className="num w-5 shrink-0 text-[13px] font-semibold text-faint">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14.5px] font-medium">{r.name}</div>
                    <div className="mt-0.5 truncate text-[12.5px] text-muted">{r.model} · 케이스 {fmt.int(r.cases)} · 호출 {fmt.int(r.judge_calls)} · {fmt.ago(r.created_at)}</div>
                  </div>
                  <StatusBadge status={r.status} />
                  <span className="num w-20 shrink-0 text-right text-[14px] font-semibold">{fmt.usd(r.cost)}</span>
                  <ArrowRight className="row-arrow hidden h-4 w-4 text-faint sm:block" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex h-[120px] items-center justify-center border-y border-line text-sm text-muted">이 기간의 평가가 없습니다.</div>
          )}
        </Section>
      </div>

      <Alert icon={<Info className="h-4 w-4" />} className="mt-2">
        <span className="inline-flex items-center gap-1"><Coins className="h-3.5 w-3.5" /></span> 추정 비용은 <b>실행 당시 단가</b>로 계산해 실행에 저장한 값입니다. 공급자의 실제 청구액(캐시 할인, 최소 과금, 환율 등)과 다를 수 있습니다. 단건 검색 비교는 판정을 하지 않으므로 비용이 없습니다.
      </Alert>
    </>
  );
}
