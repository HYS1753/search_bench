// 붙여넣은 예시 요청(URL 또는 curl)을 해석하고, 응답 JSON 에서 결과 목록·필드를 찾아낸다.
// 개발자가 아니어도 "예시 주소 붙여넣기 → 응답에서 고르기" 만으로 비교 대상을 만들 수 있게 하는 도우미.

export interface ParsedParam {
  name: string;
  values: string[]; // 같은 이름이 여러 번이면 여러 값(키 반복 방식)
  location: "query" | "body";
  isArray: boolean; // body 의 JSON 배열
  jsonType: "" | "string" | "number" | "boolean"; // body 값의 원래 타입
}

export interface ParsedRequest {
  method: "GET" | "POST";
  base_url: string;
  path: string;
  params: ParsedParam[];
  headers: Record<string, string>;
  bearer: string; // Authorization: Bearer 값(있으면)
  apiKeyHeader: { name: string; value: string } | null;
}

function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  const s = input.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

const SECRET_HEADERS = /^(x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;

export function parseRequest(text: string): ParsedRequest {
  const raw = text.trim();
  if (!raw) throw new Error("예시 주소를 붙여넣어 주세요.");
  let method: "GET" | "POST" = "GET";
  let urlText = raw;
  const headers: Record<string, string> = {};
  let body: string | null = null;
  let forceGet = false;

  if (/^curl\s/i.test(raw)) {
    const t = shellSplit(raw).slice(1);
    let url = "";
    for (let i = 0; i < t.length; i++) {
      const a = t[i];
      const next = () => t[++i] ?? "";
      if (a === "-X" || a === "--request") method = next().toUpperCase() === "POST" ? "POST" : "GET";
      else if (a === "-H" || a === "--header") {
        const h = next();
        const idx = h.indexOf(":");
        if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      } else if (["-d", "--data", "--data-raw", "--data-binary", "--json", "--data-urlencode"].includes(a)) {
        body = (body ? body + "&" : "") + next();
        if (a === "--json") headers["Content-Type"] = "application/json";
      } else if (a === "-G" || a === "--get") forceGet = true;
      else if (a === "--url") url = next();
      else if (["-u", "--user", "-o", "--output", "-A", "--user-agent", "-e", "--referer", "-m", "--max-time"].includes(a)) next();
      else if (!a.startsWith("-") && !url) url = a;
    }
    if (!url) throw new Error("curl 명령에서 주소를 찾지 못했습니다.");
    urlText = url;
    if (body && !forceGet && method === "GET" && !raw.includes("-X")) method = "POST";
  }

  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(urlText) ? urlText : `http://${urlText}`);
  } catch {
    throw new Error("주소 형식이 올바르지 않습니다. https:// 로 시작하는 전체 주소를 붙여넣어 주세요.");
  }
  const params: ParsedParam[] = [];
  const add = (name: string, value: string, location: "query" | "body", isArray = false, jsonType: ParsedParam["jsonType"] = "") => {
    const p = params.find((x) => x.name === name && x.location === location);
    if (p) p.values.push(value);
    else params.push({ name, values: [value], location, isArray, jsonType });
  };
  // 중첩 JSON 본문을 'query.text', 'filters[0].field' 같은 경로별 값으로 펼친다.
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== "object")) {
        if (!v.length) add(path, "", "body", true);
        v.forEach((x) => add(path, String(x), "body", true, typeof x === "number" ? "number" : typeof x === "boolean" ? "boolean" : "string"));
      } else v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, path ? `${path}.${k}` : k);
    } else if (v !== null && v !== undefined) {
      add(path, String(v), "body", false, typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string");
    }
  };
  u.searchParams.forEach((v, k) => add(k, v, "query"));

  if (body) {
    const b = (body as string).trim();
    if (b.startsWith("{")) {
      try {
        walk(JSON.parse(b), "");
      } catch {
        throw new Error("요청 본문(JSON)을 해석하지 못했습니다.");
      }
    } else {
      new URLSearchParams(b).forEach((v, k) => add(k, v, forceGet ? "query" : "body"));
    }
  }

  let bearer = "";
  let apiKeyHeader: ParsedRequest["apiKeyHeader"] = null;
  for (const [k, v] of Object.entries(headers)) {
    if (/^authorization$/i.test(k) && /^bearer\s+/i.test(v)) {
      bearer = v.replace(/^bearer\s+/i, "");
      delete headers[k];
    } else if (SECRET_HEADERS.test(k)) {
      apiKeyHeader = { name: k, value: v };
      delete headers[k];
    } else if (/^(content-type|accept|user-agent|content-length|host)$/i.test(k)) {
      delete headers[k];
    }
  }
  return {
    method,
    base_url: `${u.protocol}//${u.host}`,
    path: u.pathname === "/" ? "" : u.pathname,
    params,
    headers,
    bearer,
    apiKeyHeader,
  };
}

