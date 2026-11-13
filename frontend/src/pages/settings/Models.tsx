import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NextStep } from "@/components/onboarding/NextStep";
import { Bot, CheckCircle2, CircleDashed, KeyRound, Pencil, Plus, Star, Trash2, XCircle, Zap } from "lucide-react";
import { useState } from "react";
import { Dialog, Tooltip, useConfirm } from "@/components/ui/overlay";
import { PageHeader } from "@/components/ui/page";
import { Alert, Badge, Button, Card, Empty, Field, Input, Spinner, Switch, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { PROVIDER_LABEL, cn, fmt } from "@/lib/format";
import type { JudgeModel, Provider, ProviderMeta } from "@/lib/types";

interface Form {
  id?: number;
  name: string;
  provider: Provider;
  model: string;
  base_url: string;
  project: string;
  location: string;
  secret: string;
  secretTouched: boolean;
  temperature: string;
  max_tokens: string;
  price_input_per_mtok: string;
  price_output_per_mtok: string;
  is_default: boolean;
}

const EMPTY: Form = {
  name: "",
  provider: "vertex",
  model: "",
  base_url: "",
  project: "",
  location: "global",
  secret: "",
  secretTouched: false,
  temperature: "0",
  max_tokens: "4096",
  price_input_per_mtok: "0",
  price_output_per_mtok: "0",
  is_default: false,
};

function toForm(m: JudgeModel): Form {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    model: m.model,
    base_url: m.base_url,
    project: m.project,
    location: m.location,
    secret: "",
    secretTouched: false,
    temperature: m.params.temperature === null || m.params.temperature === undefined ? "" : String(m.params.temperature),
    max_tokens: String(m.params.max_tokens ?? 4096),
    price_input_per_mtok: String(m.price_input_per_mtok),
    price_output_per_mtok: String(m.price_output_per_mtok),
    is_default: m.is_default,
  };
}

