import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fmt = {
  num(v: number | null | undefined, digits = 3): string {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    return v.toFixed(digits);
  },
  signed(v: number | null | undefined, digits = 3): string {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const s = v.toFixed(digits);
    return v > 0 ? `+${s}` : s;
  },
  pct(v: number | null | undefined, digits = 0): string {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    return `${(v * 100).toFixed(digits)}%`;
  },
  signedPct(v: number | null | undefined, digits = 0): string {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const s = (v * 100).toFixed(digits);
    return v > 0 ? `+${s}%p` : `${s}%p`;
  },
  int(v: number | null | undefined): string {
    if (v === null || v === undefined) return "–";
    return v.toLocaleString("ko-KR");
  },
  ms(v: number | null | undefined): string {
    if (v === null || v === undefined) return "–";
    return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
  },
  usd(v: number | null | undefined): string {
    if (v === null || v === undefined) return "–";
    if (v === 0) return "$0";
    return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  },
  bytes(v: number): string {
    if (v < 1024) return `${v} B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 ** 2).toFixed(1)} MB`;
  },
  date(iso: string | null | undefined): string {
    if (!iso) return "–";
    const d = new Date(iso);
    return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  },
  ago(iso: string | null | undefined): string {
    if (!iso) return "–";
    const sec = (Date.now() - new Date(iso).getTime()) / 1000;
    if (sec < 60) return "방금";
    if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
    return `${Math.floor(sec / 86400)}일 전`;
  },
  duration(start: string | null, end: string | null): string {
    if (!start) return "–";
    const s = (new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / 1000;
    if (s < 60) return `${Math.round(s)}초`;
    if (s < 3600) return `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
    return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
  },
  inputs(v: unknown): string {
    if (Array.isArray(v)) return v.join(", ");
    if (v === null || v === undefined) return "";
    return String(v);
  },
};

export const STATUS_LABEL: Record<string, string> = {
  queued: "대기",
  running: "진행 중",
  done: "완료",
  failed: "실패",
  cancelled: "취소됨",
  interrupted: "중단됨",
  pending: "대기",
  error: "오류",
};

export const PROVIDER_LABEL: Record<string, string> = {
  vertex: "Vertex AI",
  gemini: "Gemini API",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openai_compatible: "OpenAI 호환",
};
