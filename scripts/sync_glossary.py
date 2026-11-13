"""frontend/src/lib/glossary.ts 의 TERMS·HINTS 를 backend/app/glossary.json 으로 복사한다.

HTML 보고서의 (i) 설명이 결과 화면과 같은 문구를 쓰도록 하기 위함이다(Docker 이미지에는 프런트 소스가 없어서 JSON 으로 둔다).
문구를 바꾼 뒤 `python3 scripts/sync_glossary.py` 를 실행하면 되고, 백엔드 테스트가 둘이 어긋나면 알려 준다.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TS = ROOT / "frontend/src/lib/glossary.ts"
OUT = ROOT / "backend/app/glossary.json"


def parse(ts: str) -> dict:
    terms_block = ts[ts.index("export const TERMS"):ts.index("};", ts.index("export const TERMS"))]
    terms = {}
    for m in re.finditer(r'^  (\w+): \{\s*name: "(.*?)",\s*short: "(.*?)",\s*how: "(.*?)",\s*read: "(.*?)",\s*learn: "(.*?)",\s*\},', terms_block, re.M | re.S):
        terms[m.group(1)] = dict(zip(("name", "short", "how", "read", "learn"), m.groups()[1:]))
    hints_block = ts[ts.index("export const HINTS"):ts.index("};", ts.index("export const HINTS"))]
    hints = {m.group(1): m.group(2) for m in re.finditer(r'^  (\w+): "(.*?)",$', hints_block, re.M)}
    return {"terms": terms, "hints": hints}


def main() -> int:
    data = parse(TS.read_text(encoding="utf-8"))
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: 용어 {len(data['terms'])}개 · 설명 {len(data['hints'])}개")
    return 0


if __name__ == "__main__":
    sys.exit(main())
