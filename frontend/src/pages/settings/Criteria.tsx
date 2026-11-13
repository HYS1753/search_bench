import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NextStep } from "@/components/onboarding/NextStep";
import { AlertTriangle, Building2, ChevronDown, Copy, FileText, Lock, Package, Pencil, PenLine, Plus, RotateCcw, Scale, Search, SlidersHorizontal, Trash2, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, Drawer, useConfirm } from "@/components/ui/overlay";
import { ChoiceList, FormRow, PageHeader, Rows, Section, Segmented } from "@/components/ui/page";
import { Alert, Badge, Button, Code, Empty, Input, Spinner, Switch, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { Criteria } from "@/lib/types";

export const PURPOSES = {
  general: {
    title: "일반 검색",
    desc: "입력에 가장 잘 맞는 결과를 찾는 검색",
    icon: <Search className="h-4 w-4" />,
    text: "사용자의 입력에 가장 직접적으로 답하는 결과를 찾는 검색이다.\n- 입력이 요구하는 내용과 조건을 결과가 직접 충족하면 관련도가 높다.\n- 단어만 겹치고 요구를 충족하지 못하면 '약간 관련' 이하로 본다.",
  },
  person: {
    title: "사람 찾기",
    desc: "조건에 맞는 사람·담당자를 찾는 검색",
    icon: <UserRound className="h-4 w-4" />,
    text: "입력한 조건(업무·역할·전문 분야 등)에 맞는 사람을 찾는 검색이다.\n- 그 사람의 역할·업무 설명이 입력 조건과 직접 일치하면 관련도가 높다.\n- 같은 소속이어도 다른 일을 맡은 사람은 관련도가 낮다.",
  },
  org: {
    title: "조직·창구 찾기",
    desc: "문의를 처리하는 부서·창구를 찾는 검색",
    icon: <Building2 className="h-4 w-4" />,
    text: "입력한 문의·문제를 처리하는 조직(부서·창구)을 찾는 검색이다.\n- 조직의 업무 설명이 입력을 직접 담당하면 관련도가 높다.\n- 넘겨줄 수만 있는 상위·인접 조직은 '약간 관련' 이하로 본다.",
  },
  doc: {
    title: "문서·규정·FAQ 찾기",
    desc: "질문에 답하는 근거 문서를 찾는 검색",
    icon: <FileText className="h-4 w-4" />,
    text: "사내 규정·매뉴얼·FAQ 에서 질문에 답하는 근거 문서를 찾는 검색이다.\n- 질문에 대한 답(조건·절차·수치)이 본문에 직접 있으면 관련도가 높다.\n- 주제만 같고 답이 없으면 '약간 관련' 이하로 본다.",
  },
  product: {
    title: "상품 찾기",
    desc: "조건에 맞는 상품을 찾는 검색",
    icon: <Package className="h-4 w-4" />,
    text: "고객이 원하는 조건에 맞는 상품을 찾는 검색이다.\n- 질문의 조건(종류·용도·가격대·사양)을 모두 만족하면 관련도가 높다.\n- 종류는 같지만 핵심 조건을 어기면 '약간 관련' 이하로 본다.",
  },
  custom: { title: "직접 쓰기", desc: "검색 목적을 직접 설명합니다", icon: <PenLine className="h-4 w-4" />, text: "" },
} as const;
type Purpose = keyof typeof PURPOSES;

const STRICTNESS = [
  { value: 1, title: "느슨하게", desc: "주제만 맞아도(‘약간 관련’ 이상) 정답으로 셉니다. 넓게 찾는 검색에 적합." },
  { value: 2, title: "보통 (권장)", desc: "실제로 도움이 되는 결과(‘관련’ 이상)만 정답으로 셉니다." },
  { value: 3, title: "엄격하게", desc: "질문에 바로 답하는 결과(‘매우 관련’)만 정답으로 셉니다." },
];
export const STRICT_LABEL: Record<number, string> = { 1: "느슨", 2: "보통", 3: "엄격" };

const SUGGESTIONS = [
  "삭제·만료·비활성 상태로 보이는 결과는 무관(0)으로 판정한다.",
  "입력에 조건(지역·기간·종류 등)이 있으면 그 조건을 어긴 결과는 '약간 관련' 이하로 본다.",
  "같은 결과가 여러 번 나오면 두 번째부터는 무관(0)으로 판정한다.",
  "더 최신 정보를 담은 결과를 더 관련 있다고 본다.",
];

interface Form {
  id?: number;
  name: string;
  description: string;
  purpose: Purpose;
  task_context: string;
  rules: string[];
  k: number;
  relevant_threshold: number;
  pairwise_enabled: boolean;
  // 고급 설정: 빈 문자열 = 기본 프롬프트
  system_prompt: string;
  item_template: string;
  pairwise_template: string;
}
type PromptKind = "system_prompt" | "item_template" | "pairwise_template";
const PROMPT_META: Record<PromptKind, { title: string; desc: string }> = {
  system_prompt: { title: "시스템 프롬프트", desc: "모든 판정 호출 맨 앞에 붙는 역할 설명입니다. 자리 표시자는 쓸 수 없습니다." },
  item_template: { title: "항목 판정 프롬프트", desc: "항목마다 0~3 등급을 매기게 하는 본문입니다. {query_block}·{items_block} 은 꼭 있어야 합니다." },
  pairwise_template: { title: "목록 비교 프롬프트", desc: "두 목록 중 더 유용한 쪽을 고르게 하는 본문입니다. {query_block}·{a_block}·{b_block} 은 꼭 있어야 합니다." },
};
interface PromptDefaults {
  defaults: Record<PromptKind, string>;
  placeholders: Record<PromptKind, { allowed: Record<string, string>; required: string[] }>;
}

function detectPurpose(text: string): Purpose {
  const hit = (Object.keys(PURPOSES) as Purpose[]).find((p) => p !== "custom" && PURPOSES[p].text === text.trim());
  return hit ?? (text.trim() ? "custom" : "general");
}

function toForm(c?: Criteria): Form {
  if (!c) return { name: "", description: "", purpose: "general", task_context: PURPOSES.general.text, rules: [], k: 5, relevant_threshold: 2, pairwise_enabled: true, system_prompt: "", item_template: "", pairwise_template: "" };
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    purpose: detectPurpose(c.task_context),
    task_context: c.task_context,
    rules: c.user_requirements.split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean),
    k: c.k,
    relevant_threshold: c.relevant_threshold,
    pairwise_enabled: c.pairwise_enabled,
    system_prompt: c.system_prompt ?? "",
    item_template: c.item_template ?? "",
    pairwise_template: c.pairwise_template ?? "",
  };
}

