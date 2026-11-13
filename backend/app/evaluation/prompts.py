"""판정 프롬프트.

공용 루브릭(이 파일, 고정) + 평가 기준의 [검색 목적]·[사용자 요구사항](설정 화면) 을 조립한다.
- 항목 관련도: TREC 4단계 등급 관련도, UMBRELA(Upadhyay et al., 2024) 식 '의도 파악 → 일치도·신뢰도 → 등급' 절차
- 목록 비교: MT-Bench(Zheng et al., 2023) 식 쌍대 비교. 호출부에서 순서를 바꿔 두 번 묻는다.
- 근거(reason)를 등급보다 먼저 쓰게 해 즉흥 판정을 줄인다.
"""

from __future__ import annotations

import string
from typing import Any

DEFAULT_TASK_CONTEXT = "사용자의 질의에 가장 직접적으로 답하는 대상을 찾는 검색이다."

SYSTEM = (
    "당신은 검색 품질을 평가하는 숙련된 평가자입니다. 주어진 기준과 정보만으로 일관되고 공정하게 판정하며, "
    "결과는 지정된 JSON 형식으로만 출력합니다. 근거는 한국어로 간결하게 씁니다."
)

GRADE_SCALE = """\
3 = 매우 관련: 질의의 의도에 직접 답하는 대상이다. 사용자가 이 항목만 보고 원하는 것을 해결할 수 있다.
2 = 관련: 질의를 해결하는 데 실질적으로 도움이 되지만 일부 조건이 빠졌거나 간접적이다.
1 = 약간 관련: 주제나 키워드는 겹치지만 질의의 요구를 충족하지 못한다.
0 = 무관: 질의와 관련이 없다."""

GRADE_LABELS = {3: "매우 관련", 2: "관련", 1: "약간 관련", 0: "무관"}

ITEM_TEMPLATE = """\
# 평가 과제
검색 시스템이 질의에 대해 반환한 항목들의 관련도를 **항목마다 독립적으로** 판정한다.

# 검색 목적
{task_context}

# 관련도 척도 (0~3)
{grade_scale}

# 판정 절차
1. 질의의 의도(무엇을 찾는지, 어떤 조건이 있는지)를 먼저 파악한다.
2. 항목 내용이 그 의도를 얼마나 충족하는지(일치도), 근거가 항목 안에 명확히 있는지(신뢰도)를 본다.
3. 두 가지를 종합해 0~3 중 하나를 고른다.

# 지켜야 할 원칙
- 항목에 적힌 정보만 근거로 판단한다. 이름·제목만 보고 추측하지 않는다.
- 다른 항목과 비교하지 않는다. 순위·표시 순서는 등급과 무관하다.
- 질의의 단어가 겹친다는 이유만으로 점수를 주지 않는다.
{expected_section}{requirements_section}
# 질의
{query_block}

# 판정할 항목 ({count}개)
{items_block}

# 출력
모든 항목에 대해 judgments 배열에 key(항목 앞 대괄호 안의 값 그대로), reason(판정 근거 한 문장), grade(0~3 정수)를 넣는다.
"""

PAIRWISE_TEMPLATE = """\
# 평가 과제
같은 질의에 대한 두 검색 결과 목록(A, B)을 비교해 **사용자에게 더 유용한 쪽**을 고른다.

# 검색 목적
{task_context}

# 비교 기준 (중요도 순)
1. 상위 순위(특히 1위)에 질의에 직접 답하는 항목이 있는가
2. 상위 {k}개 안에서 관련 항목의 비율과 순서가 좋은가
3. 무관한 항목이 상위에 섞여 있는가 (감점)

# 지켜야 할 원칙
- 결과 개수가 많다고 더 좋은 것이 아니다.
- A·B 표시 순서는 품질과 무관하다. 순서 때문에 한쪽을 선호하지 않는다.
- 두 목록이 실질적으로 같거나 우열을 가리기 어려우면 TIE 로 판정한다.
- 목록에 적힌 정보만 근거로 판단한다.
{expected_section}{requirements_section}
# 질의
{query_block}

# 결과 A ({a_status})
{a_block}

# 결과 B ({b_status})
{b_block}

# 출력
reason(어느 항목이 결정적이었는지 2~3문장), winner(A, B, TIE 중 하나), confidence(low, medium, high)를 낸다.
"""

