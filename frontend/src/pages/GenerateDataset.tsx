import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Check, CheckCircle2, CircleSlash, Eye, Loader2, Play, Plus, RotateCcw, Search, Sparkles, Square, Trash2, Wand2, X,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CountUp } from "@/components/ui/motion";
import { FormRow, PageHeader, Rows, Segmented, Stat, StatRow } from "@/components/ui/page";
import { Alert, Badge, Button, Input, PageSkeleton, Progress, Select, Switch, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { Dataset, JudgeModel, Suite } from "@/lib/types";

interface Options {
  styles: Record<string, string>;
  description_draft?: string;
  inputs?: { key: string; label: string; type: string; required: boolean; scope: string }[];
  members?: string[];
}
interface GenRow {
  id: number;
  category: string;
  style: string;
  inputs: Record<string, unknown>;
  expected: string;
  source?: { api: string; key: string; title: string } | null;
  check?: { found_in: string[]; empty: boolean; failed: string[] };
}
interface Job {
  id: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  stage: string;
  progress: number;
  total: number;
  rows: GenRow[];
  stats: Record<string, number | boolean | Record<string, number>>;
  error: string;
  params: { count: number; grounded: boolean; preview: boolean; model_name?: string };
  tokens_input: number;
  tokens_output: number;
  judge_calls: number;
  cost_estimate: number;
  dataset_id: number | null;
}

const WEIGHTS = [
  { value: "0", label: "안 씀" },
  { value: "1", label: "조금" },
  { value: "2", label: "보통" },
  { value: "3", label: "많이" },
];
const STYLE_SHORT: Record<string, string> = { keyword: "키워드형", natural: "자연어 질문", multi: "조건 여러 개", typo: "오타·구어체", ambiguous: "모호한 질의" };
const STYLE_COLOR: Record<string, string> = { keyword: "#6366f1", natural: "#14b8a6", multi: "#f59e0b", typo: "#ec4899", ambiguous: "#8b5cf6" };

function ChipInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const parts = text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).filter((x) => !value.includes(x));
    if (parts.length) onChange([...value, ...parts]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-line bg-panel px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
      {value.map((v) => (
        <span key={v} className="animate-pop inline-flex items-center gap-1 rounded-lg bg-accent-soft px-2 py-0.5 text-[13px] font-medium text-accent">
          {v}<button type="button" aria-label={`${v} 빼기`} onClick={() => onChange(value.filter((x) => x !== v))}><X className="h-3 w-3" /></button>
        </span>
      ))}
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={add} placeholder={value.length ? "" : placeholder}
        className="h-7 min-w-[120px] flex-1 bg-transparent px-1 text-sm focus:outline-none" />
    </div>
  );
}

