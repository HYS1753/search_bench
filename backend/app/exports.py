"""실행 결과 내보내기 — CSV(케이스 단위), XLSX(요약·케이스·항목 판정·목록 비교·설정), JSON(전체)."""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from app.evaluation.prompts import GRADE_LABELS
from app.models import Run, RunCase
from app.runs import member_prefix

WINNER_KO = {"candidate": "후보 승", "baseline": "기준 승", "tie": "무승부"}


def _fmt(v: Any, digits: int = 3) -> Any:
    if isinstance(v, float):
        return round(v, digits)
    return v


def _inputs_text(v: Any) -> str:
    return " ".join(map(str, v)) if isinstance(v, list) else ("" if v is None else str(v))


def case_rows(run: Run, cases: list[RunCase]) -> tuple[list[str], list[list[Any]]]:
    members = run.snapshot.get("members", [])
    baseline = next((m["label"] for m in members if m.get("is_baseline")), "")
    fields = [f["key"] for f in run.snapshot.get("suite", {}).get("input_fields", [])]
    header = ["케이스", "분류", *fields, "기대 힌트", "상태", "오류"]
    for m in members:
        lb = m["label"]
        header += [f"{lb} 1위", f"{lb} 1위 등급", f"{lb} nDCG", f"{lb} Hit@1", f"{lb} MRR", f"{lb} Precision", f"{lb} 호출", f"{lb} 지연(ms)"]
    for m in members:
        if m["label"] != baseline:
            header += [f"{m['label']} vs {baseline} 결과", f"{m['label']} vs {baseline} 순서 일치", f"{m['label']} vs {baseline} 근거"]
    prefixes = member_prefix(run.snapshot)
    rows = []
    for c in cases:
        resp = {r.label: r for r in c.responses}
        row: list[Any] = [c.case_key, c.category, *[_inputs_text(c.inputs.get(f)) for f in fields], c.expected, c.status, c.error]
        for m in members:
            lb = m["label"]
            r = resp.get(lb)
            met = (c.metrics or {}).get(lb, {})
            top = r.items[0] if r and r.ok and r.items else None
            grade = (c.item_judgments or {}).get(prefixes.get(lb, ("", 0))[0] + top["key"], {}).get("grade") if top else None
            row += [
                top["title"] if top else ("호출 실패" if r and not r.ok else ""),
                grade,
                _fmt(met.get("ndcg")), _fmt(met.get("hit1")), _fmt(met.get("mrr")), _fmt(met.get("precision")),
                ("성공" if r.ok else f"실패: {r.error}") if r else "",
                r.latency_ms if r else None,
            ]
        for m in members:
            if m["label"] == baseline:
                continue
            pw = (c.pairwise or {}).get(m["label"])
            row += [WINNER_KO.get(pw["winner"], "") if pw else "", ("예" if pw.get("consistent") else "아니오") if pw else "", pw.get("reason", "") if pw else ""]
        rows.append(row)
    return header, rows


def to_csv(run: Run, cases: list[RunCase]) -> str:
    header, rows = case_rows(run, cases)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return "﻿" + buf.getvalue()


