import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NextStep } from "@/components/onboarding/NextStep";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Layers, Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Drawer, useConfirm } from "@/components/ui/overlay";
import { ChoiceList, FormRow, PageHeader, Rows, Steps } from "@/components/ui/page";
import { Alert, Badge, Button, Code, Empty, Input, Select, Spinner } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { TRANSFORM_LABEL, autoInputs, effectiveBinding, guessBinding, inputScopeLabel, leaf, paramKey, scopedKey, varyParams } from "@/lib/binding";
import { cn } from "@/lib/format";
import { QuickCriteriaDialog } from "./Criteria";
import type { Binding, Criteria, InputField, Item, MatchRule, Suite, Target, Transform } from "@/lib/types";

interface Member {
  target_id: number | "";
  label: string;
  bindings: Record<string, Binding>;
  match: MatchRule;
  criteria_id: number | ""; // 후보: 기준 API 와 비교할 때 쓸 평가 기준
}
interface Form {
  id?: number;
  name: string;
  description: string;
  members: Member[]; // [0] = 기준
  inputs: InputField[];
  match_mode: "id" | "title" | "none";
  default_criteria_id: number | "";
}

const NO_MATCH: MatchRule = { lower: false, digits_only: false, strip_prefix: "", strip_suffix: "" };
const STEPS = ["API 고르기", "입력 맞추기", "결과 맞추기", "확인해 보기"];
const MODE_LABEL = { id: "고유 번호", title: "제목", none: "같게 보지 않음" } as const;

const EMPTY: Form = {
  name: "",
  description: "",
  members: [
    { target_id: "", label: "ASIS", bindings: {}, match: { ...NO_MATCH }, criteria_id: "" },
    { target_id: "", label: "TOBE", bindings: {}, match: { ...NO_MATCH }, criteria_id: "" },
  ],
  inputs: [],
  match_mode: "id",
  default_criteria_id: "",
};

function toForm(s: Suite, targets: Target[]): Form {
  const ordered = [...s.members].sort((a, b) => Number(b.is_baseline) - Number(a.is_baseline) || a.position - b.position);
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    inputs: s.input_fields,
    match_mode: s.match_mode ?? "id",
    default_criteria_id: s.default_criteria_id ?? "",
    members: ordered.map((m) => {
      const t = targets.find((x) => x.id === m.target_id);
      return {
        target_id: m.target_id,
        label: m.label,
        bindings: Object.fromEntries(varyParams(t).map((p) => [paramKey(p), effectiveBinding(p, m.input_bindings, s.input_fields)])),
        match: { ...NO_MATCH, ...m.match },
        criteria_id: m.is_baseline ? "" : (m.criteria_id ?? s.default_criteria_id ?? ""),
      };
    }),
  };
}

const sourceOf = (b: Binding): string => (b.transform === "const" ? "const" : b.transform === "template" ? "template" : b.from ? `in:${b.from}` : "skip");

interface PreviewSide {
  label: string;
  is_baseline: boolean;
  target_name: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  error: string;
  items: (Item & { raw_key?: string })[];
  request: { method?: string; url?: string; json?: unknown };
  inputs: Record<string, unknown>;
  overlap: { common: number; base: number; cand: number; top1_same: number } | null;
}

function Tag({ label, base }: { label: string; base: boolean }) {
  return <span className={cn("rounded-lg px-2 py-0.5 text-[13px] font-bold", base ? "bg-subtle text-muted" : "bg-accent-soft text-accent")}>{label}</span>;
}

