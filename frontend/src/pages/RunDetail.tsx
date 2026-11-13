import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, Columns3, FileCode2, Download, Share2, FileJson, FileSpreadsheet, FileText, Pause, Play, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { GradeChip } from "@/components/results/ItemCard";
import { CaseDrawer } from "@/components/results/CaseDrawer";
import { AgreementPanel, ReviewersPanel } from "@/components/results/Agreement";
import { HumanReview } from "@/components/results/HumanReview";
import { ShareDialog } from "@/components/results/ShareDialog";
import { RunSummaryView } from "@/components/results/RunSummaryView";
import { StatusBadge } from "@/components/results/Verdict";
import { Menu, useConfirm } from "@/components/ui/overlay";
import { KeyValue, PageHeader, Section, Segmented, Tabs } from "@/components/ui/page";
import { Alert, Badge, Button, Card, Code, Input, PageSkeleton, Progress, Select, Spinner } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, download, qs } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { CaseRow, Run, RunSummary } from "@/lib/types";

type Tab = "summary" | "cases" | "review" | "settings";
type Basis = "llm" | "combined" | "human";
type Outcome = "" | "win" | "loss" | "tie" | "inconsistent";

/** 진행 중이면 SSE 로 케이스 완료를 받아 화면을 갱신한다(연결이 끊기면 폴링으로 대체). */
function useLiveRun(id: string, active: boolean) {
  const qc = useQueryClient();
  const last = useRef(0);
  useEffect(() => {
    if (!active) return;
    const es = new EventSource(`/api/runs/${id}/events`);
    const refresh = (force = false) => {
      const now = Date.now();
      if (!force && now - last.current < 2500) return;
      last.current = now;
      qc.invalidateQueries({ queryKey: ["run", id] });
      qc.invalidateQueries({ queryKey: ["run-cases", id] });
    };
    es.addEventListener("case", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      qc.setQueryData<Run>(["run", id], (old) => (old ? { ...old, ...data.run } : old));
      refresh();
    });
    es.addEventListener("status", () => refresh(true));
    es.addEventListener("summary", () => refresh(true));
    return () => es.close();
  }, [id, active, qc]);
}

