import { CircleSlash, HelpCircle, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { STATUS_LABEL, cn } from "@/lib/format";
import type { RunStatus, Verdict } from "@/lib/types";

export const VERDICT_TONE: Record<Verdict["code"], { tone: "good" | "bad" | "neutral" | "warn"; label: string }> = {
  improved: { tone: "good", label: "개선" },
  regressed: { tone: "bad", label: "저하" },
  no_difference: { tone: "neutral", label: "차이 없음" },
  inconclusive: { tone: "warn", label: "판단 보류" },
  no_data: { tone: "neutral", label: "데이터 없음" },
};

export function VerdictBadge({ verdict }: { verdict: Verdict | null | undefined }) {
  if (!verdict) return <span className="text-faint">–</span>;
  const meta = VERDICT_TONE[verdict.code];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function VerdictIcon({ code, className }: { code: Verdict["code"]; className?: string }) {
  const Icon = code === "improved" ? TrendingUp : code === "regressed" ? TrendingDown : code === "inconclusive" ? HelpCircle : CircleSlash;
  return <Icon className={className} />;
}

export function StatusBadge({ status }: { status: RunStatus | string }) {
  const tone =
    status === "done" ? "good" : status === "failed" ? "bad" : status === "running" || status === "queued" ? "accent" : status === "interrupted" ? "warn" : "neutral";
  return (
    <Badge tone={tone as "good"}>
      {(status === "running" || status === "queued") && (
        <span className="relative mr-0.5 flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/** 승·무·패 막대 */
export function WinBar({ wins, ties, losses, className }: { wins: number; ties: number; losses: number; className?: string }) {
  const total = wins + ties + losses;
  if (!total) return <div className={cn("h-2 rounded-full bg-subtle", className)} />;
  return (
    <div className={cn("flex h-2 overflow-hidden rounded-full bg-subtle", className)}>
      <div className="bg-good" style={{ width: `${(wins / total) * 100}%` }} />
      <div className="bg-line" style={{ width: `${(ties / total) * 100}%` }} />
      <div className="bg-bad" style={{ width: `${(losses / total) * 100}%` }} />
    </div>
  );
}
