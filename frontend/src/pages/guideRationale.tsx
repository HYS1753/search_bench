import { BookMarked, FlaskConical, Scale, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Section } from "@/components/ui/page";
import { Badge } from "@/components/ui/primitives";

/* 평가 방법 › 설계 근거·참고 문헌. 각 결정이 왜 그렇게 되었는지, 무엇을 참고했고 무엇을 대안으로 검토했는지. */

interface Decision {
  area: string;
  title: string;
  what: ReactNode;
  why: ReactNode;
  refs: number[];
  alt?: ReactNode;
}

export const REFS: { id: number; text: string; note: string }[] = [
  { id: 1, text: "Voorhees, E. M. & Harman, D. K. (2005). TREC: Experiment and Evaluation in Information Retrieval. MIT Press.", note: "등급 관련도, 풀링(pooling) — 검색 평가의 기본 틀" },
  { id: 2, text: "Järvelin, K. & Kekäläinen, J. (2002). Cumulated gain-based evaluation of IR techniques. ACM TOIS 20(4).", note: "nDCG 의 원 논문" },
  { id: 3, text: "Thomas, P., Spielman, S., Craswell, N. & Mitra, B. (2024). Large language models can accurately predict searcher preferences. SIGIR 2024.", note: "Bing 의 LLM 관련도 판정. 의도 파악·측면별 점수 후 최종 등급, 사람 판정과의 일치 검증" },
  { id: 4, text: "Upadhyay, S., Pradeep, R., Thakur, N., Craswell, N. & Lin, J. (2024). UMBRELA: UMbrela is the (Open-Source Reproduction of the) Bing RELevance Assessor. arXiv:2406.06519.", note: "[3] 의 공개 재현. TREC 2024 RAG 트랙 관련도 판정에 사용" },
  { id: 5, text: "Upadhyay, S. et al. (2024). A Large-Scale Study of Relevance Assessments with Large Language Models: An Initial Look. arXiv:2411.08275.", note: "LLM 판정으로 매긴 시스템 순위가 사람 판정 순위와 높은 상관" },
  { id: 6, text: "Zheng, L. et al. (2023). Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena. NeurIPS 2023 Datasets & Benchmarks.", note: "쌍대 비교 판정, 위치 편향과 순서 바꾸기 보정" },
  { id: 7, text: "Wang, P. et al. (2024). Large Language Models are not Fair Evaluators. ACL 2024.", note: "제시 순서에 따라 판정이 바뀌는 위치 편향" },
  { id: 8, text: "Liu, Y. et al. (2023). G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment. EMNLP 2023.", note: "평가 절차를 단계로 제시하고 근거를 먼저 쓰게 하는 방식" },
  { id: 9, text: "Faggioli, G. et al. (2023). Perspectives on Large Language Models for Relevance Judgment. ICTIR 2023.", note: "사람·LLM 협업 판정의 스펙트럼, 사람 검수의 필요성" },
  { id: 10, text: "Clarke, C. L. A. & Dietz, L. (2024). LLM-based relevance assessment still can't replace human relevance assessment. arXiv:2412.17156.", note: "LLM 판정의 한계·순환 편향 비판" },
  { id: 11, text: "Soboroff, I. (2024). Don't Use LLMs to Make Relevance Judgments. arXiv:2409.15133.", note: "LLM 판정만을 정답으로 쓰는 것에 대한 비판" },
  { id: 12, text: "Alaofi, M. et al. (2024). LLMs can be Fooled into Labelling a Document as Relevant. SIGIR-AP 2024.", note: "키워드 채우기·지시문 삽입에 속는 사례" },
  { id: 13, text: "Smucker, M. D., Allan, J. & Carterette, B. (2007). A Comparison of Statistical Significance Tests for Information Retrieval Evaluation. CIKM 2007.", note: "무작위화(순열) 검정 권장, 부호 검정의 한계" },
  { id: 14, text: "Sakai, T. (2014). Statistical reform in information retrieval? SIGIR Forum 48(1).", note: "p 값만이 아니라 효과 크기·신뢰구간을 함께 보고할 것" },
  { id: 15, text: "Efron, B. & Tibshirani, R. J. (1993). An Introduction to the Bootstrap. Chapman & Hall.", note: "부트스트랩 신뢰구간" },
  { id: 16, text: "Holm, S. (1979). A simple sequentially rejective multiple test procedure. Scandinavian Journal of Statistics 6(2).", note: "다중 비교 보정" },
  { id: 17, text: "Wilson, E. B. (1927). Probable inference, the law of succession, and statistical inference. JASA 22(158).", note: "비율의 신뢰구간(승률)" },
  { id: 18, text: "Cohen, J. (1960/1968). A coefficient of agreement for nominal scales / Weighted kappa. Educ. Psychol. Meas.; Psychol. Bull.", note: "카파, 가중 카파" },
  { id: 19, text: "Landis, J. R. & Koch, G. G. (1977). The measurement of observer agreement for categorical data. Biometrics 33(1).", note: "카파 해석 기준(0.6 상당, 0.8 거의 완전)" },
  { id: 20, text: "Cohen, J. (1988). Statistical Power Analysis for the Behavioral Sciences (2nd ed.).", note: "효과 크기 해석, 검정력·표본 크기" },
  { id: 21, text: "Angelopoulos, A. N. et al. (2023). Prediction-powered inference. Science 382(6671).", note: "소수의 사람 판정으로 모델 판정의 치우침을 보정하는 통계" },
  { id: 22, text: "Saad-Falcon, J. et al. (2024). ARES: An Automated Evaluation Framework for Retrieval-Augmented Generation Systems. NAACL 2024.", note: "LLM 판정 + 사람 판정 소량 + PPI 보정" },
  { id: 23, text: "Gu, J. et al. (2024). A Survey on LLM-as-a-Judge. arXiv:2411.15594.", note: "LLM 판정의 편향·신뢰성 개관" },
];