export default function GenerateDataset() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const suites = useQuery({ queryKey: ["suites"], queryFn: () => api.get<Suite[]>("/suites") });
  const models = useQuery({ queryKey: ["judge-models"], queryFn: () => api.get<JudgeModel[]>("/judge-models") });
  const [suiteId, setSuiteId] = useState<number | "">(Number(sp.get("suite")) || "");
  const opts = useQuery({ queryKey: ["gen-options", suiteId], queryFn: () => api.get<Options>(`/generate/options${suiteId ? `?suite_id=${suiteId}` : ""}`) });

  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [count, setCount] = useState(30);
  const [styles, setStyles] = useState<Record<string, number>>({ natural: 3, keyword: 2, multi: 1, typo: 1, ambiguous: 0 });
  const [grounded, setGrounded] = useState(false);
  const [modelId, setModelId] = useState<number | "">("");
  const [jobId, setJobId] = useState<number | null>(null);
  const [edited, setEdited] = useState<GenRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | "found" | "empty" | "notfound">("all");
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<Dataset | null>(null);

  useEffect(() => {
    if (suiteId === "" && suites.data?.length) setSuiteId(suites.data[0].id);
  }, [suites.data, suiteId]);
  useEffect(() => {
    if (modelId === "" && models.data?.length) setModelId(models.data.find((m) => m.is_default)?.id ?? models.data[0].id);
  }, [models.data, modelId]);
  useEffect(() => {
    setDescription((d) => d || opts.data?.description_draft || "");
  }, [opts.data?.description_draft]);

  const job = useQuery({
    queryKey: ["gen-job", jobId],
    queryFn: () => api.get<Job>(`/generate/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (["queued", "running"].includes(q.state.data?.status ?? "queued") ? 800 : false),
  });
  const j = job.data;
  const running = !!jobId && (!j || j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (j && j.status !== "running" && j.status !== "queued") setEdited(j.rows);
  }, [j?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const suite = suites.data?.find((s) => s.id === suiteId);
  const inputs = opts.data?.inputs ?? [];
  const styleTotal = Object.values(styles).reduce((a, b) => a + b, 0);
  const batches = Math.ceil(count / 10);
  const apiCalls = grounded ? (Math.min(12, Math.max(4, Math.floor(count / 4))) + count) * (suite?.members.length ?? 2) : 0;

  const start = async (preview: boolean) => {
    if (!suiteId) return;
    setEdited(null);
    setSaved(null);
    try {
      const res = await api.post<Job>("/generate", {
        suite_id: suiteId, judge_model_id: modelId || null, description, categories, count, styles, grounded, preview,
      });
      setJobId(res.id);
      setName(`${suite?.name ?? "테스트"} · LLM 생성${grounded ? "(검색 기반)" : ""} · ${new Date().toLocaleDateString("ko-KR")}`);
    } catch (e) {
      toast.error("시작하지 못했습니다", (e as Error).message);
    }
  };
  const cancel = async () => {
    if (jobId) await api.post(`/generate/${jobId}/cancel`).catch(() => {});
  };
  const save = async () => {
    if (!jobId || !edited) return;
    try {
      const d = await api.post<Dataset>(`/generate/${jobId}/save`, { name: name.trim() || "LLM 생성 데이터", rows: edited });
      setSaved(d);
      qc.invalidateQueries({ queryKey: ["datasets"] });
      qc.invalidateQueries({ queryKey: ["costs"] });
      toast.success("테스트 데이터로 저장했습니다", `${d.row_count}행 · 비교 세트와 연결까지 저장되어 바로 평가할 수 있습니다.`);
    } catch (e) {
      toast.error("저장하지 못했습니다", (e as Error).message);
    }
  };

  const rowsView = useMemo(() => {
    const rs = edited ?? j?.rows ?? [];
    if (filter === "found") return rs.filter((r) => r.check?.found_in.length);
    if (filter === "empty") return rs.filter((r) => r.check?.empty);
    if (filter === "notfound") return rs.filter((r) => r.check && !r.check.found_in.length && !r.check.empty);
    return rs;
  }, [edited, j?.rows, filter]);
  const setRow = (id: number, patch: Partial<GenRow>) => setEdited((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRow = (id: number) => setEdited((rs) => (rs ?? []).filter((r) => r.id !== id));

  if (suites.isLoading || models.isLoading) return <PageSkeleton />;
  if (!suites.data?.length)
    return (
      <>
        <PageHeader eyebrow="테스트 데이터" title="LLM 으로 만들기" />
        <Alert tone="warn" title="비교 세트가 먼저 필요합니다">어떤 입력 칸을 채울지 비교 세트가 정합니다. <Link to="/settings/suites" className="font-medium text-accent">비교 세트 만들기 →</Link></Alert>
      </>
    );
  if (!models.data?.length)
    return (
      <>
        <PageHeader eyebrow="테스트 데이터" title="LLM 으로 만들기" />
        <Alert tone="warn" title="생성에 쓸 모델이 없습니다">판정 모델로 등록한 모델을 생성에도 씁니다. <Link to="/settings/models" className="font-medium text-accent">판정 모델 연결 →</Link></Alert>
      </>
    );

  const phase: "form" | "progress" | "review" = !jobId ? "form" : running ? "progress" : "review";
  const stats = j?.stats ?? {};
  const isPreview = !!j?.params.preview;
  const rowsAll = edited ?? j?.rows ?? [];

  return (
    <>
      <Link to="/datasets" className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />테스트 데이터</Link>
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />테스트 데이터</span>}
        title="LLM 으로 테스트 데이터 만들기"
        description="서비스를 설명하면 비교 세트의 입력 칸에 맞춘 질의를 만들어 줍니다. 만든 뒤 검토·수정하고 저장하면 비교 세트와 연결까지 저장되어 바로 평가할 수 있습니다."
      />

      {/* 단계 표시 */}
      <ol className="mb-10 grid grid-cols-3 border-b border-line text-[13.5px]">
        {[["form", "1. 설정"], ["progress", "2. 만드는 중"], ["review", "3. 검토하고 저장"]].map(([k, label], i) => {
          const idx = ["form", "progress", "review"].indexOf(phase);
          return (
            <li key={k} className={cn("-mb-px border-b-2 py-3 transition-colors duration-300", i === idx ? "border-ink font-semibold" : i < idx ? "border-transparent text-ink/70" : "border-transparent text-faint")}>
              {i < idx ? <Check className="mr-1 inline h-3.5 w-3.5 text-good" /> : null}{label}
            </li>
          );
        })}
      </ol>

      {phase === "form" && (
        <div className="animate-fade-up">
          <Rows>
            <FormRow label="어느 비교 세트용인가요?" required help="이 세트의 입력 칸을 채운 질의가 만들어집니다.">
              <Select value={suiteId} onChange={(e) => setSuiteId(Number(e.target.value))}>
                {suites.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              {inputs.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  <span className="text-muted">채울 칸</span>
                  {inputs.map((f) => (
                    <span key={f.key} className={cn("rounded-lg px-2 py-0.5 font-medium", f.scope ? "bg-subtle text-muted" : "bg-accent-soft text-accent")}>
                      {f.label}{f.required && <span className="ml-0.5 text-bad">*</span>}
                      <span className="ml-1 font-normal opacity-70">{f.type === "list" ? "여러 값" : f.type === "int" ? "숫자" : "문장"}</span>
                    </span>
                  ))}
                </div>
              )}
            </FormRow>
            <FormRow label="어떤 서비스인가요?" help="누가 무엇을 찾는 검색인지 2~3줄로 적어 주세요. 실제 질의 예시를 한두 개 넣으면 더 비슷하게 만듭니다. 평가 기준의 검색 목적으로 미리 채웠습니다.">
              <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder={"예: 사내 직원이 업무 문의를 할 담당자를 찾는 검색. 사람들은 '학자금 신청 누구한테 해?', '법인카드 분실' 처럼 짧게 묻는다."} />
            </FormRow>
            <FormRow label="분류 (선택)" help="분류마다 고르게 만들고, 평가 결과를 분류별로 나눠 볼 수 있습니다. 입력 후 Enter.">
              <ChipInput value={categories} onChange={setCategories} placeholder="예: 인사, 재무, 총무" />
            </FormRow>
            <FormRow label="몇 개 만들까요?" help="믿을 만한 결론에는 30개 이상을 권장합니다(최대 500).">
              <div className="flex flex-wrap items-center gap-3">
                <Segmented value={["10", "30", "50", "100"].includes(String(count)) ? String(count) : ""} onChange={(v) => v && setCount(Number(v))}
                  items={["10", "30", "50", "100"].map((v) => ({ value: v, label: `${v}개` }))} />
                <span className="text-[13px] text-muted">직접</span>
                <Input type="number" min={1} max={500} className="h-9 w-24" value={count} onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
              </div>
            </FormRow>
            <FormRow label="어떤 말투로 물을까요?" help="실제 사용자는 다양하게 묻습니다. 비율대로 섞어 만듭니다.">
              <div className="space-y-2.5">
                {Object.entries(opts.data?.styles ?? {}).map(([k, desc]) => (
                  <div key={k} className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[14px] font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STYLE_COLOR[k] }} />{STYLE_SHORT[k] ?? k}</div>
                      <div className="truncate text-[12.5px] text-muted">{desc.split(" — ")[1] ?? desc}</div>
                    </div>
                    <Segmented value={String(styles[k] ?? 0)} onChange={(v) => setStyles((s) => ({ ...s, [k]: Number(v) }))} items={WEIGHTS} />
                  </div>
                ))}
                <div className="flex h-2 overflow-hidden rounded-full bg-subtle">
                  {Object.entries(styles).filter(([, w]) => w > 0).map(([k, w]) => (
                    <span key={k} className="h-full transition-[width] duration-500" style={{ width: `${(w / Math.max(1, styleTotal)) * 100}%`, background: STYLE_COLOR[k] }} />
                  ))}
                </div>
              </div>
            </FormRow>
            <FormRow label="정확도 높이기 (선택)" help="실제 검색 결과를 보고 질의를 만들면 '답이 있는 질의'가 됩니다.">
              <div className={cn("rounded-2xl border p-4 transition-colors", grounded ? "border-accent/50 bg-accent-soft/30" : "border-line")}>
                <Switch checked={grounded} onChange={setGrounded} label={<span className="font-semibold">실제 검색 결과 참고하기</span>} />
                <ol className="mt-3 space-y-1.5 break-keep text-[13px] leading-relaxed text-muted">
                  <li><b className="text-ink">① 실제 결과 모으기</b> — 탐색용 질의 몇 개로 모든 API 를 불러 결과 항목을 모읍니다. 한 API 에 치우치지 않게 번갈아 뽑습니다.</li>
                  <li><b className="text-ink">② 항목이 답인 질의 만들기</b> — 실제 항목을 보여 주고 그 항목을 찾는 사용자의 말로 질의를 씁니다(문서 문구 그대로 베끼지 않게).</li>
                  <li><b className="text-ink">③ 답 확인</b> — 만든 질의로 다시 검색해 원본이 어느 API 상위에 나오는지, 결과 0건인지 표시합니다.</li>
                </ol>
                <div className="mt-3 text-[12.5px] text-muted">
                  {grounded ? <>검색 API 호출 약 <b className="num text-ink">{fmt.int(apiCalls)}회</b>가 추가되고 시간이 더 걸립니다.</> : "끄면 설명만 보고 만듭니다(빠름). 검색 범위 밖 질의가 섞일 수 있습니다."}
                </div>
              </div>
            </FormRow>
            <FormRow label="만들 모델" help="판정 모델 목록을 그대로 씁니다. 판정에 쓸 모델과 다른 계열이면 더 공정합니다.">
              <Select value={modelId} onChange={(e) => setModelId(Number(e.target.value))}>
                {models.data.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.model}{m.is_default ? " (기본)" : ""}</option>)}
              </Select>
              <div className="mt-2 text-[12.5px] text-muted">생성 호출 약 {batches + (grounded ? 1 : 0)}회 · 비용은 비용 화면에 ‘데이터 생성’으로 함께 집계됩니다.</div>
            </FormRow>
          </Rows>
          <div className="sticky bottom-0 z-10 -mx-4 mt-8 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/85 px-4 py-4 backdrop-blur sm:-mx-8 sm:px-8 lg:-mx-14 lg:px-14">
            <span className="mr-auto text-[13px] text-muted">{suite?.name} · {count}개 · {grounded ? "검색 기반" : "설명 기반"}</span>
            <Button icon={<Eye className="h-4 w-4" />} disabled={!suiteId} onClick={() => start(true)}>미리 5개 만들어 보기</Button>
            <Button variant="primary" icon={<Wand2 className="h-4 w-4" />} disabled={!suiteId} onClick={() => start(false)}>{count}개 만들기</Button>
          </div>
        </div>
      )}

      {phase === "progress" && (
        <div className="animate-fade-up">
          <div className="rounded-3xl border border-line bg-panel/80 p-7 shadow-soft">
            <div className="flex flex-wrap items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              <span className="text-[17px] font-semibold">{j?.stage || "준비 중"}</span>
              <span className="num ml-auto text-[13px] text-muted">{j ? `${Math.min(j.progress, j.total)} / ${j.total}` : ""}</span>
            </div>
            <Progress className="mt-4 h-2" value={j?.progress ?? 0} max={j?.total || 1} />
            {j?.params.grounded && (
              <div className="mt-5 grid gap-2 text-[13px] sm:grid-cols-3">
                {["실제 검색 결과 모으는 중", "질의 만드는 중", "답이 있는지 확인하는 중"].map((st, i) => {
                  const order = ["실제 검색 결과 모으는 중", "질의 만드는 중", "답이 있는지 확인하는 중"];
                  const cur = order.indexOf(j.stage);
                  return (
                    <div key={st} className={cn("flex items-center gap-2 rounded-xl border px-3 py-2", i === cur ? "border-accent/50 bg-accent-soft/40 text-ink" : i < cur ? "border-line text-good" : "border-line text-faint")}>
                      {i < cur ? <CheckCircle2 className="h-4 w-4" /> : i === cur ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="h-4 w-4 rounded-full border border-current" />}
                      {["① 실제 결과 모으기", "② 질의 만들기", "③ 답 확인"][i]}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-4 text-[12.5px] text-muted">
              <span>생성 호출 {fmt.int(j?.judge_calls ?? 0)}회</span>
              <span>비용 {fmt.usd(j?.cost_estimate ?? 0)}</span>
              <span>이 화면을 떠나도 서버에서 계속 진행됩니다.</span>
              <Button size="sm" variant="ghost" className="ml-auto" icon={<Square className="h-3.5 w-3.5" />} onClick={cancel}>멈추기</Button>
            </div>
          </div>
          {!!j?.rows.length && (
            <div className="mt-8">
              <div className="mb-2 text-[13.5px] font-semibold">지금까지 만든 질의</div>
              <div className="divide-y divide-line border-y border-line">
                {j.rows.slice(-8).map((r) => (
                  <div key={r.id} className="animate-fade-up flex items-center gap-3 py-2.5 text-[14px]">
                    <span className="num w-8 text-[12px] text-faint">{r.id}</span>
                    <span className="min-w-0 flex-1 truncate">{Object.values(r.inputs).filter(Boolean).map((v) => (Array.isArray(v) ? v.join(" ") : String(v))).join(" · ")}</span>
                    {r.category && <Badge>{r.category}</Badge>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {phase === "review" && j && (
        <div className="animate-fade-up">
          {j.status === "failed" && <Alert tone="bad" className="mb-6" title="만들지 못했습니다">{j.error}</Alert>}
          {j.status === "cancelled" && <Alert tone="warn" className="mb-6">멈췄습니다. 지금까지 만든 {j.rows.length}개는 저장할 수 있습니다.</Alert>}
          {j.status === "done" && j.error && <Alert tone="warn" className="mb-6">{j.error}</Alert>}
          {isPreview && (
            <Alert tone="accent" className="mb-6" icon={<Eye className="h-4 w-4" />} title="미리보기 5개입니다">
              방향이 마음에 들면 아래 ‘이 설정으로 {count}개 만들기’를 누르세요. 아니면 ‘설정 고치기’로 설명·말투를 바꿔 보세요.
            </Alert>
          )}
          {stats.grounded_fallback && <Alert tone="warn" className="mb-6">실제 검색 결과를 모으지 못해 설명만으로 만들었습니다. 검색 API 연결을 확인하세요.</Alert>}

          <StatRow min={170}>
            <Stat label="만든 질의" value={<><CountUp value={rowsAll.length} />개</>} sub={`요청 ${j.params.count}개`} />
            <Stat label="걸러낸 것" value={`${fmt.int(Number(stats.dropped_duplicate ?? 0) + Number(stats.dropped_pii ?? 0) + Number(stats.dropped_invalid ?? 0))}개`}
              sub={`중복 ${stats.dropped_duplicate ?? 0} · 개인정보 ${stats.dropped_pii ?? 0} · 형식 ${stats.dropped_invalid ?? 0}`} />
            {j.params.grounded && <Stat label="답 확인됨" tone="good" value={`${fmt.int(Number(stats.answer_found ?? 0))}개`} sub="원본 항목이 어느 API 상위에 나옴" />}
            {j.params.grounded && <Stat label="결과 0건" tone={Number(stats.all_empty) ? "warn" : undefined} value={`${fmt.int(Number(stats.all_empty ?? 0))}개`} sub="모든 API 가 결과 없음" />}
            <Stat label="비용" value={fmt.usd(j.cost_estimate)} sub={`호출 ${j.judge_calls}회 · ${j.params.model_name ?? ""}`} />
          </StatRow>

          <div className="mt-8 mb-3 flex flex-wrap items-center gap-2">
            {j.params.grounded && (
              <Segmented value={filter} onChange={setFilter} items={[
                { value: "all", label: `전체 ${rowsAll.length}` },
                { value: "found", label: `답 확인 ${rowsAll.filter((r) => r.check?.found_in.length).length}` },
                { value: "notfound", label: `원본 못 찾음 ${rowsAll.filter((r) => r.check && !r.check.found_in.length && !r.check.empty).length}` },
                { value: "empty", label: `결과 0건 ${rowsAll.filter((r) => r.check?.empty).length}` },
              ]} />
            )}
            {j.params.grounded && rowsAll.some((r) => r.check?.empty) && (
              <Button size="sm" variant="ghost" icon={<CircleSlash className="h-3.5 w-3.5" />} onClick={() => setEdited((rs) => (rs ?? []).filter((r) => !r.check?.empty))}>결과 0건 모두 빼기</Button>
            )}
            <span className="ml-auto text-[12.5px] text-muted">칸을 눌러 바로 고칠 수 있습니다.</span>
          </div>

          <div className="scroll-thin overflow-x-auto border-y border-line">
            <table className="w-full min-w-[880px] text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-muted">
                <tr>
                  <th className="w-10 px-2 py-2.5 text-left font-medium">#</th>
                  <th className="w-28 px-2 py-2.5 text-left font-medium">분류 · 말투</th>
                  {inputs.map((f) => <th key={f.key} className="px-2 py-2.5 text-left font-medium">{f.label}{f.required && <span className="text-bad">*</span>}</th>)}
                  <th className="px-2 py-2.5 text-left font-medium">기대 정답 힌트</th>
                  {j.params.grounded && <th className="w-44 px-2 py-2.5 text-left font-medium">원본 · 답 확인</th>}
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rowsView.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-subtle/40">
                    <td className="num px-2 py-2 text-[12px] text-faint">{r.id}</td>
                    <td className="px-2 py-2">
                      <input className="w-full bg-transparent text-[13px] font-medium focus:outline-none" value={r.category} placeholder="분류" onChange={(e) => setRow(r.id, { category: e.target.value })} />
                      <span className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-muted"><span className="h-1.5 w-1.5 rounded-full" style={{ background: STYLE_COLOR[r.style] }} />{STYLE_SHORT[r.style] ?? r.style}</span>
                    </td>
                    {inputs.map((f) => {
                      const v = r.inputs[f.key];
                      const text = Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v);
                      return (
                        <td key={f.key} className="px-2 py-1.5">
                          <textarea rows={1} value={text}
                            onChange={(e) => setRow(r.id, { inputs: { ...r.inputs, [f.key]: f.type === "list" ? e.target.value.split(/,\s*/) : f.type === "int" ? Number(e.target.value) || "" : e.target.value } })}
                            className={cn("w-full resize-none rounded-lg bg-transparent px-1.5 py-1 leading-snug [field-sizing:content] focus:bg-panel focus:outline-none focus:ring-2 focus:ring-accent/20", f.required && !text && "bg-bad-soft")} />
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5">
                      <textarea rows={1} value={r.expected} onChange={(e) => setRow(r.id, { expected: e.target.value })}
                        className="w-full resize-none rounded-lg bg-transparent px-1.5 py-1 text-[12.5px] leading-snug text-muted [field-sizing:content] focus:bg-panel focus:text-ink focus:outline-none focus:ring-2 focus:ring-accent/20" />
                    </td>
                    {j.params.grounded && (
                      <td className="px-2 py-2 text-[12px]">
                        {r.source && <div className="truncate text-muted" title={r.source.title}><Search className="mr-1 inline h-3 w-3" />{r.source.api} · {r.source.title}</div>}
                        <div className="mt-1">
                          {r.check?.found_in.length ? <Badge tone="good"><Check className="h-3 w-3" />{r.check.found_in.join(", ")} 에서 찾음</Badge>
                            : r.check?.empty ? <Badge tone="warn">결과 0건</Badge>
                              : r.check ? <Badge tone="outline">원본 못 찾음</Badge> : null}
                        </div>
                      </td>
                    )}
                    <td className="px-1 py-1.5"><Button size="icon" variant="ghost" aria-label="이 행 빼기" onClick={() => removeRow(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rowsView.length && <div className="py-10 text-center text-sm text-muted">표시할 행이 없습니다.</div>}
          </div>

          <div className="sticky bottom-0 z-10 -mx-4 mt-8 border-t border-line bg-bg/85 px-4 py-4 backdrop-blur sm:-mx-8 sm:px-8 lg:-mx-14 lg:px-14">
            {saved ? (
              <div className="animate-fade-up flex flex-wrap items-center gap-3">
                <CheckCircle2 className="animate-check h-5 w-5 text-good" />
                <span className="font-semibold">‘{saved.name}’ 저장 완료</span>
                <span className="text-[13px] text-muted">{saved.row_count}행 · {suite?.name} 와 연결됨</span>
                <div className="ml-auto flex gap-2">
                  <Link to={`/datasets/${saved.id}`}><Button>데이터 보기</Button></Link>
                  <Button variant="primary" icon={<Play className="h-4 w-4" />} onClick={() => navigate(`/runs/new?dataset=${saved.id}&suite=${suiteId}`)}>이 데이터로 바로 평가</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => { setJobId(null); setEdited(null); }}>설정 고치기</Button>
                {isPreview ? (
                  <Button variant="primary" className="ml-auto" icon={<Wand2 className="h-4 w-4" />} onClick={() => start(false)}>이 설정으로 {count}개 만들기</Button>
                ) : (
                  <>
                    <Button variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => start(false)}>다시 만들기</Button>
                    <Input className="ml-auto h-10 w-full sm:w-80" value={name} onChange={(e) => setName(e.target.value)} placeholder="데이터 이름" />
                    <Button variant="primary" disabled={!rowsAll.length} onClick={save}>{rowsAll.length}개 저장</Button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