interface Preview {
  system: string;
  item: string;
  pairwise: string;
  default_task_context: string;
  errors?: Record<PromptKind, string[]>;
}

/** 고급 설정 — 판정 프롬프트 원문을 보고 직접 고친다. 비워 두면(기본값 사용) 앱의 기본 루브릭을 쓴다. */
function PromptEditor({ kind, value, onChange, defaults, errors }: {
  kind: PromptKind; value: string; onChange: (v: string) => void; defaults?: PromptDefaults; errors?: string[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const custom = value !== "";
  const meta = PROMPT_META[kind];
  const def = defaults?.defaults[kind] ?? "";
  const ph = defaults?.placeholders[kind];
  const insert = (token: string) => {
    const el = ref.current;
    if (!el) return onChange(value + token);
    const { selectionStart: a, selectionEnd: b } = el;
    const next = value.slice(0, a) + token + value.slice(b);
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };
  return (
    <div className="border-t border-line py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14.5px] font-semibold">{meta.title}{custom && <Badge tone="warn">직접 수정</Badge>}</div>
          <div className="mt-0.5 break-keep text-[12.5px] text-muted">{meta.desc}</div>
        </div>
        <div className="flex items-center gap-2">
          {custom && <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => onChange("")}>기본값으로</Button>}
          <Switch checked={custom} onChange={(v) => onChange(v ? def : "")} label={<span className="text-[13px]">{custom ? "직접 수정" : "기본값 사용"}</span>} />
        </div>
      </div>
      {custom ? (
        <>
          <Textarea ref={ref} className="mt-3 font-mono text-[12.5px] leading-relaxed" rows={kind === "system_prompt" ? 4 : 18} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
          {ph && Object.keys(ph.allowed).length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-muted">자리 표시자 넣기</span>
              {Object.entries(ph.allowed).map(([k, d]) => (
                <button key={k} type="button" title={d} onClick={() => insert(`{${k}}`)}
                  className={cn("press rounded-md border px-1.5 py-0.5 font-mono text-[11.5px]", ph.required.includes(k) ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-muted hover:text-ink")}>
                  {`{${k}}`}
                </button>
              ))}
            </div>
          )}
          {!!errors?.length && (
            <Alert tone="bad" className="mt-3" icon={<AlertTriangle className="h-4 w-4" />}>{errors.join("\n")}</Alert>
          )}
        </>
      ) : (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12.5px] text-muted">기본 원문 보기</summary>
          <Code className="mt-2 max-h-[40vh] whitespace-pre-wrap">{def || "불러오는 중…"}</Code>
        </details>
      )}
    </div>
  );
}

function Editor({ initial, onClose }: { initial: Form; onClose: () => void }) {
  const [f, setF] = useState<Form>(initial);
  const [tab, setTab] = useState<"system" | "item" | "pairwise">("item");
  const [debounced, setDebounced] = useState(f);
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(f), 400);
    return () => clearTimeout(t);
  }, [f]);
  const requirements = (form: Form) => form.rules.map((r) => r.trim()).filter(Boolean).map((r) => `- ${r}`).join("\n");
  const preview = useQuery({
    queryKey: ["criteria-preview", debounced.task_context, debounced.rules, debounced.k, debounced.system_prompt, debounced.item_template, debounced.pairwise_template],
    queryFn: () => api.post<Preview>("/criteria/preview", {
      task_context: debounced.task_context, user_requirements: requirements(debounced), k: debounced.k,
      system_prompt: debounced.system_prompt, item_template: debounced.item_template, pairwise_template: debounced.pairwise_template,
    }),
    placeholderData: (p) => p,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        description: f.description,
        task_context: f.task_context,
        user_requirements: requirements(f),
        k: f.k,
        relevant_threshold: f.relevant_threshold,
        pairwise_enabled: f.pairwise_enabled,
        system_prompt: f.system_prompt,
        item_template: f.item_template,
        pairwise_template: f.pairwise_template,
      };
      return f.id ? api.put(`/criteria/${f.id}`, body) : api.post("/criteria", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["criteria"] });
      toast.success("저장했습니다", "다음 평가부터 적용됩니다. 지난 결과는 당시 기준 그대로 남습니다.");
      onClose();
    },
    onError: (e: Error) => toast.error("저장하지 못했습니다", e.message),
  });
  const pickPurpose = (p: Purpose) => setF((x) => ({ ...x, purpose: p, task_context: p === "custom" ? (x.purpose === "custom" ? x.task_context : "") : PURPOSES[p].text }));
  const kOptions = ["1", "3", "5", "10"] as const;
  const defaults = useQuery({ queryKey: ["prompt-defaults"], queryFn: () => api.get<PromptDefaults>("/criteria/prompt-defaults"), staleTime: Infinity });
  const customized = !!(f.system_prompt || f.item_template || f.pairwise_template);
  const [advanced, setAdvanced] = useState(customized);
  const promptErrors = preview.data?.errors;
  const hasErrors = !!promptErrors && Object.values(promptErrors).some((e) => e.length);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-4xl" title={f.id ? `평가 기준 수정 · ${initial.name}` : "평가 기준 만들기"}
      subtitle="판정 모델이 무엇을 ‘좋은 결과’로 볼지 질문에 답하듯 정합니다."
      footer={<><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" disabled={!f.name.trim() || hasErrors} loading={save.isPending} onClick={() => save.mutate()}>저장</Button></>}>
      <Rows>
        <FormRow label="이름" required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="예: 상품 검색 기준" autoFocus={!f.id} />
        </FormRow>
        <FormRow label="무엇을 찾는 검색인가요?" help="고르면 설명이 채워집니다. 우리 서비스에 맞게 고쳐 쓰세요. 무엇이 ‘정답’인지 구체적일수록 판정이 정확합니다.">
          <ChoiceList
            value={f.purpose}
            onChange={pickPurpose}
            columns={2}
            items={(Object.keys(PURPOSES) as Purpose[]).map((p) => ({ value: p, title: PURPOSES[p].title, desc: PURPOSES[p].desc, icon: PURPOSES[p].icon }))}
          />
          <Textarea className="mt-3" rows={5} value={f.task_context} onChange={(e) => setF({ ...f, task_context: e.target.value })}
            placeholder={preview.data?.default_task_context ?? "무엇을 찾는 검색이고, 어떤 결과가 정답인지 적어 주세요."} />
        </FormRow>
        <FormRow label="얼마나 엄격하게 볼까요?" help="Hit@1·MRR 등에서 ‘정답’으로 셀 기준입니다.">
          <ChoiceList value={f.relevant_threshold} onChange={(v) => setF({ ...f, relevant_threshold: v })} items={STRICTNESS} />
        </FormRow>
        <FormRow label="상위 몇 개까지 볼까요?" help="실제 화면이나 에이전트가 사용자에게 보여 주는 결과 수와 맞추세요.">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={kOptions.includes(String(f.k) as (typeof kOptions)[number]) ? String(f.k) : ""} onChange={(v) => v && setF({ ...f, k: Number(v) })}
              items={kOptions.map((v) => ({ value: v, label: `${v}개` }))} />
            <span className="text-[13px] text-muted">직접</span>
            <Input type="number" min={1} max={50} className="h-9 w-20" value={f.k} onChange={(e) => setF({ ...f, k: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
          </div>
        </FormRow>
        <FormRow label="추가로 지킬 조건 (선택)" help="공용 기준에 더해 판정에 꼭 반영할 내용. ‘○○이면 0점’, ‘○○가 1위면 더 좋다’처럼 판단 가능한 문장으로 적으세요.">
          <div className="space-y-2">
            {f.rules.map((r, i) => (
              <div key={i} className="flex gap-2">
                <Input value={r} onChange={(e) => setF({ ...f, rules: f.rules.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="조건을 한 문장으로" />
                <Button size="icon" variant="ghost" onClick={() => setF({ ...f, rules: f.rules.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setF({ ...f, rules: [...f.rules, ""] })}>조건 추가</Button>
          </div>
          <div className="mt-4 text-[12.5px] text-muted">예시를 눌러 추가</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.filter((s) => !f.rules.includes(s)).map((s) => (
              <button key={s} type="button" onClick={() => setF({ ...f, rules: [...f.rules.filter((r) => r.trim()), s] })}
                className="rounded-full border border-line px-3 py-1 text-left text-[12.5px] text-muted hover:border-faint hover:text-ink">+ {s}</button>
            ))}
          </div>
        </FormRow>
        <FormRow label="두 결과 목록도 통째로 비교할까요?" help="항목별 판정에 더해 ‘어느 쪽이 더 유용한지’를 순서를 바꿔 두 번 묻습니다. 결론의 보조 근거가 되고, 끄면 판정 호출이 줄어듭니다.">
          <Switch checked={f.pairwise_enabled} onChange={(v) => setF({ ...f, pairwise_enabled: v })} label={f.pairwise_enabled ? "비교함 (권장)" : "항목별 판정만"} />
        </FormRow>
        <FormRow label="메모"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></FormRow>
      </Rows>
      <div className="mt-8 rounded-2xl border border-line">
        <button type="button" onClick={() => setAdvanced(!advanced)} className="flex w-full items-center gap-3 px-5 py-4 text-left" aria-expanded={advanced}>
          <SlidersHorizontal className="h-4 w-4 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[14.5px] font-semibold">고급 설정 · 판정 프롬프트{customized && <Badge tone="warn">수정됨</Badge>}</span>
            <span className="mt-0.5 block break-keep text-[12.5px] text-muted">기본은 검색 평가 표준(TREC 등급·UMBRELA 절차)을 따른 공용 루브릭이고, 위에서 쓴 검색 목적·추가 조건이 그 안에 들어갑니다. 필요하면 원문을 직접 고칠 수 있습니다.</span>
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform duration-300", advanced && "rotate-180")} />
        </button>
        <div className={cn("grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]", advanced ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
          <div className="overflow-hidden">
            <div className="px-5 pb-5">
              <Alert tone="warn" className="mb-1" icon={<AlertTriangle className="h-4 w-4" />}>
                프롬프트를 바꾸면 이전 평가와 점수를 직접 비교하기 어려워집니다. 바꾼 뒤에는 사람 검수로 일치도를 다시 확인하세요. 지난 실행은 당시 프롬프트 그대로 남습니다.
              </Alert>
              {(Object.keys(PROMPT_META) as PromptKind[]).map((kind) => (
                <PromptEditor key={kind} kind={kind} value={f[kind]} onChange={(v) => setF((x) => ({ ...x, [kind]: v }))}
                  defaults={defaults.data} errors={promptErrors?.[kind]} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <details className="mt-6">
        <summary className="cursor-pointer text-[13.5px] font-medium text-muted"><Lock className="mr-1.5 inline h-3.5 w-3.5" />판정 모델에 실제로 보내는 프롬프트 보기 (조립 결과)</summary>
        <div className="mt-4">
          <Segmented value={tab} onChange={setTab} items={[{ value: "system", label: "시스템" }, { value: "item", label: "항목별 판정" }, { value: "pairwise", label: "목록 비교" }]} />
          <Code className="mt-3 max-h-[60vh] whitespace-pre-wrap">{preview.data ? (hasErrors ? "프롬프트에 오류가 있어 조립할 수 없습니다." : preview.data[tab]) : "불러오는 중…"}</Code>
          <div className="mt-2 text-[12.5px] text-muted">예시 질의·항목으로 조립한 모습입니다.{customized ? " 직접 수정한 프롬프트가 반영되어 있습니다." : " 관련도 척도와 판정 원칙은 기본 공용 루브릭입니다."}</div>
        </div>
      </details>
    </Drawer>
  );
}

export default function CriteriaPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Form | null>(null);
  const list = useQuery({ queryKey: ["criteria"], queryFn: () => api.get<Criteria[]>("/criteria") });
  const dup = async (c: Criteria) => {
    await api.post(`/criteria/${c.id}/duplicate`);
    qc.invalidateQueries({ queryKey: ["criteria"] });
  };
  const remove = async (c: Criteria) => {
    if (!(await confirm.ask({ title: `'${c.name}' 을 삭제할까요?`, body: "이 기준으로 한 평가 결과는 당시 설정 그대로 남습니다.", confirm: "삭제", danger: true }))) return;
    await api.del(`/criteria/${c.id}`).catch((e) => toast.error("삭제하지 못했습니다", e.message));
    qc.invalidateQueries({ queryKey: ["criteria"] });
    qc.invalidateQueries({ queryKey: ["suites"] });
  };
  return (
    <>
      <PageHeader
        eyebrow="평가 구성"
        title="평가 기준"
        description="판정 모델이 무엇을 ‘좋은 결과’로 볼지 정합니다. 검색 종류를 고르고, 필요하면 조건만 덧붙이면 됩니다."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(toForm())}>기준 만들기</Button>}
      />
      <NextStep current="criteria" />
      {list.isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !list.data?.length ? (
        <Empty icon={<Scale className="h-8 w-8" />} title="평가 기준이 없습니다" action={<Button variant="primary" onClick={() => setEditing(toForm())}>기준 만들기</Button>}>
          검색 종류만 골라도 바로 쓸 수 있습니다.
        </Empty>
      ) : (
        <Rows className="mb-14">
          {list.data.map((c) => {
            const purpose = detectPurpose(c.task_context);
            const rules = c.user_requirements.split("\n").filter((l) => l.trim()).length;
            return (
              <div key={c.id} className="flex flex-wrap items-start gap-x-8 gap-y-3 py-5">
                <div className="min-w-0 flex-1 basis-[320px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15.5px] font-semibold">{c.name}</span>
                    <Badge tone="outline">{PURPOSES[purpose].title}</Badge>
                  </div>
                  <p className="mt-1.5 line-clamp-2 whitespace-pre-line text-[13.5px] leading-relaxed text-muted">{c.task_context || "(공용 검색 목적)"}</p>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <Badge>상위 {c.k}개</Badge>
                  <Badge>{STRICT_LABEL[c.relevant_threshold]} 기준</Badge>
                  {rules > 0 && <Badge tone="accent">추가 조건 {rules}개</Badge>}
                  <Badge tone={c.pairwise_enabled ? "neutral" : "outline"}>{c.pairwise_enabled ? "목록 비교 포함" : "항목 판정만"}</Badge>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(toForm(c))}>수정</Button>
                  <Button size="icon" variant="ghost" aria-label="복사" title="복사" onClick={() => dup(c)}><Copy className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label="삭제" title="삭제" onClick={() => remove(c)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            );
          })}
        </Rows>
      )}
      <Section title="모든 기준에 공통으로 적용되는 규칙" description="기본으로는 아래 척도와 원칙을 모든 기준이 함께 써서, 기준을 바꿔도 결과를 서로 비교할 수 있습니다. 꼭 필요하면 기준 편집의 ‘고급 설정 · 판정 프롬프트’에서 원문을 고칠 수 있습니다.">
        <Rows>
          {[
            ["3 매우 관련", "good", "질문의 의도에 직접 답한다. 이 결과만 보고 해결할 수 있다."],
            ["2 관련", "accent", "실질적으로 도움이 되지만 일부 조건이 빠졌거나 간접적이다."],
            ["1 약간 관련", "warn", "주제나 단어는 겹치지만 질문의 요구를 충족하지 못한다."],
            ["0 무관", "neutral", "질문과 관련이 없다."],
          ].map(([t, tone, d]) => (
            <div key={t} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3.5">
              <span className="w-28"><Badge tone={tone as "good"}>{t}</Badge></span>
              <span className="min-w-0 flex-1 text-[14px] text-muted">{d}</span>
            </div>
          ))}
          <div className="py-4 text-[14px] leading-relaxed text-muted">
            항목에 적힌 정보만 근거로 항목마다 따로 판정하고, 단어가 겹친다는 이유만으로 점수를 주지 않습니다. 근거를 먼저 쓰고 등급을 매기며, 목록 비교는 순서를 바꿔 두 번 묻고 엇갈리면 무승부로 처리합니다.
          </div>
        </Rows>
      </Section>
      {editing && <Editor key={editing.id ?? "new"} initial={editing} onClose={() => setEditing(null)} />}
      {confirm.node}
    </>
  );
}

/** 다른 화면(비교 세트 편집 등)에서 떠나지 않고 평가 기준을 빠르게 만든다. 세부 조건은 나중에 평가 기준 화면에서 다듬는다. */
export function QuickCriteriaDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Criteria) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("general");
  const [k, setK] = useState(5);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const c = await api.post<Criteria>("/criteria", {
        name: name.trim() || `${PURPOSES[purpose].title} 기준`, task_context: PURPOSES[purpose].text, k, relevant_threshold: 2, pairwise_enabled: true,
      });
      await qc.invalidateQueries({ queryKey: ["criteria"] });
      toast.success("평가 기준을 만들었습니다", "추가 조건은 평가 기준 화면에서 언제든 다듬을 수 있습니다.");
      onCreated(c);
      setName("");
    } catch (e) {
      toast.error("만들지 못했습니다", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="평가 기준 빠르게 만들기" description="검색 종류와 볼 개수만 고르면 됩니다. 세부 조건은 나중에 평가 기준 화면에서 다듬을 수 있습니다." size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" loading={busy} onClick={create}>만들고 선택</Button></>}>
      <div className="space-y-5">
        <ChoiceList value={purpose} onChange={setPurpose} columns={2}
          items={(Object.keys(PURPOSES) as Purpose[]).filter((p) => p !== "custom").map((p) => ({ value: p, title: PURPOSES[p].title, desc: PURPOSES[p].desc, icon: PURPOSES[p].icon }))} />
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <label className="block"><span className="mb-1.5 block text-[13px] font-medium">이름</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${PURPOSES[purpose].title} 기준`} /></label>
          <label className="block"><span className="mb-1.5 block text-[13px] font-medium">상위 몇 개까지 볼까요?</span>
            <Segmented value={String(k)} onChange={(v) => setK(Number(v))} items={["1", "3", "5", "10"].map((v) => ({ value: v, label: `${v}개` }))} /></label>
        </div>
      </div>
    </Dialog>
  );
}
