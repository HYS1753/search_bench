import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Dialog } from "@/components/ui/overlay";
import { Segmented } from "@/components/ui/page";
import { Badge, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { fmt } from "@/lib/format";

interface Share { id: number; token: string; url: string; created_by: string; created_at: string; expires_at: string | null; active: boolean; revoked: boolean; expired: boolean; views: number }

/** 로그인 없이 결과만 볼 수 있는 링크(보기 전용). 주소·키·연결 같은 설정 세부는 보이지 않는다. */
export function ShareDialog({ runId, onClose }: { runId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [days, setDays] = useState<"7" | "30" | "90" | "0">("30");
  const [copied, setCopied] = useState<number | null>(null);
  const list = useQuery({ queryKey: ["shares", runId], queryFn: () => api.get<Share[]>(`/runs/${runId}/shares`) });
  const full = (s: Share) => `${window.location.origin}${s.url}`;
  const copy = async (s: Share) => {
    try {
      await navigator.clipboard.writeText(full(s));
      setCopied(s.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.info("링크", full(s));
    }
  };
  const create = async () => {
    try {
      const s = await api.post<Share>(`/runs/${runId}/share`, { days: days === "0" ? null : Number(days) });
      await qc.invalidateQueries({ queryKey: ["shares", runId] });
      copy(s);
      toast.success("공유 링크를 만들고 복사했습니다", "받는 사람은 로그인 없이 결과만 볼 수 있습니다.");
    } catch (e) {
      toast.error("만들지 못했습니다", (e as Error).message);
    }
  };
  const revoke = async (s: Share) => {
    await api.del(`/shares/${s.id}`).catch((e) => toast.error("끄지 못했습니다", (e as Error).message));
    qc.invalidateQueries({ queryKey: ["shares", runId] });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title="결과 공유" description="링크가 있는 사람은 로그인 없이 이 평가 결과를 볼 수 있습니다(보기 전용). API 주소·키·컬럼 연결 같은 설정은 보이지 않습니다.">
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-5">
        <span className="text-[13.5px] font-medium">유효 기간</span>
        <Segmented value={days} onChange={setDays} items={[{ value: "7", label: "7일" }, { value: "30", label: "30일" }, { value: "90", label: "90일" }, { value: "0", label: "기한 없음" }]} />
        <Button className="ml-auto" variant="primary" icon={<Link2 className="h-4 w-4" />} onClick={create}>링크 만들기</Button>
      </div>
      <div className="divide-y divide-line">
        {(list.data ?? []).map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
            <div className="min-w-0 flex-1 basis-[240px]">
              <div className="truncate font-mono text-[12.5px]">{full(s)}</div>
              <div className="mt-0.5 text-[12px] text-muted">{s.created_by || "–"} · {fmt.date(s.created_at)} · 조회 {s.views}회 · {s.expires_at ? `${fmt.date(s.expires_at)} 까지` : "기한 없음"}</div>
            </div>
            {s.active ? <Badge tone="good">사용 중</Badge> : <Badge>{s.revoked ? "꺼짐" : "만료"}</Badge>}
            {s.active && <Button size="sm" variant="ghost" icon={copied === s.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={() => copy(s)}>{copied === s.id ? "복사됨" : "복사"}</Button>}
            {s.active && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => revoke(s)}>끄기</Button>}
          </div>
        ))}
        {!list.data?.length && <div className="py-6 text-center text-[13px] text-muted">아직 만든 링크가 없습니다.</div>}
      </div>
    </Dialog>
  );
}
