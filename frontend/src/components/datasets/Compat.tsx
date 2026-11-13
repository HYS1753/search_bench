import { AlertTriangle, CheckCircle2, CircleHelp, FileUp, Link2, PenLine, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlay";
import type { Compat, Dataset } from "@/lib/types";

/** 이 데이터를 고른 비교 세트로 바로 쓸 수 있는지 한눈에 */
export function CompatBadge({ c }: { c?: Compat }) {
  if (!c || c.status === "unbound") return null;
  if (c.status === "ready")
    return (
      <Tooltip content={c.mapping.saved ? "이 비교 세트에서 쓴 연결이 저장되어 있어 그대로 씁니다." : "모든 입력에 맞는 열을 찾았습니다."}>
        <span><Badge tone="good"><CheckCircle2 className="h-3 w-3" />바로 사용</Badge></span>
      </Tooltip>
    );
  if (c.status === "check")
    return (
      <Tooltip content={<div className="space-y-1">
        {c.similar.length > 0 && <div>비슷한 이름의 열로 연결한 입력: {c.similar.join(", ")}</div>}
        {c.unmapped_optional.length > 0 && <div>열이 없는 선택 입력: {c.unmapped_optional.join(", ")}</div>}
        <div className="opacity-80">평가 화면에서 연결을 한 번 확인하면 저장되어 다음부터 ‘바로 사용’이 됩니다.</div>
      </div>}>
        <span><Badge tone="warn"><CircleHelp className="h-3 w-3" />연결 확인</Badge></span>
      </Tooltip>
    );
  return (
    <Tooltip content={`필수 입력에 맞는 열이 없습니다: ${c.missing_required.join(", ")}`}>
      <span><Badge tone="bad"><AlertTriangle className="h-3 w-3" />필수 열 부족 {c.missing_required.length}</Badge></span>
    </Tooltip>
  );
}

export function SourceBadge({ d }: { d: Dataset }) {
  const src = d.meta?.source ?? (d.source_filename === "직접 입력" ? "manual" : d.source_filename === "LLM 생성" ? "llm" : d.source_filename ? "file" : "manual");
  if (src === "llm")
    return <Badge tone="accent"><Sparkles className="h-3 w-3" />LLM 생성{d.meta?.grounded ? " · 검색 기반" : ""}</Badge>;
  if (src === "compare") return <Badge tone="outline"><PenLine className="h-3 w-3" />단건 비교에서 모음</Badge>;
  if (src === "file") return <Badge tone="outline"><FileUp className="h-3 w-3" />{d.source_filename || "파일"}</Badge>;
  return <Badge tone="outline"><PenLine className="h-3 w-3" />{src === "paste" ? "붙여넣기" : "직접 입력"}</Badge>;
}

export function BoundBadge({ d }: { d: Dataset }) {
  if (!d.suite_name) return null;
  return <span className="inline-flex items-center gap-1 text-[12.5px] text-muted"><Link2 className="h-3 w-3" />{d.suite_name}</span>;
}
