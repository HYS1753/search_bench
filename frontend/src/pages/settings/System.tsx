import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { PageHeader, KeyValue, Section } from "@/components/ui/page";
import { Alert, Badge, Button, Card, Kbd, PageSkeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { PROVIDER_LABEL, fmt } from "@/lib/format";
import type { SystemInfo } from "@/lib/types";

export default function System() {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const info = useQuery({ queryKey: ["system-info"], queryFn: () => api.get<SystemInfo>("/system/info") });

  const exportConfig = async () => {
    const data = await api.get<unknown>("/system/export-config");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `judge-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  const importConfig = async (file: File) => {
    setBusy("import");
    try {
      const r = await api.post<{ created: Record<string, number>; note: string }>("/system/import-config", JSON.parse(await file.text()));
      toast.success("설정을 가져왔습니다", `${Object.entries(r.created).map(([k, v]) => `${k} ${v}`).join(" · ")}\n${r.note}`);
      qc.invalidateQueries();
    } catch (e) {
      toast.error("가져오지 못했습니다", (e as Error).message);
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (info.isLoading || !info.data) return <PageSkeleton />;
  const s = info.data;
  return (
    <>
      <PageHeader eyebrow="시스템" title="환경" description="데이터 저장 위치, 키 관리 방식, 환경 변수 상태를 확인하고 설정을 옮깁니다." />
      <Section title="저장소">
        <div>
          <KeyValue
            items={[
              { k: "버전", v: s.version },
              { k: "데이터 위치", v: <span className="font-mono text-[13px]">{s.data_dir}</span> },
              { k: "DB 크기", v: fmt.bytes(s.db_size_bytes) },
              { k: "저장 키 암호화", v: s.secret_key_source },
              { k: "로그인", v: s.login_required ? <Badge tone="good">비밀번호 필요</Badge> : <span className="text-warn">없음 — 아래 안내 참고</span> },
              { k: "보관 항목", v: Object.entries(s.counts).map(([k, v]) => `${({ judge_models: "판정 모델", targets: "검색 API", suites: "비교 세트", criteria: "평가 기준", datasets: "테스트 데이터", runs: "실행" } as Record<string, string>)[k] ?? k} ${v}`).join(" · ") },
            ]}
          />
        </div>
        <Alert className="mt-6" title="데이터는 어디에 남나요?">
          모든 설정·테스트 데이터·실행 결과는 위 <b>데이터 위치</b>의 SQLite(judge.db)에 저장됩니다. Docker 에서는 이 폴더를 볼륨으로 연결해야 컨테이너를 다시 만들어도 데이터가 유지됩니다. secret.key 를 잃어버리면 저장된 키를 복호화할 수 없으니 DB 와 함께 백업하세요. 이 폴더는 git 에 올라가지 않습니다.
        </Alert>
        {!s.login_required && (
          <Alert tone="warn" className="mt-3" title="팀 서버에 띄운다면">
            <Kbd>APP_PASSWORD</Kbd> 환경 변수를 설정해 로그인을 켜세요. 지금은 주소를 아는 누구나 설정과 결과를 볼 수 있습니다.
          </Alert>
        )}
      </Section>

      <Section title="환경 변수 키" description="환경 변수에 키가 있으면 설정 화면에 저장한 키보다 우선합니다.">
        <Card className="divide-y divide-line">
          {Object.entries(s.env_keys).map(([p, env]) => (
            <div key={p} className="flex flex-wrap items-center justify-between gap-2 py-3.5 text-[14px]">
              <span>{PROVIDER_LABEL[p] ?? p}</span>
              {env ? <Badge tone="good">{env} 설정됨</Badge> : <span className="text-muted">없음 · 화면에서 입력한 키 사용</span>}
            </div>
          ))}
        </Card>
        <div className="mt-3 text-[13px] text-muted">
          기본값 · 대상 타임아웃 {s.target_defaults.timeout_seconds}초 · SSL 검증 {s.target_defaults.verify_ssl ? "켬" : "끔"} · 배치 동시 실행 {s.run_defaults.concurrency} · 판정 타임아웃 {s.run_defaults.judge_timeout_seconds}초 · 재시도 {s.run_defaults.judge_max_retries}회
        </div>
      </Section>

      <Section title="설정 옮기기" description="다른 서버로 설정을 옮길 때 씁니다. 키는 포함하지 않습니다.">
        <div className="grid gap-x-10 md:grid-cols-2">
          <Card className="flex flex-col border-b-0 py-6">
            <Download className="h-5 w-5 text-accent" />
            <div className="mt-3 font-semibold">설정 내보내기</div>
            <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted">판정 모델·검색 API·비교 세트·평가 기준을 JSON 으로 저장합니다. 키는 포함하지 않습니다.</p>
            <Button className="mt-4 self-start" size="sm" onClick={exportConfig}>내보내기</Button>
          </Card>
          <Card className="flex flex-col border-b-0 py-6">
            <Upload className="h-5 w-5 text-accent" />
            <div className="mt-3 font-semibold">설정 가져오기</div>
            <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted">다른 서버에서 내보낸 JSON 을 추가로 등록합니다. 기존 항목은 덮어쓰지 않습니다.</p>
            <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && importConfig(e.target.files[0])} />
            <Button className="mt-4 self-start" size="sm" loading={busy === "import"} onClick={() => fileRef.current?.click()}>파일 선택</Button>
          </Card>
        </div>
      </Section>
    </>
  );
}