function Editor({ initial, onClose, targets, criteria }: { initial: Form; onClose: () => void; targets: Target[]; criteria: Criteria[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Form>(initial);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [pvInputs, setPvInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewSide[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [quickCrit, setQuickCrit] = useState(false);
  const [showInputDetail, setShowInputDetail] = useState(false);

  const targetOf = (m: Member) => targets.find((t) => t.id === m.target_id);
  const baseTarget = targetOf(f.members[0]);
  const baseExamples = useMemo(() => Object.fromEntries(varyParams(baseTarget).map((p) => [paramKey(p), p.example ?? ""])), [baseTarget]);

  // API 를 모두 고르면 입력을 자동으로 나눈다(같은 뜻의 값은 공통, 한 API 에만 있는 값은 그 API 전용)
  const regroup = () =>
    setF((x) => {
      const { inputs, bindings } = autoInputs(x.members.map((m) => ({ label: m.label, target: targetOf(m) })));
      return { ...x, inputs, members: x.members.map((m) => ({ ...m, bindings: bindings[m.label] ?? {} })) };
    });
  const allChosen = f.members.every((m) => m.target_id !== "");
  useEffect(() => {
    if (allChosen && f.inputs.length === 0) regroup();
  }, [allChosen, f.members.map((m) => m.target_id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // API 의 바뀌는 값마다 연결이 없으면 추측해 채운다
  const memberKey = f.members.map((m) => m.target_id).join(",");
  const inputKey = f.inputs.map((i) => i.key).join(",");
  useEffect(() => {
    setF((x) => {
      let changed = false;
      const members = x.members.map((m) => {
        const next: Record<string, Binding> = {};
        for (const p of varyParams(targetOf(m))) {
          const key = paramKey(p);
          const cur = m.bindings[key];
          const stale = cur && cur.from && !x.inputs.some((i) => i.key === cur.from);
          next[key] = cur && !stale ? cur : guessBinding(p, x.inputs.filter((i) => !i.scope || i.scope === m.label), baseExamples);
          if (!cur || stale) changed = true;
        }
        if (Object.keys(m.bindings).some((k) => !(k in next))) changed = true;
        return { ...m, bindings: next };
      });
      return changed ? { ...x, members } : x;
    });
  }, [memberKey, inputKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 확인용 입력의 기본값: 기준 API 예시 → 그 입력을 쓰는 다른 API 의 예시 → 기본값
  const inputExamples = useMemo(() => {
    const out: Record<string, string> = {};
    for (const i of f.inputs) {
      let ex = baseExamples[i.key] ?? "";
      if (!ex)
        for (const m of f.members) {
          const p = varyParams(targetOf(m)).find((x) => m.bindings[paramKey(x)]?.from === i.key && x.example);
          if (p) {
            ex = p.example;
            break;
          }
        }
      out[i.key] = ex || (i.default !== null && i.default !== undefined ? String(i.default) : "");
    }
    return out;
  }, [f.inputs, f.members, baseExamples]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPvInputs((cur) => Object.fromEntries(f.inputs.map((i) => [i.key, cur[i.key] || inputExamples[i.key] || ""])));
  }, [f.inputs, inputExamples]);

  const setMember = (i: number, patch: Partial<Member>) =>
    setF((x) => {
      const old = x.members[i].label;
      // 라벨을 바꾸면 그 API 전용 입력의 표시도 따라 바꾼다
      const inputs = patch.label !== undefined && patch.label !== old ? x.inputs.map((v) => (v.scope === old ? { ...v, scope: patch.label } : v)) : x.inputs;
      return { ...x, inputs, members: x.members.map((m, j) => (j === i ? { ...m, ...patch } : m)) };
    });
  const newScopedInput = (i: number, p: { name: string; label?: string; example?: string; array_style?: string; json_type?: string; field?: string }) =>
    setF((x) => {
      const m = x.members[i];
      let key = scopedKey(m.label, p.field || p.name);
      while (x.inputs.some((v) => v.key === key)) key = `${key}_2`;
      const input: InputField = { key, label: p.label || leaf(p.name), type: p.array_style ? "list" : p.json_type === "number" ? "int" : "text", required: false, default: null, help: p.example ? `예: ${p.example}` : "", scope: m.label };
      return {
        ...x,
        inputs: [...x.inputs, input],
        members: x.members.map((mm, j) => (j === i ? { ...mm, bindings: { ...mm.bindings, [p.field || p.name]: { from: key, transform: "as_is", value: "" } } } : mm)),
      };
    });
  const setBinding = (i: number, key: string, b: Binding) => setF((x) => ({ ...x, members: x.members.map((m, j) => (j === i ? { ...m, bindings: { ...m.bindings, [key]: b } } : m)) }));
  const setInput = (i: number, patch: Partial<InputField>) => setF((x) => ({ ...x, inputs: x.inputs.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));

  const used = f.members.map((m) => m.target_id).filter((x) => x !== "");
  const filled = f.members.filter((m) => m.target_id !== "");
  const membersPayload = () =>
    f.members
      .filter((m) => m.target_id !== "")
      .map((m, i) => ({ target_id: Number(m.target_id), label: m.label.trim() || `API${i + 1}`, is_baseline: i === 0, input_bindings: m.bindings, match: m.match, criteria_id: i === 0 || m.criteria_id === "" ? null : Number(m.criteria_id) }));

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const r = await api.post<{ sides: PreviewSide[] }>("/suites/preview", { input_fields: f.inputs, members: membersPayload(), match_mode: f.match_mode, inputs: pvInputs });
      setPreview(r.sides);
    } catch (e) {
      toast.error("호출하지 못했습니다", (e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };
  useEffect(() => {
    if (step === 3) runPreview();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: f.name.trim(),
        description: f.description,
        members: membersPayload(),
        input_fields: f.inputs.filter((i) => i.key.trim()),
        match_mode: f.match_mode,
        default_criteria_id: f.members.slice(1).find((m) => m.criteria_id !== "")?.criteria_id || null,
      };
      if (f.id) await api.put(`/suites/${f.id}`, body);
      else await api.post("/suites", body);
      qc.invalidateQueries({ queryKey: ["suites"] });
      toast.success("저장했습니다", "단건 검색 비교·평가에서 바로 쓸 수 있습니다.");
      onClose();
    } catch (e) {
      toast.error("저장하지 못했습니다", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const unbound = f.members.flatMap((m) =>
    varyParams(targetOf(m))
      .filter((p) => sourceOf(m.bindings[paramKey(p)] ?? { from: "", transform: "as_is", value: "" }) === "skip")
      .map((p) => `${m.label} · ${p.name}`),
  );
  const fieldSets = filled.map((m) => ({ label: m.label, fields: (targetOf(m)?.response_mapping.text_fields ?? []).map((t) => t.label) }));
  const fieldsDiffer = fieldSets.length > 1 && new Set(fieldSets.map((s) => [...s.fields].sort().join("|"))).size > 1;
  const basics = !!f.name.trim() && filled.length >= 2 && f.members[0].target_id !== "";
  const inputsOk = f.inputs.length > 0 && f.inputs.every((i) => i.key.trim()) && new Set(f.inputs.map((i) => i.key)).size === f.inputs.length;
  // 모든 API 의 바뀌는 값이 입력에 연결되었으면 '자동으로 맞춤' 요약만 보여 주고 세부는 접는다
  const autoOk = inputsOk && unbound.length === 0;
  const canNext = [basics, inputsOk, true, true][step];
  const ready = basics && inputsOk;

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-6xl" scrollKey={step} title={f.id ? `비교 세트 수정 · ${initial.name}` : "비교 세트 만들기"}
      subtitle="요청·응답 형태가 서로 다른 API 도 공통 입력과 ‘같은 결과’ 기준을 맞춰 비교할 수 있습니다."
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {step > 0 && <Button variant="ghost" onClick={() => setStep(step - 1)}><ArrowLeft className="h-4 w-4" />이전</Button>}
          <div className="ml-auto flex gap-2">
            {f.id && step < 3 && <Button disabled={!ready} loading={saving} onClick={save}>바로 저장</Button>}
            {step < 3 ? (
              <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>다음<ArrowRight className="h-4 w-4" /></Button>
            ) : (
              <Button variant="primary" disabled={!ready} loading={saving} icon={<Check className="h-4 w-4" />} onClick={save}>저장</Button>
            )}
          </div>
        </div>
      }>
      <Steps steps={STEPS} current={step} onJump={(i) => (i <= step || ready) && setStep(i)} />

      {step === 0 && (
        <Rows>
          <FormRow label="이름" required help="예: 검색엔진 교체 전 vs 후">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="비교 세트 이름" autoFocus={!f.id} />
          </FormRow>
          <FormRow label="기준 (지금 쓰는 것)" required help="결과를 견줄 기준입니다. 보통 운영 중인 API(ASIS)입니다.">
            <div className="flex flex-wrap gap-2">
              <Input className="w-28" value={f.members[0].label} onChange={(e) => setMember(0, { label: e.target.value })} />
              <Select className="min-w-[220px] flex-1" value={f.members[0].target_id} onChange={(e) => setMember(0, { target_id: e.target.value ? Number(e.target.value) : "", bindings: {} })}>
                <option value="">API 선택</option>
                {targets.filter((t) => !used.includes(t.id) || t.id === f.members[0].target_id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </div>
          </FormRow>
          <FormRow label="비교할 후보" required help="요청·응답 형태가 달라도 됩니다. 다음 단계에서 맞춥니다.">
            <div className="space-y-2">
              <div className="hidden gap-2 px-1 text-[12px] font-medium text-faint sm:grid sm:grid-cols-[7rem_minmax(0,1.3fr)_minmax(0,1fr)_2.25rem]">
                <span>이름</span><span>API</span><span>평가 기준</span><span />
              </div>
              {f.members.slice(1).map((m, idx) => {
                const i = idx + 1;
                return (
                  <div key={i} className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1.3fr)_minmax(0,1fr)_2.25rem]">
                    <Input value={m.label} onChange={(e) => setMember(i, { label: e.target.value })} aria-label="후보 이름" />
                    <Select value={m.target_id} onChange={(e) => setMember(i, { target_id: e.target.value ? Number(e.target.value) : "", bindings: {} })} aria-label="후보 API">
                      <option value="">API 선택</option>
                      {targets.filter((t) => !used.includes(t.id) || t.id === m.target_id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                    <Select value={m.criteria_id} onChange={(e) => setMember(i, { criteria_id: e.target.value ? Number(e.target.value) : "" })} aria-label={`${m.label} 평가 기준`}
                      className={cn(m.criteria_id === "" && "text-faint")}>
                      <option value="">평가 기준 선택</option>
                      {criteria.map((c) => <option key={c.id} value={c.id}>{c.name} · 상위 {c.k}개</option>)}
                    </Select>
                    {f.members.length > 2 ? (
                      <Button size="icon" variant="ghost" aria-label="후보 빼기" onClick={() => setF({ ...f, members: f.members.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></Button>
                    ) : <span className="hidden sm:block" />}
                  </div>
                );
              })}
              <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setF({ ...f, members: [...f.members, { target_id: "", label: `후보${f.members.length}`, bindings: {}, match: { ...NO_MATCH }, criteria_id: f.members[f.members.length - 1]?.criteria_id ?? "" }] })}>후보 추가</Button>
              <p className="break-keep pt-1 text-[12.5px] text-muted">
                오른쪽 칸은 그 후보를 기준과 견줄 때 쓸 <b className="text-ink">평가 기준</b>입니다. 후보마다 달라도 됩니다(평가에서 바꿀 수도 있음).{" "}
                <button type="button" onClick={() => setQuickCrit(true)} className="font-medium text-accent hover:underline">
                  {criteria.length === 0 ? "평가 기준이 없습니다 — 여기서 바로 만들기 +" : "+ 새 평가 기준 만들기"}
                </button>
              </p>
            </div>
          </FormRow>
          <FormRow label="메모"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></FormRow>
        </Rows>
      )}

      {step === 1 && (
        <>
          {autoOk && (
            <div className="mb-8 rounded-2xl border border-good/30 bg-good-soft/40 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Check className="animate-check h-5 w-5 text-good" />
                <span className="text-[15px] font-semibold">입력을 자동으로 맞췄습니다</span>
                <span className="text-[13px] text-muted">API 설정을 보고 같은 뜻의 값을 묶었습니다. 그대로 다음으로 가도 됩니다.</span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowInputDetail(!showInputDetail)}>{showInputDetail ? "접기" : "직접 고치기"}</Button>
              </div>
              <div className="mt-4 divide-y divide-good/20 border-y border-good/20 text-[13.5px]">
                {f.inputs.map((x) => (
                  <div key={x.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="min-w-[120px] font-semibold">{x.label || x.key}{x.required && <span className="text-bad">*</span>}</span>
                    <Badge tone={x.scope ? "outline" : "accent"}>{x.scope ? `${x.scope} 전용` : "공통"}</Badge>
                    <span className="text-muted">
                      {f.members.map((m) => {
                        const ps = Object.entries(m.bindings).filter(([, b]) => b.from === x.key);
                        return ps.length ? `${m.label} ← ${ps.map(([k, b]) => `${leaf(k)}${b.transform !== "as_is" ? `(${TRANSFORM_LABEL[b.transform]})` : ""}`).join(", ")}` : null;
                      }).filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(!autoOk || showInputDetail) && (
            <div className="animate-fade-up">
          <div className="mb-1 text-[15px] font-semibold">입력</div>
          <p className="mb-4 break-keep text-[14px] text-muted">
            비교할 때 넣는 값입니다. 여러 API 가 같이 쓰는 값은 <b className="text-ink">공통</b>, 한 API 만 받는 값은 <b className="text-ink">그 API 전용</b>입니다(예: A 는 질문+키워드, B 는 질문+분류 → 질문 공통, 키워드 A 전용, 분류 B 전용). 단건 검색 비교의 입력칸과 테스트 데이터의 열이 이 목록을 따릅니다.
          </p>
          <div className="divide-y divide-line border-y border-line">
            {f.inputs.map((x, i) => (
              <div key={i} className="grid items-center gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_120px_140px_110px_auto_auto]">
                <Input className="h-9" value={x.label} placeholder="화면·판정에 보일 이름" onChange={(e) => setInput(i, { label: e.target.value })} />
                <Input className="h-9 font-mono text-[12px] text-muted" value={x.key} placeholder="key" title="내부 키(테스트 데이터 열 연결에 씀)" onChange={(e) => setInput(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} />
                <Select className="h-9" value={x.scope ?? ""} onChange={(e) => setInput(i, { scope: e.target.value })}>
                  <option value="">모든 API 공통</option>
                  {f.members.map((m) => <option key={m.label} value={m.label}>{m.label} 전용</option>)}
                </Select>
                <Select className="h-9" value={x.type} onChange={(e) => setInput(i, { type: e.target.value as InputField["type"] })}>
                  <option value="text">문자</option>
                  <option value="list">여러 값</option>
                  <option value="int">숫자</option>
                </Select>
                <label className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted"><input type="checkbox" checked={x.required} onChange={(e) => setInput(i, { required: e.target.checked })} />필수 여부</label>
                <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => setF({ ...f, inputs: f.inputs.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
          {!inputsOk && f.inputs.length > 0 && <Alert tone="warn" className="mt-3">공통 입력의 key 가 비었거나 겹칩니다.</Alert>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setF({ ...f, inputs: [...f.inputs, { key: `input${f.inputs.length + 1}`, label: "", type: "text", required: false, default: null, help: "" }] })}>공통 입력 추가</Button>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={regroup}>API 설정에서 자동으로 다시 나누기</Button>
          </div>

          <div className="mb-1 mt-12 text-[15px] font-semibold">API 별로 어떤 입력을 넣을까요?</div>
          <p className="mb-4 break-keep text-[14px] text-muted">각 API 는 공통 입력과 자기 전용 입력만 고를 수 있습니다. 이름이 같거나 비슷한 값(q·query·text, size·limit·top_k 등)과 예시 값이 같은 것은 공통으로 묶었습니다. 형식이 다르면(여러 값 ↔ 문장, 문자 ↔ 숫자) 변환을 고르세요.</p>
          <div className="space-y-10">
            {f.members.map((m, i) => {
              const t = targetOf(m);
              if (!t) return null;
              return (
                <div key={i}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Tag label={m.label} base={i === 0} />
                    <span className="text-[13.5px] text-muted">{t.name}</span>
                    <span className="font-mono text-[12px] text-faint">{t.method} {t.path}</span>
                  </div>
                  <div className="scroll-thin overflow-x-auto">
                    <table className="w-full min-w-[720px] text-[13.5px]">
                      <thead className="border-y border-line text-[12.5px] text-muted">
                        <tr>
                          <th className="px-3 py-2.5 text-left font-medium">이 API 의 값</th>
                          <th className="w-[240px] px-3 py-2.5 text-left font-medium">가져올 곳</th>
                          <th className="w-[210px] px-3 py-2.5 text-left font-medium">변환 / 값</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line border-b border-line">
                        {varyParams(t).map((p) => {
                          const key = paramKey(p);
                          const b = m.bindings[key] ?? { from: "", transform: "as_is" as Transform, value: "" };
                          const src = sourceOf(b);
                          return (
                            <tr key={key} className={cn(src === "skip" && "bg-warn-soft/40")}>
                              <td className="px-3 py-2.5">
                                <div className="font-mono text-[13px] font-semibold">{p.name}{p.required && <span className="ml-1.5 font-sans text-[11.5px] font-normal text-bad">필수</span>}</div>
                                <div className="text-[11.5px] text-faint">{p.location === "body" ? "요청 본문" : "주소"}{p.array_style ? " · 여러 값" : ""}{p.json_type === "number" ? " · 숫자" : ""}{p.example ? ` · 예: ${p.example}` : ""}</div>
                              </td>
                              <td className="px-3 py-2.5">
                                <Select className="h-9" value={src} onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "skip") setBinding(i, key, { from: "", transform: "as_is", value: "" });
                                  else if (v === "const") setBinding(i, key, { from: "", transform: "const", value: b.value || p.example || "" });
                                  else if (v === "template") setBinding(i, key, { from: "", transform: "template", value: b.value || f.inputs.slice(0, 2).map((x) => `{${x.key}}`).join(" ") });
                                  else if (v === "new") newScopedInput(i, p);
                                  else {
                                    const input = f.inputs.find((x) => x.key === v.slice(3));
                                    const g = input ? guessBinding({ ...p, field: input.key }, [input], {}) : null;
                                    setBinding(i, key, { from: v.slice(3), transform: g?.transform ?? "as_is", value: "" });
                                  }
                                }}>
                                  {f.inputs.filter((x) => !x.scope || x.scope === m.label).map((x) => <option key={x.key} value={`in:${x.key}`}>{inputScopeLabel(x)} · {x.label || x.key}</option>)}
                                  <option value="new">+ 이 API 전용 입력 새로 만들기</option>
                                  <option value="const">항상 같은 값</option>
                                  <option value="template">조합 문장</option>
                                  <option value="skip">보내지 않음</option>
                                </Select>
                              </td>
                              <td className="px-3 py-2.5">
                                {src.startsWith("in:") ? (
                                  <Select className="h-9" value={b.transform} onChange={(e) => setBinding(i, key, { ...b, transform: e.target.value as Transform })}>
                                    {(["as_is", "join_space", "join_comma", "split", "first", "number"] as Transform[]).map((tr) => <option key={tr} value={tr}>{TRANSFORM_LABEL[tr]}</option>)}
                                  </Select>
                                ) : src === "skip" ? (
                                  <span className={cn("text-[12.5px]", p.required ? "text-bad" : "text-warn")}>{p.required ? "필수 값인데 보내지 않습니다" : "이 값은 보내지 않습니다"}</span>
                                ) : (
                                  <Input className="h-9" value={b.value} onChange={(e) => setBinding(i, key, { ...b, value: e.target.value })} placeholder={src === "template" ? "{q} {keywords}" : "값"} />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
          {unbound.length > 0 && <Alert tone="warn" className="mt-6">연결하지 않아 보내지 않는 값: {unbound.join(", ")}. 의도한 것이 아니라면 가져올 곳을 고르세요.</Alert>}
          <div className="mt-4 text-[12.5px] text-muted">조합 문장은 공통 입력을 <code>{"{key}"}</code> 로 넣어 하나의 문장을 만듭니다. 예: <code>{"{q} {keywords}"}</code></div>
            </div>
          )}
        </>
      )}
      {step === 2 && (
        <>
          <div className="mb-1 text-[15px] font-semibold">API 결과 중 ‘같은 결과’는 어떻게 알아볼까요?</div>
          <p className="mb-4 break-keep text-[14px] text-muted">같은 결과를 알아봐야 순위 변화·겹침을 계산하고, 같은 결과는 한 번만 판정합니다.</p>
          <ChoiceList value={f.match_mode} onChange={(v) => setF({ ...f, match_mode: v })} columns={3} items={[
            { value: "id", title: "고유 번호로 (권장)", desc: "문서 ID·상품코드처럼 결과마다 고유한 값. 형식이 달라도 아래 규칙으로 맞출 수 있습니다." },
            { value: "title", title: "제목으로", desc: "API 마다 ID 체계가 전혀 다를 때. 띄어쓰기·기호·대소문자를 무시하고 제목이 같으면 같은 결과로 봅니다." },
            { value: "none", title: "같게 보지 않음", desc: "결과를 각각 판정만 합니다. 순위 변화·겹침은 계산하지 않습니다." },
          ]} />
          {f.match_mode === "id" && (
            <div className="mt-8 divide-y divide-line border-y border-line">
              {f.members.map((m, i) => {
                const t = targetOf(m);
                if (!t) return null;
                const idPath = t.response_mapping.id_path;
                return (
                  <div key={i} className="grid gap-x-6 gap-y-3 py-4 md:grid-cols-[200px_1fr]">
                    <div>
                      <Tag label={m.label} base={i === 0} />
                      <div className="mt-1.5 text-[12.5px] text-muted">고유 번호 {idPath ? <span className="font-mono text-ink">{leaf(idPath)}</span> : <span className="text-bad">없음</span>}</div>
                    </div>
                    {idPath ? (
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13.5px]">
                        <label className="flex items-center gap-1.5"><input type="checkbox" checked={m.match.lower} onChange={(e) => setMember(i, { match: { ...m.match, lower: e.target.checked } })} />대소문자 무시</label>
                        <label className="flex items-center gap-1.5"><input type="checkbox" checked={m.match.digits_only} onChange={(e) => setMember(i, { match: { ...m.match, digits_only: e.target.checked } })} />숫자만 비교</label>
                        <label className="flex items-center gap-1.5">앞부분 지우기<Input className="h-8 w-28" value={m.match.strip_prefix} placeholder="예: EMP-" onChange={(e) => setMember(i, { match: { ...m.match, strip_prefix: e.target.value } })} /></label>
                        <label className="flex items-center gap-1.5">뒷부분 지우기<Input className="h-8 w-24" value={m.match.strip_suffix} onChange={(e) => setMember(i, { match: { ...m.match, strip_suffix: e.target.value } })} /></label>
                      </div>
                    ) : (
                      <Alert tone="warn">이 API 는 고유 번호가 지정되지 않았습니다. <Link to="/settings/targets" className="font-medium text-accent">검색 API</Link> 에서 지정하거나 ‘제목으로’를 고르세요.</Alert>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 text-[12.5px] text-muted">다음 단계에서 실제로 불러 보면 규칙을 적용한 값과 겹치는 결과를 바로 확인할 수 있습니다.</div>
          <div className="mb-1 mt-12 text-[15px] font-semibold">판정에 보내는 내용</div>
          <div className="divide-y divide-line border-y border-line text-[13.5px]">
            {fieldSets.map((s) => (
              <div key={s.label} className="flex flex-wrap gap-x-6 gap-y-1 py-3">
                <span className="w-24 font-semibold">{s.label}</span>
                <span className="min-w-0 flex-1 text-muted">{s.fields.join(", ") || "없음"}</span>
              </div>
            ))}
          </div>
          {fieldsDiffer && (
            <Alert tone="warn" className="mt-3" icon={<AlertTriangle className="h-4 w-4" />}>
              API 마다 판정에 보내는 내용이 다릅니다. 정보가 많은 쪽이 판정에서 유리할 수 있으니, 가능하면 <Link to="/settings/targets" className="font-medium text-accent">검색 API</Link> 에서 같은 내용을 같은 이름으로 맞추세요.
            </Alert>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <div className="mb-1 text-[15px] font-semibold">같은 입력으로 실제로 불러 봅니다</div>
          <p className="mb-4 text-[14px] text-muted">API 마다 실제로 보낸 값과, 기준과 겹치는 결과를 확인하세요.</p>
          <div className="mb-8 flex flex-wrap items-end gap-3 border-y border-line py-4">
            {f.inputs.map((x) => (
              <label key={x.key} className="min-w-[160px] flex-1">
                <span className="mb-1 block text-[12.5px] text-muted">{x.scope ? `${x.scope} 전용 · ` : ""}{x.label || x.key}{x.type === "list" && " (쉼표로 구분)"}</span>
                <Input className="h-9" value={pvInputs[x.key] ?? ""} onChange={(e) => setPvInputs((v) => ({ ...v, [x.key]: e.target.value }))} />
              </label>
            ))}
            <Button icon={<Play className="h-4 w-4" />} loading={previewing} onClick={runPreview}>불러오기</Button>
          </div>
          {previewing && !preview && <div className="flex justify-center py-12"><Spinner /></div>}
          {preview && (
            <div className={cn("grid gap-y-10", preview.length > 1 && "lg:grid-cols-2 lg:divide-x lg:divide-line [&>*]:min-w-0 lg:[&>*]:px-8 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0")}>
              {preview.map((s) => {
                const baseKeys = new Set(preview.find((x) => x.is_baseline)?.items.map((it) => it.key) ?? []);
                return (
                  <div key={s.label}>
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <Tag label={s.label} base={s.is_baseline} />
                      <span className="text-[13px] text-muted">{s.target_name}</span>
                      <span className="ml-auto text-[12.5px] text-muted">{s.ok ? `HTTP ${s.status_code} · ${s.items.length}건` : "실패"}</span>
                    </div>
                    <div className="mb-1 text-[12.5px] text-muted">보낸 값</div>
                    <div className="mb-3 divide-y divide-line border-y border-line text-[13px]">
                      {Object.entries(s.inputs).map(([k, v]) => (
                        <div key={k} className="flex gap-3 py-2"><span className="w-28 shrink-0 truncate font-mono text-muted">{k}</span><span className="min-w-0 break-all">{Array.isArray(v) ? `[${v.join(", ")}]` : String(v)}</span></div>
                      ))}
                      {!Object.keys(s.inputs).length && <div className="py-2 text-faint">보낸 바뀌는 값 없음</div>}
                    </div>
                    {s.request.json !== undefined && (
                      <details className="mb-3"><summary className="cursor-pointer text-[12.5px] text-muted">요청 본문 보기</summary><Code className="mt-2">{JSON.stringify(s.request.json, null, 2)}</Code></details>
                    )}
                    {!s.ok ? (
                      <Alert tone="bad">{s.error}</Alert>
                    ) : (
                      <>
                        {s.overlap && (
                          <div className={cn("mb-3 text-[13.5px]", s.overlap.common === 0 && f.match_mode !== "none" ? "text-warn" : "text-ink")}>
                            기준과 겹치는 결과 <b>{s.overlap.common}</b>개 · 1위 {s.overlap.top1_same ? "같음" : "다름"}
                            {s.overlap.common === 0 && f.match_mode !== "none" && " — ‘같은 결과’ 기준(고유 번호 규칙)을 확인하세요."}
                          </div>
                        )}
                        <div className="divide-y divide-line border-y border-line">
                          {s.items.slice(0, 5).map((it, idx) => (
                            <div key={it.key} className="flex items-center gap-3 py-2.5 text-[13.5px]">
                              <span className="num w-4 text-faint">{idx + 1}</span>
                              <span className="min-w-0 flex-1 truncate font-medium">{it.title}</span>
                              <span className="max-w-[120px] truncate font-mono text-[11.5px] text-faint" title={`원래 값 ${it.raw_key ?? it.key}`}>{it.key}</span>
                              {!s.is_baseline && baseKeys.has(it.key) && <Badge tone="good">기준에도 있음</Badge>}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      <QuickCriteriaDialog open={quickCrit} onClose={() => setQuickCrit(false)}
        onCreated={(c) => { setQuickCrit(false); setF((x) => ({ ...x, members: x.members.map((m, j) => (j > 0 && m.criteria_id === "" ? { ...m, criteria_id: c.id } : m)) })); }} />
    </Drawer>
  );
}

export default function Suites() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Form | null>(null);
  const suites = useQuery({ queryKey: ["suites"], queryFn: () => api.get<Suite[]>("/suites") });
  const targets = useQuery({ queryKey: ["targets"], queryFn: () => api.get<Target[]>("/targets") });
  const criteria = useQuery({ queryKey: ["criteria"], queryFn: () => api.get<Criteria[]>("/criteria") });
  const remove = async (s: Suite) => {
    if (!(await confirm.ask({ title: `'${s.name}' 을 삭제할까요?`, body: "실행 기록은 남습니다(설정 사본 보관).", confirm: "삭제", danger: true }))) return;
    await api.del(`/suites/${s.id}`).catch((e) => toast.error("삭제하지 못했습니다", e.message));
    qc.invalidateQueries({ queryKey: ["suites"] });
  };
  // API 가 딱 2개면 기준·후보를, 평가 기준이 1개면 그 기준을 미리 골라 둔다
  const newSuite = () => {
    const f = structuredClone(EMPTY);
    const ts = targets.data ?? [];
    const cs = criteria.data ?? [];
    if (ts.length === 2) f.members = f.members.map((m, i) => ({ ...m, target_id: ts[i].id }));
    if (cs.length === 1) f.members = f.members.map((m, i) => (i > 0 ? { ...m, criteria_id: cs[0].id } : m));
    setEditing(f);
  };
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("new") !== "1" || !targets.data || !criteria.data) return;
    setParams((p) => { p.delete("new"); return p; }, { replace: true });
    if (targets.data.length >= 2) newSuite();
  }, [params, targets.data, criteria.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const critName = (id: number | null) => criteria.data?.find((c) => c.id === id)?.name;
  const tooFew = (targets.data?.length ?? 0) < 2 && !targets.isLoading;
  return (
    <>
      <PageHeader
        eyebrow="평가 구성"
        title="비교 세트"
        description="기준 API 와 비교할 후보 API 를 묶습니다. 요청·응답 형태가 서로 달라도 공통 입력과 ‘같은 결과’ 기준을 맞춰 비교할 수 있습니다."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={tooFew} onClick={newSuite}>세트 만들기</Button>}
      />
      <NextStep current="suite" />
      {tooFew && (
        <Alert tone="warn" className="mb-8" title="API 가 2개 이상 필요합니다">
          <Link to="/settings/targets" className="font-medium text-accent">검색 API</Link> 에서 기준과 후보 API 를 먼저 연결하세요.
        </Alert>
      )}
      {suites.isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !suites.data?.length ? (
        <Empty icon={<Layers className="h-8 w-8" />} title="비교 세트가 없습니다"
          action={(targets.data?.length ?? 0) >= 2
            ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={newSuite}>첫 비교 세트 만들기</Button>
            : <Link to="/settings/targets"><Button variant="primary">검색 API 먼저 연결하기 ({targets.data?.length ?? 0}/2)</Button></Link>}>
          기준 API 와 비교할 후보 API 를 묶어 세트를 만드세요.
        </Empty>
      ) : (
        <Rows>
          {suites.data.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-x-8 gap-y-3 py-5">
              <div className="min-w-0 flex-1 basis-[280px]">
                <div className="text-[15.5px] font-semibold">{s.name}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {s.members.map((m, i) => (
                    <span key={m.target_id} className="flex min-w-0 items-center gap-2">
                      {i > 0 && <span className="text-[12px] text-faint">vs</span>}
                      <span className={cn("rounded-lg px-2 py-0.5 text-[12.5px] font-bold", m.is_baseline ? "bg-subtle text-muted" : "bg-accent-soft text-accent")}>{m.label}</span>
                      <span className="truncate text-[13px] text-muted">{m.target_name}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="min-w-0 basis-[240px] text-[13px] text-muted">
                <div>입력 · {s.input_fields.map((f) => (f.scope ? `${f.label || f.key}(${f.scope})` : f.label || f.key)).join(", ")}</div>
                <div className="mt-0.5">같은 결과 · {MODE_LABEL[s.match_mode ?? "id"]} · 평가 기준 · {[...new Set(s.members.filter((m) => !m.is_baseline).map((m) => critName(m.criteria_id ?? s.default_criteria_id) ?? "기본"))].join(", ")}</div>
                <Link to={`/datasets?suite=${s.id}`} className="mt-1 inline-flex items-center gap-1 font-medium text-accent hover:underline">
                  테스트 데이터 {s.dataset_count ?? 0}개 연결됨 →
                </Link>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Link to={`/compare?suite=${s.id}`}><Button size="sm" variant="ghost">단건 비교</Button></Link>
                <Link to={`/runs/new?suite=${s.id}`}><Button size="sm" icon={<Play className="h-3.5 w-3.5" />}>평가</Button></Link>
                <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} disabled={!targets.data} onClick={() => targets.data && setEditing(toForm(s, targets.data))}>수정</Button>
                <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => remove(s)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </Rows>
      )}
      {editing && targets.data && (
        <Editor key={editing.id ?? "new"} initial={editing} onClose={() => setEditing(null)} targets={targets.data} criteria={criteria.data ?? []} />
      )}
      {confirm.node}
    </>
  );
}
