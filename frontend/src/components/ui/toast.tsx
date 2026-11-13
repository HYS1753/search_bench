import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/format";

type Tone = "success" | "error" | "info";
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  leaving?: boolean;
  ms: number;
}

const Ctx = createContext<(tone: Tone, title: string, body?: string) => void>(() => {});

/** 오른쪽 아래 알림 — 아래에서 올라오고, 남은 시간 막대가 줄어들며, 마우스를 올리면 멈춘다. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 180);
    timers.current.delete(id);
  }, []);
  const schedule = useCallback((id: number, ms: number) => {
    timers.current.set(id, setTimeout(() => dismiss(id), ms));
  }, [dismiss]);
  const push = useCallback((tone: Tone, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    const ms = tone === "error" ? 7000 : 4000;
    setItems((xs) => [...xs.slice(-3), { id, tone, title, body, ms }]);
    schedule(id, ms);
  }, [schedule]);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            onMouseEnter={() => { clearTimeout(timers.current.get(t.id)); }}
            onMouseLeave={() => !t.leaving && schedule(t.id, 1800)}
            className={cn("group pointer-events-auto relative overflow-hidden rounded-2xl border border-line bg-panel/95 py-3.5 pl-4 pr-10 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.28)] backdrop-blur", t.leaving ? "toast-out" : "toast-in")}
          >
            <div className="flex gap-3">
              {t.tone === "success" ? (
                <CheckCircle2 className="animate-check mt-0.5 h-[18px] w-[18px] shrink-0 text-good" />
              ) : t.tone === "error" ? (
                <XCircle className="animate-check mt-0.5 h-[18px] w-[18px] shrink-0 text-bad" />
              ) : (
                <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-accent" />
              )}
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink">{t.title}</div>
                {t.body && <div className="mt-0.5 whitespace-pre-line break-words text-[13px] leading-relaxed text-muted">{t.body}</div>}
              </div>
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="알림 닫기" className="absolute right-2.5 top-2.5 rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-subtle hover:text-ink group-hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
            <span
              className={cn("absolute bottom-0 left-0 h-[2px] origin-left group-hover:[animation-play-state:paused]", t.tone === "error" ? "bg-bad/50" : t.tone === "success" ? "bg-good/50" : "bg-accent/50")}
              style={{ width: "100%", animation: `toast-timer ${t.ms}ms linear forwards` }}
            />
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return {
    success: (title: string, body?: string) => push("success", title, body),
    error: (title: string, body?: string) => push("error", title, body),
    info: (title: string, body?: string) => push("info", title, body),
  };
}
