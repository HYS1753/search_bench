import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, KeyRound, Lock, ShieldCheck, UserPlus, Users as UsersIcon } from "lucide-react";
import { useState } from "react";
import { Dialog } from "@/components/ui/overlay";
import { ChoiceList, PageHeader, Segmented, Tabs } from "@/components/ui/page";
import { Alert, Badge, Button, Empty, Input, PageSkeleton, Select, Switch } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { ROLE_DESC, ROLE_LABEL, useAuth, type Role } from "@/lib/auth";
import { fmt } from "@/lib/format";

interface UserRow {
  id: number;
  username: string;
  name: string;
  role: Role;
  role_label: string;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}
interface AuditRow {
  id: number;
  at: string;
  username: string;
  method: string;
  path: string;
  status: number;
  action: string;
}
const ROLES: Role[] = ["admin", "editor", "reviewer", "viewer"];

function NewUser({ first, onClose }: { first: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(first ? "admin" : "editor");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post("/users", { username, name, role, password });
      toast.success(first ? "관리자 계정을 만들었습니다" : "계정을 만들었습니다", first ? "지금부터 로그인이 필요합니다. 이 브라우저는 방금 만든 계정으로 로그인되어 있습니다." : `${username} 에게 아이디와 임시 비밀번호를 알려 주세요.`);
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["auth"] });
      onClose();
    } catch (e) {
      toast.error("만들지 못했습니다", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={first ? "첫 관리자 계정 만들기" : "계정 추가"}
      description={first ? "계정을 만들면 그때부터 모든 사람이 로그인해야 합니다. 첫 계정은 관리자입니다." : "역할에 따라 할 수 있는 일이 다릅니다. 임시 비밀번호는 본인이 로그인 후 바꿀 수 있습니다."}
      footer={<><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" loading={busy} disabled={!username || password.length < 8} onClick={save}>만들기</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="mb-1.5 block text-[13px] font-medium">아이디</span>
            <Input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value.replace(/[^A-Za-z0-9._@-]/g, ""))} placeholder="예: hong.gildong" /></label>
          <label className="block"><span className="mb-1.5 block text-[13px] font-medium">이름</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 홍길동" /></label>
        </div>
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium">{first ? "비밀번호" : "임시 비밀번호"}</span>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="영문·숫자 포함 8자 이상" /></label>
        {!first && (
          <div>
            <span className="mb-1.5 block text-[13px] font-medium">역할</span>
            <ChoiceList value={role} onChange={setRole} columns={2} items={ROLES.map((r) => ({ value: r, title: ROLE_LABEL[r], desc: ROLE_DESC[r] }))} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ResetPassword({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState("");
  const save = async () => {
    try {
      await api.put(`/users/${user.id}`, { password: pw });
      toast.success("비밀번호를 바꿨습니다", `${user.username} 에게 새 임시 비밀번호를 알려 주세요.`);
      onClose();
    } catch (e) {
      toast.error("바꾸지 못했습니다", (e as Error).message);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title={`${user.name || user.username} 비밀번호 재설정`}
      footer={<><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" disabled={pw.length < 8} onClick={save}>재설정</Button></>}>
      <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="새 임시 비밀번호 (영문·숫자 8자 이상)" />
    </Dialog>
  );
}

export default function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const auth = useAuth().data;
  const [tab, setTab] = useState<"users" | "audit">("users");
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [auditUser, setAuditUser] = useState("");
  const [auditKind, setAuditKind] = useState<"all" | "fail">("all");
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ mode: string; items: UserRow[] }>("/users") });
  const audit = useQuery({ queryKey: ["audit", auditUser], queryFn: () => api.get<AuditRow[]>(`/audit?limit=300${auditUser ? `&user=${encodeURIComponent(auditUser)}` : ""}`), enabled: tab === "audit" });
  const patch = async (u: UserRow, body: Partial<UserRow>) => {
    try {
      await api.put(`/users/${u.id}`, body);
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success("바꿨습니다");
    } catch (e) {
      toast.error("바꾸지 못했습니다", (e as Error).message);
    }
  };
  if (users.isLoading) return <PageSkeleton />;
  const items = users.data?.items ?? [];
  const mode = auth?.mode ?? users.data?.mode;
  const auditRows = (audit.data ?? []).filter((a) => auditKind === "all" || a.status >= 400);

  return (
    <>
      <PageHeader eyebrow="운영" title="사용자·권한"
        description="누가 무엇을 할 수 있는지 정하고, 누가 언제 무엇을 바꿨는지 기록을 봅니다."
        actions={<Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>{mode === "users" ? "계정 추가" : "첫 관리자 계정 만들기"}</Button>} />

      {mode === "open" && (
        <Alert tone="warn" className="mb-8" icon={<Lock className="h-4 w-4" />} title="지금은 로그인 없이 누구나 모든 기능을 씁니다">
          사내망에서 여러 사람이 쓴다면 관리자 계정을 만드세요. 계정을 만드는 순간부터 로그인이 필요하고, 사람마다 역할을 줄 수 있습니다.
        </Alert>
      )}
      {mode === "password" && (
        <Alert className="mb-8" icon={<KeyRound className="h-4 w-4" />} title="지금은 공용 비밀번호(APP_PASSWORD) 하나로 로그인합니다">
          계정을 만들면 공용 비밀번호 대신 사람마다 아이디로 로그인하고, 역할별 권한과 감사 기록이 사람 단위로 남습니다.
        </Alert>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ROLES.map((r) => (
          <div key={r} className="rounded-2xl border border-line bg-panel/70 p-4">
            <div className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4 text-accent" />{ROLE_LABEL[r]}<Badge tone="outline">{items.filter((u) => u.role === r && u.active).length}명</Badge></div>
            <div className="mt-1.5 break-keep text-[12.5px] leading-relaxed text-muted">{ROLE_DESC[r]}</div>
          </div>
        ))}
      </div>

      <Tabs value={tab} onChange={setTab} className="mb-6" items={[{ value: "users", label: "계정", count: items.length }, { value: "audit", label: "감사 기록" }]} />

      {tab === "users" && (items.length === 0 ? (
        <Empty icon={<UsersIcon className="h-8 w-8" />} title="계정이 없습니다" action={<Button variant="primary" onClick={() => setAdding(true)}>첫 관리자 계정 만들기</Button>}>
          계정을 만들면 로그인과 역할별 권한이 켜집니다.
        </Empty>
      ) : (
        <div className="divide-y divide-line border-y border-line">
          {items.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-[14px] font-bold text-accent">{(u.name || u.username).slice(0, 1)}</span>
              <div className="min-w-0 flex-1 basis-[200px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{u.name}</span>
                  <span className="font-mono text-[12.5px] text-muted">{u.username}</span>
                  {auth?.user?.id === u.id && <Badge tone="accent">나</Badge>}
                  {!u.active && <Badge tone="bad">꺼짐</Badge>}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted">마지막 로그인 {u.last_login_at ? fmt.ago(u.last_login_at) : "없음"} · 만든 날 {fmt.date(u.created_at)}</div>
              </div>
              <Select className="h-9 w-auto" value={u.role} onChange={(e) => patch(u, { role: e.target.value as Role })} aria-label="역할">
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </Select>
              <Switch checked={u.active} onChange={(v) => patch(u, { active: v })} label={<span className="text-[13px]">{u.active ? "사용" : "꺼짐"}</span>} />
              <Button size="sm" variant="ghost" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setResetting(u)}>비밀번호 재설정</Button>
            </div>
          ))}
        </div>
      ))}

      {tab === "audit" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Segmented value={auditKind} onChange={setAuditKind} items={[{ value: "all", label: "전체" }, { value: "fail", label: "실패·거부" }]} />
            <Select className="h-9 w-auto" value={auditUser} onChange={(e) => setAuditUser(e.target.value)}>
              <option value="">모든 사람</option>
              {items.map((u) => <option key={u.id} value={u.username}>{u.name} ({u.username})</option>)}
            </Select>
            <span className="text-[12.5px] text-muted">바꾸는 작업만 남깁니다. 요청 내용(키·비밀번호)은 남기지 않습니다.</span>
          </div>
          {!auditRows.length ? (
            <Empty icon={<History className="h-8 w-8" />} title="기록이 없습니다" />
          ) : (
            <div className="scroll-thin overflow-x-auto border-y border-line">
              <table className="w-full min-w-[720px] text-[13.5px]">
                <thead className="border-b border-line text-[12px] text-muted">
                  <tr><th className="px-3 py-2.5 text-left font-medium">시각</th><th className="px-3 py-2.5 text-left font-medium">누가</th><th className="px-3 py-2.5 text-left font-medium">무엇을</th><th className="px-3 py-2.5 text-left font-medium">요청</th><th className="px-3 py-2.5 text-right font-medium">결과</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {auditRows.map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmt.date(a.at)}</td>
                      <td className="px-3 font-medium">{a.username || "(로그인 없음)"}</td>
                      <td className="px-3">{a.action || "–"}</td>
                      <td className="px-3 font-mono text-[12px] text-muted">{a.method} {a.path}</td>
                      <td className="px-3 text-right">{a.status < 400 ? <Badge tone="good">성공</Badge> : a.status === 403 ? <Badge tone="warn">권한 없음</Badge> : <Badge tone="bad">실패 {a.status}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {adding && <NewUser first={mode !== "users"} onClose={() => setAdding(false)} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </>
  );
}