ITEM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "judgments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "reason": {"type": "string"},
                    "grade": {"type": "integer"},
                },
                "required": ["key", "reason", "grade"],
            },
        }
    },
    "required": ["judgments"],
}

PAIRWISE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "reason": {"type": "string"},
        "winner": {"type": "string", "enum": ["A", "B", "TIE"]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["reason", "winner", "confidence"],
}


def _section(title: str, body: str) -> str:
    body = (body or "").strip()
    return f"\n# {title}\n{body}\n" if body else ""


def expected_section(expected: str) -> str:
    return _section(
        "기대 정답 힌트 (참고용)",
        f"{expected}\n- 힌트와 다르더라도 항목 내용상 근거가 명확하면 관련으로 인정한다." if expected.strip() else "",
    )


def requirements_section(requirements: str) -> str:
    return _section(
        "사용자 요구사항 (위 원칙과 함께 반드시 반영)",
        requirements,
    )


def query_block(inputs: dict[str, Any], labels: dict[str, str] | None = None) -> str:
    labels = labels or {}
    lines = []
    for key, value in inputs.items():
        if value is None or value == "" or value == []:
            continue
        shown = ", ".join(map(str, value)) if isinstance(value, list) else str(value)
        lines.append(f"- {labels.get(key, key)}: {shown}")
    return "\n".join(lines) or "- (입력 없음)"


def item_text(item: dict[str, Any], *, with_key: bool) -> str:
    head = f"[{item['key']}] {item.get('title', '')}" if with_key else f"{item.get('title', '')}"
    lines = [head]
    for f in item.get("fields", []):
        lines.append(f"  - {f['label']}: {f['value']}")
    return "\n".join(lines)


def list_block(items: list[dict[str, Any]]) -> str:
    if not items:
        return "(결과 0건)"
    return "\n".join(f"{i}위. {item_text(it, with_key=False)}" for i, it in enumerate(items, start=1))


# ── 고급 설정: 평가 기준마다 판정 프롬프트를 바꿀 수 있다(비우면 위 기본값) ──

DEFAULTS = {"system_prompt": SYSTEM, "item_template": ITEM_TEMPLATE, "pairwise_template": PAIRWISE_TEMPLATE}

# 템플릿에 쓸 수 있는 자리 표시자와 꼭 있어야 하는 것
PLACEHOLDERS: dict[str, dict[str, Any]] = {
    "item_template": {
        "allowed": {
            "task_context": "검색 목적(평가 기준에서 작성)",
            "grade_scale": "관련도 척도 0~3 설명",
            "expected_section": "기대 정답 힌트(있을 때만 제목 포함)",
            "requirements_section": "사용자 요구사항(있을 때만 제목 포함)",
            "query_block": "질의(입력값 목록)",
            "count": "이번 묶음의 항목 수",
            "items_block": "판정할 항목들([key] 제목 + 필드)",
        },
        "required": ["query_block", "items_block"],
    },
    "pairwise_template": {
        "allowed": {
            "task_context": "검색 목적",
            "k": "비교할 상위 개수",
            "expected_section": "기대 정답 힌트",
            "requirements_section": "사용자 요구사항",
            "query_block": "질의",
            "a_status": "A 목록 상태(건수 또는 호출 실패)",
            "a_block": "A 목록",
            "b_status": "B 목록 상태",
            "b_block": "B 목록",
        },
        "required": ["query_block", "a_block", "b_block"],
    },
    "system_prompt": {"allowed": {}, "required": []},
}


