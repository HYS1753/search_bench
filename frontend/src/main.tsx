import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";

import { StrictMode, Suspense, lazy, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { LogoMark } from "@/components/brand/Logo";
import { Button, Input, PageSkeleton, Spinner } from "@/components/ui/primitives";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useAuth, type AuthStatus } from "@/lib/auth";
import "./index.css";

const Overview = lazy(() => import("@/pages/Overview"));
const Compare = lazy(() => import("@/pages/Compare"));
const Runs = lazy(() => import("@/pages/Runs"));
const RunNew = lazy(() => import("@/pages/RunNew"));
const RunDetail = lazy(() => import("@/pages/RunDetail"));
const Datasets = lazy(() => import("@/pages/Datasets"));
const DatasetDetail = lazy(() => import("@/pages/DatasetDetail"));
const Models = lazy(() => import("@/pages/settings/Models"));
const Targets = lazy(() => import("@/pages/settings/Targets"));
const Suites = lazy(() => import("@/pages/settings/Suites"));
const CriteriaPage = lazy(() => import("@/pages/settings/Criteria"));
const System = lazy(() => import("@/pages/settings/System"));
const Guide = lazy(() => import("@/pages/Guide"));
const GettingStarted = lazy(() => import("@/pages/GettingStarted"));
const Costs = lazy(() => import("@/pages/Costs"));
const GenerateDataset = lazy(() => import("@/pages/GenerateDataset"));
const RunCompare = lazy(() => import("@/pages/RunCompare"));
const Users = lazy(() => import("@/pages/settings/Users"));
const Integrations = lazy(() => import("@/pages/settings/Integrations"));
const SharedRun = lazy(() => import("@/pages/SharedRun"));
const NotFound = lazy(() => import("@/pages/NotFound"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

function Login({ onDone, mode }: { onDone: () => void; mode: AuthStatus["mode"] }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/login", { username, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="animate-fade-up w-full max-w-sm rounded-2xl border border-line bg-panel p-8 shadow-[0_24px_64px_-24px_rgb(16_24_40/0.3)]">
        <div className="mb-7">
          <LogoMark animated className="h-11 w-11" />
          <div className="mt-5 text-[22px] font-bold tracking-tight">Search<span className="text-accent">Bench</span> 로그인</div>
          <div className="mt-1 text-sm text-muted">{mode === "users" ? "관리자에게 받은 아이디와 비밀번호를 입력하세요." : "관리자가 설정한 비밀번호를 입력하세요."}</div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {mode === "users" && <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="아이디" />}
          <Input type="password" autoFocus={mode !== "users"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="비밀번호" />
          {error && <div className="text-sm text-bad">{error}</div>}
          <Button variant="primary" className="w-full justify-center" loading={busy} type="submit">
            로그인
          </Button>
        </form>
      </div>
    </div>
  );
}

function Gate() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useAuth();
  useEffect(() => {
    const onRequired = () => refetch();
    window.addEventListener("auth:required", onRequired);
    return () => window.removeEventListener("auth:required", onRequired);
  }, [refetch]);
  if (isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (data?.required && !data.authenticated)
    return (
      <Login
        mode={data.mode}
        onDone={() => {
          qc.clear();
          refetch();
        }}
      />
    );
  return (
    <AppShell>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/new" element={<RunNew />} />
          <Route path="/runs/compare" element={<RunCompare />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/datasets" element={<Datasets />} />
          <Route path="/datasets/generate" element={<GenerateDataset />} />
          <Route path="/datasets/:id" element={<DatasetDetail />} />
          <Route path="/settings/models" element={<Models />} />
          <Route path="/settings/targets" element={<Targets />} />
          <Route path="/settings/suites" element={<Suites />} />
          <Route path="/settings/criteria" element={<CriteriaPage />} />
          <Route path="/settings/system" element={<System />} />
          <Route path="/costs" element={<Costs />} />
          <Route path="/settings/users" element={<Users />} />
          <Route path="/settings/integrations" element={<Integrations />} />
          <Route path="/guide" element={<Guide />} />
          <Route path="/guide/start" element={<GettingStarted />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipPrimitive.Provider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              {/* 공유 링크는 로그인 없이 보기 전용으로 */}
              <Route path="/share/:token" element={<Suspense fallback={<PageSkeleton />}><SharedRun /></Suspense>} />
              <Route path="*" element={<Gate />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </TooltipPrimitive.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
