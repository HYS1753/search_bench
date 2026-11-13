import { Stat, StatRow } from "@/components/ui/page";
import { Alert } from "@/components/ui/primitives";
import { cn, fmt } from "@/lib/format";
import type { Agreement as AgreementData, InterRater, ReviewProgress, ReviewerStat } from "@/lib/types";

/** 카파 해석(Landis & Koch, 1977) */
export function kappaLabel(k: number | null | undefined): { text: string; tone?: "good" | "warn" | "bad" } {
  if (k === null || k === undefined) return { text: "계산 불가" };
  if (k >= 0.8) return { text: "거의 완전 일치", tone: "good" };
  if (k >= 0.6) return { text: "상당히 일치", tone: "good" };
  if (k >= 0.4) return { text: "중간 정도", tone: "warn" };
  if (k >= 0.2) return { text: "약하게 일치", tone: "bad" };
  return { text: "거의 불일치", tone: "bad" };
}

const G = ["0 무관", "1 약간", "2 관련", "3 매우"];

export function AgreementPanel({ agreement: a, review }: { agreement?: AgreementData; review?: ReviewProgress }) {
  if (!a || !a.items)
    return (
      <Alert>
        아직 사람이 채점한 항목이 없습니다. 아래에서 몇 건을 채점하면 LLM 판정과 얼마나 일치하는지 여기에 나옵니다.
      </Alert>
    );
  const kq = kappaLabel(a.kappa_quadratic);
  const kb = kappaLabel(a.kappa_binary);
  const max = Math.max(1, ...a.confusion.flat());
  const few = (review?.complete_cases ?? 0) < 30;
  return (
    <div>
      {few && (
        <Alert tone="warn" className="mb-5">
          검수 완료 케이스가 {review?.complete_cases ?? 0}건입니다. 30건 이상이면 일치도 숫자를 믿을 만하게 볼 수 있습니다.
        </Alert>
      )}
      <StatRow min={180}>
        <Stat label="가중 카파 (0~3 등급)" term="kappa" value={fmt.num(a.kappa_quadratic, 2)} tone={kq.tone} sub={`${kq.text} · 항목 ${fmt.int(a.items)}개`} />
        <Stat label="관련/비관련 카파" term="kappa" value={fmt.num(a.kappa_binary, 2)} tone={kb.tone} sub={`${kb.text} · 일치율 ${fmt.pct(a.binary_agree)}`} />
        <Stat label="등급 완전 일치" value={fmt.pct(a.exact)} sub={`±1 이내 ${fmt.pct(a.within1)}`} />
        <Stat label="LLM 이 후한 정도" term="bias" value={fmt.signed(a.bias, 2)} tone={a.bias !== null && Math.abs(a.bias) >= 0.3 ? "warn" : undefined}
          sub={`평균 등급 LLM ${fmt.num(a.llm_mean, 2)} · 사람 ${fmt.num(a.human_mean, 2)}`} />
        <Stat label="목록 선호 일치" value={fmt.pct(a.pairwise_agree)} sub={`${fmt.int(a.pairwise_cases)}건 비교`} />
      </StatRow>

      <div className="mt-8 grid gap-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
        <div>
          <div className="mb-2 text-[13.5px] font-semibold">등급 교차표 <span className="font-normal text-muted">(세로 LLM · 가로 사람)</span></div>
          <table className="num text-[12.5px]">
            <thead>
              <tr>
                <th className="w-16" />
                {G.map((g) => <th key={g} className="w-16 pb-1.5 text-center font-medium text-muted">{g}</th>)}
              </tr>
            </thead>
            <tbody>
              {a.confusion.map((row, i) => (
                <tr key={i}>
                  <th className="pr-2 text-right font-medium text-muted">{G[i]}</th>
                  {row.map((v, j) => (
                    <td key={j} className="p-0.5">
                      <div
                        className={cn("flex h-11 items-center justify-center rounded-lg font-semibold transition-colors", i === j ? "ring-1 ring-good/40" : "")}
                        style={{ background: v ? `rgb(var(${i === j ? "--good" : "--warn"}) / ${0.12 + 0.6 * (v / max)})` : "rgb(var(--subtle))", color: v ? undefined : "rgb(var(--faint))" }}
                      >
                        {v}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-2 break-keep text-[13.5px] leading-relaxed text-muted">
          <p><b className="text-ink">대각선</b>(초록)이 진할수록 LLM 과 사람이 같은 등급을 줬다는 뜻입니다. 대각선 <b className="text-ink">위쪽</b>은 LLM 이 사람보다 낮게, <b className="text-ink">아래쪽</b>은 높게 준 경우입니다.</p>
          <p><b className="text-ink">가중 카파</b>는 우연히 맞을 확률을 뺀 일치도로, 0.6 이상이면 상당히, 0.8 이상이면 거의 완전히 일치한다고 봅니다(Landis &amp; Koch). 한 등급 차이는 덜, 세 등급 차이는 크게 벌점을 줍니다.</p>
          <p>일치도가 낮으면 평가 기준의 <b className="text-ink">검색 목적·추가 조건</b>을 구체화하거나 판정 모델을 바꿔 보세요. 그때까지는 <b className="text-ink">결합 점수</b>(사람 판정 우선)를 기준으로 보는 것이 안전합니다.</p>
        </div>
      </div>
    </div>
  );
}

/** 여러 검수자: 검수자 간 일치도와 사람별 통계 */
export function ReviewersPanel({ inter, reviewers }: { inter?: InterRater; reviewers?: ReviewerStat[] }) {
  if (!reviewers?.length) return null;
  const k = kappaLabel(inter?.kappa_avg);
  return (
    <div className="mt-10">
      <div className="mb-1 text-[15px] font-semibold">검수자 {reviewers.length}명</div>
      <p className="mb-4 break-keep text-[13px] text-muted">
        사람 점수와 결합 점수는 검수자들의 합의(등급은 중앙값, 목록 선호는 다수결 · 동률이면 ‘비슷’)를 씁니다.
        검수자끼리 일치도가 낮으면 평가 기준을 함께 다시 읽고 맞춘 뒤 검수하세요 — 사람끼리 안 맞으면 LLM 과의 일치도도 의미가 약해집니다.
      </p>
      {reviewers.length > 1 && (
        <StatRow min={200}>
          <Stat label="검수자 간 가중 카파 (평균)" term="kappa" value={fmt.num(inter?.kappa_avg, 2)} tone={k.tone} sub={inter?.kappa_avg === null || inter?.kappa_avg === undefined ? "겹쳐 본 항목이 5개 이상인 쌍이 없음 — ‘겹쳐 보기’로 검수하세요" : `${k.text} · 겹친 항목 ${fmt.int(inter?.items ?? 0)}개`} />
          <Stat label="검수자 간 목록 선호 일치" value={fmt.pct(inter?.pairwise_agree)} sub={`${fmt.int(inter?.pairwise_items ?? 0)}건 비교`} />
        </StatRow>
      )}
      <div className="scroll-thin mt-4 overflow-x-auto border-y border-line">
        <table className="w-full min-w-[560px] text-[13.5px]">
          <thead className="border-b border-line text-[12px] text-muted">
            <tr><th className="px-3 py-2.5 text-left font-medium">검수자</th><th className="px-3 py-2.5 text-right font-medium">케이스</th><th className="px-3 py-2.5 text-right font-medium">항목</th>
              <th className="px-3 py-2.5 text-right font-medium">LLM 과 가중 카파</th><th className="px-3 py-2.5 text-right font-medium">LLM 이 후한 정도</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {reviewers.map((r) => (
              <tr key={r.reviewer}>
                <td className="px-3 py-2.5 font-medium">{r.reviewer}</td>
                <td className="num px-3 text-right">{fmt.int(r.cases)}</td>
                <td className="num px-3 text-right">{fmt.int(r.items)}</td>
                <td className={cn("num px-3 text-right", kappaLabel(r.kappa_llm).tone === "bad" && "text-bad")}>{fmt.num(r.kappa_llm, 2)}</td>
                <td className="num px-3 text-right">{fmt.signed(r.bias_llm, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(inter?.pairs.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 text-[12.5px] text-muted">
          {inter!.pairs.map((p) => (
            <span key={`${p.a}-${p.b}`} className="rounded-lg bg-subtle px-2 py-1">{p.a} ↔ {p.b}: 카파 {fmt.num(p.kappa, 2)} · 완전 일치 {fmt.pct(p.exact)} · {p.items}개</span>
          ))}
        </div>
      )}
    </div>
  );
}
