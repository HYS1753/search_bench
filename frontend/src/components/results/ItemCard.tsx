import { ArrowDown, ArrowUp, Equal, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/format";
import { GRADE_META } from "@/lib/glossary";
import type { Item, Judgment } from "@/lib/types";

export function GradeChip({ grade, reason, compact }: { grade: number | null | undefined; reason?: string; compact?: boolean }) {
  if (grade === null || grade === undefined) return null;
  const meta = GRADE_META[grade] ?? GRADE_META[0];
  const chip = (
    <span
      title={compact ? `${grade} ${meta.label}` : undefined}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full py-0.5 text-[11.5px] font-semibold", compact ? "min-w-[22px] justify-center px-1.5" : "px-2", meta.tone)}
    >
      <span className="num">{grade}</span>
      {!compact && meta.label}
    </span>
  );
  return reason ? <Tooltip content={reason}>{chip}</Tooltip> : chip;
}

export function RankMove({ from, to }: { from: number | null; to: number }) {
  if (from === null)
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold text-accent">
        <Sparkles className="h-3 w-3" />신규
      </span>
    );
  if (from === to) return <span className="inline-flex items-center text-[11px] text-faint"><Equal className="h-3 w-3" /></span>;
  const up = from > to;
  return (
    <span className={cn("num inline-flex items-center gap-0.5 text-[11px] font-semibold", up ? "text-good" : "text-bad")}>
      {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(from - to)}
    </span>
  );
}

export function highlight(text: string, terms: string[]): ReactNode {
  if (!terms.length || !text) return text;
  const escaped = terms.filter((t) => t.length >= 2).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return text;
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "g"));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

export function ItemCard({
  item,
  rank,
  judgment,
  terms = [],
  move,
  dim,
  compact,
}: {
  item: Item;
  rank: number;
  judgment?: Judgment;
  terms?: string[];
  move?: ReactNode;
  dim?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn("py-4", dim && "opacity-50")}>
      <div className="flex items-start gap-2.5">
        <span className="num mt-0.5 w-5 shrink-0 text-[13px] font-bold text-faint">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{highlight(item.title, terms)}</span>
            {move}
            <span className="ml-auto flex items-center gap-2">
              {judgment && <GradeChip grade={judgment.grade} />}
            </span>
          </div>
          {!compact && item.fields.length > 0 && (
            <dl className="mt-1.5 space-y-0.5 text-[13px] leading-relaxed">
              {item.fields.map((f) => (
                <div key={f.label} className="flex gap-3">
                  <dt className="w-[88px] shrink-0 break-all text-muted">{f.label}</dt>
                  <dd className="min-w-0 break-words text-ink/90">{highlight(f.value, terms)}</dd>
                </div>
              ))}
            </dl>
          )}
          {judgment?.reason && (
            <div className="mt-2 rounded-lg bg-subtle px-2.5 py-1.5 text-[12.5px] leading-relaxed text-muted">
              <span className="font-medium text-ink/70">판정 근거 · </span>
              {judgment.reason}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
