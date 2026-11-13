import { Compass } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader, Section } from "@/components/ui/page";
import { Alert, Badge, Button, Card, Kbd } from "@/components/ui/primitives";
import { TERMS } from "@/lib/glossary";
import { RationaleSections } from "./guideRationale";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="num flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-semibold text-panel">{n}</span>
      <div className="pb-6">
        <div className="font-semibold">{title}</div>
        <div className="mt-1 text-[14px] leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  );
}

const ORDER = ["verdict", "ndcg", "ndcg_diff", "pairwise", "hit1", "mrr", "precision", "inconsistent", "grade", "error_rate", "latency", "no_relevant",
  "permutation", "holm", "effect_size", "needed_cases", "win_rate_ci", "kappa", "bias"];

export default function Guide() {
  return (
    <>
      <PageHeader eyebrow="도움말" title="평가 방법" description="이 도구가 검색 결과를 어떻게 채점하고, 결론을 어떻게 내리는지 설명합니다. 처음 쓰는 분은 위에서부터 읽어 보세요."
        actions={<Link to="/guide/start"><Button icon={<Compass className="h-4 w-4" />}>처음이라면 · 시작 가이드</Button></Link>} />

      <Section title="한눈에 보기">
        <Card className="pt-7">
          <Step n={1} title="같은 입력을 모든 API 에 보냅니다">테스트 입력마다 비교 세트의 대상(예: ASIS, TOBE)을 동시에 호출하고, 응답 매핑으로 결과 목록을 꺼냅니다.</Step>
          <Step n={2} title="항목마다 관련도를 매깁니다 (주 판정)">
            모든 대상의 상위 k개 항목을 모아(같은 항목은 한 번만) 판정 모델이 0~3 등급을 매깁니다. 한 번에 묻는 항목 수(묶음 크기)는 평가마다 고를 수 있고, 1개씩이 가장 정확합니다. 같은 항목이면 어느 대상에서 나왔든 같은 등급을 쓰므로 공정합니다. 이는 검색 평가의 표준인 TREC 등급 관련도 방식이며, LLM 이 사람 평가자를 대신하는 방법(UMBRELA, Bing 연구)을 따랐습니다.
          </Step>
          <Step n={3} title="등급으로 지표를 계산합니다">등급과 순위로 대상마다 nDCG@k·Hit@1·MRR·Precision@k 를 계산합니다. 수식이라 같은 판정이면 항상 같은 값이 나옵니다.</Step>
          <Step n={4} title="두 목록을 통째로 비교합니다 (보조 판정)">
            후보와 기준의 목록을 함께 보여 주고 어느 쪽이 더 유용한지 묻습니다. A·B 순서를 바꿔 두 번 묻고, 판정이 엇갈리면 무승부로 처리합니다(MT-Bench 의 위치 편향 보정).
          </Step>
          <Step n={5} title="통계로 결론을 냅니다">케이스별 nDCG 차이의 평균과 부트스트랩 95% 신뢰구간으로 개선·저하·차이 없음을 판정하고, 순열 검정·효과 크기·필요한 케이스 수로 교차 확인합니다. 후보가 여럿이면 Holm 보정으로 한 번 더 거릅니다.</Step>
          <Step n={6} title="(선택) 사람이 검수합니다">일부 케이스를 사람이 직접 채점하면 LLM–사람 일치도(카파)가 나오고, 사람 판정을 우선한 ‘결합 점수’와 사람만의 점수로 결과를 다시 볼 수 있습니다. LLM 판정만으로도 결과는 나옵니다.</Step>
        </Card>
      </Section>

      <Section title="관련도 등급">
        <Card className="divide-y divide-line">
          {[
            [3, "good", "매우 관련", "질의의 의도에 직접 답하는 대상. 이 항목만 보고 원하는 것을 해결할 수 있다."],
            [2, "accent", "관련", "실질적으로 도움이 되지만 일부 조건이 빠졌거나 간접적이다."],
            [1, "warn", "약간 관련", "주제나 키워드는 겹치지만 질의의 요구를 충족하지 못한다."],
            [0, "neutral", "무관", "질의와 관련이 없다."],
          ].map(([g, tone, label, body]) => (
            <div key={g as number} className="flex flex-wrap items-start gap-x-6 gap-y-1 py-3.5">
              <Badge tone={tone as "good"}>{g} {label}</Badge>
              <span className="text-[14px] text-muted">{body}</span>
            </div>
          ))}
        </Card>
        <div className="mt-3 text-[13px] text-muted">평가 기준의 ‘관련 기준 등급’(기본 2) 이상을 ‘관련’으로 세어 Hit@1·MRR·Precision 을 계산합니다.</div>
      </Section>

      <Section title="지표 사전" description="결과 화면의 (?) 아이콘과 같은 설명입니다.">
        <div className="grid gap-x-10 md:grid-cols-2">
          {ORDER.map((key) => {
            const t = TERMS[key];
            return (
              <div key={key} className="border-t border-line py-6">
                <div className="font-semibold">{t.name}</div>
                <div className="mt-1 text-[14px] text-ink/85">{t.short}</div>
                <dl className="mt-3 space-y-1.5 text-[13px] leading-relaxed">
                  <div><dt className="inline font-medium text-ink/70">계산 · </dt><dd className="inline text-muted">{t.how}</dd></div>
                  <div><dt className="inline font-medium text-ink/70">읽는 법 · </dt><dd className="inline text-muted">{t.read}</dd></div>
                  <div><dt className="inline font-medium text-ink/70">알 수 있는 것 · </dt><dd className="inline text-muted">{t.learn}</dd></div>
                </dl>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="결과를 읽는 순서">
        <Card className="py-6 text-[14.5px] leading-relaxed text-muted">
          <ol className="list-decimal space-y-2 pl-5">
            <li><span className="font-medium text-ink">결론</span>을 봅니다. ‘개선/저하’는 신뢰구간이 0을 넘어선, 우연으로 보기 어려운 차이입니다.</li>
            <li><span className="font-medium text-ink">nDCG 차이와 목록 비교 승률이 같은 방향</span>인지 확인합니다. 둘이 엇갈리면 순위는 좋아졌지만 체감은 비슷한 경우일 수 있습니다.</li>
            <li><span className="font-medium text-ink">Hit@1</span>을 봅니다. 에이전트처럼 1위만 쓰는 곳이라면 가장 중요한 지표입니다.</li>
            <li><span className="font-medium text-ink">‘기준 승’ 케이스</span>를 열어 어떤 질의에서 나빠졌는지, 판정 근거가 타당한지 확인합니다.</li>
            <li><span className="font-medium text-ink">실패율·응답 시간</span>으로 품질 차이가 장애나 속도 문제와 얽혀 있지 않은지 확인합니다.</li>
          </ol>
        </Card>
      </Section>

      <Section title="믿을 만한 결과를 얻으려면">
        <div className="grid gap-3 md:grid-cols-2">
          <Alert title="케이스는 30건 이상">10건 미만이면 결론을 보류합니다. 변경이 영향을 주는 질의와 평소 질의를 섞어 30~100건을 권장합니다.</Alert>
          <Alert title="검색 목적을 구체적으로">‘무엇이 정답인지’를 평가 기준의 검색 목적에 적을수록 등급이 일관됩니다. <Link to="/settings/criteria" className="text-accent">평가 기준</Link></Alert>
          <Alert title="판정 모델은 상위 모델로">최종 결론용 실행에는 성능이 좋은 모델을 쓰고, 순서 불일치가 많으면 모델을 바꿔 보세요.</Alert>
          <Alert title="샘플 검수">결과 일부를 사람이 직접 보고 판정 근거에 동의하는지 확인하세요. 동의하지 않으면 사용자 요구사항으로 기준을 보정합니다.</Alert>
        </div>
      </Section>

      <RationaleSections />

      <Section title="데이터와 보안">
        <Card className="py-6 text-[14.5px] leading-relaxed text-muted">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>판정 모델에는 입력값과, 검색 API 의 <span className="text-ink">응답 매핑에서 고른 필드만</span> 보냅니다. 전화번호·이메일 같은 개인정보는 매핑하지 마세요.</li>
            <li>API 키는 암호화해 저장하고 화면·내보내기에 다시 보여 주지 않습니다. 환경 변수(<Kbd>.env</Kbd>)에 둔 키가 우선합니다.</li>
            <li>모든 데이터는 <Kbd>data/</Kbd> 폴더(SQLite)에만 저장되며 git 에 올라가지 않습니다.</li>
          </ul>
        </Card>
      </Section>
    </>
  );
}
