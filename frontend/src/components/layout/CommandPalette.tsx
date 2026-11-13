import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/format";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  keywords?: string;
  hint?: string;
  run: (nav: ReturnType<typeof useNavigate>) => void;
}

/** ⌘K / Ctrl+K — 어디서든 화면 이동·작업 실행. 화살표로 고르고 Enter. */
export function CommandPalette({ commands, open, onOpenChange }: { commands: Command[]; open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/\s+/g, "");
    if (!t) return commands;
    return commands.filter((c) => `${c.label}${c.group}${c.keywords ?? ""}`.toLowerCase().replace(/\s+/g, "").includes(t));
  }, [q, commands]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onOpenChange(false);
    c.run(navigate);
  };
  const groups = [...new Set(results.map((r) => r.group))];
  let n = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-anim fixed inset-0 z-[80] bg-black/25 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="dialog-anim fixed left-1/2 top-[38%] z-[81] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_64px_-16px_rgb(16_24_40/0.35)] focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); run(results[idx]); }
          }}
        >
          <DialogPrimitive.Title className="sr-only">빠른 이동</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search className="h-4 w-4 shrink-0 text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="화면이나 작업을 검색하세요…"
              className="h-14 w-full bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none"
            />
            <kbd className="hidden shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-faint sm:block">ESC</kbd>
          </div>
          <div ref={listRef} className="scroll-thin max-h-[min(420px,60vh)] overflow-y-auto p-2">
            {results.length === 0 && <div className="px-3 py-10 text-center text-sm text-muted">‘{q}’ 와 맞는 항목이 없습니다.</div>}
            {groups.map((g) => (
              <div key={g} className="mb-1">
                <div className="px-3 pb-1 pt-2 text-[11.5px] font-medium text-faint">{g}</div>
                {results.filter((r) => r.group === g).map((c) => {
                  n += 1;
                  const i = n;
                  const on = i === idx;
                  return (
                    <button
                      key={c.id}
                      data-idx={i}
                      onMouseMove={() => setIdx(i)}
                      onClick={() => run(c)}
                      className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] transition-colors", on ? "bg-subtle text-ink" : "text-ink/80")}
                    >
                      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors", on ? "bg-panel text-accent shadow-soft" : "text-muted")}>{c.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="shrink-0 text-[12px] text-faint">{c.hint}</span>}
                      {on && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-faint" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 border-t border-line bg-subtle/60 px-4 py-2 text-[11.5px] text-faint">
            <span><kbd className="font-mono">↑↓</kbd> 이동</span>
            <span><kbd className="font-mono">Enter</kbd> 열기</span>
            <span className="ml-auto">SearchBench</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
