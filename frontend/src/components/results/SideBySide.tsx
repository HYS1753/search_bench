import { AlertTriangle, ArrowLeftRight, CheckCircle2, Equal, Trophy } from "lucide-react";
import { TermTip } from "@/components/ui/overlay";
import { Badge, Card } from "@/components/ui/primitives";
import { cn, fmt } from "@/lib/format";
import type { CaseMetric, Item, Judgment, Pairwise } from "@/lib/types";
import { ItemCard, RankMove } from "./ItemCard";

export interface SideView {
  label: string;
  is_baseline: boolean;
  ok: boolean;
  error: string;
  latency_ms: number | null;
  items: Item[];
  target_name?: string;
  status_code?: number | null;
}

function MiniMetric({ label, value, term }: { label: string; value: string; term: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[11.5px] text-muted">
        {label}
        <TermTip term={term} />
      </div>
      <div className="num mt-0.5 text-[17px] font-bold">{value}</div>
    </div>
  );
}

export function SideBySide({
  sides,
  judgments,
  metrics,
  k: kAll,
  terms = [],
  prefixes,
  kBy,
}: {
  sides: SideView[];
  judgments?: Record<string, Judgment>;
  metrics?: Record<string, CaseMetric>;
  k?: number;
  terms?: string[];
  /** 후보마다 평가 기준이 다를 때: 라벨 → 항목 판정 key 접두사, 라벨 → k */
  prefixes?: Record<string, string>;
  kBy?: Record<string, number>;
}) {
  const baseline = sides.find((s) => s.is_baseline) ?? sides[0];
  const baseRank = new Map((baseline?.items ?? []).map((it, i) => [it.key, i + 1]));
  return (
    <div className={cn("grid gap-y-12", sides.length === 2 ? "lg:grid-cols-2" : sides.length >= 3 ? "xl:grid-cols-3" : "", "lg:divide-x lg:divide-line [&>*]:min-w-0 lg:[&>*]:px-8 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0")}>
      {sides.map((s) => {
        const m = metrics?.[s.label];
        const pre = prefixes?.[s.label] ?? "";
        const k = kBy?.[s.label] ?? kAll;
        return (
          <div key={s.label} className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className={cn("rounded-lg px-2 py-0.5 text-[13px] font-bold", s.is_baseline ? "bg-subtle text-muted" : "bg-accent-soft text-accent")}>{s.label}</span>
              {s.is_baseline && <Badge tone="outline">기준</Badge>}
              {s.target_name && <span className="truncate text-[13px] text-muted">{s.target_name}</span>}
              <span className="ml-auto text-[12px] text-muted">
                {s.ok ? `${s.items.length}건 · ${fmt.ms(s.latency_ms)}` : "호출 실패"}
              </span>
            </div>
            {m && (
              <Card className="mb-1 grid grid-cols-2 gap-3 py-3.5 sm:grid-cols-4">
                <MiniMetric label={`nDCG@${k ?? ""}`} value={fmt.num(m.ndcg, 2)} term="ndcg" />
                <MiniMetric label="Hit@1" value={m.hit1 === null ? "–" : m.hit1 ? "적중" : "놓침"} term="hit1" />
                <MiniMetric label="MRR" value={fmt.num(m.mrr, 2)} term="mrr" />
                <MiniMetric label={`P@${k ?? ""}`} value={fmt.num(m.precision, 2)} term="precision" />
              </Card>
            )}
            {!s.ok ? (
              <div className="flex gap-2 rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{s.error}</span>
              </div>
            ) : s.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">결과 0건</div>
            ) : (
              <div className="divide-y divide-line border-b border-line">
                {s.items.map((it, i) => (
                  <ItemCard
                    key={it.key}
                    item={it}
                    rank={i + 1}
                    judgment={judgments?.[pre + it.key]}
                    terms={terms}
                    dim={k !== undefined && i >= k}
                    move={!s.is_baseline && baseline?.ok ? <RankMove from={baseRank.get(it.key) ?? null} to={i + 1} /> : undefined}
                  />
                ))}
                {k !== undefined && s.items.length > k && <div className="py-3 text-[12px] text-faint">흐리게 보이는 항목은 평가 범위(상위 {k}개) 밖입니다.</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const WIN_LABEL = { candidate: "후보 승", baseline: "기준 승", tie: "무승부" } as const;

export function PairwiseCard({ pw, candidate, baseline }: { pw: Pairwise; candidate: string; baseline: string }) {
  const winnerLabel = pw.winner === "candidate" ? candidate : pw.winner === "baseline" ? baseline : null;
  return (
    <Card className="py-6">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-xl",
            pw.winner === "candidate" ? "bg-good-soft text-good" : pw.winner === "baseline" ? "bg-bad-soft text-bad" : "bg-subtle text-muted",
          )}
        >
          {pw.winner === "tie" ? <Equal className="h-5 w-5" /> : <Trophy className="h-5 w-5" />}
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[13px] text-muted">
            목록 비교 · {candidate} vs {baseline}
            <TermTip term="pairwise" />
          </div>
          <div className="text-[17px] font-bold">{winnerLabel ? `${winnerLabel} 우세` : "우열 없음"}</div>
        </div>
        <div className="ml-auto flex gap-2">
          {pw.auto ? (
            <Badge tone="warn">호출 실패로 자동 판정</Badge>
          ) : pw.consistent ? (
            <Badge tone="good"><CheckCircle2 className="h-3 w-3" />순서 바꿔도 같은 판정</Badge>
          ) : (
            <Badge tone="warn"><ArrowLeftRight className="h-3 w-3" />순서 따라 판정이 달라짐</Badge>
          )}
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink/90">{pw.reason}</p>
      {pw.orders.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12.5px] text-muted">두 번의 판정 보기</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {pw.orders.map((o, i) => (
              <div key={i} className="rounded-xl bg-subtle px-3 py-2.5 text-[12.5px] leading-relaxed">
                <div className="mb-1 flex items-center gap-2 font-medium">
                  {i + 1}차 · {o.order}
                  <Badge tone={o.winner === "candidate" ? "good" : o.winner === "baseline" ? "bad" : "neutral"}>{WIN_LABEL[o.winner]}</Badge>
                  {o.confidence && <span className="text-faint">확신 {({ low: "낮음", medium: "보통", high: "높음" } as Record<string, string>)[o.confidence] ?? o.confidence}</span>}
                </div>
                <div className="text-muted">{o.reason}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
