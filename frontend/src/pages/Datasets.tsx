import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NextStep } from "@/components/onboarding/NextStep";
import { ArrowRight, ChevronDown, FileSpreadsheet, FileUp, PenLine, Play, Plus, Sparkles, Table2, Trash2, Wrench } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { BoundBadge, CompatBadge, SourceBadge } from "@/components/datasets/Compat";
import { Dialog, Menu, useConfirm } from "@/components/ui/overlay";
import { PageHeader } from "@/components/ui/page";
import { Button, Field, Input, PageSkeleton, Select, Spinner } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api, download } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { Dataset, Mapping, Suite } from "@/lib/types";

function UploadBox({ onDone, suiteId }: { onDone: (d: Dataset) => void; suiteId: number | "" }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name.replace(/\.[^.]+$/, ""));
      const d = await api.post<Dataset>("/datasets/upload", form);
      toast.success("올렸습니다", `${d.row_count}행 · 열 ${d.columns.length}개`);
      onDone(d);
    } catch (e) {
      toast.error("올리지 못했습니다", (e as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) send(f);
  };
  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => ref.current?.click()}
        className={cn("flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors", drag ? "border-accent bg-accent-soft/50" : "border-line hover:bg-subtle")}
      >
        {busy ? <Spinner className="h-6 w-6" /> : <FileUp className="h-7 w-7 text-faint" />}
        <div className="mt-3 text-[15px] font-semibold">파일을 끌어다 놓거나 눌러서 선택</div>
        <div className="mt-1 text-[13px] text-muted">CSV · 엑셀(첫 시트) · JSONL · JSON · 최대 5,000행 / 10MB · 첫 줄은 열 이름</div>
        <input ref={ref} type="file" accept=".csv,.tsv,.xlsx,.jsonl,.ndjson,.json" className="hidden" onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
        <span>열 이름은 비교 세트의 입력 이름(예: 질문)과 같거나 비슷하면 자동으로 연결됩니다.</span>
        {suiteId !== "" && <Button size="sm" variant="ghost" icon={<FileSpreadsheet className="h-3.5 w-3.5" />} onClick={(e) => { e.stopPropagation(); download(`/datasets/template?suite_id=${suiteId}`, "template.csv"); }}>양식 받기</Button>}
      </div>
    </div>
  );
}

const CREATE = [
  { key: "llm", icon: <Sparkles className="h-5 w-5" />, title: "LLM 으로 만들기", desc: "서비스 설명만 쓰면 질의를 만들어 줍니다. 실제 검색 결과를 참고하면 더 정확해집니다.", badge: "추천" },
  { key: "file", icon: <FileUp className="h-5 w-5" />, title: "파일 올리기", desc: "CSV·엑셀로 가진 질의 목록을 올립니다." },
  { key: "manual", icon: <PenLine className="h-5 w-5" />, title: "직접 입력", desc: "비교 세트의 입력 칸으로 된 빈 표를 만들어 채웁니다." },
] as const;

