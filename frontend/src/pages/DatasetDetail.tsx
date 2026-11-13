import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, History, Link2, Play, Plus, Save, Trash2, Wrench, X } from "lucide-react";
import { VersionHistory } from "@/components/datasets/VersionHistory";
import { CompatBadge, SourceBadge } from "@/components/datasets/Compat";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/ui/page";
import { Alert, Badge, Button, Card, Input, PageSkeleton, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { Compat, Dataset, Suite } from "@/lib/types";

const EDIT_LIMIT = 500;

export default function DatasetDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const ds = useQuery({ queryKey: ["dataset", id], queryFn: () => api.get<Dataset>(`/datasets/${id}?limit=5000`) });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newCol, setNewCol] = useState("");
  const [history, setHistory] = useState(false);
  const [sp, setSp] = useSearchParams();
  const suites = useQuery({ queryKey: ["suites"], queryFn: () => api.get<Suite[]>("/suites") });
  const suiteId = Number(sp.get("suite")) || ds.data?.suite_id || 0;
  const suite = suites.data?.find((x) => x.id === suiteId);
  const compat = useQuery({
    queryKey: ["dataset-compat", id, suiteId, ds.data?.updated_at],
    queryFn: () => api.get<Compat>(`/datasets/${id}/compat?suite_id=${suiteId}`),
    enabled: !!suiteId && !!ds.data,
  });
  const c = compat.data;
  // 열 → 연결된 입력 이름(머리글에 표시)
  const colInput = useMemo(() => {
    const out: Record<string, { label: string; required: boolean }> = {};
    if (!c || !suite) return out;
    for (const f of suite.input_fields) {
      const col = c.mapping.fields[f.key];
      if (col) out[col] = { label: `${f.scope ? `${f.scope} 전용 · ` : ""}${f.label || f.key}`, required: !!f.required };
    }
    if (c.mapping.case_key) out[c.mapping.case_key] = { label: "케이스 이름", required: false };
    if (c.mapping.category) out[c.mapping.category] = { label: "분류", required: false };
    if (c.mapping.expected) out[c.mapping.expected] = { label: "기대 정답", required: false };
    return out;
  }, [c, suite]);
  const emptyRequired = useMemo(
    () => rows.filter((r) => Object.entries(colInput).some(([col, x]) => x.required && !(r[col] ?? "").trim()) && Object.values(r).some((v) => v.trim())).length,
    [rows, colInput],
  );
  const bind = async () => {
    if (!suiteId) return;
    const fresh = await api.get<Compat>(`/datasets/${id}/compat?suite_id=${suiteId}`);
    await api.put(`/datasets/${id}/binding`, { suite_id: suiteId, mapping: fresh.mapping });
    qc.invalidateQueries({ queryKey: ["dataset", id] });
    qc.invalidateQueries({ queryKey: ["datasets"] });
    qc.invalidateQueries({ queryKey: ["dataset-compat", id] });
  };
  const addMissing = () => {
    if (!c) return;
    const add = c.missing_required.filter((l) => !columns.includes(l));
    change(() => {
      setColumns([...columns, ...add]);
      setRows(rows.map((r) => ({ ...r, ...Object.fromEntries(add.map((l) => [l, ""])) })));
    });
    toast.info("필수 열을 추가했습니다", "값을 채운 뒤 저장하세요. 저장하면 연결도 함께 저장됩니다.");
  };

  useEffect(() => {
    if (!ds.data) return;
    setName(ds.data.name);
    setDescription(ds.data.description);
    setColumns(ds.data.columns);
    setRows((ds.data.rows ?? []).map((r) => Object.fromEntries(ds.data!.columns.map((c) => [c, r[c] === null || r[c] === undefined ? "" : String(r[c])]))));
    setDirty(false);
  }, [ds.data]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const editable = rows.length <= EDIT_LIMIT;
  const change = (fn: () => void) => {
    fn();
    setDirty(true);
  };
  const filled = useMemo(() => rows.filter((r) => Object.values(r).some((v) => v.trim())).length, [rows]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/datasets/${id}`, { name, description, columns, rows });
      if (suiteId) await bind().catch(() => {});
      toast.success("저장했습니다", `${filled}행${suite ? ` · ‘${suite.name}’ 와 연결 저장` : ""}`);
      qc.invalidateQueries({ queryKey: ["datasets"] });
      qc.invalidateQueries({ queryKey: ["dataset", id] });
    } catch (e) {
      toast.error("저장하지 못했습니다", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (ds.isLoading) return <PageSkeleton />;
  if (!ds.data) return <Alert tone="bad">테스트 데이터를 찾을 수 없습니다.</Alert>;

  return (
    <>
      <Link to="/datasets" className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />테스트 데이터</Link>
      <PageHeader
        title={editable ? (
          // 제목이 곧 이름 입력칸: 누르면 바로 고칠 수 있고, 아래에 같은 이름 칸을 따로 두지 않는다
          <input value={name} onChange={(e) => change(() => setName(e.target.value))} aria-label="이름" placeholder="이름"
            className="-mx-2 w-full min-w-[12ch] rounded-lg border border-transparent bg-transparent px-2 py-0.5 font-bold text-ink outline-none transition-colors hover:border-line focus:border-accent/50 focus:bg-panel"
            style={{ width: `${Math.max(12, name.length + 3)}ch` }} />
        ) : ds.data.name}
        description={<span className="inline-flex flex-wrap items-center gap-2">{fmt.int(filled)}행 · 열 {columns.length}개 · 수정 {fmt.ago(ds.data.updated_at)} <SourceBadge d={ds.data} /></span>}
        actions={
          <>
            {dirty && <Badge tone="warn">저장하지 않은 변경</Badge>}
            <Button variant="ghost" icon={<History className="h-4 w-4" />} onClick={() => setHistory(true)}>v{ds.data.version ?? 1} · 변경 이력</Button>
            <Button icon={<Save className="h-4 w-4" />} disabled={!dirty || !editable} loading={saving} onClick={save}>저장</Button>
            <Button variant="primary" icon={<Play className="h-4 w-4" />} disabled={dirty || c?.status === "missing"} onClick={() => navigate(`/runs/new?dataset=${id}${suiteId ? `&suite=${suiteId}` : ""}`)}>평가</Button>
          </>
        }
      />
      {/* 비교 세트 연결 */}
      <section className="mb-8 rounded-2xl border border-line bg-panel/70 p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="inline-flex items-center gap-1.5 text-[14.5px] font-semibold"><Link2 className="h-4 w-4 text-muted" />비교 세트 연결</span>
          <Select className="h-9 w-auto min-w-[220px]" value={suiteId || ""} onChange={(e) => setSp((p) => { if (e.target.value) p.set("suite", e.target.value); else p.delete("suite"); return p; }, { replace: true })}>
            <option value="">(선택 안 함)</option>
            {suites.data?.map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === ds.data?.suite_id ? " — 연결됨" : ""}</option>)}
          </Select>
          <CompatBadge c={c} />
          <div className="ml-auto flex flex-wrap gap-2">
            {c && c.missing_required.length > 0 && editable && <Button size="sm" icon={<Wrench className="h-3.5 w-3.5" />} onClick={addMissing}>빠진 필수 열 추가</Button>}
            {c && c.status !== "missing" && (!c.bound || !c.mapping.saved) && !dirty && <Button size="sm" variant="primary" onClick={() => bind().then(() => toast.success("연결을 저장했습니다", "다음부터 평가할 때 바로 씁니다."))}>이 연결 저장</Button>}
          </div>
        </div>
        {!suiteId ? (
          <p className="mt-2 text-[13px] text-muted">비교 세트를 고르면 각 열이 어떤 입력이 되는지, 빠진 필수 입력이 있는지 보여 줍니다.</p>
        ) : c && suite ? (
          <>
            <div className="mt-4 flex flex-wrap gap-1.5 text-[12.5px]">
              {suite.input_fields.map((f) => {
                const col = c.mapping.fields[f.key];
                const how = c.mapping.matched_by[f.key];
                return (
                  <span key={f.key} className={cn("inline-flex items-center gap-1 rounded-lg border px-2 py-1",
                    col ? (how === "similar" ? "border-warn/40 bg-warn-soft text-warn" : "border-good/30 bg-good-soft text-good") : f.required ? "border-bad/30 bg-bad-soft text-bad" : "border-line text-muted")}>
                    <b className="font-semibold">{f.scope ? `${f.scope} 전용 · ` : ""}{f.label || f.key}{f.required && "*"}</b>
                    {col ? <>← {col}{how === "similar" && " (비슷한 이름)"}{how === "saved" && " (저장됨)"}</> : f.required ? " · 맞는 열 없음" : " · 사용 안 함"}
                  </span>
                );
              })}
            </div>
            {emptyRequired > 0 && <div className="mt-3 text-[12.5px] text-bad">필수 입력이 빈 행 {emptyRequired}개 — 표에서 빨간 칸을 채우세요.</div>}
            {c.unused_columns.length > 0 && <div className="mt-2 text-[12.5px] text-muted">평가에 쓰지 않는 열: {c.unused_columns.join(", ")}</div>}
          </>
        ) : null}
      </section>
      <div className="mb-6">
        <Input value={description} onChange={(e) => change(() => setDescription(e.target.value))} placeholder="설명 (선택) — 어떤 질의를 모았는지 적어 두면 나중에 찾기 쉽습니다" disabled={!editable} />
      </div>
      {!editable && (
        <Alert tone="warn" className="mb-4" title={`${EDIT_LIMIT}행이 넘는 테스트 데이터는 화면에서 편집할 수 없습니다`}>
          파일에서 고친 뒤 새로 올려 주세요. 아래 표는 처음 {EDIT_LIMIT}행만 보여 줍니다.
        </Alert>
      )}
      <Card className="overflow-hidden">
        <div className="scroll-thin max-h-[64vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-subtle text-[12px] text-muted">
              <tr>
                <th className="w-12 px-3 py-2 text-left font-medium">#</th>
                {columns.map((c) => (
                  <th key={c} className="min-w-[160px] px-3 py-2 text-left font-medium">
                    <span className="inline-flex items-center gap-1">
                      {c}
                      {editable && (
                        <button className="text-faint hover:text-bad" title="컬럼 삭제"
                          onClick={() => change(() => { setColumns(columns.filter((x) => x !== c)); setRows(rows.map(({ [c]: _drop, ...r }) => r)); })}>
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                    <span className={cn("block text-[11px] font-normal", colInput[c] ? "text-accent" : "text-faint")}>{colInput[c] ? `→ ${colInput[c].label}${colInput[c].required ? " *" : ""}` : suiteId ? "평가에 안 씀" : ""}</span>
                  </th>
                ))}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.slice(0, EDIT_LIMIT).map((r, i) => (
                <tr key={i} className="group">
                  <td className="num px-3 text-[12px] text-faint">{i + 1}</td>
                  {columns.map((c) => (
                    <td key={c} className="p-1">
                      <input
                        value={r[c] ?? ""}
                        disabled={!editable}
                        onChange={(e) => change(() => setRows(rows.map((x, j) => (j === i ? { ...x, [c]: e.target.value } : x))))}
                        className={cn("w-full rounded-lg bg-transparent px-2 py-1.5 text-[13.5px] outline-none focus:bg-accent-soft/50",
                          colInput[c]?.required && !(r[c] ?? "").trim() && Object.values(r).some((v) => v.trim()) && "bg-bad-soft")}
                      />
                    </td>
                  ))}
                  <td className="pr-2 text-right">
                    {editable && (
                      <button className="text-faint opacity-0 hover:text-bad group-hover:opacity-100" onClick={() => change(() => setRows(rows.filter((_, j) => j !== i)))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => change(() => setRows([...rows, Object.fromEntries(columns.map((c) => [c, ""]))]))}>행 추가</Button>
            <div className="ml-auto flex items-center gap-2">
              <Input className="h-8 w-40 font-mono text-[12.5px]" value={newCol} onChange={(e) => setNewCol(e.target.value.replace(/\s/g, "_"))} placeholder="새 컬럼 이름" />
              <Button size="sm" variant="ghost" disabled={!newCol || columns.includes(newCol)}
                onClick={() => change(() => { setColumns([...columns, newCol]); setRows(rows.map((r) => ({ ...r, [newCol]: "" }))); setNewCol(""); })}>컬럼 추가</Button>
            </div>
          </div>
        )}
      </Card>
      {history && <VersionHistory datasetId={ds.data.id} onClose={() => setHistory(false)} onRestored={() => { setHistory(false); qc.invalidateQueries({ queryKey: ["dataset", id] }); }} />}
    </>
  );
}
