// 원래 필드 이름(q, up_org_nm, primaryResponsibilities …)을 사람이 읽는 한국어 이름으로 제안한다.
// 판정 모델도 이 이름을 보므로 'org_nm' 보다 '조직명'이 판정에 유리하다. 제안일 뿐 언제든 고칠 수 있다.

const WHOLE: Record<string, string> = {
  q: "질문", query: "질문", question: "질문", text: "내용", keyword: "키워드", keywords: "키워드", kw: "키워드", terms: "키워드",
  search: "검색어", term: "검색어", prompt: "질문", input: "입력", message: "메시지",
  top_k: "결과 수", topk: "결과 수", k: "결과 수", size: "결과 수", limit: "결과 수", count: "개수", rows: "결과 수", page_size: "결과 수", n: "결과 수",
  page: "페이지", offset: "시작 위치", from: "시작 위치", lang: "언어", locale: "언어", language: "언어",
  cat: "분류", category: "분류", type: "유형", filter: "필터", sort: "정렬", order: "정렬",
  id: "ID", key: "키", title: "제목", name: "이름", subject: "제목", headline: "제목",
  description: "설명", desc: "설명", summary: "요약", content: "내용", body: "본문", snippet: "발췌", abstract: "요약",
  url: "링크", link: "링크", score: "점수", rank: "순위", date: "날짜", created_at: "작성일", updated_at: "수정일",
  price: "가격", brand: "브랜드", tags: "태그", tag: "태그", author: "작성자", source: "출처",
  employee_id: "사번", emp_no: "사번", empno: "사번", member_name: "이름", emp_nm: "이름",
  org_nm: "조직명", up_org_nm: "상위 조직명", dept: "부서", dept_nm: "부서명", position_name: "직위", position: "직위", job_title: "직책",
  phone_number: "전화번호", phone: "전화번호", email: "이메일",
  primary_responsibilities: "주요 담당 업무", primary_responsibility_details: "담당 업무 상세", role_keywords: "역할 키워드",
};
const TOKEN: Record<string, string> = {
  org: "조직", up: "상위", parent: "상위", dept: "부서", team: "팀", emp: "직원", employee: "직원", member: "구성원", user: "사용자",
  nm: "명", name: "이름", id: "ID", no: "번호", code: "코드", cd: "코드", key: "키",
  position: "직위", job: "직무", title: "제목", role: "역할", roles: "역할", primary: "주요", main: "주요",
  responsibility: "담당 업무", responsibilities: "담당 업무", duty: "업무", duties: "업무", task: "업무", work: "업무",
  detail: "상세", details: "상세", desc: "설명", description: "설명", summary: "요약", content: "내용", text: "내용", body: "본문",
  keyword: "키워드", keywords: "키워드", tag: "태그", tags: "태그", category: "분류", cat: "분류", type: "유형", kind: "종류",
  product: "상품", item: "항목", goods: "상품", model: "모델", brand: "브랜드", price: "가격", sale: "판매", stock: "재고",
  doc: "문서", document: "문서", file: "파일", page: "페이지", section: "섹션", chunk: "본문 조각", paragraph: "문단",
  date: "날짜", time: "시간", created: "작성", updated: "수정", start: "시작", end: "종료",
  phone: "전화번호", tel: "전화번호", email: "이메일", address: "주소", addr: "주소", location: "위치", region: "지역",
  url: "링크", link: "링크", image: "이미지", img: "이미지", score: "점수", rank: "순위", count: "개수", num: "수", total: "합계",
  question: "질문", answer: "답변", faq: "FAQ", policy: "규정", rule: "규정", manual: "매뉴얼",
  status: "상태", flag: "여부", yn: "여부", is: "", has: "", of: "", the: "", info: "정보", data: "", value: "값",
};

function leaf(path: string): string {
  return (path.split(/[.[\]]+/).filter(Boolean).pop() ?? path).replace(/^\$$/, "");
}

const AS_INPUT: Record<string, string> = { text: "검색어", content: "검색어", body: "검색어", message: "질문", value: "검색어" };

/** 제안 이름. 사전에 없으면 원래 이름을 그대로 돌려준다. asInput: 요청에 보내는 값(검색어 쪽으로 해석) */
export function humanName(path: string, asInput = false): string {
  const raw = leaf(path);
  const snake = raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (asInput && AS_INPUT[snake]) return AS_INPUT[snake];
  if (WHOLE[snake]) return WHOLE[snake];
  if (/[가-힣]/.test(raw)) return raw;
  const tokens = snake.split(/[_\-\s]+/).filter(Boolean);
  const mapped = tokens.map((t) => (t in TOKEN ? TOKEN[t] : null));
  if (!tokens.length || mapped.some((m) => m === null)) return raw;
  const words = mapped.filter(Boolean) as string[];
  // '조직 명' → '조직명', '상위 조직 명' → '상위 조직명'
  return words.join(" ").replace(/ (명|수)$/, "$1").trim() || raw;
}