// ── 파라미터: 바뀌는 값 / 고정 값 ───────────────────────────────

export type ParamKind = "vary" | "fixed" | "skip";

export const KIND_LABEL: Record<ParamKind, string> = {
  vary: "바뀌는 값",
  fixed: "고정 값",
  skip: "빼기",
};

/** 흔한 API 관례로 처음 선택만 추측한다(사용자가 바로 바꿀 수 있음). */
export function guessKind(p: ParsedParam, index: number): ParamKind {
  const n = p.name.toLowerCase();
  if (p.values.length > 1 || p.isArray) return "vary";
  if (/^(q|query|search|keyword|keywords|text|question|prompt|term|terms|input|message|content|sentence)$/.test(n)) return "vary";
  if (index === 0 && !/^\d+$/.test(p.values[0] ?? "")) return "vary";
  return "fixed";
}

/** 바뀌는 값이 여러 개일 때 보내는 방식 */
export function listStyle(p: ParsedParam): "" | "repeat" | "json" {
  if (p.location === "body" && p.isArray) return "json";
  if (p.values.length > 1) return "repeat";
  return "";
}

/** 파라미터 이름 → 입력 항목 key (영문·숫자·_ 만) */
export function fieldKey(name: string): string {
  const k = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "value";
  return /^\d/.test(k) ? `p_${k}` : k;
}

// ── 응답 JSON 탐색 ─────────────────────────────────────────────

export interface ArrayCandidate {
  path: string; // results_path
  count: number;
  sample: Record<string, unknown>;
}

/** 응답에서 '객체들의 배열'을 모두 찾는다(결과 목록 후보). */
export function findArrays(json: unknown, maxDepth = 5): ArrayCandidate[] {
  const out: ArrayCandidate[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > maxDepth || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const objs = v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown>[];
      if (objs.length && objs.length >= v.length / 2) {
        out.push({ path: path || "$", count: v.length, sample: objs[0] });
      }
      return; // 배열 안쪽 배열은 항목 필드에서 다룬다
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(json, "", 0);
  // 항목 수가 많고 얕은 경로를 우선
  return out.sort((a, b) => b.count - a.count || a.path.split(".").length - b.path.split(".").length);
}

export interface FieldInfo {
  path: string; // 항목 기준 경로 (예: assignments[].org_nm)
  example: string;
  kind: "text" | "number" | "bool" | "list";
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(show).filter(Boolean).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 결과 항목들의 필드를 펼친다(중첩 객체·배열 포함, 최대 3단계). */
export function flattenItems(items: Record<string, unknown>[], maxDepth = 3): FieldInfo[] {
  const seen = new Map<string, FieldInfo>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (v === null || v === undefined) {
      if (path && !seen.has(path)) seen.set(path, { path, example: "", kind: "text" });
      return;
    }
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x === null || typeof x !== "object")) {
        const ex = show(v);
        const cur = seen.get(path);
        if (!cur || (!cur.example && ex)) seen.set(path, { path, example: ex, kind: "list" });
        return;
      }
      if (depth >= maxDepth) return;
      for (const x of v.slice(0, 3)) walk(x, `${path}[]`, depth + 1);
      return;
    }
    if (typeof v === "object") {
      if (depth >= maxDepth) return;
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    const kind = typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : "text";
    const cur = seen.get(path);
    if (!cur || (!cur.example && show(v))) seen.set(path, { path, example: show(v), kind });
  };
  for (const it of items.slice(0, 5)) walk(it, "", 0);
  return [...seen.values()];
}

