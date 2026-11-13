import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BarChart3, Bot, Check, ChevronDown, Compass, FlaskConical, Layers, ListChecks, PlayCircle, Plug, Scale, ShieldCheck, Table2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/ui/page";
import { Alert, Badge, Button, Code, Kbd, Progress } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import type { Overview as OverviewData } from "@/lib/types";

type Done = Record<string, boolean>;

const PHASES = [
  { id: "connect", n: 1, title: "연결", desc: "판정 모델과 비교할 검색 API 를 등록합니다.", icon: <Plug className="h-5 w-5" />, keys: ["judge_model", "targets"] },
  { id: "compose", n: 2, title: "평가 구성", desc: "무엇을 좋은 결과로 볼지, 어떤 API 끼리 견줄지 정합니다.", icon: <Layers className="h-5 w-5" />, keys: ["criteria", "suite", "dataset"] },
  { id: "evaluate", n: 3, title: "평가", desc: "결과를 눈으로 확인하고, 여러 입력으로 판정합니다.", icon: <PlayCircle className="h-5 w-5" />, keys: ["run"] },
  { id: "read", n: 4, title: "결과 읽기", desc: "결론·지표·근거를 읽고 공유합니다.", icon: <BarChart3 className="h-5 w-5" />, keys: [] },
];

