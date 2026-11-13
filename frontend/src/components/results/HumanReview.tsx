import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Keyboard, SkipForward, UserCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GradeChip, highlight } from "@/components/results/ItemCard";
import { Segmented } from "@/components/ui/page";
import { Alert, Badge, Button, Input, Kbd, Progress, Spinner, Switch } from "@/components/ui/primitives";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";
import type { CaseDetail, HumanJudgment, Item, Run, RunSummary } from "@/lib/types";

interface QueueItem {
  id: number;
  reviewers: string[];
  mine_graded: number;
  mine_complete: boolean;
  case_key: string;
  category: string;
  reviewed: boolean;
  complete: boolean;
  graded: number;
  needed: number;
  pairwise_done: number;
}
type Pref = "candidate" | "baseline" | "tie";

const GRADES = [
  { g: 3, label: "매우 관련", tone: "bg-good text-white", soft: "hover:bg-good-soft hover:text-good" },
  { g: 2, label: "관련", tone: "bg-accent text-white", soft: "hover:bg-accent-soft hover:text-accent" },
  { g: 1, label: "약간 관련", tone: "bg-warn text-white", soft: "hover:bg-warn-soft hover:text-warn" },
  { g: 0, label: "무관", tone: "bg-ink text-panel", soft: "hover:bg-subtle hover:text-ink" },
];

/** 실행의 후보별 평가 기준 → 항목 판정 key 접두사·k (백엔드 runs.criteria_groups 와 같은 규칙) */
function groupsOf(run: Run) {
  const primary = run.criteria;
  const by = run.criteria_by_member ?? {};
  const cands = run.members.filter((m) => !m.is_baseline).map((m) => m.label);
  const groups = new Map<string, { prefix: string; k: number; labels: string[] }>();
  for (const label of cands) {
    const c = by[label] ?? primary;
    const id = String(c?.id ?? "p");
    if (!groups.has(id)) groups.set(id, { prefix: c?.id === primary?.id ? "" : `@${c?.id}:`, k: c?.k ?? 5, labels: [] });
    groups.get(id)!.labels.push(label);
  }
  if (!groups.size) groups.set("p", { prefix: "", k: primary?.k ?? 5, labels: [] });
  return [...groups.values()];
}

function storedName(): string {
  try {
    return localStorage.getItem("reviewer_name") ?? "";
  } catch {
    return "";
  }
}