const DECISIONS: Decision[] = [
  {
    area: "채점 방식",
    title: "항목마다 0~3 등급을 매긴다 (주 판정)",
    what: "각 API 결과의 상위 k개 항목에 대해 ‘질의와 얼마나 관련 있는지’를 0(무관)~3(매우 관련)으로 매깁니다.",
    why: "검색 평가의 표준 단위가 ‘질의–문서 관련도’이기 때문입니다. 등급이 있으면 nDCG·Hit@1·MRR 같은 표준 지표를 계산할 수 있고, 같은 항목은 어느 시스템에서 나왔든 같은 점수를 받아 비교가 공정합니다. 4단계는 TREC 와 Bing·UMBRELA 가 쓰는 척도입니다.",
    refs: [1, 3, 4, 5],
    alt: "목록 전체만 비교(어느 쪽이 낫나)하는 방식은 쉽지만 ‘얼마나·어디서’ 나은지 알 수 없어 보조 판정으로만 씁니다.",
  },
  {
    area: "채점 방식",
    title: "모든 API 의 상위 결과를 모아(풀) 한 번씩만 판정한다",
    what: "한 케이스에서 모든 API 의 상위 k개를 합치고, 같은 항목(고유 번호·제목으로 판단)은 한 번만 묻습니다.",
    why: "TREC 의 풀링 방식입니다. 같은 항목에 시스템마다 다른 점수가 붙는 일을 막고, 호출 수도 줄입니다. 이상적인 순서(nDCG 의 분모)도 이 풀로 만듭니다.",
    refs: [1, 2],
  },
  {
    area: "판정 프롬프트",
    title: "공용 루브릭은 고정, 검색 목적·조건만 덧붙인다 (고급 설정에서 원문 수정 가능)",
    what: "관련도 척도·판정 절차·원칙은 앱이 정한 공용 루브릭을 쓰고, 평가 기준의 ‘검색 목적’과 ‘추가 조건’이 그 안에 들어갑니다. 필요하면 평가 기준의 고급 설정에서 원문(시스템·항목 판정·목록 비교)을 직접 고칠 수 있습니다.",
    why: "Bing 연구는 판정 지시에 ‘사용자가 무엇을 원하는지’ 설명을 넣으면 사람과의 일치가 높아짐을 보였습니다. 반면 척도·원칙까지 매번 바뀌면 평가끼리 비교할 수 없으므로 기본은 고정합니다. 도메인 특성상 원문을 바꿔야 할 때를 위해 고급 설정을 열어 두되, 바꾼 뒤에는 사람 검수로 일치도를 다시 확인하도록 안내합니다.",
    refs: [3, 4],
    alt: "UMBRELA 원문을 그대로 쓰는 방법도 검토했지만, 영어 원문을 그대로 쓰면 한국어 데이터에서 의미가 어긋나고 사내 조건을 넣을 자리가 없어 한국어로 같은 절차를 다시 썼습니다.",
  },
  {
    area: "판정 프롬프트",
    title: "의도 파악 → 일치도·신뢰도 → 등급, 근거를 등급보다 먼저",
    what: "판정 모델에게 질의 의도를 먼저 파악하고, 항목이 의도를 얼마나 충족하는지(일치도)와 근거가 항목 안에 있는지(신뢰도)를 본 뒤 등급을 고르게 합니다. 출력도 근거 → 등급 순서입니다.",
    why: "Bing·UMBRELA 의 측면별 판정(M·T → O)과 G-Eval 의 단계 제시가 즉흥 판정을 줄이고 사람과의 일치를 높였습니다. 근거가 남으므로 사람이 판정을 검토할 수도 있습니다.",
    refs: [3, 4, 8],
  },
  {
    area: "판정 프롬프트",
    title: "묶음 판정(기본 12개)과 1개씩 판정 중 고른다",
    what: "한 번의 판정 호출에 넣는 항목 수를 평가마다 고릅니다. 기본은 12개씩 묶음이고, 1개씩(정확도 우선)·4·8·20개를 고를 수 있습니다. 묶기 전에 항목 순서를 섞습니다.",
    why: "표준(UMBRELA)은 항목마다 따로 묻지만, 케이스당 10~20번 호출이 필요해 대량 평가에는 비용·시간이 큽니다. 묶음은 호출을 크게 줄이는 대신 함께 본 항목이 기준점이 될 수 있어, 순서를 섞어 특정 API 결과가 늘 앞에 오지 않게 했습니다. 결론용 평가에서는 1개씩을 권장합니다.",
    refs: [4, 7],
  },
  {
    area: "보조 판정",
    title: "두 목록을 통째로 비교하되, A·B 순서를 바꿔 두 번 묻는다",
    what: "후보와 기준의 상위 목록을 함께 보여 주고 어느 쪽이 더 유용한지 묻습니다. 순서를 바꿔 다시 묻고, 두 답이 엇갈리면 무승부로 처리합니다.",
    why: "LLM 판정은 먼저(또는 나중에) 보인 쪽을 선호하는 위치 편향이 알려져 있습니다. 순서를 바꿔 두 번 묻는 것이 표준 보정이고, 엇갈린 비율(순서 불일치)은 판정이 흔들린다는 신호로 따로 보여 줍니다.",
    refs: [6, 7],
  },
  {
    area: "지표",
    title: "nDCG@k 를 주 지표로, Hit@1·MRR·P@k 를 함께",
    what: "등급과 순위를 함께 반영하는 nDCG 로 순위 품질을 보고, 1위만 쓰는 에이전트를 위해 Hit@1 을 따로 봅니다.",
    why: "nDCG 는 등급 관련도를 쓰는 검색 평가의 표준 지표입니다. 결론은 같은 케이스끼리 짝지은 nDCG 차이로 냅니다(시스템 간 질의 난이도 차이를 상쇄). 호출 실패는 사용자가 아무것도 받지 못했으므로 0점으로 계산하고 실패율을 따로 보고합니다.",
    refs: [2, 1],
  },
  {
    area: "통계",
    title: "신뢰구간 + 순열 검정 + 효과 크기 + 다중 비교 보정",
    what: "nDCG 차이의 부트스트랩 95% 신뢰구간으로 결론을 내고, 순열(무작위화) 검정 p, 효과 크기 d_z, 필요한 케이스 수, 승률의 윌슨 구간을 함께 보여 줍니다. 후보가 여럿이면 Holm 보정 p 로 결론을 한 번 더 거릅니다.",
    why: "IR 연구에서 대응 무작위화 검정이 가장 권장되고(부호 검정은 크기를 버림), p 값만으로는 크기를 알 수 없어 효과 크기·신뢰구간을 함께 보고하는 것이 권고입니다. 후보를 여러 개 비교하면 하나쯤 우연히 ‘개선’으로 보일 확률이 커지므로 보정합니다. 케이스 10건 미만이면 결론을 보류합니다.",
    refs: [13, 14, 15, 16, 17, 20],
    alt: "대응 t 검정도 흔히 쓰지만 nDCG 차이는 정규분포를 따르지 않는 경우가 많아, 분포 가정이 없는 순열 검정과 부트스트랩을 택했습니다.",
  },
  {
    area: "사람 판정",
    title: "LLM 판정만으로도 결과를 내고, 사람이 검수하면 ‘결합’·‘사람’ 점수와 일치도를 더한다",
    what: "사람 검수 탭에서 항목 등급과 목록 선호를 매기면, ① LLM 점수 ② 사람 점수(사람이 모든 항목을 채점한 케이스) ③ 결합 점수(항목마다 사람 등급이 있으면 사람 것, 없으면 LLM 것)를 바꿔 볼 수 있고, LLM–사람 일치도(가중 카파·관련/비관련 카파·완전 일치율·LLM 이 후한 정도)를 보여 줍니다. 검수 중에는 LLM 판정을 숨기는 것이 기본입니다.",
    why: "LLM 판정은 시스템 간 상대 비교에는 사람 판정과 상관이 높지만, 도메인마다 맞는지 확인 없이 정답처럼 쓰는 것은 비판받습니다. 표준적인 대응은 일부를 사람이 판정해 일치도를 보고하는 것입니다. 결합 점수는 사람이 고친 판정을 그대로 반영하므로 검수할수록 사람 기준에 가까워집니다. 사람이 LLM 판정을 먼저 보면 끌려가므로(앵커링) 숨김이 기본입니다. 검수 순서는 무작위여야 일치도가 전체를 대표합니다.",
    refs: [3, 9, 10, 11, 18, 19, 5],
    alt: "소수의 사람 판정으로 LLM 판정의 치우침을 통계적으로 보정하는 방법(PPI, ARES)도 있습니다. 지금은 결합 점수와 일치도로 판단하게 하고, 이후 확장 후보로 둡니다.",
  },
];

