import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Command as CommandIcon,
  Compass,
  Plus,
  Search,
  Sparkles,
  Bot,
  GitCompareArrows,
  History,
  Layers,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PlayCircle,
  Plug,
  Scale,
  Settings2,
  Sun,
  Table2,
  KeyRound,
  Users,
  Wallet,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { CommandPalette, isMac, type Command } from "@/components/layout/CommandPalette";
import { Dialog } from "@/components/ui/overlay";
import { Button, Input, Progress } from "@/components/ui/primitives";
import { ROLE_LABEL, can, useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import type { ActiveRun, Run } from "@/lib/types";

const NAV: { group?: string; items: { to: string; label: string; icon: ReactNode; end?: boolean; admin?: boolean }[] }[] = [
  { items: [{ to: "/", label: "개요", icon: <LayoutGrid className="h-[18px] w-[18px]" />, end: true }] },
  {
    group: "비교",
    items: [{ to: "/compare", label: "단건 검색 비교", icon: <GitCompareArrows className="h-[18px] w-[18px]" /> }],
  },
  {
    group: "평가",
    items: [
      { to: "/runs/new", label: "평가", icon: <PlayCircle className="h-[18px] w-[18px]" /> },
      { to: "/runs", label: "평가 실행 기록", icon: <History className="h-[18px] w-[18px]" />, end: true },
    ],
  },
  {
    group: "연결",
    items: [
      { to: "/settings/targets", label: "검색 API", icon: <Plug className="h-[18px] w-[18px]" /> },
      { to: "/settings/models", label: "판정 모델", icon: <Bot className="h-[18px] w-[18px]" /> },
    ],
  },
  {
    group: "평가 구성",
    items: [
      { to: "/settings/suites", label: "비교 세트", icon: <Layers className="h-[18px] w-[18px]" /> },
      { to: "/settings/criteria", label: "평가 기준", icon: <Scale className="h-[18px] w-[18px]" /> },
      { to: "/datasets", label: "테스트 데이터", icon: <Table2 className="h-[18px] w-[18px]" /> },
    ],
  },
  {
    group: "운영",
    items: [
      { to: "/costs", label: "비용", icon: <Wallet className="h-[18px] w-[18px]" /> },
      { to: "/settings/users", label: "사용자·권한", icon: <Users className="h-[18px] w-[18px]" />, admin: true },
      { to: "/settings/integrations", label: "연동 (알림·CI)", icon: <Workflow className="h-[18px] w-[18px]" />, admin: true },
      { to: "/settings/system", label: "환경", icon: <Settings2 className="h-[18px] w-[18px]" /> },
    ],
  },
  {
    group: "도움말",
    items: [
      { to: "/guide", label: "평가 방법", icon: <BookOpen className="h-[18px] w-[18px]" />, end: true },
      { to: "/guide/start", label: "시작 가이드", icon: <Compass className="h-[18px] w-[18px]" /> },
    ],
  },
];

function useCommands(setTheme: (t: Theme) => void): Command[] {
  const nav = NAV.flatMap((g) => g.items.map((it) => ({
    id: `nav:${it.to}`, label: it.label, group: "이동", icon: it.icon, keywords: g.group, hint: g.group,
    run: (n: (to: string) => void) => n(it.to),
  })));
  return [
    { id: "new-run", label: "새 평가 시작", group: "작업", icon: <Plus className="h-4 w-4" />, keywords: "run 실행 평가", run: (n) => n("/runs/new") },
    { id: "compare", label: "결과 나란히 보기 (단건 검색 비교)", group: "작업", icon: <GitCompareArrows className="h-4 w-4" />, keywords: "compare", run: (n) => n("/compare") },
    { id: "new-target", label: "검색 API 연결하기", group: "작업", icon: <Plug className="h-4 w-4" />, keywords: "api target 추가", run: (n) => n("/settings/targets") },
    { id: "gen-data", label: "테스트 데이터 LLM 으로 만들기", group: "작업", icon: <Sparkles className="h-4 w-4" />, keywords: "생성 합성 질의 데이터셋 generate", run: (n) => n("/datasets/generate") },
    { id: "costs", label: "비용 보기 (모델별·기간별)", group: "작업", icon: <Wallet className="h-4 w-4" />, keywords: "cost 토큰 요금 비용", run: (n) => n("/costs") },
    { id: "new-suite", label: "비교 세트 만들기", group: "작업", icon: <Layers className="h-4 w-4" />, keywords: "suite", run: (n) => n("/settings/suites") },
    { id: "start", label: "처음 사용하기 — 시작 가이드", group: "작업", icon: <Compass className="h-4 w-4" />, keywords: "onboarding 튜토리얼 도움말", run: (n) => n("/guide/start") },
    ...nav,
    { id: "theme-light", label: "라이트 테마", group: "화면", icon: <Sun className="h-4 w-4" />, keywords: "theme", run: () => setTheme("light") },
    { id: "theme-dark", label: "다크 테마", group: "화면", icon: <Moon className="h-4 w-4" />, keywords: "theme", run: () => setTheme("dark") },
    { id: "theme-system", label: "시스템 테마 따르기", group: "화면", icon: <Monitor className="h-4 w-4" />, keywords: "theme", run: () => setTheme("system") },
  ];
}

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* 저장 불가 환경 */
    }
  }, [theme]);
  return [theme, setTheme];
}

