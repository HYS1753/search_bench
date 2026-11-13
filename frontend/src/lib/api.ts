// API 호출 래퍼 — 같은 출처(/api)로 요청하고, 오류는 서버의 detail 메시지를 그대로 보여 준다.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 입력 검증 오류(422)의 영어 문구를 한국어로 */
function koMsg(m: string): string {
  const rules: [RegExp, (x: RegExpMatchArray) => string][] = [
    [/Field required/i, () => "값이 필요합니다"],
    [/at least (\d+) (character|item)/i, (x) => (x[1] === "1" ? "비워 둘 수 없습니다" : `${x[1]}개 이상 필요합니다`)],
    [/at most (\d+) (character|item)/i, (x) => `${x[1]}${x[2].startsWith("char") ? "자" : "개"}까지 가능합니다`],
    [/less than or equal to (\S+)/i, (x) => `${x[1]} 이하로 입력하세요`],
    [/greater than or equal to (\S+)/i, (x) => `${x[1]} 이상으로 입력하세요`],
    [/valid integer/i, () => "정수를 입력하세요"],
    [/valid number/i, () => "숫자를 입력하세요"],
    [/Input should be/i, () => `올바른 값이 아닙니다(${m})`],
  ];
  for (const [re, f] of rules) {
    const x = m.match(re);
    if (x) return f(x);
  }
  return m;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요.");
  }
  if (res.status === 401 && !path.startsWith("/auth")) {
    window.dispatchEvent(new CustomEvent("auth:required"));
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail))
        message = data.detail
          .map((d: { loc?: string[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${koMsg(d.msg ?? "")}`)
          .join("\n");
    } catch {
      /* 본문 없음 */
    }
    throw new ApiError(res.status, message);
  }
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** 서버가 만든 파일을 내려받는다(인증 쿠키 포함). */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api${path}`, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, "파일을 내려받지 못했습니다.");
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