function Editor({ open, onClose, initial, providers }: { open: boolean; onClose: () => void; initial: Form; providers: Record<string, ProviderMeta> }) {
  const [f, setF] = useState<Form>(initial);
  const qc = useQueryClient();
  const toast = useToast();
  const meta = providers[f.provider];
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        provider: f.provider,
        model: f.model.trim(),
        base_url: f.base_url.trim(),
        project: f.project.trim(),
        location: f.location.trim(),
        secret: f.secretTouched ? f.secret : null,
        params: { temperature: f.temperature === "" ? null : Number(f.temperature), max_tokens: Number(f.max_tokens) || 4096 },
        price_input_per_mtok: Number(f.price_input_per_mtok) || 0,
        price_output_per_mtok: Number(f.price_output_per_mtok) || 0,
        is_default: f.is_default,
      };
      return f.id ? api.put<JudgeModel>(`/judge-models/${f.id}`, body) : api.post<JudgeModel>("/judge-models", body);
    },
    onSuccess: async (m) => {
      qc.invalidateQueries({ queryKey: ["judge-models"] });
      onClose();
      // 저장하면 바로 연결 테스트까지 해서 '미확인' 상태로 남지 않게 한다
      toast.info("저장했습니다 · 연결을 확인하는 중…");
      try {
        const r = await api.post<{ ok: boolean; message: string }>(`/judge-models/${m.id}/test`);
        if (r.ok) toast.success("연결 확인 완료", "이 모델로 판정할 수 있습니다.");
        else toast.error("저장했지만 연결에 실패했습니다", r.message);
      } catch (e) {
        toast.error("연결 테스트를 하지 못했습니다", (e as Error).message);
      } finally {
        qc.invalidateQueries({ queryKey: ["judge-models"] });
        qc.invalidateQueries({ queryKey: ["overview"] });
      }
    },
    onError: (e: Error) => toast.error("저장하지 못했습니다", e.message),
  });
  const loadFile = (file: File) => file.text().then((t) => setF((x) => ({ ...x, secret: t, secretTouched: true })));
  const needs = new Set(meta?.needs ?? []);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={f.id ? "판정 모델 편집" : "판정 모델 추가"} size="lg"
      description="판정에 쓸 LLM 을 연결합니다. 키는 암호화해 저장하고 화면에는 다시 보여 주지 않습니다."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || !f.model.trim()} onClick={() => save.mutate()}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-[13px] font-medium">공급자</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries(providers).map(([key, p]) => (
              <button
                key={key}
                type="button"
                onClick={() => set("provider", key as Provider)}
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-left text-[13px] transition-colors",
                  f.provider === key ? "border-accent bg-accent-soft/60 text-ink" : "border-line text-muted hover:bg-subtle",
                )}
              >
                <div className="font-semibold text-ink">{PROVIDER_LABEL[key] ?? key}</div>
                <div className="mt-0.5 truncate text-[12px]">{p.label}</div>
              </button>
            ))}
          </div>
          {meta && <div className="mt-2 text-xs leading-relaxed text-muted">{meta.help}</div>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="이름" required help="목록과 실행 기록에 보이는 이름입니다.">
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="예: Gemini 판정용" />
          </Field>
          <Field label="모델 ID" required help="공급자 콘솔에 표시된 모델 이름을 그대로 적습니다.">
            <Input value={f.model} onChange={(e) => set("model", e.target.value)} placeholder={meta?.model_placeholder} />
          </Field>
          {needs.has("base_url") && (
            <Field label="서버 주소 (base_url)" required className="sm:col-span-2" help="예: http://localhost:11434/v1 (Ollama), http://vllm:8000/v1">
              <Input value={f.base_url} onChange={(e) => set("base_url", e.target.value)} placeholder="http://localhost:11434/v1" />
            </Field>
          )}
          {needs.has("project") && (
            <Field label="GCP 프로젝트 ID" help="비우면 서비스 계정 JSON 의 project_id 또는 GCP_PROJECT 를 씁니다.">
              <Input value={f.project} onChange={(e) => set("project", e.target.value)} />
            </Field>
          )}
          {needs.has("location") && (
            <Field label="리전" help="예: global, asia-northeast3, us-central1">
              <Input value={f.location} onChange={(e) => set("location", e.target.value)} />
            </Field>
          )}
        </div>
        <Field
          label={meta?.secret_label ?? "API 키"}
          help={
            meta?.env_secret
              ? `환경 변수 ${meta.env_secret} 가 설정되어 있어 그 값을 우선 사용합니다. 여기 입력한 값은 환경 변수가 없을 때만 씁니다.`
              : f.id
                ? "비워 두면 기존 키를 그대로 둡니다. 새로 입력하면 교체됩니다."
                : "입력한 키는 암호화되어 저장됩니다."
          }
          aside={
            f.provider === "vertex" ? (
              <label className="cursor-pointer text-xs font-medium text-accent">
                JSON 파일 선택
                <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
              </label>
            ) : null
          }
        >
          {f.provider === "vertex" ? (
            <Textarea
              value={f.secret}
              onChange={(e) => setF((x) => ({ ...x, secret: e.target.value, secretTouched: true }))}
              placeholder={f.id ? "(저장된 값 유지) 새 서비스 계정 JSON 을 붙여넣으면 교체됩니다." : '{"type": "service_account", ...}'}
              className="font-mono text-[12px]"
            />
          ) : (
            <Input
              type="password"
              autoComplete="off"
              value={f.secret}
              onChange={(e) => setF((x) => ({ ...x, secret: e.target.value, secretTouched: true }))}
              placeholder={f.id ? "(저장된 키 유지)" : "sk-..."}
            />
          )}
        </Field>
        <details className="rounded-xl border border-line px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-medium">고급 설정 · 비용 계산</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="temperature" help="판정 일관성을 위해 0 을 권장합니다. 일부 모델은 지원하지 않아 자동으로 빼고 호출합니다. 비우면 보내지 않습니다.">
              <Input value={f.temperature} onChange={(e) => set("temperature", e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="최대 출력 토큰" help="항목이 많은 판정은 출력이 길어집니다. 기본 4096.">
              <Input value={f.max_tokens} onChange={(e) => set("max_tokens", e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="입력 단가 (USD / 100만 토큰)" help="실행마다 추정 비용을 계산할 때 씁니다.">
              <Input value={f.price_input_per_mtok} onChange={(e) => set("price_input_per_mtok", e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="출력 단가 (USD / 100만 토큰)">
              <Input value={f.price_output_per_mtok} onChange={(e) => set("price_output_per_mtok", e.target.value)} inputMode="decimal" />
            </Field>
          </div>
        </details>
        <Switch checked={f.is_default} onChange={(v) => set("is_default", v)} label="기본 판정 모델로 사용" />
      </div>
    </Dialog>
  );
}

function SecretStatus({ m }: { m: JudgeModel }) {
  if (m.secret_env) return <Badge tone="accent"><KeyRound className="h-3 w-3" />환경 변수 {m.secret_env}</Badge>;
  if (m.has_secret) return <Badge><KeyRound className="h-3 w-3" />{m.secret_hint || "저장됨"}</Badge>;
  if (m.provider === "openai_compatible") return <Badge tone="outline">키 없음</Badge>;
  return <Badge tone="warn">키 필요</Badge>;
}

export default function Models() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Form | null>(null);
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api.get<Record<string, ProviderMeta>>("/providers") });
  const models = useQuery({ queryKey: ["judge-models"], queryFn: () => api.get<JudgeModel[]>("/judge-models") });
  const [testing, setTesting] = useState<number | null>(null);

  const test = async (m: JudgeModel) => {
    setTesting(m.id);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/judge-models/${m.id}/test`);
      r.ok ? toast.success("연결 성공", r.message) : toast.error("연결 실패", r.message);
    } catch (e) {
      toast.error("연결 테스트 실패", (e as Error).message);
    } finally {
      setTesting(null);
      qc.invalidateQueries({ queryKey: ["judge-models"] });
    }
  };
  const setDefault = useMutation({
    mutationFn: (id: number) => api.post(`/judge-models/${id}/default`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["judge-models"] }),
  });
  const remove = async (m: JudgeModel) => {
    if (!(await confirm.ask({ title: `'${m.name}' 을 삭제할까요?`, body: "이 모델로 만든 실행 기록은 남지만, 중단된 실행을 이어서 돌릴 수는 없게 됩니다.", confirm: "삭제", danger: true }))) return;
    try {
      await api.del(`/judge-models/${m.id}`);
      qc.invalidateQueries({ queryKey: ["judge-models"] });
    } catch (e) {
      toast.error("삭제하지 못했습니다", (e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="연결"
        title="판정 모델"
        description="검색 결과의 관련도를 매기고 두 결과를 비교하는 LLM 입니다. Vertex AI·Gemini·Claude·GPT·로컬 모델(OpenAI 호환)을 등록하고 하나를 기본으로 지정하세요."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ ...EMPTY })}>모델 추가</Button>}
      />
      <NextStep current="judge_model" />
      <Alert tone="accent" className="mb-10" title="판정 모델 고르는 법">
        판정 품질은 모델 성능에 크게 좌우됩니다. 결론을 내리는 평가에는 가능한 한 상위 모델을, 빠른 반복 확인에는 가벼운 모델을 쓰세요. 비교하는 두 시스템이 같은 모델 계열을 쓴다면 다른 계열의 판정 모델이 편향이 적습니다.
      </Alert>
      {models.isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !models.data?.length ? (
        <Empty icon={<Bot className="h-8 w-8" />} title="등록된 판정 모델이 없습니다" action={<Button variant="primary" onClick={() => setEditing({ ...EMPTY })}>첫 모델 추가</Button>}>
          판정 모델이 있어야 단건 검색 비교의 판정과 평가를 실행할 수 있습니다.
        </Empty>
      ) : (
        <Card className="divide-y divide-line">
          {models.data.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-x-5 gap-y-3 py-5">
              <div className="min-w-0 flex-1 basis-[300px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{m.name}</span>
                  {m.is_default && <Badge tone="accent"><Star className="h-3 w-3" />기본</Badge>}
                  <Badge tone="outline">{PROVIDER_LABEL[m.provider]}</Badge>
                  <SecretStatus m={m} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
                  <span className="font-mono text-[12.5px] text-ink">{m.model}</span>
                  {m.base_url && <span className="truncate">{m.base_url}</span>}
                  {(m.price_input_per_mtok > 0 || m.price_output_per_mtok > 0) && (
                    <span>입력 ${m.price_input_per_mtok} · 출력 ${m.price_output_per_mtok} / 1M</span>
                  )}
                </div>
              </div>
              <Tooltip content={m.last_test_message || "아직 테스트하지 않았습니다"}>
                <span className="flex items-center gap-1.5 text-[13px]">
                  {m.last_test_ok === true ? (
                    <><CheckCircle2 className="h-4 w-4 text-good" /><span className="text-good">연결됨</span></>
                  ) : m.last_test_ok === false ? (
                    <><XCircle className="h-4 w-4 text-bad" /><span className="text-bad">실패</span></>
                  ) : (
                    <><CircleDashed className="h-4 w-4 text-faint" /><span className="text-muted">미확인</span></>
                  )}
                  {m.last_tested_at && <span className="text-faint">· {fmt.ago(m.last_tested_at)}</span>}
                </span>
              </Tooltip>
              <div className="flex items-center gap-1">
                <Button size="sm" icon={<Zap className="h-3.5 w-3.5" />} loading={testing === m.id} onClick={() => test(m)}>연결 테스트</Button>
                {!m.is_default && <Button size="sm" variant="ghost" onClick={() => setDefault.mutate(m.id)}>기본으로</Button>}
                <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(toForm(m))}>수정</Button>
                <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => remove(m)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {editing && providers.data && (
        <Editor key={editing.id ?? "new"} open onClose={() => setEditing(null)} initial={editing} providers={providers.data} />
      )}
      {confirm.node}
    </>
  );
}