export function getAt(obj: unknown, path: string): unknown {
  if (!path || path === "$") return obj;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

// ── 필드 역할 추측 ───────────────────────────────────────────

export type FieldRole = "id" | "title" | "content" | "score" | "skip";

export const SENSITIVE = /(phone|tel|mobile|email|e_?mail|mail|ssn|jumin|birth|address|addr|password|passwd|token|secret|account_?no|card_?no|전화|연락처|이메일|주소|생년)/i;

export function guessFieldRoles(fields: FieldInfo[]): Record<string, FieldRole> {
  const roles: Record<string, FieldRole> = {};
  const leaf = (p: string) => p.split(/[.[\]]+/).filter(Boolean).pop()?.toLowerCase() ?? "";
  // 배열이 아닌(결과마다 값이 하나인) 필드, 얕은 것부터
  const top = fields.filter((f) => !f.path.includes("[]")).sort((a, b) => a.path.split(".").length - b.path.split(".").length);
  const id =
    top.find((f) => /^(id|doc_?id|uuid|key)$/.test(leaf(f.path))) ??
    top.find((f) => /(_id|_no|_code|_key)$/.test(leaf(f.path)) && f.kind !== "bool");
  const title =
    top.find((f) => /^(title|name|subject|headline)$/.test(leaf(f.path))) ??
    top.find((f) => /(_name|_nm|_title|name$)/.test(leaf(f.path)) && f.kind === "text");
  for (const f of fields) {
    const l = leaf(f.path);
    if (id && f.path === id.path) roles[f.path] = "id";
    else if (title && f.path === title.path) roles[f.path] = "title";
    else if (SENSITIVE.test(l)) roles[f.path] = "skip";
    else if (/^(score|_score|rank|relevance)$/.test(l) && f.kind === "number") roles[f.path] = "score";
    else if (f.kind === "bool" || f.kind === "number") roles[f.path] = "skip";
    else if (/(_id|_no|_code|^id$|url|uri|link|thumbnail|image|created|updated|date|time)/.test(l)) roles[f.path] = "skip";
    else roles[f.path] = f.example.trim() ? "content" : "skip";
  }
  return roles;
}

/** 경로를 사람이 읽을 이름으로 (assignments[].org_nm → assignments · org_nm) */
export function prettyPath(p: string): string {
  return p.replace(/\[\]/g, "").split(".").join(" · ");
}

/** 판정에 보일 기본 이름: 마지막 필드 이름 (assignments[].org_nm → org_nm) */
export function leafName(p: string): string {
  return p.split(/[.[\]]+/).filter(Boolean).pop() ?? p;
}

/** 'a.b[0].c' 경로에 값을 넣으며 중간 객체·배열을 만든다(예시 요청 복원용). */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const tokens = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]));
  let cur: Record<string, unknown> | unknown[] = obj;
  tokens.forEach((tok, i) => {
    const last = i === tokens.length - 1;
    const nextIsIndex = !last && typeof tokens[i + 1] === "number";
    const c = cur as Record<string | number, unknown>;
    if (last) c[tok as never] = value;
    else {
      if (c[tok as never] === undefined || typeof c[tok as never] !== "object") c[tok as never] = nextIsIndex ? [] : {};
      cur = c[tok as never] as Record<string, unknown>;
    }
  });
}

export function typed(value: string, jsonType: string): unknown {
  if (jsonType === "number" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (jsonType === "boolean") return /^(true|1|yes)$/i.test(value.trim());
  return value;
}
