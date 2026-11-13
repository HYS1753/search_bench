import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, Copy, KeyRound, Plus, Send, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { Dialog } from "@/components/ui/overlay";
import { FormRow, PageHeader, Rows, Segmented, Tabs } from "@/components/ui/page";
import { Alert, Badge, Button, Code, Empty, Input, PageSkeleton, Select, Switch } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn, fmt } from "@/lib/format";

interface Channel { id: number; name: string; kind: "slack" | "webhook"; url_hint: string; events: string[]; active: boolean; last_ok: boolean | null; last_message: string; last_sent_at: string | null }
interface Token { id: number; name: string; prefix: string; role: "editor" | "viewer"; created_by: string; created_at: string; last_used_at: string | null; revoked: boolean }
interface Catalog { suites: { id: number; name: string; labels: string[] }[]; datasets: { id: number; name: string; rows: number; suite_id: number | null }[] }

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button size="sm" variant="ghost" icon={ok ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>{ok ? "복사됨" : "복사"}</Button>
  );
}

function ChannelDialog({ initial, events, onClose }: { initial?: Channel; events: Record<string, string>; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "팀 Slack");
  const [kind, setKind] = useState<"slack" | "webhook">(initial?.kind ?? "slack");
  const [url, setUrl] = useState("");
  const [ev, setEv] = useState<string[]>(initial?.events ?? ["run_done", "run_failed", "run_regressed"]);
  const save = async () => {
    try {
      const body = { name, kind, url: url || null, events: ev, active: initial?.active ?? true };
      if (initial) await api.put(`/notifications/${initial.id}`, body);
      else await api.post("/notifications", body);
      qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("저장했습니다", "‘테스트 보내기’로 메시지가 오는지 확인하세요.");
      onClose();
    } catch (e) {
      toast.error("저장하지 못했습니다", (e as Error).message);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={initial ? "알림 수정" : "알림 추가"}
      footer={<><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" disabled={!name || (!initial && !url) || !ev.length} onClick={save}>저장</Button></>}>
      <div className="space-y-4">
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">이름</span><Input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div><span className="mb-1.5 block text-[13px] font-medium">종류</span>
          <Segmented value={kind} onChange={setKind} items={[{ value: "slack", label: "Slack" }, { value: "webhook", label: "일반 웹훅(JSON)" }]} />
          <div className="mt-1.5 text-[12.5px] text-muted">{kind === "slack" ? "Slack 앱의 ‘Incoming Webhooks’에서 만든 주소(https://hooks.slack.com/services/…)를 넣으세요." : "평가 결과를 JSON 으로 POST 합니다(event, name, verdict, ndcg_diff, url 등). 사내 메신저·자동화 도구에 연결할 때."}</div>
        </div>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">주소{initial && <span className="ml-1 font-normal text-muted">(비우면 그대로 · 지금 {initial.url_hint})</span>}</span>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
        <div><span className="mb-1.5 block text-[13px] font-medium">언제 보낼까요?</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(events).map(([k, label]) => (
              <label key={k} className={cn("flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-[13.5px]", ev.includes(k) ? "border-ink bg-panel" : "border-line")}>
                <input type="checkbox" checked={ev.includes(k)} onChange={(e) => setEv(e.target.checked ? [...ev, k] : ev.filter((x) => x !== k))} />{label}
              </label>
            ))}
          </div>
        </div>
        <div className="text-[12.5px] text-muted">메시지에 결과 링크를 넣으려면 서버 환경 변수 <code className="rounded bg-subtle px-1">PUBLIC_URL</code>(예: https://searchbench.사내도메인)을 설정하세요. 주소는 암호화해 저장합니다.</div>
      </div>
    </Dialog>
  );
}

export default function Integrations() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<"notify" | "tokens" | "ci">("notify");
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("github-actions");
  const [tokenRole, setTokenRole] = useState<"editor" | "viewer">("editor");
  const chans = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<{ events: Record<string, string>; items: Channel[] }>("/notifications") });
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api.get<Token[]>("/tokens"), enabled: tab !== "notify" });
  const catalog = useQuery({ queryKey: ["ci-catalog"], queryFn: () => api.get<Catalog>("/ci/catalog"), enabled: tab === "ci" });
  const [suite, setSuite] = useState<number | "">("");
  const [dataset, setDataset] = useState<number | "">("");
  const [gate, setGate] = useState<"regressed" | "not_improved" | "none">("regressed");
  const [overrideLabel, setOverrideLabel] = useState("");

  if (chans.isLoading) return <PageSkeleton />;
  const testSend = async (c: Channel) => {
    const r = await api.post<{ ok: boolean; message: string }>(`/notifications/${c.id}/test`).catch((e) => ({ ok: false, message: (e as Error).message }));
    if (r.ok) toast.success("테스트 메시지를 보냈습니다", `${c.name} 에서 확인하세요.`);
    else toast.error("보내지 못했습니다", r.message);
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const toggle = async (c: Channel, active: boolean) => {
    await api.put(`/notifications/${c.id}`, { name: c.name, kind: c.kind, url: null, events: c.events, active });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const createToken = async () => {
    try {
      const t = await api.post<Token & { token: string }>("/tokens", { name: tokenName, role: tokenRole });
      setNewToken(t.token);
      qc.invalidateQueries({ queryKey: ["tokens"] });
    } catch (e) {
      toast.error("만들지 못했습니다", (e as Error).message);
    }
  };

  const cat = catalog.data;
  const s = cat?.suites.find((x) => x.id === suite) ?? cat?.suites[0];
  const d = cat?.datasets.find((x) => x.id === dataset) ?? cat?.datasets.find((x) => x.suite_id === s?.id) ?? cat?.datasets[0];
  const body = JSON.stringify({
    suite: s?.name ?? "비교 세트 이름", dataset: d?.name ?? "테스트 데이터 이름", gate,
    ...(overrideLabel ? { target_overrides: { [overrideLabel]: { base_url: "${PREVIEW_URL}" } } } : {}),
  }, null, 2);
  const curl = `curl -sS -X POST "$SEARCHBENCH_URL/api/ci/runs" \\
  -H "Authorization: Bearer $SEARCHBENCH_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${body.replace(/"\$\{PREVIEW_URL\}"/, `"'"$PREVIEW_URL"'"`)}' | tee result.json
jq -e '.passed == true' result.json > /dev/null || { echo "검색 품질 게이트 실패: $(jq -r .reason result.json)"; exit 1; }`;
  const gha = `name: search-quality
on:
  pull_request:
jobs:
  searchbench:
    runs-on: ubuntu-latest
    steps:
      - name: SearchBench 평가
        env:
          SEARCHBENCH_URL: \${{ secrets.SEARCHBENCH_URL }}
          SEARCHBENCH_TOKEN: \${{ secrets.SEARCHBENCH_TOKEN }}${overrideLabel ? `
          PREVIEW_URL: https://pr-\${{ github.event.number }}.preview.example.com   # 이 PR 의 미리보기 주소로 바꾸세요` : ""}
        run: |
${curl.split("\n").map((l) => `          ${l}`).join("\n")}`;

  return (
    <>
      <PageHeader eyebrow="운영" title="연동 · 알림과 CI" description="평가가 끝나면 Slack·웹훅으로 알리고, 배포 파이프라인에서 평가를 돌려 검색 품질이 나빠지면 막을 수 있습니다." />
      <Tabs value={tab} onChange={setTab} className="mb-8" items={[
        { value: "notify", label: "알림", count: chans.data?.items.length ?? 0 }, { value: "tokens", label: "API 토큰" }, { value: "ci", label: "CI 설정 만들기" },
      ]} />

      {tab === "notify" && (
        <>
          <div className="mb-4 flex justify-end"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>알림 추가</Button></div>
          {!chans.data?.items.length ? (
            <Empty icon={<Bell className="h-8 w-8" />} title="알림이 없습니다" action={<Button variant="primary" onClick={() => setEditing("new")}>Slack 알림 추가</Button>}>
              평가 완료·실패·‘저하’ 결론·테스트 데이터 생성 완료를 팀 채널로 받을 수 있습니다.
            </Empty>
          ) : (
            <div className="divide-y divide-line border-y border-line">
              {chans.data.items.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
                  <div className="min-w-0 flex-1 basis-[240px]">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{c.name}</span><Badge tone="outline">{c.kind === "slack" ? "Slack" : "웹훅"}</Badge><span className="font-mono text-[12px] text-muted">{c.url_hint}</span></div>
                    <div className="mt-1 flex flex-wrap gap-1.5">{c.events.map((e) => <Badge key={e}>{chans.data!.events[e] ?? e}</Badge>)}</div>
                    {c.last_sent_at && <div className={cn("mt-1 text-[12px]", c.last_ok ? "text-good" : "text-bad")}>{c.last_ok ? "마지막 전송 성공" : "마지막 전송 실패"} · {c.last_message} · {fmt.ago(c.last_sent_at)}</div>}
                  </div>
                  <Switch checked={c.active} onChange={(v) => toggle(c, v)} label={<span className="text-[13px]">{c.active ? "켜짐" : "꺼짐"}</span>} />
                  <Button size="sm" variant="ghost" icon={<Send className="h-3.5 w-3.5" />} onClick={() => testSend(c)}>테스트 보내기</Button>
                  <Button size="sm" onClick={() => setEditing(c)}>수정</Button>
                  <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => api.del(`/notifications/${c.id}`).then(() => qc.invalidateQueries({ queryKey: ["notifications"] }))}><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "tokens" && (
        <>
          <Rows className="mb-6">
            <FormRow label="새 토큰" help="CI·스크립트가 로그인 없이 API 를 부를 때 씁니다(요청 헤더 Authorization: Bearer …). 토큰은 만들 때 한 번만 보입니다.">
              <div className="flex flex-wrap items-center gap-2">
                <Input className="w-56" value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="이름(예: github-actions)" />
                <Segmented value={tokenRole} onChange={setTokenRole} items={[{ value: "editor", label: "평가 실행 가능(편집자)" }, { value: "viewer", label: "읽기만" }]} />
                <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} disabled={!tokenName.trim()} onClick={createToken}>만들기</Button>
              </div>
            </FormRow>
          </Rows>
          {newToken && (
            <Alert tone="good" className="mb-6" title="토큰을 만들었습니다 — 지금만 볼 수 있습니다">
              <div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all rounded-lg bg-panel px-2 py-1 font-mono text-[12.5px]">{newToken}</code><CopyBtn text={newToken} /></div>
              <div className="mt-2">CI 의 비밀 값(예: GitHub Secrets 의 SEARCHBENCH_TOKEN)에 넣으세요.</div>
            </Alert>
          )}
          <div className="divide-y divide-line border-y border-line">
            {(tokens.data ?? []).map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="font-semibold">{t.name}</span><span className="font-mono text-[12px] text-muted">{t.prefix}…</span>{t.revoked && <Badge tone="bad">꺼짐</Badge>}</div>
                  <div className="text-[12.5px] text-muted">{t.role === "editor" ? "평가 실행 가능" : "읽기만"} · {t.created_by || "–"} · 마지막 사용 {t.last_used_at ? fmt.ago(t.last_used_at) : "없음"}</div>
                </div>
                {!t.revoked && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => api.del(`/tokens/${t.id}`).then(() => qc.invalidateQueries({ queryKey: ["tokens"] }))}>끄기</Button>}
              </div>
            ))}
            {!tokens.data?.length && <div className="py-8 text-center text-[13px] text-muted">토큰이 없습니다.</div>}
          </div>
        </>
      )}

      {tab === "ci" && (
        <>
          <Alert className="mb-6" icon={<Workflow className="h-4 w-4" />} title="배포 전에 검색 품질 확인하기">
            PR·배포 파이프라인에서 <code>POST /api/ci/runs</code> 를 부르면 평가를 돌리고 끝날 때까지 기다린 뒤 <b>passed</b>(통과 여부)를 돌려줍니다. 후보 API 주소를 이번 실행만 바꿀 수 있어 미리보기 배포를 평가할 수 있습니다.
          </Alert>
          <Rows>
            <FormRow label="비교 세트">
              <Select value={s?.id ?? ""} onChange={(e) => setSuite(Number(e.target.value))}>{cat?.suites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            </FormRow>
            <FormRow label="테스트 데이터">
              <Select value={d?.id ?? ""} onChange={(e) => setDataset(Number(e.target.value))}>{cat?.datasets.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.rows}행)</option>)}</Select>
            </FormRow>
            <FormRow label="통과 기준" help="‘저하만 막기’를 권장합니다. 개선을 꼭 요구하면 케이스가 적을 때 자주 실패할 수 있습니다.">
              <Segmented value={gate} onChange={setGate} items={[{ value: "regressed", label: "‘저하’면 실패 (권장)" }, { value: "not_improved", label: "‘개선’이어야 통과" }, { value: "none", label: "끝나기만 하면 통과" }]} />
            </FormRow>
            <FormRow label="주소 바꿀 API (선택)" help="PR 마다 미리보기 서버가 뜬다면 그 주소로 이번 실행의 API 를 바꿉니다.">
              <Select value={overrideLabel} onChange={(e) => setOverrideLabel(e.target.value)}>
                <option value="">바꾸지 않음</option>
                {s?.labels.map((l) => <option key={l} value={l}>{l}</option>)}
              </Select>
            </FormRow>
          </Rows>
          <div className="mt-8">
            <div className="mb-2 flex items-center justify-between"><span className="text-[14px] font-semibold">셸(curl + jq)</span><CopyBtn text={curl} /></div>
            <Code className="whitespace-pre">{curl}</Code>
          </div>
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between"><span className="text-[14px] font-semibold">GitHub Actions (.github/workflows/search-quality.yml)</span><CopyBtn text={gha} /></div>
            <Code className="whitespace-pre">{gha}</Code>
          </div>
          <p className="mt-3 text-[12.5px] text-muted">SEARCHBENCH_URL(이 서버 주소)과 SEARCHBENCH_TOKEN(‘API 토큰’ 탭에서 만든 토큰)을 CI 비밀 값으로 넣으세요. 응답에는 verdict·ndcg_diff·신뢰구간·결과 링크가 함께 옵니다.</p>
        </>
      )}

      {editing && <ChannelDialog initial={editing === "new" ? undefined : editing} events={chans.data?.events ?? {}} onClose={() => setEditing(null)} />}
    </>
  );
}
