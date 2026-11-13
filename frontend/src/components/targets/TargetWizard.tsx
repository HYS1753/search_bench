import { useQueryClient } from "@tanstack/react-query";
import { humanName } from "@/lib/humanize";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, ClipboardPaste, Play, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ItemCard } from "@/components/results/ItemCard";
import { Drawer } from "@/components/ui/overlay";
import { ChoiceList, FormRow, Rows, Segmented, Steps } from "@/components/ui/page";
import { Alert, Badge, Button, Code, Input, Select, Spinner, Switch, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import {
  KIND_LABEL,
  SENSITIVE,
  fieldKey,
  findArrays,
  flattenItems,
  getAt,
  guessFieldRoles,
  guessKind,
  leafName,
  listStyle,
  parseRequest,
  prettyPath,
  setPath,
  typed,
  type FieldInfo,
  type FieldRole,
  type ParamKind,
  type ParsedParam,
  type ParsedRequest,
} from "@/lib/apiParse";
import { cn, fmt } from "@/lib/format";
import type { Item, ParamSpec, Target } from "@/lib/types";

const STEPS = ["요청 보내 보기", "결과에서 고르기", "저장"];
const ROLE_LABEL: Record<FieldRole, string> = {
  id: "고유 번호",
  title: "제목",
  content: "판정에 보냄",
  score: "점수(표시만)",
  skip: "안 씀",
};
const ROLE_HELP: Record<FieldRole, string> = {
  id: "같은 결과를 알아보는 값",
  title: "결과의 이름",
  content: "판정 모델이 읽는 내용",
  score: "검색 엔진 점수",
  skip: "",
};

interface Row {
  param: ParsedParam;
  kind: ParamKind;
  value: string; // 바뀌는 값은 시험 호출용 예시, 고정 값은 항상 보낼 값
  label: string; // 바뀌는 값을 입력할 때 보일 이름
  required: boolean; // 이 API 의 필수 값
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

/** 저장된 설정 → 첫 단계에 보여 줄 예시 요청(URL 또는 curl) */
function targetToExample(t: Target): string {
  const sample = (p: ParamSpec) => (p.source === "const" ? p.value : p.example || "값");
  const query = t.params.filter((p) => p.location === "query");
  const body = t.params.filter((p) => p.location === "body");
  const qs = query.flatMap((p) => {
    const v = sample(p);
    return p.array_style === "repeat" ? v.split(/\s*,\s*/).map((x) => `${p.name}=${x}`) : [`${p.name}=${v}`];
  });
  const url = `${t.base_url}${t.path}${qs.length ? `?${qs.join("&")}` : ""}`;
  if (!body.length && t.method === "GET") return url;
  const obj: Record<string, unknown> = {};
  for (const p of body) setPath(obj, p.name, p.array_style === "json" ? sample(p).split(/\s*,\s*/).map((x) => typed(x, p.json_type ?? "")) : typed(sample(p), p.json_type ?? ""));
  return `curl -X ${t.method} '${url}' -H 'Content-Type: application/json' -d '${JSON.stringify(obj)}'`;
}

function rowsFor(parsed: ParsedRequest, initial?: Target): Row[] {
  return parsed.params.map((param, i) => {
    const spec = initial?.params.find((p) => p.name === param.name && p.location === param.location);
    const value = param.values.join(", ");
    const label = spec?.label || humanName(param.name, true);
    if (initial) {
      if (!spec) return { param, kind: "skip", value, label, required: false };
      return { param, kind: spec.source === "const" ? "fixed" : "vary", value, label, required: !!spec.required };
    }
    const kind = guessKind(param, i);
    return { param, kind, value, label, required: kind === "vary" && i === 0 };
  });
}

export function TargetWizard({ initial, onClose, onAdvanced }: { initial?: Target; onClose: () => void; onAdvanced: (draft: Partial<Target> | null) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [text, setText] = useState(initial ? targetToExample(initial) : "");
  const [parsed, setParsed] = useState<ParsedRequest | null>(null);
  const [parseError, setParseError] = useState("");
  const [method, setMethod] = useState<"GET" | "POST">(initial?.method ?? "GET");
  const [rows, setRows] = useState<Row[]>([]);

  const [authType, setAuthType] = useState<"none" | "bearer" | "header">(
    initial ? (initial.auth.type === "query" ? "header" : (initial.auth.type as "none" | "bearer" | "header")) : "none",
  );
  const [headerName, setHeaderName] = useState(initial?.auth.name || "X-API-Key");
  const [secret, setSecret] = useState("");
  const [useEnv, setUseEnv] = useState(!!initial?.auth.env);
  const [envName, setEnvName] = useState(initial?.auth.env ?? "");

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [resultsPath, setResultsPath] = useState(initial?.response_mapping.results_path ?? "");
  const [roles, setRoles] = useState<Record<string, FieldRole>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [timeout, setTimeoutSec] = useState(initial?.timeout_seconds ? String(initial.timeout_seconds) : "");
  const [verifySsl, setVerifySsl] = useState(initial?.verify_ssl ?? true);
  const [saving, setSaving] = useState(false);
  const firstParse = useRef(true);

  // 붙여넣은 내용 해석
  useEffect(() => {
    if (!text.trim()) {
      setParsed(null);
      setParseError("");
      return;
    }
    try {
      const p = parseRequest(text);
      setParsed(p);
      setParseError("");
      setMethod(p.method);
      setRows((prev) => {
        if (firstParse.current) {
          firstParse.current = false;
          return rowsFor(p, initial);
        }
        const keep = new Map(prev.map((r) => [`${r.param.location}:${r.param.name}`, r]));
        return rowsFor(p).map((r) => {
          const old = keep.get(`${r.param.location}:${r.param.name}`);
          return old ? { ...r, kind: old.kind, label: old.label, required: old.required } : r;
        });
      });
      if (p.bearer) {
        setAuthType("bearer");
        setSecret(p.bearer);
        setUseEnv(false);
      } else if (p.apiKeyHeader) {
        setAuthType("header");
        setHeaderName(p.apiKeyHeader.name);
        setSecret(p.apiKeyHeader.value);
        setUseEnv(false);
      }
    } catch (e) {
      setParsed(null);
      setParseError((e as Error).message);
    }
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const params: ParamSpec[] = useMemo(() => {
    const used = new Set<string>();
    return rows
      .filter((r) => r.kind !== "skip")
      .map((r) => {
        if (r.kind === "fixed") {
          return { name: r.param.name, source: "const", field: "", value: r.value, location: r.param.location, array_style: r.param.isArray ? "json" : "", example: r.value, json_type: r.param.jsonType } as ParamSpec;
        }
        let key = fieldKey(r.param.name);
        while (used.has(key)) key = `${key}_2`;
        used.add(key);
        return { name: r.param.name, source: "field", field: key, value: "", location: r.param.location, array_style: listStyle(r.param), example: r.value, json_type: r.param.jsonType, label: r.label.trim() || humanName(r.param.name, true), required: r.required } as ParamSpec;
      });
  }, [rows]);
  const varying = params.filter((p) => p.source === "field");

  const candidates = useMemo(() => (result?.ok ? findArrays(result.raw) : []), [result]);
  const items = useMemo(() => {
    const arr = result?.ok ? getAt(result.raw, resultsPath) : undefined;
    return Array.isArray(arr) ? (arr.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
  }, [result, resultsPath]);
  const fields: FieldInfo[] = useMemo(() => flattenItems(items), [items]);

  useEffect(() => {
    if (!fields.length) return;
    const guess = guessFieldRoles(fields);
    const m = initial?.response_mapping;
    if (m && resultsPath === m.results_path) {
      for (const f of fields) {
        guess[f.path] =
          f.path === m.id_path ? "id" : f.path === m.title_path ? "title" : f.path === m.score_path ? "score" : m.text_fields.some((t) => t.path === f.path) ? "content" : "skip";
      }
      setLabels(Object.fromEntries(m.text_fields.map((t) => [t.path, t.label])));
    }
    setRoles(guess);
  }, [fields]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRole = (path: string, role: FieldRole) =>
    setRoles((cur) => {
      const next = { ...cur };
      if (role === "id" || role === "title" || role === "score") for (const k of Object.keys(next)) if (next[k] === role) next[k] = "skip";
      next[path] = role;
      return next;
    });

  const mapping = useMemo(() => {
    const pick = (role: FieldRole) => Object.entries(roles).find(([, r]) => r === role)?.[0] ?? "";
    return {
      results_path: resultsPath,
      id_path: pick("id"),
      title_path: pick("title"),
      score_path: pick("score"),
      text_fields: fields.filter((f) => roles[f.path] === "content").map((f) => ({ label: labels[f.path]?.trim() || humanName(f.path), path: f.path })),
    };
  }, [roles, labels, fields, resultsPath]);

  const body = () => ({
    name: name.trim() || `${parsed?.base_url ?? ""}${parsed?.path ?? ""}`,
    description,
    method,
    base_url: parsed?.base_url ?? initial?.base_url ?? "",
    path: parsed?.path ?? initial?.path ?? "",
    headers: parsed?.headers ?? initial?.headers ?? {},
    auth: { type: authType, name: authType === "header" ? headerName : "", env: useEnv ? envName.trim().toUpperCase() : "" },
    secret: authType === "none" ? (initial?.has_secret ? "" : null) : useEnv ? null : secret ? secret : null,
    params,
    response_mapping: mapping,
    timeout_seconds: timeout ? Number(timeout) : null,
    verify_ssl: verifySsl,
  });

  const runTest = async () => {
    if (!parsed) return;
    setTesting(true);
    try {
      const inputs: Record<string, unknown> = {};
      for (const p of varying) {
        const v = p.example.trim();
        if (v) inputs[p.field] = p.array_style ? v.split(/\s*,\s*/).filter(Boolean) : v;
      }
      const r = await api.post<TestResult>("/targets/test", {
        target: { ...body(), response_mapping: { ...mapping, results_path: mapping.results_path || "$" } },
        target_id: initial?.id ?? null,
        inputs,
      });
      setResult(r);
      if (r.ok) {
        const found = findArrays(r.raw);
        if (!found.some((c) => c.path === resultsPath)) setResultsPath(found[0]?.path ?? "");
      }
    } catch (e) {
      toast.error("호출하지 못했습니다", (e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  // 붙여넣으면 한 번 자동으로 불러 본다
  useEffect(() => {
    if (!parsed) return;
    const t = setTimeout(() => runTest(), 700);
    return () => clearTimeout(t);
  }, [parsed]); // eslint-disable-line react-hooks/exhaustive-deps

  const valueAt = (it: Record<string, unknown>, path: string) => {
    let cur: unknown[] = [it];
    for (const seg of path.split(".")) {
      const arr = seg.endsWith("[]");
      const key = arr ? seg.slice(0, -2) : seg;
      cur = cur.flatMap((c) => (c && typeof c === "object" && !Array.isArray(c) ? [(c as Record<string, unknown>)[key]] : []));
      if (arr) cur = cur.flatMap((c) => (Array.isArray(c) ? c : []));
    }
    return [...new Set(cur.flatMap((c) => (Array.isArray(c) ? c : [c])).filter((c) => c !== null && c !== undefined && c !== "").map((c) => (typeof c === "object" ? JSON.stringify(c) : String(c))))].join(" / ");
  };

  const preview: Item[] = useMemo(
    () =>
      items.slice(0, 5).map((it, i) => ({
        key: mapping.id_path ? valueAt(it, mapping.id_path) : `#${i + 1}`,
        title: mapping.title_path ? valueAt(it, mapping.title_path) : "(제목 없음)",
        fields: mapping.text_fields.map((t) => ({ label: t.label, value: valueAt(it, t.path) })).filter((f) => f.value),
        score: null,
      })),
    [items, mapping], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const save = async () => {
    setSaving(true);
    try {
      const b = body();
      if (initial) await api.put<Target>(`/targets/${initial.id}`, b);
      else await api.post<Target>("/targets", b);
      qc.invalidateQueries({ queryKey: ["targets"] });
      qc.invalidateQueries({ queryKey: ["suites"] });
      toast.success("저장했습니다", "비교 세트에서 다른 API 와 묶으면 비교할 수 있습니다.");
      onClose();
    } catch (e) {
      toast.error("저장하지 못했습니다", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const listOk = !!result?.ok && candidates.length > 0 && !!resultsPath;
  const authOk = authType === "none" || useEnv ? true : !!secret || !!initial?.has_secret;
  const canNext = [!!parsed && varying.length > 0 && listOk && authOk, !!mapping.title_path && mapping.text_fields.length > 0, true][step];
  const sensitiveSent = fields.filter((f) => roles[f.path] === "content" && SENSITIVE.test(f.path));

  const resultPanel = (
    <div className="border-t border-line pt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[15px] font-semibold">실제 응답</div>
        <Button size="sm" icon={testing ? undefined : <Play className="h-3.5 w-3.5" />} loading={testing} disabled={!parsed} onClick={runTest}>
          {result ? "다시 불러오기" : "호출해 보기"}
        </Button>
      </div>
      {!result && !testing && <div className="py-6 text-[13.5px] text-muted">요청을 붙여넣으면 자동으로 한 번 불러옵니다.</div>}
      {testing && !result && <div className="flex justify-center py-10"><Spinner /></div>}
      {result && !result.ok && (
        <Alert tone="bad" title="호출에 실패했습니다" icon={<AlertTriangle className="h-4 w-4" />}>
          {result.error}
          {"\n"}주소·값·인증을 확인하고 다시 불러오세요.
        </Alert>
      )}
      {result?.ok && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px]">
            <span className="flex items-center gap-1.5 text-good"><CheckCircle2 className="h-4 w-4" />HTTP {result.status_code}</span>
            <span className="text-muted">{fmt.ms(result.latency_ms)}</span>
            {candidates.length ? (
              <span className="text-ink">결과 목록 <b>{prettyPath(resultsPath)}</b> 에서 <b>{items.length}개</b>를 찾았습니다</span>
            ) : (
              <span className="text-warn">응답에서 결과 목록(여러 개의 항목)을 찾지 못했습니다</span>
            )}
          </div>
          {candidates.length > 1 && (
            <div className="mb-4">
              <div className="mb-2 text-[13px] text-muted">결과 목록으로 보이는 곳이 여러 개입니다. 비교할 목록을 고르세요.</div>
              <ChoiceList value={resultsPath} onChange={setResultsPath} columns={2}
                items={candidates.slice(0, 6).map((c) => ({ value: c.path, title: <span className="font-mono">{prettyPath(c.path)}</span>, desc: `${c.count}개 · ${Object.keys(c.sample).slice(0, 4).join(", ")}` }))} />
            </div>
          )}
          <Code className="max-h-[300px]">{JSON.stringify(result.raw, null, 2)}</Code>
        </>
      )}
    </div>
  );

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-6xl"
      scrollKey={step}
      title={initial ? `API 수정 · ${initial.name}` : "검색 API 연결하기"}
      subtitle="예시 요청을 붙여넣고, 실제 응답을 보면서 쓸 부분을 고릅니다."
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => onAdvanced(parsed ? (body() as unknown as Partial<Target>) : initial ?? null)}>개발자용 직접 편집</Button>
          <div className="ml-auto flex gap-2">
            {step > 0 && <Button variant="ghost" onClick={() => setStep(step - 1)}><ArrowLeft className="h-4 w-4" />이전</Button>}
            {step < 2 ? (
              <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>다음<ArrowRight className="h-4 w-4" /></Button>
            ) : (
              <Button variant="primary" loading={saving} icon={<Check className="h-4 w-4" />} onClick={save}>저장</Button>
            )}
          </div>
        </div>
      }
    >
      <Steps steps={STEPS} current={step} onJump={(i) => i <= step && setStep(i)} />

      {step === 0 && (
        <>
          <div className="mb-2 flex items-center gap-2 text-[15px] font-semibold"><ClipboardPaste className="h-4 w-4" />API 를 한 번 호출하는 예시 요청을 붙여넣으세요</div>
          <p className="mb-4 break-keep text-[14px] leading-relaxed text-muted">
            브라우저 주소창의 URL, API 문서의 예시, <b className="text-ink">curl 명령</b> 모두 됩니다. 붙여넣으면 자동으로 한 번 불러 보고 응답을 아래에 보여 줍니다.
          </p>
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]"
            placeholder={"https://api.example.com/v1/search?query=검색어&size=10\n또는  curl -H 'Authorization: Bearer sk-…' 'https://api.example.com/v1/search?query=검색어'"} />
          {parseError && <Alert tone="bad" className="mt-3">{parseError}</Alert>}

          {parsed && (
            <div className="mt-8">
              <Rows>
                <FormRow label="주소">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[13.5px]">
                    <Select className="h-9 w-24" value={method} onChange={(e) => setMethod(e.target.value as "GET" | "POST")}>
                      <option>GET</option>
                      <option>POST</option>
                    </Select>
                    <span className="min-w-0 break-all">{parsed.base_url}<span className="text-accent">{parsed.path}</span></span>
                  </div>
                </FormRow>
                <FormRow label="입력 방식" help={<>비교할 때마다 달라지는 값(검색어·분류 등)은 <b className="text-ink">바뀌는 값</b>, 항상 같은 값은 <b className="text-ink">고정 값</b>으로 두세요. 바뀌는 값이 이 API 의 입력칸이 되고, 필수 값은 비교·평가 전에 비어 있는지 검사합니다.</>}>
                  {rows.length === 0 ? (
                    <Alert tone="warn">요청에 보내는 값(?이름=값 또는 본문)이 없습니다. 값을 하나 이상 넣어 호출하는 예시를 붙여넣어 주세요.</Alert>
                  ) : (
                    <div className="divide-y divide-line border-y border-line">
                      {rows.map((r, i) => (
                        <div key={`${r.param.location}:${r.param.name}`} className="grid items-center gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(90px,0.6fr)_minmax(0,1.4fr)_auto]">
                          <div className="min-w-0">
                            <div className="truncate font-mono text-[13.5px] font-semibold" title={r.param.name}>{r.param.name}</div>
                            <div className="text-[11.5px] text-faint">{r.param.location === "body" ? "요청 본문" : "주소"}{r.param.values.length > 1 || r.param.isArray ? " · 여러 값" : ""}</div>
                          </div>
                          <Input className={cn("h-9", r.kind === "skip" && "opacity-50")} value={r.value} disabled={r.kind === "skip"}
                            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                            placeholder={r.kind === "vary" ? "시험 호출에 쓸 예시 값" : "항상 보낼 값"} />
                          <Segmented value={r.kind} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, kind: v } : x)))}
                            items={(Object.keys(KIND_LABEL) as ParamKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
                          {r.kind === "vary" && (
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-2 sm:col-start-2">
                              <label className="flex min-w-[220px] flex-1 items-center gap-2 text-[12.5px] text-muted">
                                입력할 때 보일 이름
                                <Input className="h-8 flex-1" value={r.label} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder={humanName(r.param.name, true)} />
                              </label>
                              <label className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted">
                                <input type="checkbox" checked={r.required} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
                                필수 여부
                              </label>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {rows.length > 0 && varying.length === 0 && <Alert tone="warn" className="mt-3">바뀌는 값이 하나 이상 있어야 비교할 때 입력을 넣을 수 있습니다.</Alert>}
                  {rows.some((r) => r.kind === "vary" && (r.param.values.length > 1 || r.param.isArray)) && (
                    <div className="mt-2 text-[12.5px] text-muted">여러 값은 쉼표(,)로 구분해 적습니다.</div>
                  )}
                </FormRow>
                <FormRow label="인증" help={authType !== "none" && !useEnv && secret && (parsed.bearer || parsed.apiKeyHeader) ? "붙여넣은 요청에서 키를 찾았습니다." : "키가 필요한 API 만 설정하세요."}>
                  <Segmented value={authType} onChange={setAuthType} items={[{ value: "none", label: "필요 없음" }, { value: "bearer", label: "API 키 (Bearer)" }, { value: "header", label: "API 키 (헤더)" }]} />
                  {authType !== "none" && (
                    <div className="mt-3 space-y-3">
                      {authType === "header" && <Input value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="헤더 이름 (예: X-API-Key)" />}
                      {useEnv ? (
                        <Input value={envName} onChange={(e) => setEnvName(e.target.value.toUpperCase())} placeholder="서버 환경 변수 이름 (예: SEARCH_API_KEY)" />
                      ) : (
                        <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={initial?.has_secret ? `저장된 키 ${initial.secret_hint} 유지 — 바꿀 때만 입력` : "키 (암호화해 저장)"} />
                      )}
                      <Switch checked={useEnv} onChange={setUseEnv} label={<span className="text-[13px] text-muted">키를 화면에 저장하지 않고 서버 환경 변수(.env)에서 읽기</span>} />
                    </div>
                  )}
                </FormRow>
              </Rows>
              <div className="mt-8">{resultPanel}</div>
            </div>
          )}
        </>
      )}

      {step === 1 && (
        <>
          <div className="mb-1 text-[15px] font-semibold">실제 결과를 보면서, 각 항목에서 무엇을 쓸지 고르세요</div>
          <p className="mb-5 break-keep text-[14px] text-muted">
            <b className="text-ink">제목</b> 1개와 <b className="text-ink">판정에 보냄</b> 1개 이상이 필요합니다. <b className="text-ink">고유 번호</b>를 고르면 두 API 에 같은 결과가 있을 때 한 번만 판정하고 순위 변화를 보여 줍니다.
          </p>
          <div className="mb-6 flex flex-wrap items-end gap-3 border-y border-line py-4">
            {rows.filter((r) => r.kind === "vary").map((r) => (
              <label key={r.param.name} className="min-w-[160px] flex-1">
                <span className="mb-1 block font-mono text-[12px] text-muted">{r.param.name}</span>
                <Input className="h-9" value={r.value} onChange={(e) => setRows(rows.map((x) => (x === r ? { ...x, value: e.target.value } : x)))} />
              </label>
            ))}
            <Button icon={<RefreshCw className="h-4 w-4" />} loading={testing} onClick={runTest}>다른 값으로 불러오기</Button>
          </div>
          {!items.length ? (
            <Alert tone="warn">결과가 0건입니다. 결과가 나오는 값으로 다시 불러와 주세요.</Alert>
          ) : (
            <div className="scroll-thin -mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[820px] text-[13.5px]">
                <thead className="border-b border-line text-[12.5px] text-muted">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">필드</th>
                    {items.slice(0, 3).map((_, i) => <th key={i} className="px-3 py-3 text-left font-medium">{i + 1}번째 결과</th>)}
                    <th className="w-[170px] px-3 py-3 text-left font-medium">쓰임새</th>
                    <th className="w-[160px] px-3 py-3 text-left font-medium">판정에 보일 이름</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {fields.map((f) => {
                    const role = roles[f.path] ?? "skip";
                    const sensitive = SENSITIVE.test(f.path);
                    return (
                      <tr key={f.path} className={cn(role !== "skip" && "bg-accent-soft/30")}>
                        <td className="px-3 py-2.5">
                          <div className="font-mono text-[12.5px] font-semibold">{leafName(f.path)}</div>
                          {f.path !== leafName(f.path) && <div className="font-mono text-[11px] text-faint">{prettyPath(f.path)}</div>}
                          {sensitive && <Badge tone="warn" className="mt-1"><ShieldAlert className="h-3 w-3" />개인정보</Badge>}
                        </td>
                        {items.slice(0, 3).map((it, i) => {
                          const v = valueAt(it, f.path);
                          return (
                            <td key={i} className={cn("max-w-[220px] px-3 py-2.5", role === "skip" ? "text-muted" : "text-ink")}>
                              <div className="line-clamp-2 break-all" title={v}>{v || <span className="text-faint">–</span>}</div>
                            </td>
                          );
                        })}
                        <td className="px-3 py-2.5">
                          <Select className="h-9" value={role} title={ROLE_HELP[role]} onChange={(e) => setRole(f.path, e.target.value as FieldRole)}>
                            {(Object.keys(ROLE_LABEL) as FieldRole[]).filter((r) => r !== "score" || f.kind === "number").map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                          </Select>
                        </td>
                        <td className="px-3 py-2.5">
                          {role === "content" ? (
                            <Input className="h-9" value={labels[f.path] ?? humanName(f.path)} placeholder={leafName(f.path)} onChange={(e) => setLabels((x) => ({ ...x, [f.path]: e.target.value }))} />
                          ) : <span className="text-faint">–</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {sensitiveSent.length > 0 && (
            <Alert tone="warn" className="mt-4" icon={<ShieldAlert className="h-4 w-4" />}>
              개인정보로 보이는 필드({sensitiveSent.map((f) => leafName(f.path)).join(", ")})를 판정 모델에 보냅니다. 필요하지 않다면 ‘안 씀’으로 바꾸세요.
            </Alert>
          )}
          <div className="mt-10">
            <div className="mb-1 text-[15px] font-semibold">판정 모델이 보게 될 모습</div>
            <div className="mb-3 text-[13px] text-muted">비교·평가 화면에도 이렇게 보입니다.</div>
            {!mapping.title_path || !mapping.text_fields.length ? (
              <Alert tone="warn">제목과 ‘판정에 보냄’ 필드를 하나 이상 고르면 미리보기가 나옵니다.</Alert>
            ) : (
              <div className="divide-y divide-line border-y border-line">
                {preview.map((it, i) => <ItemCard key={i} item={it} rank={i + 1} />)}
              </div>
            )}
          </div>
        </>
      )}

      {step === 2 && (
        <Rows>
          <FormRow label="이름" required help="목록과 결과 화면에 보일 이름입니다. 운영/변경안이 드러나게 지으세요.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 상품 검색 · 운영" autoFocus />
          </FormRow>
          <FormRow label="메모"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="버전·배포 환경 등" /></FormRow>
          <FormRow label="응답 대기 시간" help="비우면 기본 30초입니다.">
            <Input value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} inputMode="decimal" placeholder="30" className="max-w-[160px]" />
          </FormRow>
          <FormRow label="인증서 검사" help="사내 인증서 때문에 연결이 안 될 때만 끄세요.">
            <Switch checked={verifySsl} onChange={setVerifySsl} label={verifySsl ? "검사함" : "검사하지 않음"} />
          </FormRow>
          <FormRow label="정리">
            <dl className="space-y-1.5 text-[13.5px]">
              <div className="flex flex-wrap gap-x-3"><dt className="w-20 text-muted">요청</dt><dd className="min-w-0 break-all font-mono">{method} {parsed?.base_url}{parsed?.path}</dd></div>
              <div className="flex flex-wrap gap-x-3"><dt className="w-20 text-muted">입력</dt><dd>{varying.map((p) => `${p.label}${p.required ? "(필수)" : ""}`).join(", ") || "없음"}</dd></div>
              <div className="flex flex-wrap gap-x-3"><dt className="w-20 text-muted">고정 값</dt><dd className="min-w-0 break-all">{params.filter((p) => p.source === "const").map((p) => `${p.name}=${p.value}`).join(", ") || "없음"}</dd></div>
              <div className="flex flex-wrap gap-x-3"><dt className="w-20 text-muted">인증</dt><dd>{authType === "none" ? "없음" : useEnv ? `환경 변수 ${envName}` : "저장된 키"}</dd></div>
              <div className="flex flex-wrap gap-x-3"><dt className="w-20 text-muted">결과</dt><dd className="min-w-0">제목 {leafName(mapping.title_path)} · 판정 내용 {mapping.text_fields.map((t) => t.label).join(", ")}{mapping.id_path ? ` · 고유 번호 ${leafName(mapping.id_path)}` : ""}</dd></div>
            </dl>
          </FormRow>
        </Rows>
      )}
    </Drawer>
  );
}
