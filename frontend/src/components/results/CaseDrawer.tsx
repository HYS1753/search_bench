import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import { Drawer } from "@/components/ui/overlay";
import { KeyValue, Section } from "@/components/ui/page";
import { Alert, Badge, Code, Spinner } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";
import type { CaseDetail, Run } from "@/lib/types";
import { PairwiseCard, SideBySide } from "./SideBySide";

export function CaseDrawer({ run, caseId, onClose }: { run: Run; caseId: number | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["run-case", run.id, caseId],
    queryFn: () => api.get<CaseDetail>(`/runs/${run.id}/cases/${caseId}`),
    enabled: caseId !== null,
  });
  const c = detail.data;
  const baseline = run.members.find((m) => m.is_baseline)?.label ?? "";
  const labels = Object.fromEntries(run.input_fields.map((f) => [f.key, f.label || f.key]));
  const terms = useMemo(
    () => Object.values(c?.inputs ?? {}).flatMap((v) => (Array.isArray(v) ? v : String(v ?? "").split(/\s+/))).map(String).filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
    [c],
  );
  const sides = (c?.responses ?? []).map((r) => ({
    label: r.label,
    is_baseline: r.label === baseline,
    ok: r.ok,
    error: r.error,
    latency_ms: r.latency_ms,
    items: r.items,
    status_code: r.status_code,
    target_name: run.members.find((m) => m.label === r.label)?.target_name,
  }));
  // 후보마다 평가 기준이 다르면 항목 판정이 "@{기준 id}:{key}" 로 따로 저장된다
  const primaryId = run.criteria?.id;
  const byMember = run.criteria_by_member ?? {};
  const prefixes = Object.fromEntries(Object.entries(byMember).map(([l, cr]) => [l, cr.id === primaryId ? "" : `@${cr.id}:`]));
  const kBy = Object.fromEntries(Object.entries(byMember).map(([l, cr]) => [l, cr.k]));
  return (
    <Drawer open={caseId !== null} onOpenChange={(o) => !o && onClose()} width="max-w-6xl"
      title={c ? `케이스 ${c.case_key}` : "케이스"}
      subtitle={c ? [c.category, fmt.inputs(c.inputs[run.input_fields[0]?.key])].filter(Boolean).join(" · ") : undefined}>
      {!c ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : (
        <>
          <Section title="입력">
            <KeyValue items={[
              ...Object.entries(c.inputs).map(([k, v]) => ({ k: labels[k] ?? k, v: fmt.inputs(v) || <span className="text-faint">–</span> })),
              ...(c.expected ? [{ k: "기대 힌트", v: c.expected }] : []),
              { k: "상태", v: c.status === "done" ? <Badge tone="good">완료</Badge> : c.status === "error" ? <Badge tone="bad">오류</Badge> : <Badge>대기</Badge> },
            ]} />
            {c.error && <Alert tone="bad" className="mt-3" icon={<AlertTriangle className="h-4 w-4" />}>{c.error}</Alert>}
          </Section>
          {Object.keys(c.pairwise).length > 0 && (
            <Section title="목록 비교">
              <div className="grid gap-3">
                {Object.entries(c.pairwise).map(([cand, pw]) => <PairwiseCard key={cand} pw={pw} candidate={cand} baseline={baseline} />)}
              </div>
            </Section>
          )}
          <Section title="결과와 항목별 판정" description="등급 칩에 마우스를 올리거나 카드 아래 근거로 왜 그 점수인지 확인하세요.">
            <SideBySide sides={sides} judgments={c.item_judgments} metrics={c.metrics} k={run.criteria?.k} terms={terms} prefixes={prefixes} kBy={kBy} />
          </Section>
          <details className="rounded-xl border border-line bg-panel px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-medium">원본 응답</summary>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {c.responses.map((r) => (
                <div key={r.label}>
                  <div className="mb-1 text-[12.5px] font-semibold">{r.label} · HTTP {r.status_code ?? "-"} · {fmt.ms(r.latency_ms)}</div>
                  <Code>{JSON.stringify(r.raw, null, 2)}</Code>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </Drawer>
  );
}