function StepCard({ id, n, title, done, to, cta, icon, children, optional }: {
  id: string; n: string; title: string; done?: boolean; to?: string; cta?: string; icon: ReactNode; children: ReactNode; optional?: boolean;
}) {
  return (
    <div id={id} className="grid scroll-mt-24 gap-x-6 gap-y-3 border-t border-line py-8 md:grid-cols-[56px_1fr]">
      <div className="flex items-start gap-3 md:block">
        <span className={cn("flex h-11 w-11 items-center justify-center rounded-2xl transition-colors", done ? "bg-good-soft text-good" : "bg-accent-soft text-accent")}>
          {done ? <Check className="animate-check h-5 w-5" /> : icon}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-[12.5px] font-semibold text-faint">{n}</span>
          <h3 className="text-[18px] font-bold tracking-tight">{title}</h3>
          {optional && <Badge tone="outline">선택</Badge>}
          {done && <Badge tone="good">완료</Badge>}
        </div>
        <div className="mt-3 max-w-3xl space-y-3 break-keep text-[14.5px] leading-relaxed text-ink/80">{children}</div>
        {to && (
          <Link to={to} className="mt-5 inline-block">
            <Button variant={done ? "secondary" : "primary"} size="sm">{cta ?? "열기"}<ArrowRight className="h-3.5 w-3.5" /></Button>
          </Link>
        )}
      </div>
    </div>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3">
          <span className="num mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-subtle text-[11px] font-semibold text-muted">{i + 1}</span>
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ol>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-4 py-4 text-left text-[15px] font-semibold" aria-expanded={open}>
        {q}
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform duration-300", open && "rotate-180")} />
      </button>
      <div className={cn("grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <div className="max-w-3xl break-keep pb-5 text-[14px] leading-relaxed text-muted">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** 목차: 화면에 보이는 단계를 강조한다. */
function useActive(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [ids.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

export default function GettingStarted() {
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => api.get<OverviewData>("/overview") });
  const done: Done = Object.fromEntries((data?.onboarding ?? []).map((o) => [o.key, o.done]));
  const total = data?.onboarding.length ?? 6;
  const finished = (data?.onboarding ?? []).filter((o) => o.done).length;
  const ids = PHASES.map((p) => p.id).concat(["example", "faq"]);
  const active = useActive(ids);
  const phaseDone = (keys: string[]) => keys.length > 0 && keys.every((k) => done[k] || k === "dataset");

  return (
    <>
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><Compass className="h-3.5 w-3.5" />도움말 · 시작 가이드</span>}
        title="처음 사용하는 분을 위한 시작 가이드"
        description="연결 → 평가 구성 → 평가 → 결과 읽기, 네 단계를 순서대로 따라 하면 첫 결과를 볼 수 있습니다. 각 단계의 버튼을 누르면 해당 화면으로 바로 이동하고, 끝낸 단계에는 자동으로 완료 표시가 붙습니다."
        actions={<Link to="/guide"><Button variant="ghost" size="sm">채점·지표 설명 (평가 방법) →</Button></Link>}
      />

      {/* 진행 현황 */}
      <div className="mb-12 border-y border-line py-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[15px] font-semibold">내 진행 상황</div>
          <div className="num text-[13px] text-muted">{finished}/{total} 완료</div>
        </div>
        <Progress value={finished} max={total} className="h-2" tone={finished === total ? "good" : "accent"} />
        <div className="stagger mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PHASES.map((p) => {
            const ok = phaseDone(p.keys);
            return (
              <a key={p.id} href={`#${p.id}`} className="lift group rounded-2xl border border-line bg-panel/70 p-4">
                <div className="flex items-center justify-between">
                  <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", ok ? "bg-good-soft text-good" : "bg-subtle text-muted group-hover:text-accent")}>{ok ? <Check className="h-4 w-4" /> : p.icon}</span>
                  <span className="num text-[12px] font-semibold text-faint">STEP {p.n}</span>
                </div>
                <div className="mt-3 font-semibold">{p.title}</div>
                <div className="mt-1 break-keep text-[12.5px] leading-relaxed text-muted">{p.desc}</div>
              </a>
            );
          })}
        </div>
      </div>

      <div className="grid gap-x-12 lg:grid-cols-[180px_minmax(0,1fr)]">
        {/* 목차 */}
        <nav className="hidden lg:block">
          <div className="sticky top-24 space-y-1 text-[13.5px]">
            <div className="mb-2 text-[12px] font-medium text-faint">목차</div>
            {[...PHASES.map((p) => ({ id: p.id, label: `${p.n}. ${p.title}` })), { id: "example", label: "예시 따라 하기" }, { id: "faq", label: "자주 묻는 질문" }].map((x) => (
              <a key={x.id} href={`#${x.id}`} className={cn("block rounded-lg border-l-2 px-3 py-1.5 transition-colors", active === x.id ? "border-accent font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}>
                {x.label}
              </a>
            ))}
          </div>
        </nav>

        <div className="min-w-0">
          {/* 1. 연결 */}
          <section id="connect" className="scroll-mt-24 pb-10">
            <PhaseTitle n={1} title="연결" desc="평가에 쓸 두 가지를 연결합니다: 채점을 맡을 판정 모델(LLM), 그리고 비교할 검색 API 들." />
            <StepCard id="step-judge" n="1-1" title="판정 모델 연결" icon={<Bot className="h-5 w-5" />} done={done.judge_model} to="/settings/models" cta="판정 모델 화면 열기">
              <Bullets items={[
                <>공급자를 고릅니다 — Vertex AI, Gemini, Claude(Anthropic), OpenAI, 사내 OpenAI 호환 서버.</>,
                <>모델 이름과 API 키를 넣습니다. 키는 암호화해 저장하고, 서버 <Kbd>.env</Kbd> 에 둔 키가 있으면 그쪽이 우선합니다.</>,
                <><b>연결 테스트</b>를 눌러 통과하면 준비 끝. 하나를 <b>기본</b>으로 지정해 두면 평가 때 자동으로 골라집니다.</>,
              ]} />
              <Alert tone="accent">결론을 낼 평가에는 성능 좋은 모델을, 설정을 맞춰 보는 시험 평가에는 저렴한 모델을 권장합니다.</Alert>
            </StepCard>
            <StepCard id="step-api" n="1-2" title="검색 API 연결 (2개 이상)" icon={<Plug className="h-5 w-5" />} done={done.targets} to="/settings/targets" cta="검색 API 화면 열기">
              <p>지금 쓰는 API(ASIS)와 새 API(TOBE)를 각각 연결합니다. 문서가 없어도 <b>예시 요청 하나</b>만 있으면 됩니다.</p>
              <Bullets items={[
                <><b>요청 보내 보기</b> — 브라우저 주소, API 문서 예시, <Kbd>curl</Kbd> 명령 중 아무거나 붙여넣으면 바로 한 번 호출해 실제 응답을 보여 줍니다.</>,
                <><b>입력 방식</b> — 요청의 값마다 <b>바뀌는 값</b>(검색어처럼 매번 달라짐) / <b>고정 값</b> / <b>빼기</b>를 고릅니다. 바뀌는 값에는 화면에 보일 이름과 <b>필수 여부</b>를 정합니다. API 마다 받는 값이 달라도 괜찮습니다(예: A 는 <Kbd>q</Kbd>+<Kbd>keywords</Kbd>, B 는 <Kbd>q</Kbd>+<Kbd>cat</Kbd>).</>,
                <><b>결과에서 고르기</b> — 응답의 결과 목록에서 <b>제목</b>, 판정 모델에 보낼 <b>내용</b>, 같은 결과를 알아볼 <b>고유 번호</b>를 실제 값을 보며 고릅니다. 개인정보로 보이는 필드는 자동으로 빠집니다.</>,
                <><b>저장</b> — 이름을 붙여 저장합니다. 비교할 API 마다 반복하세요.</>,
              ]} />
            </StepCard>
          </section>

          {/* 2. 평가 구성 */}
          <section id="compose" className="scroll-mt-24 pb-10">
            <PhaseTitle n={2} title="평가 구성" desc="‘무엇이 좋은 결과인가’와 ‘누구와 누구를 견줄 것인가’를 정합니다." />
            <StepCard id="step-criteria" n="2-1" title="평가 기준 만들기" icon={<Scale className="h-5 w-5" />} done={done.criteria} to="/settings/criteria" cta="평가 기준 화면 열기">
              <Bullets items={[
                <><b>무엇을 찾는 검색인가요?</b> — 사람·조직·문서·상품 등 목적을 고르면 판정 모델에게 줄 설명이 채워집니다. 우리 서비스에 맞게 고쳐 쓰세요.</>,
                <><b>얼마나 엄격하게?</b> — 느슨하게 / 보통(권장) / 엄격하게.</>,
                <><b>상위 몇 개까지?</b> — 실제 화면·에이전트가 보여 주는 결과 수와 맞춥니다.</>,
                <><b>추가 조건</b> — ‘퇴사자가 1위면 0점’처럼 판단 가능한 문장으로 적습니다.</>,
              ]} />
              <p className="text-muted">후보 API 마다 다른 기준을 쓸 수 있으니, 필요한 만큼 여러 개 만들어 두세요.</p>
            </StepCard>
            <StepCard id="step-suite" n="2-2" title="비교 세트 만들기" icon={<Layers className="h-5 w-5" />} done={done.suite} to="/settings/suites" cta="비교 세트 화면 열기">
              <Bullets items={[
                <><b>API 고르기</b> — 기준(보통 ASIS) 하나와 비교할 후보를 고르고, <b>후보마다 평가 기준</b>을 정합니다.</>,
                <><b>입력 맞추기</b> — API 설정을 보고 입력을 자동으로 나눕니다. 여러 API 가 같이 쓰는 값은 <b>공통</b>, 한 API 만 받는 값은 <b>그 API 전용</b>입니다. 형식이 다르면(목록↔문장, 문자↔숫자) 변환도 골라 둡니다.</>,
                <><b>결과 맞추기</b> — 두 API 결과 중 ‘같은 결과’를 알아보는 기준(고유 번호 / 제목)을 정합니다. ID 형식이 다르면 앞·뒷부분 지우기 등으로 맞춥니다.</>,
                <><b>확인해 보기</b> — 실제로 한 번 불러 API 별로 보낸 값과 겹치는 결과를 확인한 뒤 저장합니다.</>,
              ]} />
            </StepCard>
            <StepCard id="step-data" n="2-3" title="테스트 데이터 준비" optional icon={<Table2 className="h-5 w-5" />} done={done.dataset} to="/datasets" cta="테스트 데이터 화면 열기">
              <p>평가 화면에서 바로 붙여넣어도 되지만, 반복해서 쓸 입력 모음은 파일(CSV·엑셀·JSONL)로 올려 두면 편합니다. 첫 줄은 열 이름입니다.</p>
              <Code>{`case_id,category,q,ASIS__keywords,TOBE__cat,expected
C01,인사,학자금 신청 담당자,학자금 교육비,인사,학자금 담당
C02,재무,법인카드 분실 재발급,법인카드,재무,카드 담당`}</Code>
              <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-muted">
                <li>공통 입력은 키 그대로(<Kbd>q</Kbd>), API 전용 입력은 <Kbd>TOBE__cat</Kbd> 처럼 API 이름이 앞에 붙은 키나 보이는 이름(<Kbd>분류</Kbd>)으로 씁니다.</li>
                <li><Kbd>case_id</Kbd>(이름), <Kbd>category</Kbd>(분류별 분석), <Kbd>expected</Kbd>(기대 정답 힌트)는 선택입니다.</li>
              </ul>
            </StepCard>
          </section>

          {/* 3. 평가 */}
          <section id="evaluate" className="scroll-mt-24 pb-10">
            <PhaseTitle n={3} title="평가" desc="먼저 눈으로 확인하고, 그다음 여러 입력으로 판정합니다." />
            <StepCard id="step-compare" n="3-1" title="단건 검색 비교로 먼저 확인" icon={<FlaskConical className="h-5 w-5" />} to="/compare" cta="단건 검색 비교 열기">
              <p>입력 하나를 공통·API 전용 칸에 넣고 <b>결과 보기</b>를 누르면 모든 API 결과가 나란히 나옵니다. 채점은 하지 않으며, 겹치는 결과·순위 변화·응답 시간을 바로 볼 수 있습니다. 결과가 이상하면 이 단계에서 API 설정을 고치세요.</p>
            </StepCard>
            <StepCard id="step-run" n="3-2" title="평가 실행" icon={<ListChecks className="h-5 w-5" />} done={done.run} to="/runs/new" cta="평가 시작">
              <Bullets items={[
                <><b>무엇을 비교할까요</b> — 비교 세트를 고릅니다.</>,
                <><b>테스트 입력</b> — 직접 붙여넣기 / 파일 올리기 / 저장된 데이터 중 하나.</>,
                <><b>입력 검증</b> — 실행 전에 모든 행을 검사합니다. 필수 값이 빠진 행은 이유와 함께 보여 주고, <b>고친 뒤 다시 검사</b>하거나 <b>실패한 행은 빼고 실행</b>할 수 있습니다.</>,
                <><b>판정 방법</b> — 후보마다 평가 기준, 판정 모델, 동시 처리 수. 처음엔 ‘일부만 먼저 해 보기’로 5~10건만 돌려 보세요.</>,
                <><b>확인하고 시작</b> — 예상 호출 수를 보고 시작합니다.</>,
              ]} />
              <Alert tone="good" icon={<ShieldCheck className="h-4 w-4" />}>실행은 서버에서 진행됩니다. 브라우저를 닫아도 계속되고, 왼쪽 아래에서 진행률을 볼 수 있으며 끝나면 알림이 뜹니다.</Alert>
            </StepCard>
          </section>

          {/* 4. 결과 읽기 */}
          <section id="read" className="scroll-mt-24 pb-10">
            <PhaseTitle n={4} title="결과 읽기" desc="결론부터 보고, 근거로 내려가며 확인합니다." />
            <StepCard id="step-read" n="4-1" title="결론 → 지표 → 근거" icon={<BarChart3 className="h-5 w-5" />} to="/guide" cta="채점·지표 자세히 보기">
              <Bullets items={[
                <><b>결론</b> — 개선 / 저하 / 차이 없음 / 판단 보류. 95% 신뢰구간이 0을 넘어야 ‘개선’입니다.</>,
                <><b>핵심 지표</b> — nDCG 차이, 목록 비교 승률, Hit@1. 같은 방향인지 확인합니다.</>,
                <><b>‘기준 승’ 케이스</b> — 나빠진 질의를 열어 판정 근거가 타당한지 봅니다.</>,
                <><b>내보내기</b> — 엑셀·CSV·JSON 으로 공유합니다.</>,
              ]} />
            </StepCard>
          </section>

          {/* 예시 */}
          <section id="example" className="scroll-mt-24 border-t border-line pb-10 pt-10">
            <h2 className="text-[22px] font-bold tracking-tight">예시 따라 하기 — 입력이 다른 두 API</h2>
            <p className="mt-2 max-w-3xl break-keep text-[14.5px] leading-relaxed text-muted">A(ASIS)는 <Kbd>q</Kbd>+<Kbd>keywords</Kbd>, B(TOBE)는 <Kbd>q</Kbd>+<Kbd>cat</Kbd>(필수)를 받는 경우입니다.</p>
            <div className="stagger mt-6 grid gap-3 md:grid-cols-3">
              {[
                ["API 설정", "A: q·keywords 를 바뀌는 값으로. B: q·cat 을 바뀌는 값으로, cat 은 ‘필수 여부’ 체크."],
                ["비교 세트", "자동으로 q = 공통, keywords = A 전용, cat = B 전용(필수)으로 나뉩니다. 후보 B 에 평가 기준을 고릅니다."],
                ["평가", "테스트 데이터에 q, A__keywords, B__cat 열을 둡니다. cat 이 빈 행은 입력 검증에서 걸러집니다."],
              ].map(([t, b], i) => (
                <div key={t} className="rounded-2xl border border-line bg-panel/70 p-5">
                  <div className="num text-[12px] font-semibold text-accent">0{i + 1}</div>
                  <div className="mt-1.5 font-semibold">{t}</div>
                  <p className="mt-1.5 break-keep text-[13.5px] leading-relaxed text-muted">{b}</p>
                </div>
              ))}
            </div>
          </section>

          {/* FAQ */}
          <section id="faq" className="scroll-mt-24 pt-6">
            <h2 className="mb-3 text-[22px] font-bold tracking-tight">자주 묻는 질문</h2>
            <Faq q="몇 건으로 평가해야 믿을 만한가요?">10건 미만이면 결론을 보류합니다. 변경이 영향을 주는 질의와 평소 질의를 섞어 30~100건을 권장합니다.</Faq>
            <Faq q="후보마다 다른 평가 기준을 써도 되나요?">네. 비교 세트에서 후보마다 기준을 고를 수 있고, 평가의 ‘판정 방법’ 단계에서 실행마다 바꿀 수도 있습니다. 각 후보는 자기 기준으로 기준 API 와 견줍니다.</Faq>
            <Faq q="API 키는 어디에 저장되나요?">서버의 <Kbd>data/</Kbd> 폴더(SQLite)에 암호화해 저장하며, 화면·내보내기에는 끝 4자리만 보입니다. 데이터는 git 에 올라가지 않습니다.</Faq>
            <Faq q="평가 중에 브라우저를 닫으면 어떻게 되나요?">서버에서 계속 진행됩니다. 서버가 재시작되면 ‘중단됨’으로 표시되고, ‘이어서 실행’으로 남은 케이스만 처리합니다. 이미 받은 응답과 판정은 다시 묻지 않습니다.</Faq>
            <Faq q="어디서든 빨리 이동하려면?"><Kbd>⌘K</Kbd>(Windows 는 <Kbd>Ctrl+K</Kbd>)를 누르면 화면 이동·작업 검색 창이 열립니다.</Faq>
          </section>
        </div>
      </div>
    </>
  );
}

function PhaseTitle({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <div className="mb-2 flex items-start gap-4 pt-2">
      <span className="num flex h-9 shrink-0 items-center rounded-full bg-ink px-3.5 text-[13px] font-bold text-panel">STEP {n}</span>
      <div className="min-w-0">
        <h2 className="text-[24px] font-bold leading-tight tracking-tight">{title}</h2>
        <p className="mt-1 break-keep text-[14.5px] text-muted">{desc}</p>
      </div>
    </div>
  );
}
