import { useQuery } from "@tanstack/react-query";
import { Columns3, History, Play, Search, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { StatusBadge, VerdictBadge, WinBar } from "@/components/results/Verdict";
import { PageHeader, Segmented } from "@/components/ui/page";
import { Button, Card, Empty, Input, Progress, Spinner } from "@/components/ui/primitives";
import { api, qs } from "@/lib/api";
import { fmt } from "@/lib/format";
import type { Run } from "@/lib/types";

type Filter = "all" | "active" | "done" | "stopped";
const FILTER_STATUS: Record<Filter, string | undefined> = {
  all: undefined,
  active: "queued,running",
  done: "done",
  stopped: "failed,cancelled,interrupted",
};

export default function Runs() {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  // 비교할 실행 고르기(실행 상세의 '다른 실행과 비교'로 오면 그 실행이 미리 골라져 있음)
  const [picked, setPicked] = useState<number[]>(() => (Number(sp.get("with")) ? [Number(sp.get("with"))] : []));
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 6 ? p : [...p, id]));
  const runs = useQuery({
    queryKey: ["runs", "list", filter, q],
    queryFn: () => api.get<{ total: number; items: Run[] }>(`/runs${qs({ status: FILTER_STATUS[filter], q, limit: 200 })}`),
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === "running" || r.status === "queued") ? 3000 : false),
  });
  return (
    <>
      <PageHeader
        eyebrow="평가"
        title="평가 실행 기록"
        description="평가 결과 모음입니다. 진행 중인 실행도 여기서 확인하고, 행을 누르면 결과 대시보드로 이동합니다."
        actions={<Link to="/runs/new"><Button variant="primary" icon={<Play className="h-4 w-4" />}>새 평가</Button></Link>}
      />
      {sp.get("with") && picked.length < 2 && (
        <div className="animate-fade-up mb-4 rounded-2xl border border-accent/30 bg-accent-soft/40 px-5 py-3 text-[14px]">
          #{sp.get("with")} 와 비교할 실행을 왼쪽 칸에서 고르세요(최대 6개). 같은 테스트 데이터로 돌린 실행끼리면 케이스별 변화까지 볼 수 있습니다.
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented value={filter} onChange={setFilter} items={[{ value: "all", label: "전체" }, { value: "active", label: "진행 중" }, { value: "done", label: "완료" }, { value: "stopped", label: "중단·실패" }]} />
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <Input className="pl-9" placeholder="실행 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {runs.isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !runs.data?.items.length ? (
        <Empty icon={<History className="h-8 w-8" />} title={filter === "all" && !q ? "아직 실행한 평가가 없습니다" : "조건에 맞는 실행이 없습니다"}
          action={filter === "all" && !q ? <Link to="/runs/new"><Button variant="primary">첫 평가</Button></Link> : undefined} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="border-b border-line text-[12px] text-muted">
              <tr>
                <th className="w-10 pl-5 pr-0 py-3 text-left font-medium" title="비교할 실행 고르기"><Columns3 className="h-3.5 w-3.5" /></th>
                <th className="px-3 py-3 text-left font-medium">실행</th>
                <th className="px-3 py-3 text-left font-medium">상태</th>
                <th className="px-3 py-3 text-left font-medium">결론</th>
                <th className="px-3 py-3 text-right font-medium">nDCG 차이</th>
                <th className="w-40 px-3 py-3 text-left font-medium">승·무·패</th>
                <th className="px-3 py-3 text-right font-medium">비용</th>
                <th className="px-5 py-3 text-right font-medium">시작</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {runs.data.items.map((r) => {
                const h = r.headline;
                const active = r.status === "running" || r.status === "queued";
                return (
                  <tr key={r.id} className={picked.includes(r.id) ? "bg-accent-soft/40" : "hover:bg-subtle/60"}>
                    <td className="pl-5 pr-0">
                      <input type="checkbox" aria-label={`${r.name} 비교에 넣기`} className="h-4 w-4 accent-[rgb(var(--accent))]"
                        checked={picked.includes(r.id)} disabled={active} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="px-3 py-3.5">
                      <Link to={`/runs/${r.id}`} className="block">
                        <div className="font-medium text-ink hover:text-accent">{r.name}</div>
                        <div className="mt-0.5 text-[12.5px] text-muted">
                          #{r.id} · {r.members.map((m) => m.label).join(" vs ")} · {fmt.int(r.total)}건 · {r.judge_model?.name}
                        </div>
                      </Link>
                    </td>
                    <td className="px-3">
                      <StatusBadge status={r.status} />
                      {active && <Progress className="mt-1.5 w-24" value={r.completed + r.failed} max={r.total} />}
                      {r.failed > 0 && !active && <div className="mt-1 text-[11.5px] text-bad">오류 {r.failed}건</div>}
                    </td>
                    <td className="px-3"><VerdictBadge verdict={h?.verdict} /></td>
                    <td className={`num px-3 text-right font-semibold ${h?.ndcg_diff && h.ndcg_diff > 0 ? "text-good" : h?.ndcg_diff && h.ndcg_diff < 0 ? "text-bad" : ""}`}>
                      {fmt.signed(h?.ndcg_diff)}
                    </td>
                    <td className="px-3">
                      {h?.wins !== null && h?.wins !== undefined ? (
                        <div>
                          <WinBar wins={h.wins} ties={h.ties ?? 0} losses={h.losses ?? 0} />
                          <div className="num mt-1 text-[11.5px] text-muted">{h.wins}승 {h.ties}무 {h.losses}패</div>
                        </div>
                      ) : <span className="text-faint">–</span>}
                    </td>
                    <td className="num px-3 text-right text-muted">{fmt.usd(r.cost_estimate)}</td>
                    <td className="px-5 text-right text-[12.5px] text-muted">{fmt.date(r.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {picked.length > 0 && (
        <div className="toast-in fixed inset-x-0 bottom-5 z-30 mx-auto flex w-[min(560px,calc(100vw-32px))] items-center gap-3 rounded-2xl border border-line bg-panel/95 px-4 py-3 shadow-[0_16px_40px_-16px_rgb(16_24_40/0.35)] backdrop-blur">
          <Columns3 className="h-4 w-4 text-accent" />
          <span className="text-[14px]"><b className="num">{picked.length}</b>개 선택 {picked.length < 2 && <span className="text-muted">· 1개 더 고르세요</span>}</span>
          <Button size="sm" variant="ghost" className="ml-auto" icon={<X className="h-3.5 w-3.5" />} onClick={() => setPicked([])}>선택 해제</Button>
          <Button size="sm" variant="primary" disabled={picked.length < 2} onClick={() => navigate(`/runs/compare?ids=${picked.join(",")}`)}>나란히 비교</Button>
        </div>
      )}
    </>
  );
}
