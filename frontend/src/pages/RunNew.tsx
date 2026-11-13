import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ClipboardList, FileUp, Info, Play, Search, Sparkles, Table2 } from "lucide-react";
import { CompatBadge } from "@/components/datasets/Compat";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChoiceList, FormRow, PageHeader, Rows, Segmented, Stat, StatRow, Steps } from "@/components/ui/page";
import { Alert, Badge, Button, Input, PageSkeleton, Select, Spinner } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { Criteria, Dataset, JudgeModel, Mapping, Run, Suite } from "@/lib/types";
import { QuickCriteriaDialog, STRICT_LABEL } from "./settings/Criteria";

const STEPS = ["무엇을 비교할까요", "테스트 입력", "입력 검증", "판정 방법", "확인하고 시작"];

interface Report {
  total: number;
  valid: number;
  invalid: number;
  errors: { row: number; messages: string[] }[];
  inputs: { key: string; label: string; scope: string; required: boolean; column: string; filled: number; empty: number }[];
  unmapped: string[];
}
type Source = "saved" | "paste" | "file" | "llm";

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

type GridRow = Record<string, string>;

/** 입력 항목 + 기대 정답 열로 된 표. 엑셀·메모장에서 여러 줄(탭 구분)을 붙여넣으면 아래·오른쪽으로 채운다. */
function InputGrid({ columns, rows, onChange }: { columns: { key: string; label: string; hint?: string }[]; rows: GridRow[]; onChange: (rows: GridRow[]) => void }) {
  const paste = (r: number, c: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, "").split("\n").filter((l, i, arr) => l.length || i < arr.length - 1);
    const next = rows.map((x) => ({ ...x }));
    lines.forEach((line, i) => {
      const ri = r + i;
      while (next.length <= ri) next.push({});
      line.split("\t").forEach((cell, j) => {
        const col = columns[c + j];
        if (col) next[ri][col.key] = cell.trim();
      });
    });
    onChange(next);
  };
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-[13.5px]" style={{ minWidth: Math.max(560, columns.length * 200) }}>
        <thead className="border-b border-line text-[12.5px] text-muted">
          <tr>
            <th className="w-10 px-2 py-2.5 text-left font-medium">#</th>
            {columns.map((c) => (
              <th key={c.key} className="px-2 py-2.5 text-left font-medium">
                {c.label}
                {c.hint && <span className="ml-1 font-normal text-faint">{c.hint}</span>}
              </th>
            ))}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, r) => (
            <tr key={r} className="group">
              <td className="num px-2 text-[12px] text-faint">{r + 1}</td>
              {columns.map((col, c) => (
                <td key={col.key} className="p-1">
                  <input
                    value={row[col.key] ?? ""}
                    onChange={(e) => onChange(rows.map((x, i) => (i === r ? { ...x, [col.key]: e.target.value } : x)))}
                    onPaste={(e) => paste(r, c, e)}
                    className="w-full rounded-lg bg-transparent px-2 py-2 outline-none placeholder:text-faint focus:bg-panel focus:ring-1 focus:ring-line"
                    placeholder={r === 0 ? "여기에 붙여넣기" : ""}
                  />
                </td>
              ))}
              <td className="pr-1 text-right">
                <button type="button" className="px-1 text-faint opacity-0 hover:text-bad group-hover:opacity-100" onClick={() => onChange(rows.filter((_, i) => i !== r))} aria-label="행 삭제">×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="mt-2 text-[13px] font-medium text-accent" onClick={() => onChange([...rows, ...Array.from({ length: 5 }, () => ({}))])}>+ 5줄 더</button>
    </div>
  );
}

const critDesc = (c: Criteria) =>
  `상위 ${c.k}개 · ${STRICT_LABEL[c.relevant_threshold]} 기준 · ${c.pairwise_enabled ? "목록 비교 포함" : "항목 판정만"}${c.user_requirements.trim() ? " · 추가 조건 있음" : ""}`;

