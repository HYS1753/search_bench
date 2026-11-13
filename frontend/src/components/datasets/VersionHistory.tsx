import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Minus, Pencil, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Drawer, useConfirm } from "@/components/ui/overlay";
import { Badge, Button, Spinner } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";

interface Version {
  version: number;
  note: string;
  created_by: string;
  created_at: string;
  row_count: number;
  current: boolean;
  runs: number;
  changes: { added: number; removed: number; changed: number; columns_added: string[]; columns_removed: string[] } | null;
}
interface Diff {
  added: number;
  removed: number;
  changed: number;
  columns_added: string[];
  columns_removed: string[];
  added_rows: Record<string, unknown>[];
  removed_rows: Record<string, unknown>[];
  changed_rows: { before: Record<string, unknown>; after: Record<string, unknown>; columns: string[] }[];
}

const rowText = (r: Record<string, unknown>) => Object.entries(r).filter(([, v]) => v !== "" && v !== null && v !== undefined).map(([k, v]) => `${k}: ${String(v)}`).join(" · ");

/** 버전 이력: 저장할 때마다 남은 사본, 버전마다 바뀐 행, 되돌리기 */
export function VersionHistory({ datasetId, onClose, onRestored }: { datasetId: number; onClose: () => void; onRestored: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ["dataset-versions", datasetId], queryFn: () => api.get<Version[]>(`/datasets/${datasetId}/versions`) });
  const [sel, setSel] = useState<number | null>(null);
  const selV = list.data?.find((v) => v.version === sel) ?? list.data?.[0];
  const prev = selV ? list.data?.find((v) => v.version < selV.version) : undefined;
  const diff = useQuery({
    queryKey: ["dataset-diff", datasetId, prev?.version, selV?.version],
    queryFn: () => api.get<Diff>(`/datasets/${datasetId}/versions/diff?a=${prev!.version}&b=${selV!.version}`),
    enabled: !!selV && !!prev,
  });
  const restore = async (v: Version) => {
    if (!(await confirm.ask({ title: `v${v.version} 으로 되돌릴까요?`, body: "그 버전의 내용이 새 버전으로 저장됩니다. 지금 내용도 이력에 남아 있어 다시 되돌릴 수 있습니다.", confirm: "되돌리기" }))) return;
    try {
      await api.post(`/datasets/${datasetId}/versions/${v.version}/restore`);
      qc.invalidateQueries({ queryKey: ["dataset-versions", datasetId] });
      qc.invalidateQueries({ queryKey: ["datasets"] });
      toast.success(`v${v.version} 내용으로 되돌렸습니다`);
      onRestored();
    } catch (e) {
      toast.error("되돌리지 못했습니다", (e as Error).message);
    }
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-5xl" title="변경 이력" subtitle="저장할 때마다 그때의 내용을 남깁니다(최근 30개). 평가는 실행할 때의 버전을 기록하므로 데이터를 고쳐도 지난 결과가 어떤 데이터로 나왔는지 알 수 있습니다.">
      {list.isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="divide-y divide-line border-y border-line">
            {(list.data ?? []).map((v) => (
              <button key={v.version} onClick={() => setSel(v.version)}
                className={cn("block w-full px-3 py-3 text-left transition-colors", (selV?.version === v.version) ? "bg-accent-soft/50" : "hover:bg-subtle/60")}>
                <div className="flex items-center gap-2">
                  <span className="num font-semibold">v{v.version}</span>
                  {v.current && <Badge tone="accent">지금</Badge>}
                  {v.runs > 0 && <Badge tone="outline">평가 {v.runs}회</Badge>}
                  <span className="ml-auto text-[12px] text-faint">{fmt.ago(v.created_at)}</span>
                </div>
                <div className="mt-0.5 truncate text-[13px]">{v.note || "저장"}</div>
                <div className="mt-1 flex flex-wrap gap-2 text-[12px] text-muted">
                  <span>{v.created_by || "–"} · {fmt.int(v.row_count)}행</span>
                  {v.changes && (
                    <span className="num">
                      <span className="text-good">+{v.changes.added}</span> <span className="text-bad">−{v.changes.removed}</span> <span className="text-warn">~{v.changes.changed}</span>
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
          <div className="min-w-0">
            {selV && (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <History className="h-4 w-4 text-muted" />
                  <span className="font-semibold">{prev ? `v${prev.version} → v${selV.version} 에서 바뀐 것` : `v${selV.version} (처음 버전)`}</span>
                  {!selV.current && <Button size="sm" className="ml-auto" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => restore(selV)}>이 버전으로 되돌리기</Button>}
                </div>
                {!prev ? <div className="text-[13.5px] text-muted">처음 저장한 버전입니다. {fmt.int(selV.row_count)}행.</div>
                  : diff.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : diff.data && (
                    <div className="space-y-6 text-[13.5px]">
                      {(diff.data.columns_added.length > 0 || diff.data.columns_removed.length > 0) && (
                        <div className="text-muted">열 {diff.data.columns_added.map((c) => <Badge key={c} tone="good">+{c}</Badge>)} {diff.data.columns_removed.map((c) => <Badge key={c} tone="bad">−{c}</Badge>)}</div>
                      )}
                      {[
                        { title: "추가된 행", n: diff.data.added, icon: <Plus className="h-3.5 w-3.5 text-good" />, rows: diff.data.added_rows.map((r) => rowText(r)) },
                        { title: "삭제된 행", n: diff.data.removed, icon: <Minus className="h-3.5 w-3.5 text-bad" />, rows: diff.data.removed_rows.map((r) => rowText(r)) },
                      ].map((g) => g.n > 0 && (
                        <div key={g.title}>
                          <div className="mb-1.5 flex items-center gap-1.5 font-semibold">{g.icon}{g.title} {g.n}</div>
                          <div className="divide-y divide-line border-y border-line">
                            {g.rows.map((t, i) => <div key={i} className="truncate py-2 text-[13px]">{t}</div>)}
                          </div>
                        </div>
                      ))}
                      {diff.data.changed > 0 && (
                        <div>
                          <div className="mb-1.5 flex items-center gap-1.5 font-semibold"><Pencil className="h-3.5 w-3.5 text-warn" />바뀐 행 {diff.data.changed}</div>
                          <div className="divide-y divide-line border-y border-line">
                            {diff.data.changed_rows.map((r, i) => (
                              <div key={i} className="py-2.5 text-[13px]">
                                {r.columns.map((col) => (
                                  <div key={col} className="flex flex-wrap items-baseline gap-2">
                                    <span className="w-24 shrink-0 text-muted">{col}</span>
                                    <span className="text-bad line-through">{String(r.before[col] ?? "")}</span>
                                    <span className="text-faint">→</span>
                                    <span className="text-good">{String(r.after[col] ?? "")}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {!diff.data.added && !diff.data.removed && !diff.data.changed && !diff.data.columns_added.length && !diff.data.columns_removed.length && (
                        <div className="text-muted">행 내용은 같고 순서만 바뀌었습니다.</div>
                      )}
                    </div>
                  )}
              </>
            )}
          </div>
        </div>
      )}
      {confirm.node}
    </Drawer>
  );
}
