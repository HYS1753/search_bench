import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/format";
import { TermTip } from "./overlay";

/* 레이아웃 원칙: 상자(카드) 대신 얇은 선으로 영역을 나눈다. 모든 행·칸은 폭이 줄면 줄바꿈된다. */

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-10">
      {eyebrow && <div className="mb-2 text-[13px] font-medium text-muted">{eyebrow}</div>}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <h1 className="min-w-0 break-keep text-[28px] font-bold leading-tight tracking-tight text-ink">{title}</h1>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="mt-3 max-w-3xl break-keep text-[15px] leading-relaxed text-muted">{description}</p>}
    </header>
  );
}

export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-14", className)}>
      {(title || actions) && (
        <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            {title && <h2 className="break-keep text-[20px] font-bold tracking-tight text-ink">{title}</h2>}
            {description && <p className="mt-1.5 max-w-3xl break-keep text-[14.5px] leading-relaxed text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** 큰 숫자 지표 칸. StatRow 안에서 폭에 따라 자동으로 줄바꿈되고 칸 사이는 세로선으로 나뉜다. */
export function Stat({ label, value, sub, term, tone, className, to }: { label: ReactNode; value: ReactNode; sub?: ReactNode; term?: string; tone?: "good" | "bad" | "warn" | "accent"; className?: string; to?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[13.5px] text-muted">
        {label}
        {term && <TermTip term={term} />}
        {to && <ArrowUpRight className="ml-auto h-4 w-4 text-faint transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent" />}
      </div>
      <div
        className={cn(
          "num mt-2.5 break-all text-[30px] font-bold leading-none tracking-tight",
          tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : "text-ink",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-2.5 text-[13px] leading-snug text-muted">{sub}</div>}
    </>
  );
  const cls = cn("-ml-px min-w-0 border-b border-l border-line px-6 py-6", className);
  return to ? (
    <Link to={to} className={cn(cls, "group block transition-colors hover:bg-panel/70")}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function StatRow({ children, className, min = 250 }: { children: ReactNode; className?: string; min?: number }) {
  return (
    <div
      className={cn("grid overflow-hidden border-t border-line", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` }}
    >
      {children}
    </div>
  );
}

/** 선으로 나뉜 목록. 각 자식이 한 행이 된다. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-line border-y border-line", className)}>{children}</div>;
}

/** 설정 화면식 한 줄: 왼쪽 설명, 오른쪽 입력. 좁으면 위아래로 쌓인다. */
export function FormRow({ label, help, children, className, required }: { label: ReactNode; help?: ReactNode; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <div className={cn("grid gap-y-3 py-6 md:grid-cols-[minmax(200px,280px)_1fr] md:gap-y-0", className)}>
      <div className="min-w-0 md:pr-8">
        <div className="text-[14.5px] font-semibold text-ink">
          {label}
          {required && <span className="ml-0.5 text-bad">*</span>}
        </div>
        {help && <div className="mt-1 break-keep text-[13px] leading-relaxed text-muted">{help}</div>}
      </div>
      <div className="min-w-0 md:border-l md:border-line md:pl-8">{children}</div>
    </div>
  );
}

/** 표: 머리글 아래 선, 행 사이 선. 좁으면 가로 스크롤(페이지 전체는 넘치지 않음). */
export function Table({ head, children, minWidth = 640, className }: { head: ReactNode; children: ReactNode; minWidth?: number; className?: string }) {
  return (
    <div className={cn("scroll-thin -mx-1 overflow-x-auto px-1", className)}>
      <table className="w-full text-[14px]" style={{ minWidth }}>
        <thead className="border-b border-line text-[13px] text-muted [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:font-medium">
          {head}
        </thead>
        <tbody className="divide-y divide-line [&_td]:px-4 [&_td]:py-3.5 [&_td]:align-middle">{children}</tbody>
      </table>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div className={cn("flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]", className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={cn(
            "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-3 text-[14.5px] font-medium transition-[color,border-color] duration-200",
            value === it.value ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {it.label}
          {it.count !== undefined && <span className="num rounded-full bg-subtle px-1.5 text-[11px] text-muted">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={cn("inline-flex max-w-full flex-wrap rounded-xl bg-subtle p-1", className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={cn("rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors", value === it.value ? "bg-panel text-ink shadow-soft" : "text-muted hover:text-ink")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** 큰 선택지(라디오 카드 대신 선으로 구분된 선택 행) */
export function ChoiceList<T extends string | number>({ value, onChange, items, columns = 1 }: { value: T; onChange: (v: T) => void; items: { value: T; title: ReactNode; desc?: ReactNode; icon?: ReactNode }[]; columns?: 1 | 2 | 3 }) {
  return (
    <div className={cn("grid gap-2", columns === 2 && "sm:grid-cols-2", columns === 3 && "sm:grid-cols-2 lg:grid-cols-3")}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={String(it.value)}
            type="button"
            onClick={() => onChange(it.value)}
            className={cn(
              "press flex min-w-0 items-start gap-3 rounded-xl border px-4 py-3.5 text-left",
              on ? "border-ink bg-panel shadow-soft" : "border-line hover:border-faint hover:bg-panel/60",
            )}
          >
            <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", on ? "border-ink" : "border-faint")}>
              {on && <span className="animate-check h-2 w-2 rounded-full bg-ink" />}
            </span>
            {it.icon && <span className="mt-0.5 shrink-0 text-muted">{it.icon}</span>}
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold text-ink">{it.title}</span>
              {it.desc && <span className="mt-0.5 block break-keep text-[12.5px] leading-relaxed text-muted">{it.desc}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function KeyValue({ items, className }: { items: { k: ReactNode; v: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("divide-y divide-line border-y border-line text-[14px]", className)}>
      {items.map((it, i) => (
        <div key={i} className="grid gap-x-8 gap-y-1 py-3.5 sm:grid-cols-[180px_1fr]">
          <dt className="text-muted">{it.k}</dt>
          <dd className="min-w-0 break-words text-ink">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 단계 표시(마법사 상단) */
export function Steps({ steps, current, onJump }: { steps: string[]; current: number; onJump?: (i: number) => void }) {
  return (
    <ol className="mb-10 grid border-b border-line" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((s, i) => (
        <li key={s} className="min-w-0">
          <button
            type="button"
            disabled={!onJump || i > current}
            onClick={() => onJump?.(i)}
            className={cn(
              "-mb-px flex w-full min-w-0 items-center gap-2 border-b-2 py-3 text-left text-[13.5px] transition-[color,border-color] duration-300",
              i === current ? "border-ink font-semibold text-ink" : i < current ? "border-transparent text-ink/70 hover:text-ink" : "border-transparent text-faint",
            )}
          >
            <span className={cn("num flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-300", i < current ? "bg-good text-white" : i === current ? "bg-ink text-panel" : "bg-subtle text-muted")}>
              {i < current ? "✓" : i + 1}
            </span>
            <span className="truncate">{s}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
