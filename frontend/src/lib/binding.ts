// 비교 세트의 '공통 입력'과 API 별 파라미터를 잇는 규칙 — 자동 추측과 표시용 이름.
import type { Binding, InputField, ParamSpec, Target, Transform } from "./types";

export const TRANSFORM_LABEL: Record<Transform, string> = {
  as_is: "그대로",
  join_space: "공백으로 합치기",
  join_comma: "쉼표로 합치기",
  split: "목록으로 나누기",
  first: "첫 번째 값만",
  number: "숫자로",
  const: "고정 값",
  template: "조합 문장",
};

const SYNONYMS = [
  ["q", "query", "question", "text", "keyword", "search", "term", "prompt", "input", "message", "content", "sentence", "querytext", "search_query"],
  ["keywords", "kw", "terms", "tags", "keyword_list"],
  ["top_k", "topk", "size", "limit", "k", "n", "count", "rows", "page_size", "pagesize", "num", "num_results", "max_results"],
  ["lang", "locale", "language"],
  ["page", "page_no", "offset", "from", "start"],
  ["category", "cat", "type", "filter"],
];

export function leaf(name: string): string {
  return (name.split(/[.[\]]+/).filter(Boolean).pop() ?? name).toLowerCase();
}

function group(name: string): number {
  const n = leaf(name).replace(/[-\s]/g, "_");
  return SYNONYMS.findIndex((g) => g.includes(n));
}

export function varyParams(t: Target | undefined): ParamSpec[] {
  return (t?.params ?? []).filter((p) => p.source === "field" && (p.field || p.name));
}

export function paramKey(p: ParamSpec): string {
  return p.field || p.name;
}

/** 기준 API 의 바뀌는 값으로 공통 입력을 만든다. */
export function inputsFrom(t: Target | undefined): InputField[] {
  return varyParams(t).map((p) => ({
    key: paramKey(p),
    label: leaf(p.name),
    type: p.array_style ? "list" : /^-?\d+$/.test((p.example ?? "").trim()) || p.json_type === "number" ? "int" : "text",
    required: false,
    default: null,
    help: p.example ? `예: ${p.example}` : "",
  }));
}

function transformFor(input: InputField, p: ParamSpec): Transform {
  const paramIsList = !!p.array_style;
  if (input.type === "list" && !paramIsList) return "join_space";
  if (input.type !== "list" && paramIsList) return "split";
  if (p.json_type === "number" || (input.type === "int" && p.location === "body")) return "number";
  return "as_is";
}

/** API 의 바뀌는 값 하나를 어느 공통 입력에서 가져올지 추측한다. */
export function guessBinding(p: ParamSpec, inputs: InputField[], baselineExamples: Record<string, string>): Binding {
  const key = paramKey(p);
  const same = inputs.find((i) => i.key === key);
  if (same) return { from: same.key, transform: transformFor(same, p), value: "" };
  // 단수·복수, 경로 끝 이름이 같은 것(keyword ↔ keywords, query.text ↔ text)
  const stem = (n: string) => leaf(n).replace(/(es|s)$/, "");
  const close = inputs.find((i) => stem(i.key) === stem(p.name) || stem(i.label) === stem(p.name));
  if (close) return { from: close.key, transform: transformFor(close, p), value: "" };
  const g = group(p.name);
  const syn = g >= 0 ? inputs.find((i) => group(i.key) === g || group(i.label) === g) : undefined;
  if (syn) return { from: syn.key, transform: transformFor(syn, p), value: "" };
  const ex = (p.example ?? "").trim();
  const byExample = ex ? inputs.find((i) => (baselineExamples[i.key] ?? "").trim() === ex) : undefined;
  if (byExample) return { from: byExample.key, transform: transformFor(byExample, p), value: "" };
  return { from: "", transform: "as_is", value: "" };
}

/** 저장된 연결이 없으면 이전 동작(같은 이름 그대로)을 보여 준다. */
export function effectiveBinding(p: ParamSpec, saved: Record<string, Binding> | undefined, inputs: InputField[]): Binding {
  const b = saved?.[paramKey(p)];
  if (b) return { from: b.from ?? "", transform: b.transform ?? "as_is", value: b.value ?? "" };
  return inputs.some((i) => i.key === paramKey(p)) ? { from: paramKey(p), transform: "as_is", value: "" } : { from: "", transform: "as_is", value: "" };
}

// ── 공통 입력 / API 전용 입력 자동 구성 ─────────────────────────

export function scopedKey(label: string, key: string): string {
  const l = label.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "api";
  return `${/^\d/.test(l) ? `a${l}` : l}__${key}`;
}

function inputTypeOf(p: ParamSpec): InputField["type"] {
  if (p.array_style) return "list";
  if (p.json_type === "number" || /^-?\d+$/.test((p.example ?? "").trim())) return "int";
  return "text";
}

/**
 * 고른 API 들의 바뀌는 값을 보고 입력을 나눈다.
 * 여러 API 에 같은 뜻의 값(같은/비슷한 이름, 같은 예시 값)이 있으면 '공통 입력' 하나로,
 * 한 API 에만 있으면 그 API '전용 입력'으로 만든다. (예: A=q+keywords, B=q+cat → q 공통, A 전용 keywords, B 전용 cat)
 */
export function autoInputs(members: { label: string; target: Target | undefined }[]): { inputs: InputField[]; bindings: Record<string, Record<string, Binding>> } {
  type Entry = { label: string; p: ParamSpec };
  const clusters: Entry[][] = [];
  const stem = (n: string) => leaf(n).replace(/(es|s)$/, "");
  const alike = (a: ParamSpec, b: ParamSpec) => {
    if (leaf(a.name) === leaf(b.name) || stem(a.name) === stem(b.name)) return true;
    const ga = group(a.name);
    if (ga >= 0 && ga === group(b.name)) return true;
    const ea = (a.example ?? "").trim();
    return !!ea && ea === (b.example ?? "").trim();
  };
  for (const m of members) {
    for (const p of varyParams(m.target)) {
      const c = clusters.find((cl) => !cl.some((e) => e.label === m.label) && cl.some((e) => alike(e.p, p)));
      if (c) c.push({ label: m.label, p });
      else clusters.push([{ label: m.label, p }]);
    }
  }
  const inputs: InputField[] = [];
  const bindings: Record<string, Record<string, Binding>> = Object.fromEntries(members.map((m) => [m.label, {}]));
  const used = new Set<string>();
  for (const cl of clusters) {
    const first = cl[0].p;
    const shared = cl.length > 1;
    let key = shared ? paramKey(first) : scopedKey(cl[0].label, paramKey(first));
    while (used.has(key)) key = `${key}_2`;
    used.add(key);
    const input: InputField = {
      key,
      label: first.label || leaf(first.name),
      type: inputTypeOf(first),
      required: cl.some((e) => !!e.p.required),
      default: null,
      help: first.example ? `예: ${first.example}` : "",
      scope: shared ? "" : cl[0].label,
    };
    inputs.push(input);
    for (const e of cl) bindings[e.label][paramKey(e.p)] = { from: key, transform: transformFor(input, e.p), value: "" };
  }
  // 공통 입력을 앞에
  inputs.sort((a, b) => Number(!!a.scope) - Number(!!b.scope));
  return { inputs, bindings };
}

export function inputScopeLabel(f: InputField): string {
  return f.scope ? `${f.scope} 전용` : "공통";
}
