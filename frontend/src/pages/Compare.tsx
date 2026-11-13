import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompareArrows, ListPlus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SideBySide } from "@/components/results/SideBySide";
import { PageHeader, Section, Stat, StatRow } from "@/components/ui/page";
import { Dialog } from "@/components/ui/overlay";
import { Alert, Button, Code, Empty, Input, PageSkeleton, Select, Spinner } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import type { CompareResult, CompareSide, Dataset, Suite } from "@/lib/types";

/** 지금 비교한 입력을 테스트 데이터에 한 줄로 더한다 — 눈으로 본 좋은/나쁜 사례를 평가에 모으기 */
function AddToDataset({ suite, inputs, onClose }: { suite: Suite; inputs: Record<string, unknown>; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["datasets", suite.id], queryFn: () => api.get<Dataset[]>(`/datasets?suite_id=${suite.id}`) });
  const usable = (list.data ?? []).filter((d) => d.compat?.status !== "missing");
  const [target, setTarget] = useState<string>("");
  const [name, setName] = useState("");
  const [expected, setExpected] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (target === "" && list.data) {
      const bound = usable.find((d) => d.suite_id === suite.id);
      setTarget(bound ? String(bound.id) : "new");
    }
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    setBusy(true);
    try {
      const d = await api.post<Dataset>("/datasets/add-row", {
        suite_id: suite.id, dataset_id: target === "new" ? null : Number(target), name, inputs, expected, category,
      });
      qc.invalidateQueries({ queryKey: ["datasets"] });
      toast.success("테스트 데이터에 더했습니다", `‘${d.name}’ · 이제 ${d.row_count}행`);
      onClose();
    } catch (e) {
      toast.error("더하지 못했습니다", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="이 입력을 테스트 데이터에 추가" description="눈으로 확인한 사례를 모아 두면 다음 평가에서 같은 질의로 다시 확인할 수 있습니다."
      footer={<><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" loading={busy} disabled={!target} onClick={add}>추가</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">어디에 더할까요?</span>
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">+ 새 테스트 데이터 만들기</option>
            {usable.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.row_count}행){d.suite_id === suite.id ? " · 이 세트와 연결됨" : ""}</option>)}
          </Select>
        </label>
        {target === "new" && (
          <label className="block"><span className="mb-1.5 block text-[13px] font-medium">새 데이터 이름</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${suite.name} · 단건 비교에서 모은 질의`} /></label>
        )}
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">기대 정답 힌트 (선택)</span>
          <Input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="예: 학자금 담당자가 1위여야 함" /></label>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">분류 (선택)</span>
          <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="예: 인사" /></label>
      </div>
    </Dialog>
  );
}

/** 판정 없이 계산하는 단순 비교: 겹치는 결과, 순위 변화, 한쪽에만 있는 결과 */
function overlap(base: CompareSide, cand: CompareSide) {
  const baseRank = new Map(base.items.map((it, i) => [it.key, i]));
  const candKeys = new Set(cand.items.map((it) => it.key));
  let up = 0;
  let down = 0;
  let same = 0;
  for (const [i, it] of cand.items.entries()) {
    const r = baseRank.get(it.key);
    if (r === undefined) continue;
    if (r > i) up++;
    else if (r < i) down++;
    else same++;
  }
  const common = up + down + same;
  return {
    common,
    up,
    down,
    same,
    onlyCand: cand.items.length - common,
    onlyBase: base.items.filter((it) => !candKeys.has(it.key)).length,
    top1Same: !!base.items[0] && base.items[0].key === cand.items[0]?.key,
  };
}

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const suites = useQuery({ queryKey: ["suites"], queryFn: () => api.get<Suite[]>("/suites") });
  const suite = suites.data?.find((s) => s.id === Number(params.get("suite"))) ?? suites.data?.[0];
  const suiteId = suite?.id ?? 0;
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!suite) return;
    setInputs(Object.fromEntries(suite.input_fields.map((f) => [f.key, f.default === null || f.default === undefined ? "" : String(f.default)])));
  }, [suite?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({ mutationFn: () => api.post<CompareResult>("/compare", { suite_id: suiteId, inputs, judge: false }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run.mutate();
  };
  const terms = useMemo(
    () => Object.values(inputs).flatMap((v) => String(v).split(/[\s,]+/)).filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
    [inputs],
  );
  const result = run.data;
  const base = result?.sides.find((s) => s.is_baseline);
  const cands = result?.sides.filter((s) => !s.is_baseline) ?? [];

  if (suites.isLoading) return <PageSkeleton />;
  if (!suites.data?.length)
    return (
      <>
        <PageHeader eyebrow="비교" title="단건 검색 비교" />
        <Empty icon={<GitCompareArrows className="h-8 w-8" />} title="비교 세트가 없습니다"
          action={<Link to="/settings/suites"><Button variant="primary">비교 세트 만들기</Button></Link>}>
          비교할 API 들을 묶은 비교 세트가 있어야 같은 입력을 동시에 보내 볼 수 있습니다.
        </Empty>
      </>
    );

  const required = suite?.input_fields.filter((f) => f.required && !(inputs[f.key] ?? "").trim()) ?? [];
  const groups = [
    { scope: "", fields: (suite?.input_fields ?? []).filter((f) => !f.scope) },
    ...(suite?.members ?? []).map((m) => ({ scope: m.label, fields: (suite?.input_fields ?? []).filter((f) => f.scope === m.label) })),
  ].filter((g) => g.fields.length);
  return (
    <>
      <PageHeader
        eyebrow="비교"
        title="단건 검색 비교"
        description="같은 입력을 모든 API 에 동시에 보내 결과를 나란히 봅니다. 채점은 하지 않고 결과만 확인하는 화면입니다. 채점은 평가에서 합니다."
      />
      <form onSubmit={submit} className="mb-14 border-y border-line py-7">
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-[minmax(0,280px)_1fr]">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[13px] font-medium">비교 세트</span>
            <Select value={suiteId} onChange={(e) => setParams({ suite: e.target.value })}>
              {suites.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            {suite && <span className="mt-1.5 block truncate text-[12.5px] text-muted">{suite.members.map((m) => `${m.label}${m.is_baseline ? "(기준)" : ""}`).join(" vs ")}</span>}
          </label>
          <div className="min-w-0 space-y-6">
            {groups.map((g) => (
              <div key={g.scope || "shared"} className="min-w-0">
                {groups.length > 1 && (
                  <div className="mb-2 flex items-center gap-2 text-[12.5px] text-muted">
                    {g.scope ? <span className="rounded-md bg-accent-soft px-1.5 py-0.5 font-bold text-accent">{g.scope}</span> : <span className="rounded-md bg-subtle px-1.5 py-0.5 font-bold">공통</span>}
                    {g.scope ? `${g.scope} 에만 보내는 값` : "모든 API 에 보내는 값"}
                  </div>
                )}
                <div className="grid min-w-0 gap-x-4 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
                  {g.fields.map((f, i) => {
                    const wide = !g.scope && i === 0 && f.type === "text";
                    return (
                      <label key={f.key} className={wide ? "block min-w-0 sm:col-span-2 xl:col-span-3" : "block min-w-0"}>
                        <span className="mb-1.5 block text-[13px] font-medium">
                          {f.label || f.key}
                          {f.required && <span className="ml-0.5 text-bad">*</span>}
                          {f.type === "list" && <span className="ml-1.5 font-normal text-faint">쉼표로 여러 값</span>}
                        </span>
                        <Input
                          type={f.type === "int" ? "number" : "text"}
                          value={inputs[f.key] ?? ""}
                          onChange={(e) => setInputs((x) => ({ ...x, [f.key]: e.target.value }))}
                          placeholder={f.help || ""}
                          className={wide ? "h-12 text-[15px]" : ""}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <Button type="submit" variant="primary" size="lg" icon={<Search className="h-4 w-4" />} loading={run.isPending} disabled={required.length > 0}>결과 보기</Button>
        </div>
      </form>

      {run.isError && <Alert tone="bad" className="mb-6" title="불러오지 못했습니다">{(run.error as Error).message}</Alert>}
      {run.isPending && <div className="flex justify-center py-16"><Spinner className="h-6 w-6" /></div>}

      {result && !run.isPending && base && (
        <>
          {cands.map((c) => {
            const o = overlap(base, c);
            return (
              <Section key={c.label} title={`${c.label} vs ${base.label}`} description="판정 없이 결과 목록만 비교한 숫자입니다. 같은 결과는 고유 번호로 알아봅니다.">
                <StatRow min={170}>
                  <Stat label="1위" value={!base.ok || !c.ok ? "–" : o.top1Same ? "같음" : "다름"} tone={o.top1Same ? undefined : "accent"} />
                  <Stat label="겹치는 결과" value={`${o.common}개`} sub={`${base.label} ${base.items.length}개 · ${c.label} ${c.items.length}개`} />
                  <Stat label="순위가 오른 결과" value={`${o.up}개`} tone={o.up ? "good" : undefined} sub={`내려감 ${o.down} · 그대로 ${o.same}`} />
                  <Stat label={`${c.label}에만 있음`} value={`${o.onlyCand}개`} sub={`${base.label}에만 있음 ${o.onlyBase}개`} />
                  <Stat label="응답 시간" value={fmt.ms(c.latency_ms)} sub={`${base.label} ${fmt.ms(base.latency_ms)}`} />
                </StatRow>
              </Section>
            );
          })}
          <Section title="결과" description="뱃지는 기준 대비 순위 변화입니다(↑ 올라감, ↓ 내려감, 신규 = 기준에 없던 결과). 입력한 단어는 노란색으로 표시됩니다."
            actions={<Button icon={<ListPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>테스트 데이터에 추가</Button>}>
            <SideBySide sides={result.sides} terms={terms} />
          </Section>
          <details className="border-y border-line py-4">
            <summary className="cursor-pointer text-[13px] font-medium text-muted">보낸 요청 · 원본 응답 보기</summary>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {result.sides.map((s) => (
                <div key={s.label} className="min-w-0">
                  <div className="mb-1 text-[12.5px] font-semibold">{s.label} · HTTP {s.status_code ?? "-"}</div>
                  <Code>{JSON.stringify({ request: s.request, response: s.raw }, null, 2)}</Code>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
      {adding && suite && <AddToDataset suite={suite} inputs={result?.inputs ?? inputs} onClose={() => setAdding(false)} />}
    </>
  );
}
