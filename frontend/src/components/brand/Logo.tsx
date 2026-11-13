import { useId } from "react";
import { cn } from "@/lib/format";

export const APP_NAME = "SearchBench";
export const APP_TAGLINE = "검색 품질 판정 랩";

/** 오름차순 막대 3개 = 순위·벤치마크. 가장 높은 막대가 '더 나은 결과'. */
export function LogoMark({ className, animated = false }: { className?: string; animated?: boolean }) {
  // 같은 화면에 로고가 여러 개(숨겨진 사이드바 포함) 있어도 그라데이션이 깨지지 않게 id 를 따로 쓴다
  const gid = `sb-g-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 32 32" className={cn("h-8 w-8 shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C88FF" />
          <stop offset="1" stopColor="#4F46E5" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gid})`} />
      <g className={animated ? "logo-bars" : undefined}>
        <rect x="7.5" y="17" width="4.2" height="8" rx="2.1" fill="#fff" fillOpacity=".5" />
        <rect x="13.9" y="12" width="4.2" height="13" rx="2.1" fill="#fff" fillOpacity=".75" />
        <rect x="20.3" y="7" width="4.2" height="18" rx="2.1" fill="#fff" />
      </g>
    </svg>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark animated className={compact ? "h-7 w-7" : "h-9 w-9"} />
      <span className="min-w-0 leading-none">
        <span className={cn("block font-bold tracking-[-0.03em] text-ink", compact ? "text-[16px]" : "text-[19px]")}>
          Search<span className="text-accent">Bench</span>
        </span>
        {!compact && <span className="mt-1 block text-[12px] font-medium text-muted">{APP_TAGLINE}</span>}
      </span>
    </span>
  );
}
