import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NextStep } from "@/components/onboarding/NextStep";
import { Code2, Copy, KeyRound, Pencil, Play, Plug, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ItemCard } from "@/components/results/ItemCard";
import { TargetWizard } from "@/components/targets/TargetWizard";
import { Drawer, useConfirm } from "@/components/ui/overlay";
import { PageHeader, Rows } from "@/components/ui/page";
import { Alert, Badge, Button, Card, Code, Empty, Field, Input, Kbd, Select, Spinner, Switch } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { AuthSpec, Item, ParamSpec, ResponseMapping, Target } from "@/lib/types";

interface Form {
  id?: number;
  name: string;
  description: string;
  method: "GET" | "POST";
  base_url: string;
  path: string;
  headers: { key: string; value: string }[];
  auth: AuthSpec;
  has_secret: boolean;
  secret_hint: string;
  secret: string;
  secretTouched: boolean;
  params: ParamSpec[];
  response_mapping: ResponseMapping;
  timeout_seconds: string;
  verify_ssl: boolean;
}

const EMPTY: Form = {
  name: "",
  description: "",
  method: "GET",
  base_url: "",
  path: "",
  headers: [],
  auth: { type: "none", name: "", env: "" },
  has_secret: false,
  secret_hint: "",
  secret: "",
  secretTouched: false,
  params: [{ name: "query", source: "field", field: "query", value: "", location: "query", array_style: "", example: "" }],
  response_mapping: { results_path: "results", id_path: "id", title_path: "title", score_path: "", text_fields: [{ label: "내용", path: "content" }] },
  timeout_seconds: "",
  verify_ssl: true,
};

function toForm(t: Target): Form {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    method: t.method,
    base_url: t.base_url,
    path: t.path,
    headers: Object.entries(t.headers ?? {}).map(([key, value]) => ({ key, value })),
    auth: { ...EMPTY.auth, ...t.auth },
    has_secret: t.has_secret,
    secret_hint: t.secret_hint,
    secret: "",
    secretTouched: false,
    params: t.params.map((p) => ({ ...EMPTY.params[0], ...p })),
    response_mapping: { ...EMPTY.response_mapping, ...t.response_mapping },
    timeout_seconds: t.timeout_seconds ? String(t.timeout_seconds) : "",
    verify_ssl: t.verify_ssl,
  };
}

function payload(f: Form) {
  return {
    name: f.name.trim(),
    description: f.description,
    method: f.method,
    base_url: f.base_url.trim(),
    path: f.path.trim(),
    headers: Object.fromEntries(f.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])),
    auth: f.auth,
    secret: f.secretTouched ? f.secret : null,
    params: f.params.filter((p) => p.name.trim()),
    response_mapping: { ...f.response_mapping, text_fields: f.response_mapping.text_fields.filter((t) => t.path.trim()) },
    timeout_seconds: f.timeout_seconds ? Number(f.timeout_seconds) : null,
    verify_ssl: f.verify_ssl,
  };
}

interface TestResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  error: string;
  items: Item[];
  raw: unknown;
  request: Record<string, unknown>;
}

function SubHead({ n, title, desc }: { n: number; title: string; desc?: string }) {
  return (
    <div className="mb-4 flex gap-3">
      <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-panel">{n}</span>
      <div>
        <div className="text-[15px] font-semibold">{title}</div>
        {desc && <div className="mt-0.5 text-[13px] leading-relaxed text-muted">{desc}</div>}
      </div>
    </div>
  );
}

