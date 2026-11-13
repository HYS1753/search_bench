import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { HelpCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/format";
import { TERMS } from "@/lib/glossary";
import { Button } from "./primitives";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-anim fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            "dialog-anim fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl focus:outline-none",
            { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" }[size],
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
            <div>
              <DialogPrimitive.Title className="text-lg font-semibold text-ink">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded-lg p-1 text-muted hover:bg-subtle hover:text-ink">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
          {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line bg-panel px-6 py-4">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 오른쪽에서 열리는 패널 — 편집기·케이스 상세에 쓴다. */
export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  width = "max-w-3xl",
  scrollKey,
  headerActions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** 값이 바뀌면(예: 마법사 단계) 본문을 맨 위로 올린다 */
  scrollKey?: unknown;
  /** 닫기 버튼 왼쪽에 놓을 버튼(이전·다음 등) */
  headerActions?: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [scrollKey]);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-anim fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px]" />
        <DialogPrimitive.Content
          className={cn("drawer-anim fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-bg shadow-2xl focus:outline-none", width)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line bg-panel px-6 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-[17px] font-semibold text-ink">{title}</DialogPrimitive.Title>
              {subtitle ? (
                <DialogPrimitive.Description asChild>
                  <div className="mt-0.5 text-sm text-muted">{subtitle}</div>
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">상세</DialogPrimitive.Description>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
              <DialogPrimitive.Close className="rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-ink">
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
          </div>
          <div ref={bodyRef} className="scroll-thin flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-panel px-6 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root delayDuration={150}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="tooltip-anim z-[60] max-w-xs rounded-xl bg-ink px-3 py-2 text-[12.5px] leading-relaxed text-panel shadow-lg"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-ink" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** 버튼을 누르면 아래로 펼쳐지는 작은 메뉴(내보내기 형식 고르기 등). 바깥을 누르거나 Esc 로 닫힌다. */
export function Menu({ trigger, items, align = "end" }: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: { label: ReactNode; icon?: ReactNode; onSelect: () => void; disabled?: boolean }[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div role="menu" className={cn("menu-anim absolute top-full z-30 mt-1.5 min-w-[160px] overflow-hidden rounded-xl border border-line bg-panel p-1 shadow-lg", align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left")}>
          {items.map((it, i) => (
            <button key={i} role="menuitem" type="button" disabled={it.disabled}
              onClick={() => { setOpen(false); it.onSelect(); }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13.5px] text-ink hover:bg-subtle disabled:opacity-50">
              {it.icon && <span className="text-muted">{it.icon}</span>}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 지표 이름 옆 (?) — 정의·읽는 법·알 수 있는 것을 보여 준다. */
export function TermTip({ term, className }: { term: keyof typeof TERMS | string; className?: string }) {
  const t = TERMS[term];
  if (!t) return null;
  return (
    <Tooltip
      content={
        <div className="space-y-1.5">
          <div className="font-semibold">{t.name}</div>
          <div>{t.short}</div>
          <div className="opacity-80">읽는 법 · {t.read}</div>
          <div className="opacity-80">알 수 있는 것 · {t.learn}</div>
        </div>
      }
    >
      <button type="button" className={cn("inline-flex text-faint hover:text-muted", className)} aria-label={`${t.name} 설명`}>
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

export function useConfirm() {
  const [state, setState] = useState<null | { title: string; body?: ReactNode; confirm: string; danger?: boolean; resolve: (v: boolean) => void }>(null);
  const ask = (opts: { title: string; body?: ReactNode; confirm?: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setState({ confirm: "확인", ...opts, resolve }));
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const node = (
    <Dialog
      open={!!state}
      onOpenChange={(o) => !o && close(false)}
      title={state?.title ?? ""}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            취소
          </Button>
          <Button variant={state?.danger ? "danger" : "primary"} onClick={() => close(true)}>
            {state?.confirm}
          </Button>
        </>
      }
    >
      {state?.body && <div className="text-sm leading-relaxed text-muted">{state.body}</div>}
    </Dialog>
  );
  return { ask, node };
}