export function HumanReview({ run, onSummary }: { run: Run; onSummary: (s: RunSummary) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const me = useAuth().data?.user;
  // 계정으로 로그인했으면 계정 이름, 아니면 이 브라우저에 저장한 검수자 이름
  const loggedIn = !!me?.id;
  const [nameDraft, setNameDraft] = useState(storedName());
  const [guestName, setGuestName] = useState(storedName());
  const reviewer = loggedIn ? (me!.name || me!.username) : guestName || "공용";
  const [mode, setMode] = useState<"mine" | "overlap" | "fresh">("mine");
  const queue = useQuery({
    queryKey: ["review", run.id, reviewer, mode],
    queryFn: () => api.get<{ reviewer: string; items: QueueItem[]; candidates: string[] }>(`/runs/${run.id}/review?mode=${mode}&reviewer=${encodeURIComponent(loggedIn ? "" : guestName)}`),
  });
  const [pos, setPos] = useState(0);
  const [blind, setBlind] = useState(true);
  const [focus, setFocus] = useState(0);
  const items = queue.data?.items ?? [];
  const current = items[pos];
  const detail = useQuery({
    queryKey: ["run-case", run.id, current?.id],
    queryFn: () => api.get<CaseDetail>(`/runs/${run.id}/cases/${current!.id}`),
    enabled: !!current,
  });
  const c = detail.data;
  const [human, setHuman] = useState<Record<string, HumanJudgment>>({});
  const [prefs, setPrefs] = useState<Record<string, Pref>>({});
  // 편집하는 것은 '내' 등급·선호(합의 값이 아님)
  const myBy = c?.human_by?.[reviewer];
  const others = Object.entries(c?.human_by ?? {}).filter(([n]) => n !== reviewer);
  useEffect(() => {
    setHuman((myBy?.grades as Record<string, HumanJudgment>) ?? {});
    setPrefs((myBy?.pairwise as Record<string, Pref>) ?? {});
    setFocus(0);
  }, [c?.id, reviewer]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => groupsOf(run), [run]);
  const baseline = run.members.find((m) => m.is_baseline)?.label ?? "";
  const candidates = run.members.filter((m) => !m.is_baseline).map((m) => m.label);

  // 화면에 보일 목록: 대상마다 자기 평가 범위(상위 k)까지
  const sides = useMemo(() => {
    if (!c) return [];
    return c.responses.map((r) => {
      const g = groups.find((x) => x.labels.includes(r.label));
      const k = r.label === baseline ? Math.max(...groups.map((x) => x.k)) : g?.k ?? 5;
      return { label: r.label, ok: r.ok, error: r.error, items: (r.ok ? r.items : []).slice(0, k), prefix: g?.prefix ?? "" };
    });
  }, [c, groups, baseline]);
  // 채점이 필요한 항목 key(접두사 포함). 같은 항목은 어느 목록에서 채점해도 모든 그룹에 반영한다.
  const needed = useMemo(() => {
    const out = new Map<string, string[]>(); // 원래 key → 접두사 포함 key 들
    if (!c) return out;
    for (const g of groups) {
      for (const r of c.responses) {
        if (!r.ok || (r.label !== baseline && !g.labels.includes(r.label))) continue;
        for (const it of r.items.slice(0, g.k)) out.set(it.key, [...new Set([...(out.get(it.key) ?? []), g.prefix + it.key])]);
      }
    }
    return out;
  }, [c, groups, baseline]);
  const flat = useMemo(() => {
    const seen = new Set<string>();
    const out: { side: string; item: Item }[] = [];
    for (const s of sides) for (const it of s.items) if (!seen.has(it.key)) { seen.add(it.key); out.push({ side: s.label, item: it }); }
    return out;
  }, [sides]);
  const gradeOf = (key: string) => {
    const ks = needed.get(key) ?? [key];
    const h = ks.map((k) => human[k]).find(Boolean);
    return h?.grade;
  };
  const graded = flat.filter((f) => gradeOf(f.item.key) !== undefined).length;

  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const save = useCallback((body: { grades?: Record<string, number | null>; pairwise?: Record<string, Pref | null> }) => {
    if (!current) return;
    pending.current = pending.current.then(() =>
      api.put<{ summary: RunSummary }>(`/runs/${run.id}/cases/${current.id}/human`, { ...body, reviewer: loggedIn ? "" : guestName })
        .then((res) => {
          onSummary(res.summary);
          qc.invalidateQueries({ queryKey: ["review", run.id] });
        })
        .catch((e) => toast.error("저장하지 못했습니다", (e as Error).message)),
    );
  }, [current, run.id, onSummary, qc, toast, loggedIn, guestName]);

  const setGrade = (key: string, g: number | null) => {
    const ks = needed.get(key) ?? [key];
    setHuman((h) => {
      const n = { ...h };
      for (const k of ks) {
        if (g === null) delete n[k];
        else n[k] = { grade: g };
      }
      return n;
    });
    save({ grades: Object.fromEntries(ks.map((k) => [k, g])) });
  };
  const setPref = (cand: string, p: Pref | null) => {
    setPrefs((x) => {
      const n = { ...x };
      if (p === null) delete n[cand];
      else n[cand] = p;
      return n;
    });
    save({ pairwise: { [cand]: p } });
  };
  const go = (d: number) => setPos((p) => Math.max(0, Math.min(items.length - 1, p + d)));
  const nextUnreviewed = () => {
    const i = items.findIndex((x, j) => j > pos && !x.mine_complete);
    if (i >= 0) setPos(i);
    else toast.info("검수하지 않은 케이스가 더 없습니다");
  };

  // 키보드: 0~3 등급, ↑↓ 항목 이동, ←→ 케이스 이동
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || e.metaKey || e.ctrlKey) return;
      if (/^[0-3]$/.test(e.key) && flat[focus]) {
        e.preventDefault();
        setGrade(flat[focus].item.key, Number(e.key));
        setFocus((f) => Math.min(flat.length - 1, f + 1));
      } else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); setFocus((f) => Math.min(flat.length - 1, f + 1)); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); setFocus((f) => Math.max(0, f - 1)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.querySelector(`[data-review-idx="${focus}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);

  if (queue.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (!items.length) return <Alert>판정이 끝난 케이스가 생기면 사람 검수를 할 수 있습니다.</Alert>;
  const done = items.filter((x) => x.mine_complete).length;
  const reviewedCount = items.filter((x) => x.mine_graded > 0).length;
  const labelsIn = Object.fromEntries(run.input_fields.map((f) => [f.key, f.label || f.key]));
  const terms = Object.values(c?.inputs ?? {}).flatMap((v) => (Array.isArray(v) ? v : String(v ?? "").split(/\s+/))).map(String).filter((t) => t.length >= 2);
  const sharedKeys = new Set(flat.filter((f) => sides.filter((s) => s.items.some((it) => it.key === f.item.key)).length > 1).map((f) => f.item.key));

  return (
    <div>
      {/* 진행 */}
      <div className="mb-6 grid gap-4 border-y border-line py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[15px] font-semibold">{reviewer} 님의 검수</span>
            <span className="num text-[13px] text-muted">내가 끝낸 것 {done} · 일부 {reviewedCount - done} · 전체 {items.length}건</span>
          </div>
          <Progress className="mt-2.5 h-2" value={done} max={Math.min(items.length, 30)} tone={done >= Math.min(items.length, 30) ? "good" : "accent"} />
          <div className="mt-2 break-keep text-[12.5px] text-muted">
            무작위 순서로 보여 줍니다. 앞에서부터 <b className="text-ink">30건</b> 정도 검수하면 LLM 판정과의 일치도를 믿을 만하게 볼 수 있습니다(많을수록 좋음).
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={mode} onChange={(v) => { setMode(v); setPos(0); }} items={[
            { value: "mine", label: "내가 안 본 것" }, { value: "overlap", label: "겹쳐 보기" }, { value: "fresh", label: "아무도 안 본 것" },
          ]} />
          <Switch checked={blind} onChange={setBlind} label={<span className="inline-flex items-center gap-1.5 text-[13px]">{blind ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}LLM 판정 숨기기</span>} />
        </div>
      </div>

      {!loggedIn && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel/70 px-4 py-3">
          <UserCheck className="h-4 w-4 text-accent" />
          <span className="text-[13.5px]">검수자 이름</span>
          <Input className="h-9 w-48" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="예: 홍길동" />
          <Button size="sm" disabled={!nameDraft.trim() || nameDraft.trim() === guestName} onClick={() => {
            const n = nameDraft.trim();
            setGuestName(n);
            try { localStorage.setItem("reviewer_name", n); } catch { /* 저장 불가 */ }
          }}>이 이름으로 검수</Button>
          <span className="text-[12.5px] text-muted">여러 명이 나눠 검수하면 사람마다 따로 저장되고 합의 값과 검수자 간 일치도가 계산됩니다. 계정으로 로그인하면 자동으로 이름이 쓰입니다.</span>
        </div>
      )}
      <div className="mb-5 text-[12.5px] text-muted">
        <b className="text-ink">겹쳐 보기</b>: 다른 사람이 본 케이스를 먼저 보여 줘 검수자 간 일치도를 잴 수 있게 합니다. <b className="text-ink">아무도 안 본 것</b>: 여러 명이 나눠 빨리 넓게 볼 때.
      </div>
      {blind && <Alert className="mb-5" icon={<EyeOff className="h-4 w-4" />}>LLM 판정과 다른 검수자의 등급을 숨긴 상태입니다(권장). 먼저 보면 끌려가 일치도가 실제보다 높게 나옵니다.</Alert>}

      {/* 케이스 이동 */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} disabled={pos === 0} onClick={() => go(-1)}>이전</Button>
        <span className="num text-[13px] text-muted">{pos + 1} / {items.length}</span>
        <Button size="sm" variant="ghost" disabled={pos >= items.length - 1} onClick={() => go(1)}>다음<ArrowRight className="h-3.5 w-3.5" /></Button>
        <Button size="sm" icon={<SkipForward className="h-3.5 w-3.5" />} onClick={nextUnreviewed}>검수 안 한 다음 케이스</Button>
        <span className="ml-auto hidden items-center gap-1.5 text-[12px] text-faint md:inline-flex">
          <Keyboard className="h-3.5 w-3.5" /><Kbd>0</Kbd>~<Kbd>3</Kbd> 등급 · <Kbd>↑</Kbd><Kbd>↓</Kbd> 항목 · <Kbd>←</Kbd><Kbd>→</Kbd> 케이스
        </span>
      </div>

      {!c ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div key={c.id} className="animate-fade-up">
          <div className="mb-6 rounded-2xl border border-line bg-panel/70 p-5">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              <span className="font-semibold text-ink">케이스 {c.case_key}</span>
              {c.category && <Badge>{c.category}</Badge>}
              {current?.mine_complete ? <Badge tone="good"><Check className="h-3 w-3" />내 검수 완료</Badge> : <Badge tone="outline">내 항목 {graded}/{flat.length}</Badge>}
              {others.length > 0 && <Badge tone="accent">다른 검수자 {others.length}명: {others.map(([n]) => n).join(", ")}</Badge>}
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-[14.5px] sm:grid-cols-[auto_1fr]">
              {Object.entries(c.inputs).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length)).map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-muted">{labelsIn[k] ?? k}</dt><dd className="font-medium">{fmt.inputs(v)}</dd></div>
              ))}
              {c.expected && <><dt className="text-muted">기대 힌트</dt><dd>{c.expected}</dd></>}
            </dl>
          </div>

          <div className={cn("grid gap-x-8 gap-y-8", sides.length >= 2 && "lg:grid-cols-2", sides.length >= 3 && "xl:grid-cols-3", "[&>*]:min-w-0")}>
            {sides.map((s) => (
              <div key={s.label}>
                <div className="mb-2 flex items-center gap-2">
                  <span className={cn("rounded-lg px-2 py-0.5 text-[13px] font-bold", s.label === baseline ? "bg-subtle text-muted" : "bg-accent-soft text-accent")}>{s.label}</span>
                  {s.label === baseline && <Badge tone="outline">기준</Badge>}
                </div>
                {!s.ok ? <Alert tone="bad">호출 실패 · {s.error}</Alert> : !s.items.length ? <div className="border-y border-line py-6 text-center text-sm text-muted">결과 0건</div> : (
                  <div className="divide-y divide-line border-y border-line">
                    {s.items.map((it, i) => {
                      const idx = flat.findIndex((f) => f.item.key === it.key);
                      const g = gradeOf(it.key);
                      const llm = c.item_judgments[s.prefix + it.key] ?? c.item_judgments[it.key];
                      const on = idx === focus;
                      return (
                        <div key={it.key} data-review-idx={idx} onClick={() => setFocus(idx)}
                          className={cn("-mx-2 rounded-xl px-2 py-3.5 transition-colors", on ? "bg-accent-soft/50 ring-1 ring-accent/30" : "hover:bg-subtle/50")}>
                          <div className="flex items-start gap-2.5">
                            <span className="num mt-0.5 w-5 shrink-0 text-[13px] font-bold text-faint">{i + 1}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold">{highlight(it.title, terms)}</span>
                                {sharedKeys.has(it.key) && <Badge tone="outline">양쪽 공통</Badge>}
                                {!blind && (llm || others.length > 0) && (
                                  <span className="ml-auto inline-flex flex-wrap items-center gap-1 text-[11.5px] text-muted">
                                    {llm && <>LLM <GradeChip grade={llm.grade} reason={llm.reason} /></>}
                                    {others.map(([n, rv]) => {
                                      const g = (rv.grades as Record<string, HumanJudgment> | undefined)?.[s.prefix + it.key] ?? (rv.grades as Record<string, HumanJudgment> | undefined)?.[it.key];
                                      return g ? <span key={n} className="inline-flex items-center gap-0.5">{n} <GradeChip grade={g.grade} /></span> : null;
                                    })}
                                  </span>
                                )}
                              </div>
                              {it.fields.length > 0 && (
                                <dl className="mt-1 space-y-0.5 text-[13px] leading-relaxed">
                                  {it.fields.map((f) => (
                                    <div key={f.label} className="flex gap-3"><dt className="w-[80px] shrink-0 text-muted">{f.label}</dt><dd className="min-w-0 break-words text-ink/90">{highlight(f.value, terms)}</dd></div>
                                  ))}
                                </dl>
                              )}
                              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                <span className="mr-1 inline-flex items-center gap-1 text-[12px] text-muted"><UserCheck className="h-3.5 w-3.5" />사람</span>
                                {GRADES.map((x) => (
                                  <button key={x.g} type="button" onClick={(e) => { e.stopPropagation(); setGrade(it.key, g === x.g ? null : x.g); setFocus(idx); }}
                                    className={cn("press rounded-lg border px-2.5 py-1 text-[12px] font-medium", g === x.g ? cn("border-transparent", x.tone) : cn("border-line text-muted", x.soft))}>
                                    <span className="num mr-1 opacity-70">{x.g}</span>{x.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 목록 선호 */}
          <div className="mt-10 border-t border-line pt-6">
            <div className="mb-1 text-[15px] font-semibold">어느 목록이 더 유용한가요? <span className="text-[13px] font-normal text-muted">(선택)</span></div>
            <p className="mb-4 text-[13px] text-muted">항목 등급과 별개로, 목록 전체를 보고 사용자에게 더 나은 쪽을 고릅니다. LLM 의 목록 비교와 일치도를 잽니다.</p>
            <div className="space-y-3">
              {candidates.map((cand) => {
                const llmPw = c.pairwise?.[cand];
                return (
                  <div key={cand} className="flex flex-wrap items-center gap-2">
                    <span className="w-28 shrink-0 text-[13.5px] font-medium">{cand} vs {baseline}</span>
                    {([["baseline", `${baseline} 이 낫다`], ["tie", "비슷하다"], ["candidate", `${cand} 가 낫다`]] as [Pref, string][]).map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setPref(cand, prefs[cand] === v ? null : v)}
                        className={cn("press rounded-xl border px-3.5 py-2 text-[13px] font-medium",
                          prefs[cand] === v ? (v === "candidate" ? "border-good bg-good-soft text-good" : v === "baseline" ? "border-bad bg-bad-soft text-bad" : "border-ink bg-panel text-ink") : "border-line text-muted hover:border-faint hover:text-ink")}>
                        {label}
                      </button>
                    ))}
                    {!blind && llmPw && <span className="text-[12px] text-muted">LLM: {llmPw.winner === "candidate" ? `${cand} 승` : llmPw.winner === "baseline" ? "기준 승" : "무승부"}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-8 flex flex-wrap justify-between gap-2 border-t border-line pt-6">
            <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} disabled={pos === 0} onClick={() => go(-1)}>이전 케이스</Button>
            <Button variant="primary" disabled={pos >= items.length - 1} onClick={() => go(1)}>다음 케이스<ArrowRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
