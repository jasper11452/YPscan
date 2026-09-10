#!/usr/bin/env python3
"""Replay structured review verdicts and controlled evidence gaps (D2/D3).

The 2026-09-10 negation replay tested a text-polarity helper; the candidate removes
that helper, so the same business expectations are migrated to the structured entry
point: free-text wording must never drive a price conflict, while same-id verdict
contradictions must. Evidence gaps are validated against real missing evidence.

Usage: python3 scripts/replay-dify-review-negation.py [frozen-workflow.json]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dify_replay_support import compile_node, load_source  # noqa: E402

PRICE_CONDITION = {"id": "H1", "requirement": "视频报价不超过100000元", "source_quote": "需求原文",
                   "scope": "creator_commercial", "price_basis": "quoted"}
NET_CONDITION = {"id": "H3", "requirement": "返点后到手单价不超过10000元", "source_quote": "需求原文",
                 "scope": "creator_commercial", "price_basis": "rebate_net"}

NEGATION_TEXTS = ["不满足", "无法满足", "未满足", "不符合", "不能满足", "不能确认满足预算", "没有满足", "尚不满足",
                  "并不满足", "不很满足", "未完全符合", "无法完全满足", "不能充分满足", "不 符合",
                  "满足", "完全符合", "不仅满足", "类型不符，但报价满足预算",
                  "报价不满足原预算；满足调整后的预算", "待核实", None]

TITLE_ONLY = {"records": [{"id": "R1", "data": {"视频标题": "红烧肉教程"}}], "profile": {}}
WITH_COMMENTS = {"records": [{"id": "R1", "data": {"视频标题": "红烧肉教程", "正文": "步骤", "评论原文": "跟做了"}}],
                 "profile": {"视频报价": "12000"}}
DEFAULT_EVIDENCE = {"records": [{"id": "R1", "data": {"视频标题": "红烧肉教程", "正文": "步骤"}}],
                    "profile": {"视频报价": "12000", "粉丝数": 100000}}


def parsed(*conditions, group="must_have"):
    groups = {"must_have": [], "must_not": [], "secondary_conditions": []}
    groups[group] = list(conditions)
    return groups


def analysis(identifier, status):
    return {"constraint_results": [{"id": identifier, "status": status, "evidence": identifier + "：程序核验"}]}


def review_value(verdicts, reason="账号主线为家常菜教学，与需求匹配。", gaps=None, business=None):
    return {
        "content_relevance": {"level": 3, "evidence_ids": ["R1"], "reason": "内容相关"},
        "type_relevance": {"level": 3, "evidence_ids": ["R1"], "reason": "类型相关"},
        "coverage": 0.5, "priority": "备选", "verdict": "推荐",
        "strongest_support": "多条作品相关", "main_objection": "",
        "corrections": [], "business": business or {}, "reason": reason,
        "strengths": ["多条作品相关"], "weaknesses": [],
        "condition_reviews": [{"id": identifier, "verdict": verdict, "reason": "逐条件依据"}
                              for identifier, verdict in verdicts.items()],
        "evidence_gaps": gaps or [],
    }


def run(namespace, value, conditions, program, evidence=None):
    evidence = evidence or DEFAULT_EVIDENCE
    return namespace["main"](raw_text=json.dumps(value, ensure_ascii=False),
                             evidence_json=json.dumps(evidence, ensure_ascii=False),
                             parsed=conditions, analysis=program)


def cases():
    """Each case: (name, parsed conditions, program analysis, review value, expected, evidence)."""
    out = []
    # A. same-id verdict matrix. Conflict only when program and review are opposite PASS/FAIL.
    for status in ("PASS", "FAIL", "UNKNOWN"):
        for verdict in ("PASS", "FAIL", "UNKNOWN"):
            conflict = status in ("PASS", "FAIL") and verdict in ("PASS", "FAIL") and status != verdict
            out.append((f"A program {status} / review {verdict}", parsed(PRICE_CONDITION),
                        analysis("H1", status), review_value({"H1": verdict}),
                        "review_conflict" if conflict else "ok", None))
    # B. free-text wording never drives a price conflict (migrated negation cases).
    for text in NEGATION_TEXTS:
        out.append((f"B reason text {text!r}", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                    review_value({"H1": "UNKNOWN"}, reason="" if text is None else text), "ok", None))
    for text in ("报价未完全符合预算", "报价无法完全满足预算", "报价满足预算"):
        out.append((f"B business.price {text!r}", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                    review_value({"H1": "UNKNOWN"}, business={"price": text}), "ok", None))
    # C. preference mismatch is a diagnostic, not a hard conflict.
    preference = dict(PRICE_CONDITION)
    preference["id"] = "S1"
    out.append(("C preference program FAIL / review PASS", parsed(preference, group="secondary_conditions"),
                analysis("S1", "FAIL"), review_value({"S1": "PASS"}), "ok", None))
    out.append(("C preference program PASS / review FAIL", parsed(preference, group="secondary_conditions"),
                analysis("S1", "PASS"), review_value({"S1": "FAIL"}), "ok", None))
    # C2. different condition ids are never cross-compared (T7).
    second = dict(PRICE_CONDITION)
    second["id"] = "H2"
    cross_value = review_value({"H1": "UNKNOWN", "H2": "FAIL"})
    out.append(("C2 different-id PASS/FAIL does not conflict", parsed(PRICE_CONDITION, second),
                {"constraint_results": [{"id": "H1", "status": "FAIL", "evidence": "H1：程序核验"},
                                         {"id": "H2", "status": "UNKNOWN", "evidence": "H2：程序核验"}]},
                cross_value, "ok", None))
    # D. coverage and schema errors.
    out.append(("D missing condition review", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({}), "condition_review_coverage", None))
    extra = review_value({"H1": "UNKNOWN"})
    extra["condition_reviews"].append({"id": "H9", "verdict": "UNKNOWN", "reason": "外来 id"})
    out.append(("D extra condition review id", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                extra, "condition_review_coverage", None))
    duplicate = review_value({"H1": "UNKNOWN"})
    duplicate["condition_reviews"].append({"id": "H1", "verdict": "UNKNOWN", "reason": "重复"})
    out.append(("D duplicate condition review id", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                duplicate, "condition_review_duplicate", None))
    out.append(("D illegal verdict", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({"H1": "MAYBE"}), "condition_review_verdict", None))
    empty_reason = review_value({"H1": "UNKNOWN"})
    empty_reason["condition_reviews"][0]["reason"] = ""
    out.append(("D empty review reason", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                empty_reason, "condition_review_reason", None))
    out.append(("D no creator conditions requires empty reviews", parsed(), analysis("H1", "FAIL"),
                review_value({"H1": "UNKNOWN"}), "condition_review_coverage", None))
    out.append(("D legal empty condition set", parsed(), analysis("H1", "FAIL"),
                review_value({}), "ok", None))
    # E. evidence gaps.
    net_conditions = parsed(NET_CONDITION)
    out.append(("E valid net-price gap", net_conditions, analysis("H3", "UNKNOWN"),
                review_value({"H3": "UNKNOWN"},
                             gaps=[{"kind": "unverified_price_basis", "condition_ids": ["H3"]}]), "ok", None))
    net_no_keyword = {"id": "H7", "requirement": "返点后到手价不超过10000元", "source_quote": "需求原文",
                      "scope": "creator_commercial", "price_basis": "rebate_net"}
    out.append(("E net-price gap without price keyword", parsed(net_no_keyword), analysis("H7", "UNKNOWN"),
                review_value({"H7": "UNKNOWN"},
                             gaps=[{"kind": "unverified_price_basis", "condition_ids": ["H7"]}]), "ok", None))
    out.append(("E net-price gap on quoted id is dropped", net_conditions, analysis("H3", "UNKNOWN"),
                review_value({"H3": "UNKNOWN"},
                             gaps=[{"kind": "unverified_price_basis", "condition_ids": ["H1"]}]),
                "ok", None))
    out.append(("E net-price gap without ids is dropped", net_conditions, analysis("H3", "UNKNOWN"),
                review_value({"H3": "UNKNOWN"},
                             gaps=[{"kind": "unverified_price_basis", "condition_ids": []}]),
                "ok", None))
    out.append(("E unknown gap kind", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({"H1": "UNKNOWN"}, gaps=[{"kind": "missing_video", "condition_ids": []}]),
                "evidence_gap_kind", None))
    out.append(("E injected free text in gap", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({"H1": "UNKNOWN"},
                             gaps=[{"kind": "missing_content", "condition_ids": [], "note": "但口播讲解清晰"}]),
                "evidence_gap_schema", None))
    out.append(("E gap condition id not in parse is dropped", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({"H1": "UNKNOWN"},
                             gaps=[{"kind": "missing_content", "condition_ids": ["H9"]}]),
                "ok", TITLE_ONLY))
    out.append(("E duplicate gap kind", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({"H1": "UNKNOWN"},
                             gaps=[{"kind": "missing_content", "condition_ids": []},
                                   {"kind": "missing_content", "condition_ids": []}]),
                "evidence_gap_duplicate", TITLE_ONLY))
    out.append(("E claimed missing content but content exists is dropped", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({"H1": "UNKNOWN"}, gaps=[{"kind": "missing_content", "condition_ids": []}]),
                "ok", None))
    out.append(("E claimed missing comments but comments exist is dropped", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                review_value({"H1": "UNKNOWN"}, gaps=[{"kind": "missing_comments", "condition_ids": []}],
                             business={"price": ""}),
                "ok", WITH_COMMENTS))
    # F. T6: the model layer may still misread a double negative; the code detects the PASS/FAIL clash.
    out.append(("F double-negation text with PASS verdict still conflicts", parsed(PRICE_CONDITION),
                analysis("H1", "FAIL"), review_value({"H1": "PASS"}, reason="不是不符合预算"),
                "review_conflict", None))
    # G. P4/P5: fabricated content claims stay guarded, mixed sentences are not exempted.
    for text, expected_kept in (("口播讲解清晰", False), ("未提供口播样本，但口播讲解清晰", False),
                                ("账号主线为家常菜教学", True),
                                ("未提供口播样本，无法判断表达能力", False)):
        out.append((f"G fabrication guard {text!r}", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
                    review_value({"H1": "UNKNOWN"}, gaps=[{"kind": "missing_content", "condition_ids": []}]),
                    None, TITLE_ONLY, (text, expected_kept)))
    return out


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else None
    loaded = load_source(source)
    namespace = compile_node(loaded["codes"], "review_json")
    failures = []
    checks = 0
    for name, conditions, program, value, expected, evidence, *rest in cases():
        fabrications = rest[0] if rest else None
        if fabrications is not None:
            text, _ = fabrications
            value["weaknesses"] = [text]
        result = run(namespace, value, conditions, program, evidence)
        if fabrications is not None:
            text, expected_kept = fabrications
            checks += 1
            kept = any(text == item for item in result["value"].get("weaknesses", []))
            if kept != expected_kept:
                failures.append({"case": name, "expected": "kept" if expected_kept else "removed",
                                 "actual": result["value"].get("weaknesses", [])})
            continue
        actual = "ok"
        if result["error"]:
            actual = result["error"].replace("整体复核校验失败：", "")
        checks += 1
        if actual != expected:
            failures.append({"case": name, "expected": expected, "actual": actual})
    # H. ungrounded gaps are dropped with a diagnostic instead of failing the review.
    for name, conditions, program, value, evidence, reason in (
            ("H content gap dropped", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
             review_value({"H1": "UNKNOWN"}, gaps=[{"kind": "missing_content", "condition_ids": []}]), None, "content_present"),
            ("H quoted price gap dropped", parsed(NET_CONDITION, PRICE_CONDITION),
             {"constraint_results": [{"id": "H3", "status": "UNKNOWN", "evidence": "H3：程序核验"},
                                     {"id": "H1", "status": "FAIL", "evidence": "H1：程序核验"}]},
             review_value({"H3": "UNKNOWN", "H1": "UNKNOWN"},
                          gaps=[{"kind": "unverified_price_basis", "condition_ids": ["H1"]}]), None, "price_condition_not_unverified"),
            ("H unknown condition gap dropped", parsed(PRICE_CONDITION), analysis("H1", "FAIL"),
             review_value({"H1": "UNKNOWN"}, gaps=[{"kind": "missing_content", "condition_ids": ["H9"]}]), TITLE_ONLY, "unknown_condition")):
        result = run(namespace, value, conditions, program, evidence)
        dropped = (result.get("diagnostics") or {}).get("dropped_gaps") or []
        checks += 2
        if result["error"] or result["value"].get("evidence_gaps"):
            failures.append({"case": name, "expected": "accepted with empty gaps", "actual": result["error"] or result["value"].get("evidence_gaps")})
        elif not any(item.get("reason") == reason for item in dropped):
            failures.append({"case": name + " diagnostic", "expected": reason, "actual": dropped})
    print(json.dumps({"meta": loaded["meta"], "checks": checks, "passed": checks - len(failures),
                      "failed": failures}, ensure_ascii=False, indent=2))
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