function Editor({ initial, onClose }: { initial: Form; onClose: () => void }) {
  const [f, setF] = useState<Form>(initial);
  const [testInputs, setTestInputs] = useState<Record<string, string>>(() => Object.fromEntries(initial.params.filter((p) => p.source === "field").map((p) => [p.field || p.name, p.example ?? ""])));
  const [result, setResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const setParam = (i: number, patch: Partial<ParamSpec>) => set("params", f.params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const setMap = (patch: Partial<ResponseMapping>) => set("response_mapping", { ...f.response_mapping, ...patch });
  const fieldKeys = useMemo(() => [...new Set(f.params.filter((p) => p.source === "field").map((p) => p.field || p.name).filter(Boolean))], [f.params]);

  const save = useMutation({
    mutationFn: () => (f.id ? api.put<Target>(`/targets/${f.id}`, payload(f)) : api.post<Target>("/targets", payload(f))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["targets"] });
      qc.invalidateQueries({ queryKey: ["suites"] });
      toast.success("저장했습니다");
      onClose();
    },
    onError: (e: Error) => toast.error("저장하지 못했습니다", e.message),
  });

  const runTest = async () => {
    setTesting(true);
    try {
      const inputs: Record<string, unknown> = {};
      for (const k of fieldKeys) {
        const v = (testInputs[k] ?? "").trim();
        if (!v) continue;
        const spec = f.params.find((p) => (p.field || p.name) === k);
        inputs[k] = spec?.array_style ? v.split(/[\s,]+/).filter(Boolean) : v;
      }
      setResult(await api.post<TestResult>("/targets/test", { target: payload(f), target_id: f.id ?? null, inputs }));
    } catch (e) {
      toast.error("테스트 호출 실패", (e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={f.id ? `직접 편집 · ${initial.name}` : "검색 API 직접 편집"}
      subtitle="개발자용 화면입니다. 요청 파라미터와 응답 경로를 직접 적습니다."
      width="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>취소</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || !f.base_url.trim()} onClick={() => save.mutate()}>저장</Button>
        </>
      }
    >
      <div className="space-y-10">
        <section>
          <SubHead n={1} title="기본 정보" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="이름" required><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="예: 상품 검색 · 운영" /></Field>
            <Field label="설명"><Input value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="버전·환경 메모" /></Field>
          </div>
        </section>

        <section>
          <SubHead n={2} title="요청" desc="입력 필드 값이 어떤 파라미터로 전달되는지 정합니다. 비어 있는 선택 입력은 보내지 않습니다." />
          <div className="grid gap-4 sm:grid-cols-[110px_1fr_1fr]">
            <Field label="메서드">
              <Select value={f.method} onChange={(e) => set("method", e.target.value as Form["method"])}>
                <option>GET</option>
                <option>POST</option>
              </Select>
            </Field>
            <Field label="서버 주소" required><Input value={f.base_url} onChange={(e) => set("base_url", e.target.value)} placeholder="https://api.example.com" /></Field>
            <Field label="경로" help={<>경로 변수는 <Kbd>{"{name}"}</Kbd> 로 적고 위치를 path 로 지정</>}>
              <Input value={f.path} onChange={(e) => set("path", e.target.value)} placeholder="/v1/search" />
            </Field>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-medium">파라미터</div>
              <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => set("params", [...f.params, { name: "", source: "field", field: "", value: "", location: "query", array_style: "", example: "" }])}>추가</Button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-subtle text-[12px] text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">파라미터 이름</th>
                    <th className="px-3 py-2 text-left font-medium">값 출처</th>
                    <th className="px-3 py-2 text-left font-medium">입력 필드 key / 고정값</th>
                    <th className="px-3 py-2 text-left font-medium">위치</th>
                    <th className="px-3 py-2 text-left font-medium">목록 전달 방식</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {f.params.map((p, i) => (
                    <tr key={i}>
                      <td className="p-2"><Input className="h-9" value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} placeholder="q" /></td>
                      <td className="p-2">
                        <Select className="h-9" value={p.source} onChange={(e) => setParam(i, { source: e.target.value as ParamSpec["source"] })}>
                          <option value="field">입력 필드</option>
                          <option value="const">고정값</option>
                        </Select>
                      </td>
                      <td className="p-2">
                        {p.source === "field" ? (
                          <Input className="h-9" value={p.field} onChange={(e) => setParam(i, { field: e.target.value })} placeholder={p.name || "필드 key"} />
                        ) : (
                          <Input className="h-9" value={p.value} onChange={(e) => setParam(i, { value: e.target.value })} placeholder="고정값" />
                        )}
                      </td>
                      <td className="p-2">
                        <Select className="h-9" value={p.location} onChange={(e) => setParam(i, { location: e.target.value as ParamSpec["location"] })}>
                          <option value="query">query</option>
                          <option value="body">body(JSON)</option>
                          <option value="path">path</option>
                        </Select>
                      </td>
                      <td className="p-2">
                        <Select className="h-9" value={p.array_style} onChange={(e) => setParam(i, { array_style: e.target.value as ParamSpec["array_style"] })}>
                          <option value="">단일 값</option>
                          <option value="repeat">키 반복 (?k=a&k=b)</option>
                          <option value="space">공백 결합 (a b)</option>
                          <option value="comma">쉼표 결합 (a,b)</option>
                          <option value="json">JSON 배열</option>
                        </Select>
                      </td>
                      <td className="p-2 text-right">
                        <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => set("params", f.params.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-xs text-muted">입력 필드 key 는 비교 세트에서 정의한 입력 필드(q, keywords 등)와 같아야 값이 들어갑니다.</div>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Field label="인증 방식">
              <Select value={f.auth.type} onChange={(e) => set("auth", { ...f.auth, type: e.target.value as AuthSpec["type"] })}>
                <option value="none">없음</option>
                <option value="bearer">Authorization: Bearer</option>
                <option value="header">헤더</option>
                <option value="query">쿼리 파라미터</option>
              </Select>
            </Field>
            {(f.auth.type === "header" || f.auth.type === "query") && (
              <Field label={f.auth.type === "header" ? "헤더 이름" : "파라미터 이름"}>
                <Input value={f.auth.name} onChange={(e) => set("auth", { ...f.auth, name: e.target.value })} placeholder={f.auth.type === "header" ? "X-API-Key" : "api_key"} />
              </Field>
            )}
            {f.auth.type !== "none" && (
              <Field label="환경 변수 이름" help="이 이름의 환경 변수가 있으면 그 값을 우선 사용합니다.">
                <Input value={f.auth.env} onChange={(e) => set("auth", { ...f.auth, env: e.target.value.toUpperCase() })} placeholder="ASIS_API_KEY" />
              </Field>
            )}
          </div>
          {f.auth.type !== "none" && (
            <Field className="mt-4" label="키 (선택)"
              help={f.has_secret && !f.secretTouched ? `저장된 키 ${f.secret_hint} 를 씁니다. 새로 입력하면 교체됩니다.` : "환경 변수 대신 화면에서 넣는 경우. 암호화해 저장합니다."}>
              <Input type="password" autoComplete="off" value={f.secret} onChange={(e) => setF((x) => ({ ...x, secret: e.target.value, secretTouched: true }))} placeholder={f.has_secret ? "(저장된 키 유지)" : ""} />
            </Field>
          )}
          <details className="mt-4 rounded-xl border border-line px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-medium">고급 · 헤더 · 타임아웃 · SSL</summary>
            <div className="mt-4 space-y-2">
              {f.headers.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <Input className="h-9" value={h.key} placeholder="헤더 이름" onChange={(e) => set("headers", f.headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                  <Input className="h-9" value={h.value} placeholder="값" onChange={(e) => set("headers", f.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <Button size="icon" variant="ghost" onClick={() => set("headers", f.headers.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set("headers", [...f.headers, { key: "", value: "" }])}>헤더 추가</Button>
              <div className="grid gap-4 pt-2 sm:grid-cols-2">
                <Field label="타임아웃(초)" help="비우면 TARGET_TIMEOUT_SECONDS(기본 30초)">
                  <Input value={f.timeout_seconds} onChange={(e) => set("timeout_seconds", e.target.value)} inputMode="decimal" />
                </Field>
                <div className="pt-7"><Switch checked={f.verify_ssl} onChange={(v) => set("verify_ssl", v)} label="SSL 인증서 검증" /></div>
              </div>
            </div>
          </details>
        </section>

        <section>
          <SubHead n={3} title="응답 매핑" desc="응답 JSON 에서 결과 목록과 각 항목의 ID·제목·내용을 꺼냅니다. 판정 모델에는 여기서 고른 내용만 전달됩니다(연락처 등은 넣지 마세요)." />
          <Alert className="mb-4">
            경로 문법 · <Kbd>results</Kbd> 최상위 키 · <Kbd>data.items</Kbd> 중첩 · <Kbd>items[].name</Kbd> 배열의 모든 값 · <Kbd>items[0].name</Kbd> 특정 순번 · <Kbd>$</Kbd> 응답 전체
          </Alert>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="결과 목록 경로" required help="응답에서 결과 배열이 있는 위치"><Input value={f.response_mapping.results_path} onChange={(e) => setMap({ results_path: e.target.value })} /></Field>
            <Field label="항목 ID 경로" help="대상 간 같은 항목을 알아보는 키. 비우면 내용으로 자동 생성"><Input value={f.response_mapping.id_path} onChange={(e) => setMap({ id_path: e.target.value })} /></Field>
            <Field label="제목 경로" help="항목 이름(사람 이름, 조직명, 문서 제목 등)"><Input value={f.response_mapping.title_path} onChange={(e) => setMap({ title_path: e.target.value })} /></Field>
            <Field label="점수 경로 (선택)" help="검색 엔진 점수 — 화면 표시용, 판정에는 쓰지 않음"><Input value={f.response_mapping.score_path} onChange={(e) => setMap({ score_path: e.target.value })} /></Field>
          </div>
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-medium">판정에 보낼 내용 필드</div>
              <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setMap({ text_fields: [...f.response_mapping.text_fields, { label: "", path: "" }] })}>추가</Button>
            </div>
            <div className="space-y-2">
              {f.response_mapping.text_fields.map((t, i) => (
                <div key={i} className="flex gap-2">
                  <Input className="h-9 w-48" value={t.label} placeholder="표시 이름" onChange={(e) => setMap({ text_fields: f.response_mapping.text_fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <Input className="h-9 flex-1 font-mono text-[12.5px]" value={t.path} placeholder="경로" onChange={(e) => setMap({ text_fields: f.response_mapping.text_fields.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
                  <Button size="icon" variant="ghost" onClick={() => setMap({ text_fields: f.response_mapping.text_fields.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <SubHead n={4} title="테스트 호출" desc="저장하기 전에 실제로 불러 보고, 매핑된 결과를 확인하세요." />
          <Card className="py-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {fieldKeys.map((k) => (
                <Field key={k} label={k}>
                  <Input className="h-9" value={testInputs[k] ?? ""} onChange={(e) => setTestInputs((x) => ({ ...x, [k]: e.target.value }))} />
                </Field>
              ))}
            </div>
            <Button className="mt-4" icon={<Play className="h-4 w-4" />} loading={testing} disabled={!f.base_url.trim()} onClick={runTest}>테스트 호출</Button>
          </Card>
          {result && (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={result.ok ? "good" : "bad"}>{result.ok ? "성공" : "실패"}</Badge>
                {result.status_code && <span className="text-muted">HTTP {result.status_code}</span>}
                <span className="text-muted">· {fmt.ms(result.latency_ms)}</span>
                {result.ok && <span className="text-muted">· 항목 {result.items.length}개</span>}
              </div>
              {result.error && <Alert tone="bad">{result.error}</Alert>}
              {result.ok && result.items.length === 0 && (
                <Alert tone="warn" title="매핑된 항목이 없습니다">결과 목록 경로가 응답 구조와 맞는지 아래 원본 응답에서 확인하세요.</Alert>
              )}
              <div className="divide-y divide-line border-y border-line">
                {result.items.slice(0, 5).map((it, i) => <ItemCard key={it.key} item={it} rank={i + 1} />)}
              </div>
              <details className="rounded-xl border border-line px-4 py-3">
                <summary className="cursor-pointer text-[13px] font-medium">보낸 요청 (키는 가림)</summary>
                <Code className="mt-3">{JSON.stringify(result.request, null, 2)}</Code>
              </details>
              <details className="rounded-xl border border-line px-4 py-3" open={!result.items.length}>
                <summary className="cursor-pointer text-[13px] font-medium">원본 응답</summary>
                <Code className="mt-3">{JSON.stringify(result.raw, null, 2)}</Code>
              </details>
            </div>
          )}
        </section>
      </div>
    </Drawer>
  );
}

export default function Targets() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Form | null>(null);
  const [wizard, setWizard] = useState<{ initial?: Target } | null>(null);
  const targets = useQuery({ queryKey: ["targets"], queryFn: () => api.get<Target[]>("/targets") });
  const duplicate = async (t: Target) => {
    await api.post(`/targets/${t.id}/duplicate`);
    qc.invalidateQueries({ queryKey: ["targets"] });
    toast.success("복사했습니다", "변경안(TOBE)처럼 주소만 다른 대상을 만들 때 편합니다. 복사본의 주소를 바꿔 주세요.");
  };
  const remove = async (t: Target) => {
    if (!(await confirm.ask({ title: `'${t.name}' 을 삭제할까요?`, confirm: "삭제", danger: true }))) return;
    try {
      await api.del(`/targets/${t.id}`);
      qc.invalidateQueries({ queryKey: ["targets"] });
    } catch (e) {
      toast.error("삭제할 수 없습니다", (e as Error).message);
    }
  };
  const openAdvanced = (draft: Partial<Target> | null, base?: Target) => {
    setWizard(null);
    const merged = { ...(base ?? {}), ...(draft ?? {}) } as Target;
    setEditing(draft || base ? { ...toForm({ ...merged, auth: { ...EMPTY.auth, ...(merged.auth ?? {}) }, params: merged.params ?? [], response_mapping: { ...EMPTY.response_mapping, ...(merged.response_mapping ?? {}) }, headers: merged.headers ?? {}, has_secret: base?.has_secret ?? false, secret_hint: base?.secret_hint ?? "" } as Target), id: base?.id } : { ...EMPTY });
  };
  return (
    <>
      <PageHeader
        eyebrow="연결"
        title="검색 API"
        description="비교할 API 를 연결합니다. 예시 요청을 붙여넣고 실제 응답에서 쓸 부분만 고르면 됩니다. 운영(ASIS)과 변경안(TOBE)을 각각 연결한 뒤 비교 세트에서 묶습니다."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setWizard({})}>API 연결하기</Button>}
      />
      <NextStep current="targets" />
      {targets.isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !targets.data?.length ? (
        <Empty icon={<Plug className="h-8 w-8" />} title="연결된 API 가 없습니다"
          action={<Button variant="primary" onClick={() => setWizard({})}>API 연결하기</Button>}>
          API 를 한 번 호출하는 예시 요청(주소 또는 curl) 하나만 있으면 됩니다.
        </Empty>
      ) : (
        <Rows>
          {targets.data.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 py-5">
              <div className="min-w-0 flex-1 basis-[320px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15.5px] font-semibold">{t.name}</span>
                  {t.auth.type !== "none" && (
                    <Badge tone={t.has_secret || t.auth.env ? "neutral" : "warn"}>
                      <KeyRound className="h-3 w-3" />
                      {t.auth.env ? `환경 변수 ${t.auth.env}` : t.has_secret ? t.secret_hint : "키 없음"}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 break-all font-mono text-[12.5px] text-muted">
                  <span className={cn("mr-2 font-semibold", t.method === "GET" ? "text-good" : "text-accent")}>{t.method}</span>
                  {t.base_url}{t.path}
                </div>
                <div className="mt-1.5 text-[13px] text-muted">
                  바뀌는 값 {t.params.filter((p) => p.source === "field").map((p) => p.name).join(", ") || "없음"} · 판정 내용 {t.response_mapping.text_fields.map((f) => f.label).join(", ") || "없음"}
                  {t.description && <> · {t.description}</>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setWizard({ initial: t })}>수정</Button>
                <Button size="icon" variant="ghost" aria-label="개발자용 직접 편집" title="개발자용 직접 편집" onClick={() => openAdvanced(null, t)}><Code2 className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="복사" title="복사" onClick={() => duplicate(t)}><Copy className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="삭제" title="삭제" onClick={() => remove(t)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </Rows>
      )}
      {wizard && (
        <TargetWizard
          key={wizard.initial?.id ?? "new"}
          initial={wizard.initial}
          onClose={() => setWizard(null)}
          onAdvanced={(draft) => openAdvanced(draft, wizard.initial)}
        />
      )}
      {editing && <Editor key={editing.id ?? "new"} initial={editing} onClose={() => setEditing(null)} />}
      {confirm.node}
    </>
  );
}
