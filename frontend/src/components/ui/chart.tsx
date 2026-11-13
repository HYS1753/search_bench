import type { ReactNode } from "react";

/*
 * 차트 공통 테마 — 모든 차트가 같은 축·격자·툴팁·색을 쓰도록 모아 둔다.
 * 원칙: 채도 낮은 색, 얇은 점선 격자, 둥근 막대 끝, 부드러운 곡선(monotone) + 아래로 옅어지는 채우기.
 */

/** 계열 색: 첫 번째는 강조색, 나머지는 index.css 의 --chart-N (라이트·다크 각각 정의) */
export const SERIES = ["rgb(var(--accent))", "rgb(var(--chart-2))", "rgb(var(--chart-3))", "rgb(var(--chart-4))", "rgb(var(--chart-5))", "rgb(var(--chart-6))"];
export const seriesColor = (i: number) => SERIES[i % SERIES.length];
/** 기준(비교 대상의 기준선)은 무채색 */
export const BASELINE_COLOR = "rgb(var(--faint) / 0.55)";
export const GOOD = "rgb(var(--good) / 0.8)";
export const BAD = "rgb(var(--bad) / 0.75)";
export const NEUTRAL = "rgb(var(--faint) / 0.35)";

export const AXIS_TICK = { fontSize: 11.5, fill: "rgb(var(--faint))" };
export const CATEGORY_TICK = { fontSize: 12.5, fill: "rgb(var(--ink) / 0.8)" };
/** <CartesianGrid {...GRID} vertical={false} /> */
export const GRID = { stroke: "rgb(var(--line))", strokeDasharray: "3 5" };
export const CURSOR_FILL = { fill: "rgb(var(--subtle) / 0.7)" };
export const CURSOR_LINE = { stroke: "rgb(var(--faint) / 0.5)", strokeDasharray: "3 3" };
export const LEGEND_STYLE = { fontSize: 12.5, paddingTop: 10 };
export const ANIM = { animationDuration: 650, animationEasing: "ease-out" as const };

/** 영역 차트 채우기: 선 색에서 아래로 투명해지는 그라데이션. <defs> 안에 넣는다. */
export function FadeGradient({ id, color, from = 0.26 }: { id: string; color: string; from?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={from} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}

export type TipRow = { color?: string; name: ReactNode; value: ReactNode };

/** 밝은 카드형 툴팁(라이트·다크 모두 panel 색). */
export function ChartTooltip({ title, rows, footer }: { title?: ReactNode; rows: TipRow[]; footer?: ReactNode }) {
  return (
    <div className="min-w-[150px] rounded-xl border border-line bg-panel/95 px-3 py-2.5 text-[12px] text-ink shadow-[0_10px_30px_-12px_rgb(16_24_40/0.28)] backdrop-blur-sm">
      {title && <div className="mb-1.5 font-semibold">{title}</div>}
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            {r.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />}
            <span className="text-muted">{r.name}</span>
            <span className="num ml-auto pl-4 font-semibold">{r.value}</span>
          </div>
        ))}
      </div>
      {footer && <div className="mt-1.5 border-t border-line pt-1.5 text-muted">{footer}</div>}
    </div>
  );
}

/** 데이터가 없거나 모두 0 일 때 빈 축 대신 보여 준다. */
export function ChartEmpty({ children, height = 160 }: { children: ReactNode; height?: number }) {
  return <div className="flex items-center justify-center rounded-xl border border-dashed border-line text-[13px] text-muted" style={{ height }}>{children}</div>;
}
