import { ArrowUpRight, ChevronDown } from "lucide-react";
import { Children, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/format";
import { TermTip } from "./overlay";

/* 레이아웃 원칙: 상자(카드) 대신 얇은 선으로 영역을 나눈다. 모든 행·칸은 폭이 줄면 줄바꿈된다. */

export function PageHeader({ title, description, actions, eyebrow, compactTitle }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; compactTitle?: boolean }) {
  return (
    <header className="mb-10">
      {/* 그룹 이름은 사이드바에 이미 보이므로 사이드바가 접히는 좁은 화면에서만 보여 준다 */}
      {eyebrow && <div className="mb-2 text-[13px] font-medium text-muted lg:hidden">{eyebrow}</div>}
      <div className={cn("flex flex-wrap justify-between gap-x-6 gap-y-4", compactTitle ? "items-center" : "items-start")}>
        <h1 className={cn("min-w-0 text-[28px] font-bold leading-tight tracking-tight text-ink", compactTitle ? "flex-1 basis-[320px]" : "break-keep")}>{title}</h1>
        {actions && <div className={cn("flex flex-wrap items-center gap-2", compactTitle && "ml-auto shrink-0 justify-end")}>{actions}</div>}
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
export function Stat({ label, value, sub, term, hint, tone, className, to }: { label: ReactNode; value: ReactNode; sub?: ReactNode; term?: string; hint?: ReactNode; tone?: "good" | "bad" | "warn" | "accent"; className?: string; to?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[13.5px] text-muted">
        {label}
        {(term || hint) && <TermTip term={term} hint={hint} />}
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
  // 좁은 화면: 최소 폭(min) 기준으로 자동 줄바꿈. 넓은 화면(xl): 칸 수만큼 한 줄 — 4칸 줄에 5번째 칸이 혼자 남는 일을 막는다.
  const n = Math.min(Children.toArray(children).filter(Boolean).length, 6);
  return (
    <div
      className={cn("grid overflow-hidden border-t border-line [grid-template-columns:var(--cols)] xl:[grid-template-columns:var(--cols-xl)]", className)}
      style={{ "--cols": `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, "--cols-xl": `repeat(${n || 1}, minmax(0, 1fr))` } as CSSProperties}
    >
      {children}
    </div>
  );
}

/** 접고 펼치는 영역. 높이가 부드럽게 늘고 줄어든다(grid-rows 0fr↔1fr). 보조 정보(숫자 표·통계)를 기본으로 접어 둘 때 쓴다. */
export function Collapsible({ title, summary, children, defaultOpen = false, className, open: controlled, onOpenChange }: {
  title: ReactNode; summary?: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string;
  open?: boolean; onOpenChange?: (v: boolean) => void;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const open = controlled ?? inner;
  const set = (v: boolean) => (onOpenChange ? onOpenChange(v) : setInner(v));
  return (
    <section className={cn("border-y border-line", className)}>
      <button type="button" onClick={() => set(!open)} aria-expanded={open}
        className="group flex w-full flex-wrap items-center gap-x-4 gap-y-1 py-4 text-left">
        <span className="text-[15px] font-semibold tracking-tight text-ink">{title}</span>
        {summary && <span className="text-[13px] text-muted">{summary}</span>}
        <span className="ml-auto inline-flex items-center gap-1 text-[13px] font-medium text-muted transition-colors group-hover:text-accent">
          {open ? "접기" : "펼치기"}<ChevronDown className={cn("h-4 w-4 transition-transform duration-300 ease-out", open && "rotate-180")} />
        </span>
      </button>
      <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="min-h-0 overflow-hidden">
          <div className="pb-6">{children}</div>
        </div>
      </div>
    </section>
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
  /*
   * 선택 표시(유리 알약)를 버튼 뒤의 한 덩어리로 그린다.
   *  - 값이 바뀌면 그 자리로 미끄러져 간다(줄바꿈돼도 위치를 재서 따라감)
   *  - 선택된 칸을 누른 채 좌우로 끌면 알약이 손가락을 따라오고, 놓은 자리의 항목이 선택된다
   *  - 누르는 동안 알약이 살짝 커지며 유리(liquid glass) 질감이 진해진다
   */
  const wrap = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; w: number; pressed: boolean } | null>(null);
  const start = useRef<{ px: number; x0: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const buttons = () => [...(wrap.current?.querySelectorAll<HTMLButtonElement>("[data-value]") ?? [])];
  useLayoutEffect(() => {
    const measure = () => {
      const el = wrap.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(String(value))}"]`);
      setPill(el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [value, items.length]);

  // 끌기는 한 줄일 때만(줄바꿈되면 좌우 이동이 의미 없음)
  const oneRow = () => new Set(buttons().map((b) => b.offsetTop)).size === 1;
  const under = (center: number) => {
    const bs = buttons();
    return bs.reduce((best, b) => (Math.abs(b.offsetLeft + b.offsetWidth / 2 - center) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - center) ? b : best), bs[0]);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-value]");
    if (!pill || !target || target.dataset.value !== String(value) || e.button !== 0) return;
    start.current = { px: e.clientX, x0: pill.x, moved: false, id: e.pointerId };
    setDrag({ x: pill.x, w: pill.w, pressed: true });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const st = start.current;
    if (!st || !pill || !wrap.current) return;
    const dx = e.clientX - st.px;
    if (!st.moved && Math.abs(dx) < 4) return;
    if (!st.moved) {
      if (!oneRow()) return;
      st.moved = true;
      wrap.current.setPointerCapture(st.id);
    }
    const bs = buttons();
    const min = bs[0].offsetLeft;
    const last = bs[bs.length - 1];
    const x = Math.max(min, Math.min(last.offsetLeft + last.offsetWidth - pill.w, st.x0 + dx));
    const target = under(x + pill.w / 2);
    setDrag({ x, w: target.offsetWidth, pressed: true });
  };
  const finish = (e: React.PointerEvent) => {
    const st = start.current;
    start.current = null;
    if (!st) return;
    if (st.moved && drag) {
      suppressClick.current = true;
      const target = under(drag.x + drag.w / 2);
      const v = target.dataset.value as T;
      if (v !== value) onChange(v);
      if (wrap.current?.hasPointerCapture(e.pointerId)) wrap.current.releasePointerCapture(e.pointerId);
    }
    setDrag(null);
  };

  const dragging = !!drag && !!start.current?.moved;
  const x = drag && dragging ? drag.x : pill?.x ?? 0;
  const w = drag && dragging ? drag.w : pill?.w ?? 0;
  return (
    <div ref={wrap} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={finish}
      className={cn("glass-track relative inline-flex max-w-full touch-pan-y select-none flex-wrap rounded-xl p-1", className)}>
      {pill && (
        <span aria-hidden data-pressed={!!drag?.pressed}
          className={cn("glass-pill absolute left-0 top-0 rounded-lg",
            dragging ? "transition-[width,box-shadow] duration-200" : "transition-[transform,width,height,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]")}
          style={{ transform: `translate(${x}px, ${pill.y}px) scale(${drag?.pressed ? 1.06 : 1})`, width: w, height: pill.h }} />
      )}
      {items.map((it) => (
        <button
          key={it.value}
          data-value={it.value}
          type="button"
          onClick={() => {
            if (suppressClick.current) { suppressClick.current = false; return; }
            onChange(it.value);
          }}
          aria-pressed={value === it.value}
          className={cn("relative z-[1] rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors duration-200",
            value === it.value ? "cursor-grab text-ink active:cursor-grabbing" : "text-muted hover:text-ink", !pill && value === it.value && "bg-panel shadow-soft")}
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
