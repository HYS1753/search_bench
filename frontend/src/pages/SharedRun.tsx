import { useQuery } from "@tanstack/react-query";
import { Eye, Lock } from "lucide-react";
import { useParams } from "react-router-dom";
import { LogoMark } from "@/components/brand/Logo";
import { RunSummaryView } from "@/components/results/RunSummaryView";
import { Badge, PageSkeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { CaseRow, Run } from "@/lib/types";

interface Shared {
  run: Run;
  cases: { id: number; case_key: string; category: string; inputs: Record<string, unknown>; ndcg_diff: number | null; winner: string | null; tops: Record<string, string | null> }[];
  expires_at: string | null;
  shared_by: string;
}

/** 공유 링크로 보는 결과 — 로그인 없이, 보기 전용. 설정 세부(주소·키·연결)는 보여 주지 않는다. */
export default function SharedRun() {
  const { token = "" } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["share", token], queryFn: () => api.get<Shared>(`/share/${token}`), retry: false });
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-3 sm:px-8">
          <LogoMark className="h-7 w-7" />
          <span className="font-bold tracking-tight">Search<span className="text-accent">Bench</span></span>
          <Badge tone="outline"><Eye className="h-3 w-3" />공유된 결과 · 보기 전용</Badge>
          {data?.expires_at && <span className="ml-auto text-[12.5px] text-muted">{fmt.date(data.expires_at)} 까지 볼 수 있음</span>}
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 pb-24 pt-10 sm:px-8">
        {isLoading ? <PageSkeleton /> : error || !data ? (
          <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-panel p-8 text-center">
            <Lock className="mx-auto h-8 w-8 text-faint" />
            <div className="mt-3 font-semibold">결과를 볼 수 없습니다</div>
            <p className="mt-1 text-sm text-muted">{(error as Error)?.message ?? "공유 링크가 없거나 만료·해제되었습니다."}</p>
          </div>
        ) : (
          <div className="animate-page">
            <div className="mb-2 text-[13px] text-muted">{data.shared_by ? `${data.shared_by} 님이 공유` : "공유된 평가"} · {fmt.date(data.run.created_at)}</div>
            <h1 className="break-keep text-[28px] font-bold leading-tight tracking-tight">{data.run.name}</h1>
            <p className="mt-2 text-[14.5px] text-muted">
              {data.run.members.map((m) => `${m.label}${m.is_baseline ? "(기준)" : ""}`).join(" vs ")} · {data.run.dataset_name} · 판정 {data.run.judge_model?.name} · {fmt.int(data.run.completed)}건
            </p>
            <div className="mt-10">
              {data.run.summary && (
                <RunSummaryView summary={data.run.summary} k={data.run.criteria?.k ?? 5}
                  candidate={data.run.members.find((m) => !m.is_baseline)?.label ?? ""}
                  cases={data.cases.map((c) => ({ ...c, ndcg_diff: c.ndcg_diff }) as unknown as CaseRow)}
                  onOpenCase={() => {}} live={false} />
              )}
            </div>
            <section className="mt-4">
              <h2 className="mb-4 text-[20px] font-bold tracking-tight">케이스</h2>
              <div className="scroll-thin overflow-x-auto border-y border-line">
                <table className="w-full min-w-[720px] text-[13.5px]">
                  <thead className="border-b border-line text-[12px] text-muted">
                    <tr><th className="px-3 py-2.5 text-left font-medium">케이스</th><th className="px-3 py-2.5 text-left font-medium">입력</th>
                      {data.run.members.map((m) => <th key={m.label} className="px-3 py-2.5 text-left font-medium">{m.label} 1위</th>)}
                      <th className="px-3 py-2.5 text-right font-medium">nDCG 차이</th><th className="px-3 py-2.5 text-left font-medium">목록 비교</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.cases.map((c) => (
                      <tr key={c.id}>
                        <td className="px-3 py-2.5 font-medium">{c.case_key}<div className="text-[12px] font-normal text-muted">{c.category}</div></td>
                        <td className="max-w-[280px] truncate px-3">{fmt.inputs(Object.values(c.inputs)[0])}</td>
                        {data.run.members.map((m) => <td key={m.label} className="max-w-[200px] truncate px-3">{c.tops[m.label] ?? "–"}</td>)}
                        <td className={cn("num px-3 text-right font-semibold", (c.ndcg_diff ?? 0) > 0 ? "text-good" : (c.ndcg_diff ?? 0) < 0 ? "text-bad" : "text-muted")}>{fmt.signed(c.ndcg_diff, 2)}</td>
                        <td className="px-3">{c.winner === "candidate" ? <Badge tone="good">후보 승</Badge> : c.winner === "baseline" ? <Badge tone="bad">기준 승</Badge> : c.winner ? <Badge>무승부</Badge> : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