/** 진행 중인 실행 — 어느 화면에 있어도 보이고, 끝나면 알림을 띄운다. */
function ActiveRuns() {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const prev = useRef<Map<number, string>>(new Map());
  const { data = [] } = useQuery({
    queryKey: ["runs", "active"],
    queryFn: () => api.get<ActiveRun[]>("/runs/active"),
    refetchInterval: 4000,
  });
  useEffect(() => {
    const now = new Map(data.map((r) => [r.id, r.name]));
    for (const [id, name] of prev.current) {
      if (!now.has(id)) {
        api.get<Run>(`/runs/${id}`).then((run) => {
          qc.invalidateQueries({ queryKey: ["runs"] });
          qc.invalidateQueries({ queryKey: ["overview"] });
          if (run.status === "done") toast.success("평가가 끝났습니다", `${name} · 결과를 확인하세요.`);
          else if (run.status === "failed") toast.error("평가가 실패했습니다", run.error || name);
        }).catch(() => {});
      }
    }
    prev.current = now;
  }, [data, qc, toast]);
  if (!data.length) return null;
  return (
    <div className="mx-4 mb-3 space-y-2.5 border-t border-line px-3 pt-4">
      <div className="flex items-center gap-2 text-[12px] font-medium text-muted">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        진행 중 {data.length}건
      </div>
      {data.slice(0, 3).map((r) => (
        <button key={r.id} onClick={() => navigate(`/runs/${r.id}`)} className="block w-full text-left">
          <div className="truncate text-[12.5px] text-ink">{r.name}</div>
          <div className="mt-1 flex items-center gap-2">
            <Progress value={r.completed + r.failed} max={r.total} className="h-1" />
            <span className="num shrink-0 text-[11px] text-muted">
              {r.completed + r.failed}/{r.total}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post("/auth/password", { current: cur, new: next });
      toast.success("비밀번호를 바꿨습니다");
      onClose();
    } catch (e) {
      toast.error("바꾸지 못했습니다", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="비밀번호 바꾸기" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>취소</Button><Button variant="primary" loading={busy} disabled={!cur || next.length < 8} onClick={save}>바꾸기</Button></>}>
      <div className="space-y-3">
        <Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="지금 비밀번호" />
        <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="새 비밀번호 (영문·숫자 포함 8자 이상)" />
      </div>
    </Dialog>
  );
}

function Sidebar({ onNavigate, theme, setTheme, onSearch }: { onNavigate?: () => void; theme: Theme; setTheme: (t: Theme) => void; onSearch: () => void }) {
  const auth = useAuth().data;
  const me = auth?.user;
  const [pw, setPw] = useState(false);
  const nextTheme: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <div className="flex h-full flex-col">
      <Link to="/" onClick={onNavigate} className="block px-7 pb-6 pt-8" aria-label="SearchBench 홈">
        <Logo />
      </Link>
      <div className="px-4 pb-5">
        <button
          onClick={onSearch}
          className="press flex w-full items-center gap-2.5 rounded-xl border border-line bg-panel/70 px-3 py-2 text-[13.5px] text-faint shadow-soft hover:border-faint/60 hover:text-muted"
        >
          <Search className="h-4 w-4" />
          검색·바로 가기
          <kbd className="ml-auto flex items-center gap-0.5 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px]">
            {isMac() ? <CommandIcon className="h-3 w-3" /> : "Ctrl"}K
          </kbd>
        </button>
      </div>
      <nav className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {NAV.map((g) => ({ ...g, items: g.items.filter((it) => !it.admin || can(me, "admin")) })).map((g, i) => (
          <div key={i}>
            {g.group && <div className="mb-1 px-3 text-[12.5px] text-muted">{g.group}</div>}
            <div className="space-y-0.5">
              {g.items.map((it) => (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      "group relative flex items-center gap-3 rounded-2xl px-3 py-2 text-[14.5px] transition-[background-color,color,box-shadow] duration-200",
                      isActive ? "bg-panel font-semibold text-ink shadow-[0_1px_3px_rgb(16_24_40/0.08),0_4px_14px_rgb(16_24_40/0.05)]" : "text-ink/75 hover:bg-panel/60 hover:text-ink",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={cn("absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-all duration-300", isActive ? "opacity-100" : "scale-y-0 opacity-0")} />
                      <span className={cn("transition-transform duration-200 group-hover:scale-110", isActive ? "text-accent" : "")}>{it.icon}</span>
                      {it.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <ActiveRuns />
      {auth?.required && me && (
        <div className="mx-4 flex items-center gap-3 border-t border-line px-2 pt-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent">{(me.name || me.username || "?").slice(0, 1)}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{me.name || me.username}</div>
            <div className="text-[12px] text-muted">{me.role_label ?? ROLE_LABEL[me.role]}</div>
          </div>
          {!!me.id && (
            <button onClick={() => setPw(true)} className="rounded-lg p-1.5 text-muted hover:bg-panel hover:text-ink" title="비밀번호 바꾸기" aria-label="비밀번호 바꾸기">
              <KeyRound className="h-4 w-4" />
            </button>
          )}
          <button onClick={() => api.post("/auth/logout").then(() => window.location.assign("/"))} className="rounded-lg p-1.5 text-muted hover:bg-panel hover:text-ink" title="로그아웃" aria-label="로그아웃">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      )}
      {pw && <PasswordDialog onClose={() => setPw(false)} />}
      <div className="flex items-center gap-1 px-5 py-4">
        <button
          onClick={() => setTheme(nextTheme[theme])}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-panel hover:text-ink"
          title="화면 테마 바꾸기"
        >
          <ThemeIcon className="h-4 w-4" />
          {theme === "system" ? "시스템" : theme === "light" ? "라이트" : "다크"}
        </button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const me = useAuth().data?.user;
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useTheme();
  const commands = useCommands(setTheme);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const side = { theme, setTheme, onSearch: () => setPalette(true) };
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-[280px] shrink-0 border-r border-line lg:block">
        <Sidebar {...side} />
      </aside>
      <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur-md lg:hidden">
        <button onClick={() => setOpen(true)} className="press rounded-lg p-2 text-muted hover:bg-panel" aria-label="메뉴 열기">
          <Menu className="h-5 w-5" />
        </button>
        <Link to="/" aria-label="SearchBench 홈"><Logo compact /></Link>
        <button onClick={() => setPalette(true)} className="press ml-auto rounded-lg p-2 text-muted hover:bg-panel" aria-label="검색">
          <Search className="h-5 w-5" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="animate-fade-in absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="mobile-nav-in absolute inset-y-0 left-0 w-[280px] bg-bg shadow-2xl">
            <button onClick={() => setOpen(false)} className="absolute right-3 top-3 rounded-lg p-2 text-muted" aria-label="메뉴 닫기">
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} {...side} onSearch={() => { setOpen(false); setPalette(true); }} />
          </div>
        </div>
      )}
      <main className="min-w-0 flex-1 px-4 pb-24 pt-20 sm:px-8 lg:px-14 lg:pt-[84px]">
        <div key={location.pathname} className="animate-page mx-auto max-w-[1200px]">
          {me && !can(me, "editor") && (
            <div className="mb-6 flex items-center gap-2 rounded-xl bg-subtle px-4 py-2.5 text-[13px] text-muted">
              <KeyRound className="h-3.5 w-3.5" />
              {me.role === "reviewer" ? "검수자 계정입니다. 결과 보기와 사람 검수를 할 수 있고, 설정·평가 실행은 편집자 이상만 할 수 있습니다." : "보기 전용 계정입니다. 결과 보기와 단건 검색 비교만 할 수 있습니다."}
            </div>
          )}
          {children}
        </div>
      </main>
      <CommandPalette commands={commands} open={palette} onOpenChange={setPalette} />
    </div>
  );
}
