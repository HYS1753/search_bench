import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ArrowRight, CheckCircle2, Info } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import type { Overview } from "@/lib/types";

/**
 * 준비 단계 화면(판정 모델·검색 API·평가 기준·비교 세트·테스트 데이터) 위에 '다음에 할 일'을 보여 준다.
 * 이 화면의 단계가 끝났고 아직 남은 단계가 있으면 바로 이동 버튼을, 덜 끝났으면 무엇이 부족한지 알려 준다.
 */
export function NextStep({ current }: { current: "judge_model" | "targets" | "criteria" | "suite" | "dataset" }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/overview"), staleTime: 2000 });
  // 이 화면의 목록이 새로 불려 오면(저장·삭제 후) 준비 상태도 다시 받는다
  useEffect(
    () =>
      qc.getQueryCache().subscribe((e) => {
        const k = e.query.queryKey[0];
        if (e.type === "updated" && e.action.type === "success" && ["judge-models", "targets", "criteria", "suites", "datasets"].includes(String(k)))
          qc.invalidateQueries({ queryKey: ["overview"] });
      }),
    [qc],
  );
  if (!data) return null;
  const steps = data.onboarding;
  const me = steps.find((s) => s.key === current);
  if (!me) return null;
  // 선택 단계(테스트 데이터)는 건너뛸 수 있으므로 필수 단계를 먼저 안내한다
  const next = steps.find((s) => !s.done && s.key !== current && s.key !== "dataset") ?? steps.find((s) => !s.done && s.key !== current);
  if (!me.done) {
    if (current === "targets" && (data.counts.targets ?? 0) === 1)
      return (
        <Banner tone="info" text="API 를 1개 연결했습니다. 비교하려면 하나 더(예: 개선안·새 검색엔진) 연결하세요." />
      );
    if (current === "judge_model" && (data.counts.judge_models ?? 0) > 0)
      return <Banner tone="info" text="모델을 등록했습니다. ‘연결 테스트’가 통과하면 다음 단계로 넘어갈 수 있습니다." />;
    return null;
  }
  if (!next) return null;
  return (
    <div className="animate-fade-up mb-8 flex flex-wrap items-center gap-3 rounded-2xl border border-good/30 bg-good-soft/60 px-5 py-3.5">
      <CheckCircle2 className="animate-check h-5 w-5 shrink-0 text-good" />
      <div className="min-w-0 flex-1 text-[14px]">
        <b>{me.title}</b> 완료 · <span className="text-muted">다음은 ‘{next.title}’ 입니다. {next.hint}</span>
      </div>
      <Link to={next.to}><Button size="sm" variant="primary">다음: {next.title}<ArrowRight className="h-3.5 w-3.5" /></Button></Link>
    </div>
  );
}

function Banner({ text, tone }: { text: string; tone: "info" }) {
  return (
    <div className="animate-fade-up mb-8 flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent-soft/50 px-5 py-3.5 text-[14px]" data-tone={tone}>
      <Info className="h-4 w-4 shrink-0 text-accent" />
      {text}
    </div>
  );
}