function Ref({ ids }: { ids: number[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((i) => <a key={i} href={`#ref-${i}`} className="num rounded-md bg-subtle px-1.5 py-0.5 text-[11.5px] font-semibold text-muted hover:text-accent">[{i}]</a>)}
    </span>
  );
}

export function RationaleSections() {
  const areas = [...new Set(DECISIONS.map((d) => d.area))];
  return (
    <>
      <Section title="왜 이렇게 만들었나 — 설계 근거" description="각 결정의 내용, 그렇게 한 이유, 참고한 연구, 검토했지만 택하지 않은 대안입니다. 대괄호 번호는 아래 참고 문헌입니다.">
        <div className="space-y-10">
          {areas.map((area) => (
            <div key={area}>
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-accent">
                {area === "통계" ? <FlaskConical className="h-4 w-4" /> : area === "사람 판정" ? <Scale className="h-4 w-4" /> : <BookMarked className="h-4 w-4" />}
                {area}
              </div>
              <div className="divide-y divide-line border-y border-line">
                {DECISIONS.filter((d) => d.area === area).map((d) => (
                  <div key={d.title} className="grid gap-x-8 gap-y-3 py-6 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                    <div>
                      <div className="break-keep text-[15.5px] font-bold leading-snug">{d.title}</div>
                      <div className="mt-2"><Ref ids={d.refs} /></div>
                    </div>
                    <dl className="space-y-2.5 break-keep text-[14px] leading-relaxed lg:border-l lg:border-line lg:pl-8">
                      <div><dt className="mb-0.5 text-[12px] font-semibold text-faint">무엇을</dt><dd className="text-ink/85">{d.what}</dd></div>
                      <div><dt className="mb-0.5 text-[12px] font-semibold text-faint">왜</dt><dd className="text-ink/85">{d.why}</dd></div>
                      {d.alt && <div><dt className="mb-0.5 text-[12px] font-semibold text-faint">검토한 대안</dt><dd className="text-muted">{d.alt}</dd></div>}
                    </dl>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="알려진 한계" description="LLM 판정에 대해 연구에서 지적된 약점과, 이 도구에서 어떻게 다루는지입니다.">
        <div className="grid gap-x-10 md:grid-cols-2">
          {[
            { t: "LLM 은 사람보다 후하게 준다", b: "등급이 전반적으로 높게 나오는 경향이 있습니다. 두 시스템에 같은 방향으로 작용해 차이 비교에는 영향이 작지만, ‘Hit@1 90%’ 같은 절대값은 과대평가일 수 있습니다. 사람 검수의 ‘LLM 이 후한 정도’로 확인하세요.", r: [9, 10, 23] },
            { t: "순환 편향", b: "평가 대상(TOBE)이 판정 모델과 같은 계열의 LLM 으로 순위를 매기면 판정이 그쪽에 유리할 수 있습니다. 이런 경우 다른 계열의 판정 모델을 쓰거나 사람 검수 비중을 높이세요.", r: [10, 11] },
            { t: "키워드·지시문에 속을 수 있다", b: "항목 본문에 질의 단어를 채우거나 지시문을 넣으면 ‘관련’으로 판정되는 사례가 보고됐습니다. 사내 데이터에서는 위험이 낮지만, 외부 데이터라면 사람 검수로 확인하세요.", r: [12] },
            { t: "프롬프트·모델이 바뀌면 점수도 바뀐다", b: "판정 모델 버전이나 프롬프트(고급 설정)를 바꾸면 같은 데이터라도 점수가 달라질 수 있습니다. 실행마다 당시 설정을 사본으로 남기니, 비교는 같은 설정의 실행끼리 하세요.", r: [23] },
          ].map((x) => (
            <div key={x.t} className="border-t border-line py-5">
              <div className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-4 w-4 text-warn" />{x.t}</div>
              <p className="mt-1.5 break-keep text-[13.5px] leading-relaxed text-muted">{x.b}</p>
              <div className="mt-2"><Ref ids={x.r} /></div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="참고 문헌">
        <ol className="divide-y divide-line border-y border-line">
          {REFS.map((r) => (
            <li key={r.id} id={`ref-${r.id}`} className="grid scroll-mt-24 gap-x-4 gap-y-1 py-3 text-[13.5px] sm:grid-cols-[40px_minmax(0,1fr)]">
              <span className="num font-semibold text-faint">[{r.id}]</span>
              <div className="min-w-0">
                <div className="break-words text-ink/90">{r.text}</div>
                <div className="mt-0.5 text-[12.5px] text-muted"><Badge tone="outline">쓰인 곳</Badge> {r.note}</div>
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