/** 비교 세트가 많을 때: 이름·대상·입력으로 찾는 목록. 선택한 행은 강조, 목록은 일정 높이에서 스크롤 */
function SuiteList({ items, value, onChange }: { items: { value: number; title: string; desc: string }[]; value: number | ""; onChange: (v: number) => void }) {
  const [q, setQ] = useState("");
  const shown = items.filter((it) => !q.trim() || `${it.title} ${it.desc}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel/70">
      <div className="relative border-b border-line">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`비교 세트 ${items.length}개 중 찾기 — 이름·API·입력`}
          className="h-11 w-full bg-transparent pl-10 pr-4 text-[14px] outline-none placeholder:text-faint" />
      </div>
      <div role="radiogroup" className="scroll-thin max-h-[360px] divide-y divide-line overflow-y-auto">
        {shown.map((it) => {
          const on = it.value === value;
          return (
            <button key={it.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(it.value)}
              className={cn("flex w-full items-center gap-3 px-4 py-3 text-left transition-colors", on ? "bg-accent-soft/60" : "hover:bg-subtle/60")}>
              <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", on ? "border-accent" : "border-faint")}>
                {on && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold" title={it.title}>{it.title}</span>
                <span className="block truncate text-[12.5px] text-muted" title={it.desc}>{it.desc}</span>
              </span>
            </button>
          );
        })}
        {!shown.length && <div className="px-4 py-8 text-center text-[13px] text-muted">‘{q}’ 와 맞는 세트가 없습니다.</div>}
      </div>
    </div>
  );
}

export default function RunNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStepRaw] = useState(params.get("dataset") && params.get("suite") ? 1 : 0);
  // 단계 이동 방향(앞 +1 / 뒤 −1)에 따라 들어오는 쪽을 바꾼다
  const dir = useRef(1);
  const setStep = (n: number) => {
    dir.current = n >= step ? 1 : -1;
    setStepRaw(n);
  };
  const [suiteId, setSuiteId] = useState<number | "">(Number(params.get("suite")) || "");
  const [source, setSource] = useState<Source>(params.get("dataset") ? "saved" : "paste");
  const [datasetId, setDatasetId] = useState<number | "">(Number(params.get("dataset")) || "");
  const [grid, setGrid] = useState<GridRow[]>(() => Array.from({ length: 8 }, () => ({})));
  const [busy, setBusy] = useState("");
  const [mapping, setMapping] = useState<Mapping>({ fields: {}, case_key: "", category: "", expected: "" });
  const [showMapping, setShowMapping] = useState(false);
  // 후보 라벨 → 평가 기준(후보마다 기준 API 와 견줄 기준)
  const [critBy, setCritBy] = useState<Record<string, number | "">>({});
  const [modelId, setModelId] = useState<number | "">("");
  const [concurrency, setConcurrency] = useState(4);
  const [batchSize, setBatchSize] = useState(12);
  const [maxCost, setMaxCost] = useState("");
  const [limit, setLimit] = useState("");
  const [name, setName] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [mappingFor, setMappingFor] = useState<string>("");
  const [validating, setValidating] = useState(false);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [quickCrit, setQuickCrit] = useState(false);

  const suites = useQuery({ queryKey: ["suites"], queryFn: () => api.get<Suite[]>("/suites") });
  // 비교 세트를 고르면 데이터마다 호환 상태(바로 사용/연결 확인/필수 열 부족)를 받아 바로 쓸 수 있는 것부터 보여 준다
  const datasets = useQuery({
    queryKey: ["datasets", suiteId],
    queryFn: () => api.get<Dataset[]>(`/datasets${suiteId ? `?suite_id=${suiteId}` : ""}`),
    placeholderData: (p) => p,
  });
  const criteria = useQuery({ queryKey: ["criteria"], queryFn: () => api.get<Criteria[]>("/criteria") });
  const models = useQuery({ queryKey: ["judge-models"], queryFn: () => api.get<JudgeModel[]>("/judge-models") });
  const preview = useQuery({
    queryKey: ["dataset", datasetId, "preview"],
    queryFn: () => api.get<Dataset>(`/datasets/${datasetId}?limit=5`),
    enabled: !!datasetId,
  });
  const suite = suites.data?.find((s) => s.id === suiteId);
  const ds = datasets.data?.find((d) => d.id === datasetId);
  const cands = suite?.members.filter((m) => !m.is_baseline) ?? [];
  const readyCount = (datasets.data ?? []).filter((d) => d.compat?.status === "ready").length;
  const critOf = (label: string) => criteria.data?.find((c) => c.id === critBy[label]);
  const crit = cands.length ? critOf(cands[0].label) : undefined;
  const critNames = [...new Set(cands.map((m) => critOf(m.label)?.name).filter(Boolean))];
  const critReady = cands.length > 0 && cands.every((m) => !!critBy[m.label]);
  const model = models.data?.find((m) => m.id === modelId);

  useEffect(() => {
    if (suiteId === "" && suites.data?.length) setSuiteId(suites.data[0].id);
  }, [suites.data, suiteId]);
  useEffect(() => {
    if (modelId === "" && models.data?.length) setModelId(models.data.find((m) => m.is_default)?.id ?? models.data[0].id);
  }, [models.data, modelId]);
  useEffect(() => {
    if (suite)
      setCritBy(Object.fromEntries(suite.members.filter((m) => !m.is_baseline).map((m) => {
        const id = m.criteria_id ?? suite.default_criteria_id;
        return [m.label, id && criteria.data?.some((c) => c.id === id) ? id : criteria.data?.[0]?.id ?? ""];
      })));
  }, [suite, criteria.data]);
  useEffect(() => {
    if (!suiteId || !datasetId) return;
    api.get<Mapping>(`/datasets/${datasetId}/mapping?suite_id=${suiteId}`).then((m) => {
      setMapping(m);
      setMappingFor(`${suiteId}:${datasetId}`);
      setShowMapping(false);
    }).catch(() => {});
  }, [suiteId, datasetId]);

  const fields = suite?.input_fields ?? [];
  const gridColumns = useMemo(
    () => [
      ...fields.map((f) => ({ key: f.key, label: `${f.scope ? `${f.scope} · ` : ""}${f.label || f.key}`, hint: [f.scope ? "전용" : "", f.required ? "필수" : "", f.type === "list" ? "쉼표로 여러 값" : ""].filter(Boolean).join(" · ") || undefined })),
      { key: "expected", label: "기대 정답", hint: "선택 · 판정 참고용" },
    ],
    [fields],
  );
  const filledRows = useMemo(() => grid.filter((r) => fields.some((f) => (r[f.key] ?? "").trim())), [grid, fields]);
  const gridMissing = filledRows.some((r) => fields.some((f) => f.required && !(r[f.key] ?? "").trim()));
  const columns = preview.data?.columns ?? [];
  const missing = fields.filter((f) => f.required && !mapping.fields[f.key]);
  const cases = report ? (skipInvalid ? report.valid : report.total) : Math.min(ds?.row_count ?? 0, Number(limit) || Infinity);
  // 항목 판정 호출 = 기준(그룹)마다 ⌈풀 크기 ÷ 묶음 크기⌉. 풀은 대상 수 × k 를 넘지 않는다(겹치면 더 적음).
  const poolSize = (crit?.k ?? 5) * (suite?.members.length ?? 2);
  const itemCalls = Math.max(1, critNames.length) * Math.ceil(poolSize / batchSize);
  const callsPerCase = itemCalls + cands.reduce((n, m) => n + (critOf(m.label)?.pairwise_enabled ? 2 : 0), 0);

  const createFromPaste = async () => {
    const cols = ["case_id", ...fields.map((f) => f.key), "expected"];
    const pasteMapping = { fields: Object.fromEntries(fields.map((f) => [f.key, f.key])), case_key: "case_id", category: "", expected: "expected" };
    const rows = filledRows.map((r, i) => ({
      case_id: `#${String(i + 1).padStart(3, "0")}`,
      ...Object.fromEntries(fields.map((f) => [f.key, (r[f.key] ?? "").trim()])),
      expected: (r.expected ?? "").trim(),
    }));
    const d = await api.post<Dataset>("/datasets", {
      name: `직접 입력 ${new Date().toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      description: `${suite?.name ?? ""} 평가용`,
      columns: cols,
      rows,
      suite_id: suiteId || null,
      mapping: pasteMapping,
      meta: { source: "paste" },
    });
    qc.invalidateQueries({ queryKey: ["datasets"] });
    setDatasetId(d.id);
    setSource("saved");
    return d;
  };
  const upload = async (file: File) => {
    setBusy("upload");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name.replace(/\.[^.]+$/, ""));
      const d = await api.post<Dataset>("/datasets/upload", form);
      qc.invalidateQueries({ queryKey: ["datasets"] });
      setDatasetId(d.id);
      setSource("saved");
      toast.success("파일을 올렸습니다", `${d.row_count}개`);
    } catch (e) {
      toast.error("올리지 못했습니다", (e as Error).message);
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const validate = async () => {
    if (!suiteId || !datasetId) return;
    setValidating(true);
    try {
      // 컬럼 연결을 아직 못 받았으면 먼저 받는다(붙여넣기로 방금 만든 데이터 등)
      let m = mapping;
      if (mappingFor !== `${suiteId}:${datasetId}`) {
        m = await api.get<Mapping>(`/datasets/${datasetId}/mapping?suite_id=${suiteId}`);
        setMapping(m);
        setMappingFor(`${suiteId}:${datasetId}`);
      }
      setReport(await api.post<Report>("/runs/validate", { suite_id: suiteId, dataset_id: datasetId, mapping: m, case_limit: Number(limit) || null }));
    } catch (e) {
      toast.error("검증하지 못했습니다", (e as Error).message);
    } finally {
      setValidating(false);
    }
  };
  useEffect(() => {
    if (step === 2) {
      setReport(null);
      setSkipInvalid(false);
      validate();
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = async () => {
    if (step === 1 && source === "paste") {
      setBusy("paste");
      try {
        await createFromPaste();
      } catch (e) {
        toast.error("입력을 저장하지 못했습니다", (e as Error).message);
        return;
      } finally {
        setBusy("");
      }
    }
    setStep(step + 1);
  };
  const submit = async () => {
    setBusy("submit");
    try {
      const run = await api.post<Run>("/runs", {
        name: name.trim(),
        suite_id: suiteId,
        dataset_id: datasetId,
        criteria_by_member: Object.fromEntries(Object.entries(critBy).filter(([, v]) => v !== "")),
        judge_model_id: modelId || null,
        mapping,
        concurrency,
        judge_batch_size: batchSize,
        max_cost: Number(maxCost) > 0 ? Number(maxCost) : null,
        case_limit: Number(limit) || null,
        skip_invalid: skipInvalid,
      });
      toast.success("평가를 시작했습니다", "이 화면을 떠나도 서버에서 계속 진행됩니다.");
      navigate(`/runs/${run.id}`);
    } catch (e) {
      toast.error("시작하지 못했습니다", (e as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (suites.isLoading || datasets.isLoading || models.isLoading || criteria.isLoading)
    return <PageSkeleton />;
  const blockers = [
    !suites.data?.length && { text: "비교 세트가 없습니다.", to: "/settings/suites", cta: "비교 세트 만들기" },
    !models.data?.length && { text: "판정 모델이 없습니다.", to: "/settings/models", cta: "판정 모델 등록" },
    !criteria.data?.length && { text: "평가 기준이 없습니다.", to: "/settings/criteria", cta: "평가 기준 만들기" },
  ].filter(Boolean) as { text: string; to: string; cta: string }[];

  const canNext = [
    !!suite,
    source === "paste" ? filledRows.length > 0 && !gridMissing : !!datasetId && missing.length === 0,
    !!report && report.valid > 0 && (report.invalid === 0 || skipInvalid),
    critReady && !!modelId,
    true,
  ][step];

  return (
    <>
      <PageHeader eyebrow="평가" title="평가" description="여러 입력을 한꺼번에 보내 어느 쪽이 더 나은지 판정합니다. 실행은 서버에서 진행되므로 화면을 닫아도 됩니다." />
      {blockers.length > 0 ? (
        <Alert tone="warn" title="시작하기 전에 준비가 필요합니다">
          {blockers.map((b) => <div key={b.to}>{b.text} <Link to={b.to} className="font-medium text-accent">{b.cta} →</Link></div>)}
        </Alert>
      ) : (
        <>
          <Steps steps={STEPS} current={step} onJump={setStep} />

          <div key={step} className={dir.current >= 0 ? "step-next" : "step-prev"}>
          {step === 0 && (
            <>
              <div className="mb-4 text-[15px] font-semibold">어떤 검색을 비교할까요?</div>
              {(() => {
                const items = suites.data!.map((s) => ({
                  value: s.id,
                  title: s.name,
                  desc: `${s.members.map((m) => `${m.label}${m.is_baseline ? "(기준)" : ""}`).join(" vs ")} · 입력 ${s.input_fields.map((f) => f.label || f.key).join(", ")}`,
                }));
                // 5개까지는 카드, 넘으면 검색되는 목록(스크롤)으로
                return items.length > 5
                  ? <SuiteList items={items} value={suiteId} onChange={(v) => setSuiteId(v)} />
                  : <ChoiceList value={suiteId} onChange={(v) => setSuiteId(v)} columns={2} items={items} />;
              })()}
              <div className="mt-4 text-[13px] text-muted">찾는 세트가 없으면 <Link to="/settings/suites" className="text-accent">비교 세트 만들기 →</Link></div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="mb-4 text-[15px] font-semibold">어떤 입력으로 평가할까요?</div>
              <ChoiceList
                value={source}
                onChange={setSource}
                columns={2}
                items={[
                  { value: "saved", title: "저장된 테스트 데이터", desc: readyCount ? `${datasets.data?.length ?? 0}개 · 이 세트로 바로 쓸 수 있는 것 ${readyCount}개` : `${datasets.data?.length ?? 0}개`, icon: <Table2 className="h-4 w-4" /> },
                  { value: "llm", title: "LLM 으로 만들기", desc: "서비스 설명으로 질의를 만들어 검토 후 바로 평가", icon: <Sparkles className="h-4 w-4" /> },
                  { value: "paste", title: "직접 입력·붙여넣기", desc: "표에 입력하거나 엑셀에서 복사해 붙여넣기", icon: <ClipboardList className="h-4 w-4" /> },
                  { value: "file", title: "파일 올리기", desc: "CSV·엑셀·JSONL", icon: <FileUp className="h-4 w-4" /> },
                ]}
              />
              <div className="mt-8">
                {source === "paste" && (
                  <>
                    <InputGrid columns={gridColumns} rows={grid} onChange={setGrid} />
                    <div className="mt-3 flex flex-wrap justify-between gap-2 text-[13px] text-muted">
                      <span>엑셀이나 메모장에서 여러 줄을 복사해 첫 칸에 붙여넣으면 한 번에 채워집니다(탭으로 나뉜 열은 오른쪽 칸으로).</span>
                      <span className="num font-medium text-ink">{filledRows.length}개 입력</span>
                    </div>
                    {gridMissing && <Alert tone="warn" className="mt-3">필수 항목이 비어 있는 줄이 있습니다.</Alert>}
                    {filledRows.length > 0 && filledRows.length < 10 && <Alert tone="warn" className="mt-3">입력이 10개보다 적으면 결론을 보류합니다. 믿을 만한 결론에는 30개 이상을 권장합니다.</Alert>}
                  </>
                )}
                {source === "llm" && (
                  <div className="rounded-2xl border border-accent/40 bg-accent-soft/30 p-6">
                    <div className="flex items-center gap-2 text-[15px] font-semibold"><Sparkles className="h-4 w-4 text-accent" />‘{suite?.name}’ 의 입력 칸에 맞춰 질의를 만듭니다</div>
                    <p className="mt-2 break-keep text-[13.5px] leading-relaxed text-muted">서비스 설명·분류·말투만 정하면 됩니다. ‘실제 검색 결과 참고’를 켜면 답이 있는 질의를 만들고 답 확인까지 해 줍니다. 만든 뒤 검토·수정하고 저장하면 이 화면으로 돌아와 바로 평가할 수 있습니다.</p>
                    <Link to={`/datasets/generate?suite=${suiteId}`}><Button className="mt-4" variant="primary" icon={<Sparkles className="h-4 w-4" />}>LLM 으로 만들러 가기</Button></Link>
                  </div>
                )}
                {source === "file" && (
                  <div onClick={() => fileRef.current?.click()} className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-line px-6 py-12 text-center hover:bg-panel/60">
                    {busy === "upload" ? <Spinner className="h-6 w-6" /> : <FileUp className="h-7 w-7 text-faint" />}
                    <div className="mt-3 text-[15px] font-semibold">파일 선택</div>
                    <div className="mt-1 text-[13px] text-muted">첫 줄은 컬럼 이름. 컬럼 이름을 입력 항목 이름({fields.map((f) => f.key).join(", ")})과 같게 하면 자동으로 연결됩니다.</div>
                    <input ref={fileRef} type="file" accept=".csv,.tsv,.xlsx,.jsonl,.ndjson,.json" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                  </div>
                )}
                {source === "saved" && (
                  <Rows>
                    <FormRow label="테스트 데이터">
                      <Select value={datasetId} onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : "")}>
                        <option value="">선택하세요</option>
                        {datasets.data!.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.compat ? `${{ ready: "✓ 바로 사용", check: "△ 연결 확인", missing: "✕ 필수 열 부족", unbound: "" }[d.compat.status]} · ` : ""}{d.name} ({fmt.int(d.row_count)}개)
                          </option>
                        ))}
                      </Select>
                      {ds?.compat && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                          <CompatBadge c={ds.compat} />
                          {ds.compat.mapping.saved ? "이 비교 세트에서 쓴 연결이 저장되어 있습니다." : "평가를 시작하면 아래 연결이 데이터에 저장되어 다음부터 바로 쓸 수 있습니다."}
                        </div>
                      )}
                    </FormRow>
                    {ds && preview.data && (
                      <FormRow label="연결 확인" help="테스트 데이터의 어느 칸이 어떤 입력이 되는지입니다. 이름이 같으면 자동으로 연결합니다.">
                        <div className="space-y-1.5 text-[14px]">
                          {fields.map((f) => (
                            <div key={f.key} className="flex flex-wrap items-center gap-2">
                              <span className="w-24 text-muted">{f.label || f.key}</span>
                              {mapping.fields[f.key] ? <Badge tone={(mapping as Mapping & { matched_by?: Record<string, string> }).matched_by?.[f.key] === "similar" ? "warn" : "good"}>← {mapping.fields[f.key]}{(mapping as Mapping & { matched_by?: Record<string, string> }).matched_by?.[f.key] === "similar" ? " (비슷한 이름)" : ""}</Badge> : f.required ? <Badge tone="bad">연결 필요</Badge> : <Badge>{f.default !== null && f.default !== undefined && f.default !== "" ? `기본값 ${String(f.default)}` : "사용 안 함"}</Badge>}
                            </div>
                          ))}
                          {mapping.expected && <div className="flex gap-2"><span className="w-24 text-muted">기대 정답</span><Badge tone="good">← {mapping.expected}</Badge></div>}
                          {mapping.category && <div className="flex gap-2"><span className="w-24 text-muted">분류</span><Badge tone="good">← {mapping.category}</Badge></div>}
                        </div>
                        {missing.length === 0 && <button className="mt-3 text-[13px] font-medium text-accent" onClick={() => setShowMapping(!showMapping)}>{showMapping ? "접기" : "연결 바꾸기"}</button>}
                        {(showMapping || missing.length > 0) && (
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            {fields.map((f) => (
                              <label key={f.key} className="block">
                                <span className="mb-1 block text-[12.5px] text-muted">{f.label || f.key}{f.required && " *"}</span>
                                <Select className="h-9" value={mapping.fields[f.key] ?? ""} onChange={(e) => setMapping({ ...mapping, fields: { ...mapping.fields, [f.key]: e.target.value } })}>
                                  <option value="">(연결 안 함)</option>
                                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                                </Select>
                              </label>
                            ))}
                            {([["case_key", "케이스 이름"], ["category", "분류"], ["expected", "기대 정답"]] as const).map(([k, l]) => (
                              <label key={k} className="block">
                                <span className="mb-1 block text-[12.5px] text-muted">{l}</span>
                                <Select className="h-9" value={mapping[k]} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}>
                                  <option value="">(없음)</option>
                                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                                </Select>
                              </label>
                            ))}
                          </div>
                        )}
                      </FormRow>
                    )}
                    {ds && preview.data?.rows && (
                      <FormRow label="미리보기" help={`${fmt.int(ds.row_count)}개 중 처음 ${preview.data.rows.length}개`}>
                        <div className="divide-y divide-line border-y border-line text-[13.5px]">
                          {preview.data.rows.map((r, i) => (
                            <div key={i} className="py-2.5">
                              <div className="truncate">{cellText(r[mapping.fields[fields[0]?.key] ?? ""]) || <span className="text-faint">(입력 없음)</span>}</div>
                              <div className="mt-0.5 truncate text-[12.5px] text-muted">
                                {fields.slice(1).map((f) => mapping.fields[f.key] && `${f.label || f.key}: ${cellText(r[mapping.fields[f.key]])}`).filter(Boolean).join(" · ")}
                                {mapping.expected && r[mapping.expected] ? ` · 기대: ${cellText(r[mapping.expected])}` : ""}
                              </div>
                            </div>
                          ))}
                        </div>
                      </FormRow>
                    )}
                  </Rows>
                )}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
                <div className="text-[15px] font-semibold">실행하기 전에 테스트 입력을 검사합니다</div>
                <Button size="sm" loading={validating} onClick={validate}>다시 검사</Button>
              </div>
              <p className="mb-6 break-keep text-[14px] text-muted">행마다 입력을 만들어 보고, 각 API 의 필수 값이 비었는지, 숫자 형식이 맞는지 확인합니다.</p>
              {!report ? (
                <div className="flex justify-center py-16"><Spinner /></div>
              ) : (
                <>
                  <StatRow min={180}>
                    <Stat label="전체" value={`${fmt.int(report.total)}행`} />
                    <Stat label="통과" value={`${fmt.int(report.valid)}행`} tone={report.valid === report.total ? "good" : undefined} />
                    <Stat label="실패" value={`${fmt.int(report.invalid)}행`} tone={report.invalid ? "bad" : undefined} sub={report.invalid ? "아래에서 이유를 확인하세요" : "모두 실행할 수 있습니다"} />
                  </StatRow>
                  <div className="mt-10 mb-3 text-[14.5px] font-semibold">입력별 채움 현황</div>
                  <div className="scroll-thin overflow-x-auto">
                    <table className="w-full min-w-[620px] text-[13.5px]">
                      <thead className="border-y border-line text-[12.5px] text-muted">
                        <tr>
                          <th className="px-3 py-2.5 text-left font-medium">입력</th>
                          <th className="px-3 py-2.5 text-left font-medium">연결된 열</th>
                          <th className="px-3 py-2.5 text-right font-medium">채워짐</th>
                          <th className="px-3 py-2.5 text-right font-medium">비어 있음</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line border-b border-line">
                        {report.inputs.map((i) => (
                          <tr key={i.key}>
                            <td className="px-3 py-2.5">
                              {i.label}
                              {i.required && <Badge tone="outline" className="ml-2">필수</Badge>}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-[12.5px] text-muted">{i.column || "(연결 안 함)"}</td>
                            <td className="num px-3 py-2.5 text-right">{fmt.int(i.filled)}</td>
                            <td className={cn("num px-3 py-2.5 text-right", i.empty && i.required ? "font-semibold text-bad" : i.empty ? "text-warn" : "text-muted")}>{fmt.int(i.empty)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {report.errors.length > 0 && (
                    <>
                      <div className="mt-10 mb-3 text-[14.5px] font-semibold">실패한 행 {report.invalid > report.errors.length ? `(처음 ${report.errors.length}개)` : ""}</div>
                      <div className="max-h-[320px] divide-y divide-line overflow-y-auto border-y border-line text-[13.5px] scroll-thin">
                        {report.errors.map((e) => (
                          <div key={e.row} className="flex gap-4 py-2.5">
                            <span className="num w-14 shrink-0 text-muted">{e.row}행</span>
                            <span className="min-w-0 text-bad">{e.messages.join(" · ")}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-6">
                        <ChoiceList value={skipInvalid ? "skip" : "fix"} onChange={(v) => setSkipInvalid(v === "skip")} columns={2} items={[
                          { value: "fix", title: "고친 뒤 다시 검사", desc: "이전 단계로 돌아가 값을 채우거나, 테스트 데이터를 고친 뒤 다시 검사합니다." },
                          { value: "skip", title: `실패한 ${report.invalid}행은 빼고 실행`, desc: `통과한 ${report.valid}행만 평가합니다.` },
                        ]} />
                      </div>
                    </>
                  )}
                  {report.valid === 0 && <Alert tone="bad" className="mt-6">통과한 행이 없습니다. 입력을 확인해 주세요.</Alert>}
                </>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div className="mb-1 text-[15px] font-semibold">무엇을 좋은 결과로 볼까요?</div>
              <p className="mb-5 break-keep text-[14px] text-muted">후보마다 기준 API({suite?.members.find((m) => m.is_baseline)?.label}) 와 견줄 평가 기준을 고릅니다. 비교 세트에 정한 기준이 미리 골라져 있습니다.</p>
              {cands.length === 1 ? (
                <ChoiceList
                  value={critBy[cands[0].label] ?? ""}
                  onChange={(v) => setCritBy({ [cands[0].label]: v })}
                  columns={2}
                  items={criteria.data!.map((c) => ({ value: c.id, title: c.name, desc: critDesc(c) }))}
                />
              ) : (
                <Rows>
                  {cands.map((m) => (
                    <FormRow key={m.label} label={`${m.label} vs ${suite?.members.find((x) => x.is_baseline)?.label}`} help={m.target_name}>
                      <Select value={critBy[m.label] ?? ""} onChange={(e) => setCritBy((x) => ({ ...x, [m.label]: e.target.value ? Number(e.target.value) : "" }))}>
                        <option value="">평가 기준 선택</option>
                        {criteria.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </Select>
                      {critOf(m.label) && <div className="mt-1.5 text-[12.5px] text-muted">{critDesc(critOf(m.label)!)}</div>}
                    </FormRow>
                  ))}
                </Rows>
              )}
              <div className="mt-3 text-[13px] text-muted">
                맞는 기준이 없으면 <button type="button" className="font-medium text-accent hover:underline" onClick={() => setQuickCrit(true)}>+ 여기서 새로 만들기</button>
                {" "}· 세부 조건은 <Link to="/settings/criteria" target="_blank" className="text-accent">평가 기준 화면 ↗</Link>에서 다듬을 수 있습니다.
              </div>
              <QuickCriteriaDialog open={quickCrit} onClose={() => setQuickCrit(false)}
                onCreated={(c) => { setQuickCrit(false); setCritBy((x) => (cands.length === 1 ? { [cands[0].label]: c.id } : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v || c.id])))); }} />
              <div className="mt-10">
                <Rows>
                  <FormRow label="판정 모델" help="결론을 내는 평가에는 성능 좋은 모델을 권장합니다.">
                    <Select value={modelId} onChange={(e) => setModelId(Number(e.target.value))}>
                      {models.data!.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.model}{m.is_default ? " (기본)" : ""}{m.last_test_ok === false ? " — 연결 실패" : ""}</option>)}
                    </Select>
                  </FormRow>
                  <FormRow label="판정 묶음 크기" help={<>판정 모델에게 <b className="text-ink">한 번에 몇 개 항목</b>의 관련도를 물을지 정합니다. 기본은 12개씩 묶음입니다.</>}>
                    <Segmented value={String(batchSize)} onChange={(v) => setBatchSize(Number(v))} items={[
                      { value: "1", label: "1개씩 (정확도 우선)" }, { value: "4", label: "4개" }, { value: "8", label: "8개" },
                      { value: "12", label: "12개 (기본)" }, { value: "20", label: "20개 (비용 우선)" },
                    ]} />
                    <div className="mt-3 space-y-1.5 break-keep text-[12.5px] leading-relaxed text-muted">
                      <p><b className="text-ink">무엇을 하나요?</b> 한 케이스에서 모든 API 의 상위 결과를 모으면 보통 10~20개 항목이 됩니다. 이를 몇 개씩 묶어 한 번에 채점할지입니다.</p>
                      <p><b className="text-ink">1개씩</b> — 항목마다 따로 묻습니다. 검색 평가 표준(UMBRELA·Bing 연구)의 방식으로 다른 항목에 영향받지 않아 가장 정확하지만, 호출 수가 묶음 크기만큼 늘어 시간·비용이 늘어납니다.</p>
                      <p><b className="text-ink">묶음</b> — 여러 항목을 한 번에 물어 호출이 적고 빠릅니다. 대신 함께 본 항목끼리 서로 기준점이 되어 등급이 조금 흔들릴 수 있습니다. 이를 줄이려고 묶기 전에 항목 순서를 섞어 특정 API 결과가 늘 앞에 오지 않게 합니다.</p>
                      <p>지금 설정이면 케이스당 항목 판정 호출 약 <b className="num text-ink">{itemCalls}회</b>(전체 약 {fmt.int(cases * itemCalls)}회).</p>
                    </div>
                  </FormRow>
                  <FormRow label="비용 상한 (선택)" help="이 평가의 판정 비용이 이 금액에 닿으면 남은 케이스를 멈춥니다. 멈춘 뒤 ‘이어서 실행’하면 상한 없이 남은 케이스를 처리합니다. 판정 모델에 단가가 있어야 동작합니다.">
                    <div className="flex items-center gap-2">
                      <span className="text-muted">$</span>
                      <Input type="number" min={0} step="0.01" className="max-w-[140px]" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} placeholder="제한 없음" />
                      {model && !model.price_input_per_mtok && !model.price_output_per_mtok && <span className="text-[12.5px] text-warn">이 판정 모델은 단가가 비어 있어 상한이 동작하지 않습니다.</span>}
                    </div>
                  </FormRow>
                  <FormRow label="동시에 처리할 개수" help="API·판정 모델의 호출 한도에 맞추세요. 기본 4.">
                    <Input type="number" min={1} max={32} className="max-w-[140px]" value={concurrency} onChange={(e) => setConcurrency(Math.max(1, Math.min(32, Number(e.target.value) || 1)))} />
                  </FormRow>
                  <FormRow label="일부만 먼저 해 보기 (선택)" help="설정이 맞는지 앞의 몇 개만 먼저 돌려 볼 때.">
                    <Input type="number" min={1} className="max-w-[140px]" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="전체" />
                  </FormRow>
                </Rows>
              </div>
            </>
          )}

          {step === 4 && suite && (
            <>
              {report && report.invalid > 0 && <Alert tone="warn" className="mb-6">검증에 실패한 {report.invalid}행은 빼고 {report.valid}행만 실행합니다.</Alert>}
              {cases > 0 && cases < 30 && (
                <Alert tone="warn" className="mb-6" title={`입력이 ${cases}개라 결론의 근거가 약합니다`}>
                  {cases < 10 ? "10개 미만이면 결론을 보류합니다. " : ""}차이를 확실히 가리려면 30개 이상을 권장합니다. 설정이 맞는지 먼저 보는 시험 실행이라면 그대로 시작해도 됩니다.{" "}
                  <Link to={`/datasets/generate?suite=${suiteId}`} className="font-medium text-accent">LLM 으로 질의 더 만들기 →</Link>
                </Alert>
              )}
            </>
          )}
          {step === 4 && suite && (
            <>
              <p className="max-w-3xl break-keep text-[17px] leading-relaxed">
                후보 <b>{suite.members.filter((m) => !m.is_baseline).map((m) => m.label).join(", ")}</b> 와 기준 <b>{suite.members.find((m) => m.is_baseline)?.label}</b> 중 어느 쪽이 나은지
                {" "}<b>{fmt.int(cases)}개 입력</b>으로 확인합니다. 각 API 의 상위 <b>{crit?.k}개</b> 결과를 <b>{critNames.map((n) => `‘${n}’`).join(", ")}</b> 기준으로 채점합니다(판정 모델: <b>{model?.name}</b>).
              </p>
              <div className="mt-8">
                <StatRow min={200}>
                  <Stat label="입력" value={`${fmt.int(cases)}개`} sub={ds?.name} />
                  <Stat label="API 호출" value={`${fmt.int(cases * (suite.members.length))}회`} sub={`${suite.members.length}개 API × 입력`} />
                  <Stat label="판정 호출 (예상)" value={`약 ${fmt.int(cases * callsPerCase)}회`} sub={critNames.length > 1 ? `기준 ${critNames.length}개 × 항목 판정 + 목록 비교` : crit?.pairwise_enabled ? "항목 판정 + 순서 바꿔 목록 비교 2회" : "항목 판정"} />
                </StatRow>
              </div>
              <div className="mt-8">
                <Rows>
                  <FormRow label="평가 이름 (선택)">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${suite.name} · ${ds?.name ?? ""}`} />
                  </FormRow>
                </Rows>
              </div>
              <Alert className="mt-6" icon={<Info className="h-4 w-4" />}>시작하면 서버에서 진행됩니다. 다른 화면으로 가도 왼쪽 아래에서 진행률을 볼 수 있고, 끝나면 알림이 뜹니다.</Alert>
            </>
          )}

          </div>

          <div className={cn("mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6")}>
            {step > 0 ? <Button variant="ghost" onClick={() => setStep(step - 1)}><ArrowLeft className="h-4 w-4" />이전</Button> : <span />}
            {step < 4 ? (
              <Button variant="primary" disabled={!canNext} loading={busy === "paste"} onClick={next}>다음<ArrowRight className="h-4 w-4" /></Button>
            ) : (
              <Button variant="primary" size="lg" icon={<Play className="h-4 w-4" />} loading={busy === "submit"} onClick={submit}>평가 시작</Button>
            )}
          </div>
        </>
      )}
    </>
  );
}