def validate_template(kind: str, text: str) -> list[str]:
    """빈 문자열은 '기본값 사용'. 자리 표시자 오타·누락·중괄호 오류를 찾는다."""
    if not (text or "").strip():
        return []
    spec = PLACEHOLDERS[kind]
    errors: list[str] = []
    try:
        names = [f for _, f, _, _ in string.Formatter().parse(text) if f is not None]
    except ValueError as exc:
        return [f"중괄호가 짝이 맞지 않습니다({exc}). 글자 그대로의 중괄호는 {{{{ }}}} 처럼 두 번 쓰세요."]
    for n in names:
        if n == "" or n not in spec["allowed"]:
            shown = "{}" if n == "" else "{" + n + "}"
            hint = "쓸 수 있는 것: " + ", ".join("{" + a + "}" for a in spec["allowed"]) if spec["allowed"] else "시스템 프롬프트에는 자리 표시자를 쓸 수 없습니다(중괄호는 {{ }} 로)."
            errors.append(f"알 수 없는 자리 표시자 {shown}. {hint}")
    for r in spec["required"]:
        if r not in names:
            errors.append(f"필수 자리 표시자 {{{r}}} 가 없습니다.")
    return errors


def system_text(custom: str = "") -> str:
    return (custom or "").strip() or SYSTEM


def build_item_prompt(
    *, task_context: str, requirements: str, expected: str, inputs: dict[str, Any],
    labels: dict[str, str] | None, items: list[dict[str, Any]], template: str = "",
) -> str:
    return ((template or "").strip() or ITEM_TEMPLATE).format(
        task_context=(task_context or DEFAULT_TASK_CONTEXT).strip(),
        grade_scale=GRADE_SCALE,
        expected_section=expected_section(expected),
        requirements_section=requirements_section(requirements),
        query_block=query_block(inputs, labels),
        count=len(items),
        items_block="\n\n".join(item_text(it, with_key=True) for it in items),
    )


def build_pairwise_prompt(
    *, task_context: str, requirements: str, expected: str, inputs: dict[str, Any],
    labels: dict[str, str] | None, k: int, a: dict[str, Any], b: dict[str, Any], template: str = "",
) -> str:
    def status(side: dict[str, Any]) -> str:
        return f"호출 실패: {side.get('error')}" if not side.get("ok") else f"{len(side['items'])}건"

    return ((template or "").strip() or PAIRWISE_TEMPLATE).format(
        task_context=(task_context or DEFAULT_TASK_CONTEXT).strip(),
        k=k,
        expected_section=expected_section(expected),
        requirements_section=requirements_section(requirements),
        query_block=query_block(inputs, labels),
        a_status=status(a),
        a_block=list_block(a["items"]),
        b_status=status(b),
        b_block=list_block(b["items"]),
    )


def preview(task_context: str, requirements: str, k: int, *, system_prompt: str = "", item_template: str = "",
            pairwise_template: str = "") -> dict[str, str]:
    """설정 화면의 '최종 프롬프트 미리보기'(예시 질의·항목으로 조립)."""
    sample_inputs = {"query": "예시 입력"}
    sample_items = [
        {"key": "item-1", "title": "예시 항목 1", "fields": [{"label": "설명", "value": "항목 내용"}]},
        {"key": "item-2", "title": "예시 항목 2", "fields": [{"label": "설명", "value": "항목 내용"}]},
    ]
    item_prompt = build_item_prompt(
        task_context=task_context, requirements=requirements, expected="", inputs=sample_inputs,
        labels={"query": "검색어"}, items=sample_items, template=item_template,
    )
    pair_prompt = build_pairwise_prompt(
        task_context=task_context, requirements=requirements, expected="", inputs=sample_inputs,
        labels={"query": "검색어"}, k=k,
        a={"ok": True, "items": sample_items}, b={"ok": True, "items": list(reversed(sample_items))},
        template=pairwise_template,
    )
    return {"system": system_text(system_prompt), "item": item_prompt, "pairwise": pair_prompt}
