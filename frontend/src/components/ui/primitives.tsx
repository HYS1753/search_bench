import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-panel hover:bg-ink/90 shadow-soft",
  secondary: "bg-panel text-ink border border-line hover:bg-subtle shadow-soft",
  outline: "bg-transparent text-ink border border-line hover:bg-subtle",
  ghost: "bg-transparent text-muted hover:text-ink hover:bg-subtle",
  danger: "bg-panel text-bad border border-line hover:bg-bad-soft",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-xl",
  icon: "h-9 w-9 rounded-lg justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "press inline-flex items-center font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

/** 상자 대신 위아래 선으로 영역을 구분한다(첨부 디자인 톤). */
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("border-y border-line", className)} {...rest}>
      {children}
    </div>
  );
}

const fieldBase =
  "w-full rounded-xl border border-line bg-panel px-3 text-sm text-ink placeholder:text-faint transition-colors focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:bg-subtle disabled:text-muted";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(fieldBase, "h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(fieldBase, "py-2.5 leading-relaxed min-h-[96px]", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        fieldBase,
        "h-10 appearance-none pr-9 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23989fae%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-no-repeat bg-[right_10px_center]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Field({
  label,
  help,
  error,
  required,
  children,
  className,
  aside,
}: {
  label?: ReactNode;
  help?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}) {
  return (
    <label className={cn("block", className)}>
      {label && (
        <span className="mb-1.5 flex items-center justify-between gap-2 text-[13px] font-medium text-ink">
          <span>
            {label}
            {required && <span className="ml-0.5 text-bad">*</span>}
          </span>
          {aside}
        </span>
      )}
      {children}
      {error ? (
        <span className="mt-1.5 block text-xs text-bad">{error}</span>
      ) : help ? (
        <span className="mt-1.5 block text-xs leading-relaxed text-muted">{help}</span>
      ) : null}
    </label>
  );
}

type Tone = "neutral" | "accent" | "good" | "bad" | "warn" | "outline";
const TONES: Record<Tone, string> = {
  neutral: "bg-subtle text-muted",
  accent: "bg-accent-soft text-accent",
  good: "bg-good-soft text-good",
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  outline: "border border-line text-muted",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-5", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex max-w-full items-center gap-2.5 text-left text-sm text-ink disabled:opacity-50"
    >
      <span className={cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors", checked ? "bg-accent" : "bg-line")}>
        <span className={cn("h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4" : "translate-x-0")} />
      </span>
      {label && <span className="min-w-0">{label}</span>}
    </button>
  );
}

/** 로딩 자리 표시(스피너 대신 모양을 미리 보여 준다) */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} aria-hidden />;
}

/** 페이지 로딩 스켈레톤: 머리글 + 지표 줄 + 목록 */
export function PageSkeleton() {
  return (
    <div className="animate-fade-in" aria-busy="true" aria-label="불러오는 중">
      <Skeleton className="mb-3 h-3.5 w-20" />
      <Skeleton className="mb-4 h-8 w-64" />
      <Skeleton className="mb-12 h-4 w-[min(520px,90%)]" />
      <div className="mb-12 grid gap-6 border-t border-line pt-6 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="mb-3 h-3.5 w-24" />
            <Skeleton className="h-8 w-28" />
          </div>
        ))}
      </div>
      <div className="divide-y divide-line border-y border-line">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 py-4">
            <Skeleton className="h-9 w-9 rounded-xl" />
            <div className="flex-1">
              <Skeleton className="mb-2 h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-muted", className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="animate-fade-up flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-14 text-center">
      {icon && <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-panel text-faint shadow-soft ring-1 ring-line">{icon}</div>}
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Progress({ value, max, tone = "accent", className }: { value: number; max: number; tone?: "accent" | "good" | "bad"; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-subtle", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]", { accent: "bg-accent", good: "bg-good", bad: "bg-bad" }[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cn("scroll-thin max-h-[420px] overflow-auto rounded-xl bg-subtle p-3.5 font-mono text-[12px] leading-relaxed text-ink", className)}>
      {children}
    </pre>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[12px] text-ink">{children}</code>;
}

export function Alert({ tone = "neutral", title, children, className, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div role={tone === "bad" ? "alert" : undefined} className={cn("animate-fade-in flex gap-3 rounded-xl px-4 py-3 text-sm", TONES[tone], className)}>
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn("leading-relaxed", title && "mt-0.5", "text-ink/80 whitespace-pre-line")}>{children}</div>}
      </div>
    </div>
  );
}