export default function RunDetail() {
  const { id = "" } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) || "summary";
  const setTab = (t: Tab) => setSp((p) => { p.set("tab", t); return p; }, { replace: true });
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [caseId, setCaseId] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"row" | "ndcg_diff" | "ndcg_diff_desc">("row");
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState("");
  const [basis, setBasis] = useState<Basis>("llm");
  const [sharing, setSharing] = useState(false);

  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.get<Run>(`/runs/${id}`),
    refetchInterval: (query) => (["running", "queued"].includes(query.state.data?.status ?? "") ? 10000 : false),
  });
  const r = run.data;
  const active = r?.status === "running" || r?.status === "queued";
  useLiveRun(id, !!active);
  const candidates = (r?.members ?? []).filter((m) => !m.is_baseline).map((m) => m.label);
  const cand = candidate || candidates[0] || "";
  const allCases = useQuery({
    queryKey: ["run-cases", id, "all", cand],
    queryFn: () => api.get<{ total: number; items: CaseRow[]; categories: string[] }>(`/runs/${id}/cases${qs({ candidate: cand, limit: 500 })}`),
    enabled: !!r,
  });
  const cases = useQuery({
    queryKey: ["run-cases", id, cand, outcome, category, status, q, sort],
    queryFn: () =>
      api.get<{ total: number; items: CaseRow[]; categories: string[]; baseline: string }>(
        `/runs/${id}/cases${qs({ candidate: cand, outcome, category, status, q, sort, limit: 500 })}`,
      ),
    enabled: !!r && tab === "cases",
    placeholderData: (prev) => prev,
  });

  const act = async (what: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(what);
    try {
      await fn();
      toast.success(ok);
      qc.invalidateQueries({ queryKey: ["run", id] });
      qc.invalidateQueries({ queryKey: ["runs"] });
    } catch (e) {
      toast.error("처리하지 못했습니다", (e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const exportAs = async (format: "xlsx" | "csv" | "json" | "html") => {
    setBusy(format);
    try {
      await download(`/runs/${id}/export?format=${format}`, `run-${id}.${format}`);
    } catch (e) {
      toast.error("내보내지 못했습니다", (e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const onHumanSummary = (s: RunSummary) => qc.setQueryData<Run>(["run", id], (old) => (old ? { ...old, summary: s } : old));
  const showOutcome = (o: "win" | "loss") => {
    setOutcome(o);
    setTab("cases");
  };

  if (run.isLoading) return <PageSkeleton />;
  if (!r) return <Alert tone="bad">실행을 찾을 수 없습니다.</Alert>;
  const k = r.criteria?.k ?? 5;
  const firstText = r.input_fields.find((f) => f.type === "text")?.key ?? r.input_fields[0]?.key;
  const pending = r.total - r.completed;
  const canResume = !active && pending > 0 && ["interrupted", "cancelled", "failed", "done"].includes(r.status);

  return (
    <>
      <Link to="/runs" className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />평가 실행 기록</Link>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{r.name}<StatusBadge status={r.status} /></span>}
        description={`#${r.id} · ${r.members.map((m) => `${m.label}${m.is_baseline ? "(기준)" : ""}`).join(" vs ")} · ${r.dataset_name ?? "-"}${r.dataset_version ? ` v${r.dataset_version}` : ""} · 판정 ${r.judge_model?.name ?? "-"} (${r.judge_model?.model ?? ""}) · 시작 ${fmt.date(r.started_at ?? r.created_at)} · 소요 ${fmt.duration(r.started_at, r.finished_at)}`}
        actions={
          <>
            {active && <Button icon={<Pause className="h-4 w-4" />} loading={busy === "cancel"} onClick={() => act("cancel", () => api.post(`/runs/${id}/cancel`), "취소했습니다")}>취소</Button>}
            {canResume && <Button icon={<Play className="h-4 w-4" />} loading={busy === "resume"} onClick={() => act("resume", () => api.post(`/runs/${id}/resume`), "남은 케이스를 이어서 실행합니다")}>이어서 실행 ({pending}건)</Button>}
            {!active && (
              <Button variant="ghost" icon={<Share2 className="h-4 w-4" />} onClick={() => setSharing(true)}>공유</Button>
            )}
            {!active && (
              <Link to={`/runs?with=${r.id}`}><Button variant="ghost" icon={<Columns3 className="h-4 w-4" />}>다른 실행과 비교</Button></Link>
            )}
            {!active && (
              <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} loading={busy === "rerun"}
                onClick={async () => {
                  setBusy("rerun");
                  try {
                    const nr = await api.post<Run>(`/runs/${id}/rerun`);
                    navigate(`/runs/${nr.id}`);
                  } catch (e) {
                    toast.error("다시 실행하지 못했습니다", (e as Error).message);
                  } finally {
                    setBusy("");
                  }
                }}>
                같은 설정으로 다시
              </Button>
            )}
            <Menu
              trigger={({ open, toggle }) => (
                <Button variant="ghost" icon={<Download className="h-4 w-4" />} loading={["xlsx", "csv", "json", "html"].includes(busy)} onClick={toggle} aria-expanded={open}>
                  내보내기<ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} />
                </Button>
              )}
              items={[
                { label: "보고서 (.html)", icon: <FileCode2 className="h-4 w-4" />, onSelect: () => exportAs("html"), disabled: !!busy },
                { label: "엑셀 (.xlsx)", icon: <FileSpreadsheet className="h-4 w-4" />, onSelect: () => exportAs("xlsx"), disabled: !!busy },
                { label: "CSV", icon: <FileText className="h-4 w-4" />, onSelect: () => exportAs("csv"), disabled: !!busy },
                { label: "JSON", icon: <FileJson className="h-4 w-4" />, onSelect: () => exportAs("json"), disabled: !!busy },
              ]}
            />
            {!active && (
              <Button size="icon" variant="ghost" aria-label="삭제"
                onClick={async () => {
                  if (!(await confirm.ask({ title: "이 실행을 삭제할까요?", body: "케이스별 응답과 판정 결과가 모두 지워지며 되돌릴 수 없습니다. 필요하면 먼저 내보내기로 저장하세요.", confirm: "삭제", danger: true }))) return;
                  await api.del(`/runs/${id}`);
                  qc.invalidateQueries({ queryKey: ["runs"] });
                  navigate("/runs");
                }}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </>
        }
      />

      {(active || r.status === "interrupted") && (
        <Card className="mb-10 py-6">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="font-medium">{active ? "진행 중 — 이 화면을 닫아도 서버에서 계속 진행됩니다." : "서버 재시작 등으로 중단되었습니다."}</span>
            <span className="num text-muted">
              {fmt.int(r.completed)} 완료 · {r.failed > 0 && <span className="text-bad">{r.failed} 오류 · </span>}{fmt.int(r.total)} 중
            </span>
          </div>
          <Progress className="mt-3 h-2" value={r.completed + r.failed} max={r.total} />
          <div className="mt-3 text-[12.5px] text-muted">판정 호출 {fmt.int(r.judge_calls)}회 · 토큰 {fmt.int(r.tokens_input)}/{fmt.int(r.tokens_output)} · 추정 비용 {fmt.usd(r.cost_estimate)}</div>
        </Card>
      )}
      {r.error && !active && <Alert tone={r.status === "failed" ? "bad" : "warn"} className="mb-6">{r.error}</Alert>}
      {r.failed > 0 && !active && (
        <Alert tone="warn" className="mb-6" title={`오류 케이스 ${r.failed}건`}>
          판정 또는 처리 중 오류가 난 케이스는 지표에서 빠집니다. 원인을 해결한 뒤 ‘이어서 실행’하면 오류 케이스만 다시 처리합니다.
        </Alert>
      )}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <Tabs value={tab} onChange={setTab} items={[
          { value: "summary", label: "요약" }, { value: "cases", label: "케이스", count: r.total },
          { value: "review", label: "사람 검수", count: r.summary?.review?.reviewed_cases ?? 0 }, { value: "settings", label: "실행 설정" },
        ]} className="min-w-0 basis-full sm:basis-auto sm:flex-1" />
        {candidates.length > 1 && (
          <Select className="h-9 w-full sm:w-auto" value={cand} onChange={(e) => setCandidate(e.target.value)}>
            {candidates.map((c) => <option key={c} value={c}>{c} vs 기준</option>)}
          </Select>
        )}
      </div>

      <div key={tab} className="animate-tab">
      {tab === "summary" && r.summary && (() => {
        const rv = r.summary.review;
        const hasHuman = !!r.summary.combined;
        const variant = basis === "combined" ? r.summary.combined : basis === "human" ? r.summary.human : undefined;
        const view: RunSummary = variant ? { ...variant, grade_distribution: r.summary.grade_distribution, status_counts: r.summary.status_counts } : r.summary;
        return (
          <>
            <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line pb-5">
              <span className="text-[13.5px] font-semibold">점수 기준</span>
              <Segmented value={basis} onChange={setBasis} items={[
                { value: "llm", label: "LLM 판정" },
                { value: "combined", label: `결합${hasHuman ? "" : " (검수 없음)"}` },
                { value: "human", label: `사람 판정${rv?.complete_cases ? ` (${rv.complete_cases}건)` : ""}` },
              ]} />
              <span className="min-w-0 grow basis-64 break-keep text-[12.5px] text-muted">
                {basis === "llm" && "판정 모델만으로 낸 결과입니다. 사람 검수 없이도 볼 수 있습니다."}
                {basis === "combined" && "항목마다 사람 등급이 있으면 사람 것을, 없으면 LLM 것을 씁니다(목록 선호도 같은 방식). 검수할수록 사람 기준에 가까워집니다."}
                {basis === "human" && "사람이 모든 항목을 채점한 케이스만으로 계산합니다. 건수가 적으면 결론이 보류됩니다."}
              </span>
              {!!rv?.reviewed_cases && <Button size="sm" variant="ghost" onClick={() => setTab("review")}>검수 {rv.reviewed_cases}건 · 일치도 보기 →</Button>}
            </div>
            {basis !== "llm" && !variant ? (
              <Alert className="mb-8">
                아직 사람 판정이 없습니다. <button className="font-medium text-accent" onClick={() => setTab("review")}>사람 검수</button> 탭에서 케이스를 채점하면 {basis === "combined" ? "결합" : "사람"} 점수가 생깁니다.
              </Alert>
            ) : (
              <RunSummaryView summary={view} k={k} candidate={cand} cases={allCases.data?.items ?? []} onOpenCase={setCaseId} onShowOutcome={showOutcome} live={!!active} />
            )}
          </>
        );
      })()}

      {tab === "review" && (
        <>
          <Section title="LLM–사람 일치도" description="같은 항목을 LLM 과 사람이 둘 다 채점한 경우만 비교합니다. 검수할 때마다 바로 갱신됩니다.">
            <AgreementPanel agreement={r.summary?.agreement} review={r.summary?.review} />
            <ReviewersPanel inter={r.summary?.inter_rater} reviewers={r.summary?.reviewers} />
          </Section>
          {active ? <Alert>평가가 끝난 뒤 검수할 수 있습니다.</Alert> : <HumanReview run={r} onSummary={onHumanSummary} />}
        </>
      )}

      {tab === "cases" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Segmented value={outcome} onChange={setOutcome} items={[
              { value: "", label: "전체" }, { value: "win", label: `${cand} 승` }, { value: "loss", label: "기준 승" }, { value: "tie", label: "무승부" }, { value: "inconsistent", label: "순서 불일치" },
            ]} />
            <Select className="h-9 w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">모든 분류</option>
              {(allCases.data?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
            <Select className="h-9 w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">모든 상태</option>
              <option value="done">완료</option>
              <option value="error">오류</option>
              <option value="pending">대기</option>
            </Select>
            <Select className="h-9 w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="row">입력 순서</option>
              <option value="ndcg_diff">많이 나빠진 순</option>
              <option value="ndcg_diff_desc">많이 좋아진 순</option>
            </Select>
            <div className="relative ml-auto w-56">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
              <Input className="h-9 pl-9" placeholder="케이스·질의 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <Card className="overflow-x-auto">
            {/* 결과(차이·목록 비교)를 앞에 두어, 좁은 화면에서 넘쳐도 핵심 열은 먼저 보이게 한다 */}
            <table className="w-full text-sm" style={{ minWidth: 560 + r.members.length * 150 }}>
              <thead className="border-b border-line text-[12px] text-muted [&_th]:whitespace-nowrap">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">케이스</th>
                  <th className="px-3 py-3 text-left font-medium">질의</th>
                  <th className="px-3 py-3 text-right font-medium">nDCG 차이</th>
                  <th className="px-3 py-3 text-left font-medium">목록 비교</th>
                  {r.members.map((m) => <th key={m.label} className="px-3 py-3 text-left font-medium last:pr-5">{m.label} 1위</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(cases.data?.items ?? []).map((c) => {
                  const pw = c.pairwise?.[cand];
                  return (
                    <tr key={c.id} onClick={() => setCaseId(c.id)} className="cursor-pointer hover:bg-subtle/60">
                      <td className="px-5 py-3">
                        <div className="font-medium">{c.case_key}</div>
                        {c.category && <div className="mt-0.5 text-[12px] text-muted">{c.category}</div>}
                      </td>
                      <td className="max-w-[260px] px-3">
                        <div className="truncate">{fmt.inputs(c.inputs[firstText])}</div>
                        {c.status === "error" && <div className="truncate text-[12px] text-bad">{c.error}</div>}
                        {c.status === "pending" && <div className="text-[12px] text-faint">대기 중</div>}
                      </td>
                      <td className={cn("num px-3 text-right font-semibold", (c.ndcg_diff ?? 0) > 1e-9 ? "text-good" : (c.ndcg_diff ?? 0) < -1e-9 ? "text-bad" : "text-muted")}>{fmt.signed(c.ndcg_diff, 2)}</td>
                      <td className="px-3">
                        {pw ? (
                          <div className="flex items-center gap-1.5">
                            <Badge tone={pw.winner === "candidate" ? "good" : pw.winner === "baseline" ? "bad" : "neutral"}>
                              {pw.winner === "candidate" ? `${cand} 승` : pw.winner === "baseline" ? "기준 승" : "무승부"}
                            </Badge>
                            {!pw.consistent && <Badge tone="warn">불일치</Badge>}
                          </div>
                        ) : <span className="text-faint">–</span>}
                      </td>
                      {r.members.map((m) => {
                        const t = c.tops[m.label];
                        return (
                          <td key={m.label} className="max-w-[200px] px-3 last:pr-5">
                            {!t ? <span className="text-faint">–</span> : t.ok === false ? <span className="text-[12.5px] text-bad">호출 실패</span> : t.title ? (
                              <div className="flex items-center gap-2"><span className="truncate">{t.title}</span><GradeChip grade={t.grade} compact /></div>
                            ) : <span className="text-[12.5px] text-muted">0건</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {cases.isFetching && !cases.data && <div className="flex justify-center py-10"><Spinner /></div>}
            {cases.data && !cases.data.items.length && <div className="py-12 text-center text-sm text-muted">조건에 맞는 케이스가 없습니다.</div>}
          </Card>
          {cases.data && <div className="mt-2 text-[12.5px] text-muted">{cases.data.total}건 · 행을 누르면 상세가 열립니다.</div>}
        </>
      )}

      {tab === "settings" && (
        <div className="grid gap-x-14 gap-y-12 lg:grid-cols-2">
          <Section title="비교한 API" className="mb-0">
            <Card className="divide-y divide-line">
              {r.members.map((m) => (
                <div key={m.label} className="flex flex-wrap items-center gap-3 py-3.5 text-[14px]">
                  <span className="font-semibold">{m.label}</span>
                  {m.is_baseline && <Badge tone="outline">기준</Badge>}
                  <span className="text-muted">{m.target_name}</span>
                </div>
              ))}
            </Card>
          </Section>
          <Section title="판정" className="mb-0">
            <div>
              <KeyValue items={[
                { k: "판정 모델", v: `${r.judge_model?.name} · ${r.judge_model?.model}` },
                { k: "판정 호출", v: `${fmt.int(r.judge_calls)}회` },
                { k: "토큰", v: `입력 ${fmt.int(r.tokens_input)} · 출력 ${fmt.int(r.tokens_output)}` },
                { k: "추정 비용", v: fmt.usd(r.cost_estimate) },
                { k: "동시 실행", v: r.options.concurrency ?? "-" },
              ]} />
            </div>
          </Section>
          {Object.keys(r.criteria_by_member ?? {}).length > 1 && new Set(Object.values(r.criteria_by_member ?? {}).map((c) => c.id)).size > 1 && (
            <Section title="후보별 평가 기준" className="mb-0 lg:col-span-2">
              <KeyValue items={Object.entries(r.criteria_by_member ?? {}).map(([label, c]) => ({
                k: label, v: `${c.name} · 상위 ${c.k}개 · 관련 ≥ ${c.relevant_threshold} · ${c.pairwise_enabled ? "목록 비교 포함" : "항목 판정만"}`,
              }))} />
            </Section>
          )}
          <Section title={`평가 기준 · ${r.criteria?.name ?? ""}`} className="mb-0 lg:col-span-2">
            <div>
              <KeyValue items={[
                { k: "검색 목적", v: <span className="whitespace-pre-line">{r.criteria?.task_context || "(공용 문장)"}</span> },
                { k: "사용자 요구사항", v: <span className="whitespace-pre-line">{r.criteria?.user_requirements || "없음"}</span> },
                { k: "평가 범위", v: `상위 ${r.criteria?.k}개 · 관련 ≥ ${r.criteria?.relevant_threshold} · ${r.criteria?.pairwise_enabled ? "목록 비교 포함" : "항목 판정만"}` },
              ]} />
              <div className="mt-3 text-[12.5px] text-muted">실행 시점의 설정 사본입니다. 이후 평가 기준을 바꿔도 이 실행 결과는 바뀌지 않습니다.</div>
            </div>
          </Section>
          <Section title="컬럼 연결" className="mb-0 lg:col-span-2">
            <Code>{JSON.stringify(r.mapping, null, 2)}</Code>
          </Section>
        </div>
      )}
      </div>

      {(() => {
        const ids = (cases.data?.items ?? []).map((x) => x.id);
        const i = caseId === null ? -1 : ids.indexOf(caseId);
        return (
          <CaseDrawer run={r} caseId={caseId} onClose={() => setCaseId(null)}
            position={i >= 0 ? `${i + 1} / ${ids.length}` : undefined}
            onPrev={i > 0 ? () => setCaseId(ids[i - 1]) : undefined}
            onNext={i >= 0 && i < ids.length - 1 ? () => setCaseId(ids[i + 1]) : undefined} />
        );
      })()}
      {sharing && <ShareDialog runId={r.id} onClose={() => setSharing(false)} />}
      {confirm.node}
    </>
  );
}
