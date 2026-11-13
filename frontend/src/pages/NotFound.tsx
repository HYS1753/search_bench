import { Link } from "react-router-dom";
import { Button, Empty } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <Empty title="페이지를 찾을 수 없습니다" action={<Link to="/"><Button variant="primary">개요로 가기</Button></Link>}>
      주소가 바뀌었거나 삭제된 항목일 수 있습니다.
    </Empty>
  );
}