export default function Datasets() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const [dialog, setDialog] = useState<"" | "file" | "manual">("");
  const [newName, setNewName] = useState("");
  const suites = useQuery({ queryKey: ["suites"], queryFn: () => api.get<Suite[]>("/suites") });
  const suiteId: number | "" = Number(sp.get("suite")) || (suites.data?.length === 1 ? suites.data[0].id : "");
  const setSuite = (v: number | "") => setSp((p) => { if (v) p.set("suite", String(v)); else p.delete("suite"); return p; }, { replace: true });
  const list = useQuery({
    queryKey: ["datasets", suiteId],
    queryFn: () => api.get<Dataset[]>(`/datasets${suiteId ? `?suite_id=${suiteId}` : ""}`),
    placeholderData: (p) => p,
  });
  const suite = suites.data?.find((s) => s.id === suiteId);

  const start = (key: (typeof CREATE)[number]["key"]) => {
    if (key === "llm") navigate(`/datasets/generate${suiteId ? `?suite=${suiteId}` : ""}`);
    else setDialog(key);
  };
  const createBlank = async () => {
    try {
      let columns = ["케이스", "질의", "기대 정답"];
      let mapping: Partial<Mapping> | undefined;
      if (suiteId) {
        const b = await api.get<{ columns: string[]; mapping: Mapping }>(`/datasets/blank-columns?suite_id=${suiteId}`);
        columns = b.columns;
        mapping = b.mapping;
      }
      const rows = Array.from({ length: 5 }, (_, i) => Object.fromEntries(columns.map((c) => [c, c === "케이스" ? `C${String(i + 1).padStart(3, "0")}` : ""])));
      const d = await api.post<Dataset>("/datasets", { name: newName || "새 테스트 데이터", description: "", columns, rows, suite_id: suiteId || null, mapping });
      qc.invalidateQueries({ queryKey: ["datasets"] });
      navigate(`/datasets/${d.id}`);
    } catch (e) {
      toast.error("만들지 못했습니다", (e as Error).message);
    }
  };
  const remove = async (d: Dataset) => {
    if (!(await confirm.ask({ title: `'${d.name}' 을 삭제할까요?`, body: "이 데이터로 한 평가 기록은 남지만, 같은 설정으로 다시 실행할 수는 없게 됩니다.", confirm: "삭제", danger: true }))) return;
    await api.del(`/datasets/${d.id}`);
    qc.invalidateQueries({ queryKey: ["datasets"] });
  };

  if (list.isLoading && !list.data) return <PageSkeleton />;
  const items = list.data ?? [];
  const counts = { ready: items.filter((d) => d.compat?.status === "ready").length, check: items.filter((d) => d.compat?.status === "check").length, missing: items.filter((d) => d.compat?.status === "missing").length };

  return (
    <>
      <PageHeader
        eyebrow="평가 구성"
        title="테스트 데이터"
        description="평가에 넣을 질의 모음입니다. 비교 세트를 고르면 각 데이터를 그 세트로 바로 쓸 수 있는지 함께 보여 줍니다."
        actions={items.length > 0 && (
          <Menu
            trigger={({ open, toggle }) => (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={toggle} aria-expanded={open}>
                새 데이터<ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} />
              </Button>
            )}
            items={CREATE.map((c) => ({ label: c.title, icon: c.icon, onSelect: () => start(c.key) }))}
          />
        )}
      />
      <NextStep current="dataset" />

      {/* 만들기 — 데이터가 없을 때만 크게 보여 주고, 있으면 머리글의 '새 데이터' 메뉴로 충분하다 */}
      {!items.length && (
      <div className="stagger mb-12 grid gap-3 md:grid-cols-3">
        {CREATE.map((c) => (
          <button key={c.key} onClick={() => start(c.key)}
            className={cn("lift group relative rounded-2xl border p-5 text-left", c.key === "llm" ? "border-accent/40 bg-accent-soft/40" : "border-line bg-panel/70")}>
            <div className="flex items-center justify-between">
              <span className={cn("flex h-10 w-10 items-center justify-center rounded-xl", c.key === "llm" ? "bg-accent text-white" : "bg-subtle text-muted group-hover:text-accent")}>{c.icon}</span>
              {"badge" in c && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">{c.badge}</span>}
            </div>
            <div className="mt-4 flex items-center gap-1.5 font-semibold">{c.title}<ArrowRight className="h-3.5 w-3.5 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" /></div>
            <div className="mt-1 break-keep text-[13px] leading-relaxed text-muted">{c.desc}</div>
          </button>
        ))}
      </div>
      )}

      {/* 비교 세트 기준 */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-4">
        <span className="text-[14px] font-semibold">어느 비교 세트로 평가하나요?</span>
        <Select className="h-9 w-auto min-w-[220px]" value={suiteId} onChange={(e) => setSuite(e.target.value ? Number(e.target.value) : "")}>
          <option value="">(고르면 바로 쓸 수 있는지 표시)</option>
          {suites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        {suite && (
          <span className="text-[12.5px] text-muted">
            <b className="text-good">바로 사용 {counts.ready}</b> · <b className="text-warn">연결 확인 {counts.check}</b> · <b className="text-bad">필수 열 부족 {counts.missing}</b>
          </span>
        )}
      </div>

      {!items.length ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-14 text-center">
          <Table2 className="mx-auto h-8 w-8 text-faint" />
          <div className="mt-3 font-semibold">테스트 데이터가 없습니다</div>
          <div className="mt-1 text-sm text-muted">위에서 만드는 방법을 고르세요. 처음이라면 ‘LLM 으로 만들기’가 가장 빠릅니다.</div>
        </div>
      ) : (
        <div className="stagger divide-y divide-line border-y border-line">
          {items.map((d) => {
            const c = d.compat;
            return (
              <div key={d.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
                <Link to={`/datasets/${d.id}${suiteId ? `?suite=${suiteId}` : ""}`} className="min-w-0 flex-1 basis-[280px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold hover:text-accent">{d.name}</span>
                    <SourceBadge d={d} />
                    <CompatBadge c={c} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                    <span className="num">{fmt.int(d.row_count)}행</span>
                    <BoundBadge d={d} />
                    <span className="min-w-0 truncate">열: {d.columns.join(", ")}</span>
                  </div>
                  {c?.status === "missing" && <div className="mt-1 text-[12.5px] text-bad">없는 필수 입력: {c.missing_required.join(", ")}</div>}
                </Link>
                <span className="text-[12.5px] text-faint">{fmt.ago(d.updated_at)}</span>
                {c?.status === "missing" ? (
                  <Link to={`/datasets/${d.id}?suite=${suiteId}`}><Button size="sm" icon={<Wrench className="h-3.5 w-3.5" />}>고치기</Button></Link>
                ) : (
                  <Link to={`/runs/new?dataset=${d.id}${suiteId || d.suite_id ? `&suite=${suiteId || d.suite_id}` : ""}`}>
                    <Button size="sm" icon={<Play className="h-3.5 w-3.5" />}>평가</Button>
                  </Link>
                )}
                <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => remove(d)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={dialog === "file"} onOpenChange={(o) => !o && setDialog("")} title="파일 올리기" size="lg">
        <UploadBox suiteId={suiteId} onDone={(d) => { setDialog(""); qc.invalidateQueries({ queryKey: ["datasets"] }); navigate(`/datasets/${d.id}${suiteId ? `?suite=${suiteId}` : ""}`); }} />
      </Dialog>
      <Dialog open={dialog === "manual"} onOpenChange={(o) => !o && setDialog("")} title="직접 입력으로 만들기" description="비교 세트의 입력 칸으로 된 빈 표를 만든 뒤 편집 화면에서 채웁니다."
        footer={<><Button variant="ghost" onClick={() => setDialog("")}>취소</Button><Button variant="primary" onClick={createBlank}>만들기</Button></>}>
        <div className="space-y-4">
          <Field label="이름"><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="예: 학자금 문의 회귀 테스트" /></Field>
          <Field label="어느 비교 세트로 평가하나요?" help="세트의 입력 이름(예: 질문, TOBE 전용 · 분류)으로 열을 만들고 연결까지 저장합니다.">
            <Select value={suiteId} onChange={(e) => setSuite(e.target.value ? Number(e.target.value) : "")}>
              <option value="">(선택 안 함)</option>
              {suites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
      </Dialog>
      {confirm.node}
    </>
  );
}