def to_json(run: Run, cases: list[RunCase]) -> str:
    payload = {
        "run": {
            "id": run.id, "name": run.name, "status": run.status,
            "created_at": run.created_at.isoformat() + "Z",
            "finished_at": run.finished_at.isoformat() + "Z" if run.finished_at else None,
            "judge_calls": run.judge_calls, "tokens_input": run.tokens_input, "tokens_output": run.tokens_output,
            "cost_estimate": run.cost_estimate,
        },
        "settings": {k: v for k, v in run.snapshot.items() if k != "members"}
        | {"members": [{**m, "target": {k: v for k, v in m["target"].items() if k != "secret_enc"}} for m in run.snapshot.get("members", [])]},
        "options": run.options,
        "summary": run.summary,
        "cases": [
            {
                "case": c.case_key, "category": c.category, "inputs": c.inputs, "expected": c.expected,
                "status": c.status, "error": c.error, "metrics": c.metrics, "pairwise": c.pairwise,
                "item_judgments": c.item_judgments,
                "responses": [
                    {"label": r.label, "ok": r.ok, "status_code": r.status_code, "latency_ms": r.latency_ms,
                     "error": r.error, "items": r.items}
                    for r in c.responses
                ],
            }
            for c in cases
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def to_xlsx(run: Run, cases: list[RunCase]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    head_font = Font(bold=True)
    head_fill = PatternFill("solid", fgColor="EEF1F6")

    def sheet(title: str, header: list[str], rows: list[list[Any]], widths: dict[int, int] | None = None):
        ws = wb.create_sheet(title)
        ws.append(header)
        for cell in ws[1]:
            cell.font, cell.fill = head_font, head_fill
        for r in rows:
            ws.append(r)
        ws.freeze_panes = "A2"
        for i, h in enumerate(header, start=1):
            ws.column_dimensions[get_column_letter(i)].width = (widths or {}).get(i, max(10, min(40, len(str(h)) + 4)))
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=isinstance(cell.value, str) and len(cell.value) > 40)
        return ws

    wb.remove(wb.active)
    s = run.summary or {}
    summary_rows: list[list[Any]] = [
        ["실행", run.name], ["상태", run.status], ["케이스", s.get("cases")], ["기준 대상", s.get("baseline")],
        ["판정 모델", f"{run.snapshot.get('judge_model', {}).get('name')} ({run.snapshot.get('judge_model', {}).get('model')})"],
        ["판정 호출", run.judge_calls], ["토큰(입력/출력)", f"{run.tokens_input}/{run.tokens_output}"],
        ["추정 비용(USD)", round(run.cost_estimate, 4)], [],
        ["대상", "nDCG", "Hit@1", "MRR", "Precision", "실패율", "0건 비율", "지연 p50(ms)", "지연 p95(ms)"],
    ]
    for t in s.get("targets", []):
        summary_rows.append([t["label"] + (" (기준)" if t["is_baseline"] else ""), _fmt(t["ndcg"]), _fmt(t["hit1"]), _fmt(t["mrr"]),
                             _fmt(t["precision"]), _fmt(t["error_rate"]), _fmt(t["empty_rate"]), _fmt(t["latency_p50"], 0), _fmt(t["latency_p95"], 0)])
    head = ["비교", "결론", "nDCG 차이", "95% 신뢰구간", "순열검정 p", "Holm 보정 p", "효과 크기 dz", "필요 케이스(80%)",
            "승", "패", "무", "승률 95% 구간", "순서 불일치", "부호검정 p"]

    def cmp_rows(block: dict[str, Any], title: str) -> None:
        summary_rows.extend([[], [title], head])
        for cmp in block.get("comparisons", []):
            ci, wci = cmp.get("ndcg_ci"), cmp.get("win_rate_ci")
            summary_rows.append([
                f"{cmp['candidate']} vs {cmp['baseline']}", cmp["verdict"]["title"], _fmt(cmp["ndcg_diff"]),
                f"{ci[0]:+.3f} ~ {ci[1]:+.3f}" if ci else "", _fmt(cmp.get("permutation_p"), 4), _fmt(cmp.get("permutation_p_holm"), 4),
                _fmt(cmp.get("effect_size")), cmp.get("needed_cases"), cmp["wins"], cmp["losses"], cmp["ties"],
                f"{wci[0]:.2f} ~ {wci[1]:.2f}" if wci else "", cmp["inconsistent"], _fmt(cmp["sign_test_p"], 4),
            ])

    cmp_rows(s, "LLM 판정")
    if s.get("combined"):
        cmp_rows(s["combined"], "결합(사람 판정 우선, 없으면 LLM)")
    if s.get("human"):
        cmp_rows(s["human"], f"사람 판정(풀 전체를 사람이 채점한 {s.get('review', {}).get('complete_cases', 0)}건)")
    ag = s.get("agreement")
    if ag:
        summary_rows.extend([[], ["LLM–사람 일치도"], ["비교한 항목", ag["items"]], ["완전 일치율", _fmt(ag["exact"])],
                             ["±1 이내 일치율", _fmt(ag["within1"])], ["이차 가중 카파", _fmt(ag["kappa_quadratic"])],
                             ["관련/비관련 카파", _fmt(ag["kappa_binary"])], ["LLM−사람 평균 등급 차", _fmt(ag["bias"])],
                             ["목록 선호 일치율", _fmt(ag["pairwise_agree"])]])
    sheet("요약", ["항목", "값", "", "", "", "", "", "", "", "", "", "", "", ""], summary_rows, {1: 22, 2: 30})

    header, rows = case_rows(run, cases)
    sheet("케이스", header, rows)

    item_rows = []
    prefixes = member_prefix(run.snapshot)
    for c in cases:
        for r in c.responses:
            for rank, it in enumerate(r.items, start=1):
                key = prefixes.get(r.label, ("", 0))[0] + it["key"]
                j = (c.item_judgments or {}).get(key)
                h = (c.human_judgments or {}).get(key)
                fields = " | ".join(f"{f['label']}: {f['value']}" for f in it.get("fields", []))
                item_rows.append([c.case_key, r.label, rank, it["title"], fields,
                                  j["grade"] if j else None, GRADE_LABELS.get(j["grade"]) if j else "", j["reason"] if j else "",
                                  h["grade"] if h else None, h.get("note", "") if h else ""])
    sheet("항목 판정", ["케이스", "대상", "순위", "제목", "내용", "LLM 등급", "등급 의미", "LLM 근거", "사람 등급", "사람 메모"], item_rows,
          {4: 30, 5: 60, 8: 60, 10: 30})

    pair_rows = []
    for c in cases:
        for cand, pw in (c.pairwise or {}).items():
            orders = pw.get("orders") or []
            pair_rows.append([c.case_key, cand, WINNER_KO.get(pw["winner"]), "예" if pw.get("consistent") else "아니오",
                              "자동(호출 실패)" if pw.get("auto") else "", pw.get("reason", ""),
                              orders[0]["reason"] if len(orders) > 0 else "", orders[1]["reason"] if len(orders) > 1 else ""])
    sheet("목록 비교", ["케이스", "후보", "결과", "순서 일치", "비고", "최종 근거", "1차 근거", "2차 근거"], pair_rows,
          {6: 60, 7: 50, 8: 50})

    crit = run.snapshot.get("criteria", {})
    by_member = run.snapshot.get("criteria_by_member") or {}
    sheet("설정", ["항목", "값"], [
        *[[f"{label} 평가 기준", c.get("name")] for label, c in by_member.items()],
        ["평가 기준", crit.get("name")], ["검색 목적", crit.get("task_context")], ["사용자 요구사항", crit.get("user_requirements")],
        ["k", crit.get("k")], ["관련 기준 등급", crit.get("relevant_threshold")], ["목록 비교", "사용" if crit.get("pairwise_enabled") else "미사용"],
        *[[f"대상 {m['label']}", f"{m['target'].get('method')} {m['target'].get('base_url')}{m['target'].get('path')}"] for m in run.snapshot.get("members", [])],
    ], {1: 18, 2: 80})

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
