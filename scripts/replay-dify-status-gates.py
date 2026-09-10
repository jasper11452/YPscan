#!/usr/bin/env python3
"""Replay final-node status gates against the candidate Dify scoring code.

Migrated from the 2026-09-10 status-gate replay: the historical decisions are kept
("综合分不为0" is not a creator hard condition; UNKNOWN annotates instead of blocking)
and the inputs now carry scope. New P0 cases cover the net-price FAIL that the old
substring filter silently dropped.

Usage: python3 scripts/replay-dify-status-gates.py [frozen-workflow.json]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dify_replay_support import compile_node, load_source  # noqa: E402


def scored(content=4, type_level=4, coverage=0.8, checks=None, gaps=None):
    return {
        "content_relevance": {"level": content, "evidence_ids": ["R1"], "reason": "内容相关"},
        "type_relevance": {"level": type_level, "evidence_ids": ["R1"], "reason": "类型相关"},
        "coverage": coverage,
        "constraint_results": checks or [],
        "strengths": ["多条作品为家常菜制作教学"],
        "weaknesses": [],
        "reason": "账号主线为家常菜教学，与需求匹配。",
        "evidence_gaps": gaps or [],
    }


def condition(identifier, text, scope, basis=None):
    item = {"id": identifier, "requirement": text, "source_quote": "需求原文", "scope": scope}
    if basis:
        item["price_basis"] = basis
    return item


def parsed(must_have=None, must_not=None, secondary=None):
    return {"must_have": must_have or [], "must_not": must_not or [], "secondary_conditions": secondary or []}


PRICE = condition("H1", "植入视频单价在0至100000元之间", "creator_commercial", "quoted")
FORM = condition("H2", "合作形式为报备视频", "creator_objective")
SCORE_RULE = condition("H4", "综合分不为0", "delivery")
DEADLINE = condition("H5", "提报截止时间为3月1日", "project")
NET_PRICE = condition("H9", "返点后到手单价不超过10000元", "creator_commercial", "rebate_net")
SCORE_LABEL = condition("H10", "综合分不低于60", "creator_commercial")

EVIDENCE = json.dumps({"records": [{"id": "R1", "data": {"视频标题": "红烧肉教程", "正文": "步骤"}}],
                       "profile": {"粉丝数": 100000}}, ensure_ascii=False)

CASES = [
    {
        "name": "delivery rule 综合分不为0 is ignored",
        "scored": scored(checks=[{"id": "H1", "status": "PASS", "evidence": "植入视频单价在0至100000元之间：报价2000元"},
                                  {"id": "H4", "status": "UNKNOWN", "evidence": "综合分不为0：无法核验"}]),
        "parsed": parsed(must_have=[PRICE, SCORE_RULE]),
        "expect": {"tier": "首选", "decision": "推荐", "final_score": 100, "evaluation_status": "ok",
                   "pending_checks": 0, "failed_checks": 0, "reason_contains": None,
                   "reason_absent": "待确认", "filtered": ["H4"]},
    },
    {
        "name": "unknown 合作形式 annotates instead of blocking",
        "scored": scored(checks=[{"id": "H1", "status": "PASS", "evidence": "植入视频单价在0至100000元之间：报价2000元"},
                                  {"id": "H2", "status": "UNKNOWN", "evidence": "合作形式为报备视频：资料未提供可核验信息"}]),
        "parsed": parsed(must_have=[PRICE, FORM]),
        "expect": {"tier": "首选", "decision": "推荐", "final_score": 100, "evaluation_status": "ok",
                   "pending_checks": 1, "failed_checks": 0,
                   "reason_contains": "待确认：合作形式为报备视频", "reason_absent": "资格待核实", "filtered": []},
    },
    {
        "name": "missing price annotates instead of blocking",
        "scored": scored(checks=[{"id": "H1", "status": "UNKNOWN", "evidence": "植入视频单价在0至100000元之间：资料未提供可核验信息"}]),
        "parsed": parsed(must_have=[PRICE]),
        "expect": {"tier": "首选", "decision": "推荐", "final_score": 100, "evaluation_status": "ok",
                   "pending_checks": 1, "failed_checks": 0,
                   "reason_contains": "待确认：植入视频单价在0至100000元之间", "reason_absent": "资格待核实", "filtered": []},
    },
    {
        "name": "confirmed over-budget still fails",
        "scored": scored(checks=[{"id": "H1", "status": "FAIL", "evidence": "植入视频单价在0至100000元之间：报价120000元"}]),
        "parsed": parsed(must_have=[PRICE]),
        "expect": {"tier": "硬约束失败", "decision": "不推荐", "final_score": 100,
                   "evaluation_status": "hard_constraint_fail", "pending_checks": 0, "failed_checks": 1,
                   "reason_contains": "已确认不满足本次硬条件", "reason_absent": None, "filtered": []},
    },
    {
        "name": "must_not failure still fails",
        "scored": scored(checks=[{"id": "N1", "status": "FAIL", "evidence": "竞品品牌合作：近30天有竞品合作"}]),
        "parsed": parsed(must_not=[condition("N1", "竞品品牌合作", "creator_objective")]),
        "expect": {"tier": "硬约束失败", "decision": "不推荐", "final_score": 100,
                   "evaluation_status": "hard_constraint_fail", "pending_checks": 0, "failed_checks": 1,
                   "reason_contains": "已确认不满足本次硬条件", "reason_absent": None, "filtered": []},
    },
    {
        "name": "weak relevance is not recommended",
        "scored": scored(content=1, type_level=2,
                         checks=[{"id": "H1", "status": "PASS", "evidence": "植入视频单价在0至100000元之间：报价2000元"}]),
        "parsed": parsed(must_have=[PRICE]),
        "expect": {"tier": "不推荐", "decision": "不推荐", "final_score": 38.7, "evaluation_status": "ok",
                   "pending_checks": 0, "failed_checks": 0, "reason_contains": None, "reason_absent": None, "filtered": []},
    },
    {
        "name": "missing score stays insufficient",
        "scored": {"constraint_results": [{"id": "H1", "status": "PASS", "evidence": "植入视频单价在0至100000元之间：报价2000元"}],
                   "strengths": [], "weaknesses": [], "reason": ""},
        "parsed": parsed(must_have=[PRICE]),
        "expect": {"tier": "数据不足", "decision": "不推荐", "final_score": 0, "evaluation_status": "insufficient_data",
                   "pending_checks": 0, "failed_checks": 0, "reason_contains": None, "reason_absent": None, "filtered": []},
    },
    {
        "name": "T1 net-price FAIL with 返点 label is retained",
        "scored": scored(checks=[{"id": "H9", "status": "FAIL",
                                  "evidence": "返点后到手单价不超过10000元：同口径核验净价 12000 元"}]),
        "parsed": parsed(must_have=[NET_PRICE]),
        "expect": {"tier": "硬约束失败", "decision": "不推荐", "final_score": 100,
                   "evaluation_status": "hard_constraint_fail", "pending_checks": 0, "failed_checks": 1,
                   "reason_contains": "返点后到手单价不超过10000元", "reason_absent": None, "filtered": []},
    },
    {
        "name": "T1b creator condition with 综合分 label is retained",
        "scored": scored(checks=[{"id": "H10", "status": "FAIL", "evidence": "综合分不低于60：综合分40"}]),
        "parsed": parsed(must_have=[SCORE_LABEL]),
        "expect": {"tier": "硬约束失败", "decision": "不推荐", "final_score": 100,
                   "evaluation_status": "hard_constraint_fail", "pending_checks": 0, "failed_checks": 1,
                   "reason_contains": "综合分不低于60", "reason_absent": None, "filtered": []},
    },
    {
        "name": "project deadline FAIL is filtered, no pending noise",
        "scored": scored(checks=[{"id": "H5", "status": "FAIL", "evidence": "提报截止时间为3月1日：已过期"}]),
        "parsed": parsed(must_have=[DEADLINE]),
        "expect": {"tier": "首选", "decision": "推荐", "final_score": 100, "evaluation_status": "ok",
                   "pending_checks": 0, "failed_checks": 0, "reason_contains": None,
                   "reason_absent": "待确认", "filtered": ["H5"]},
    },
    {
        "name": "preference FAIL stays advisory",
        "scored": scored(checks=[{"id": "S1", "status": "FAIL", "evidence": "综合分不低于60：综合分40"}]),
        "parsed": parsed(secondary=[condition("S1", "综合分不低于60", "creator_commercial")]),
        "expect": {"tier": "首选", "decision": "推荐", "final_score": 100, "evaluation_status": "ok",
                   "pending_checks": 0, "failed_checks": 0, "reason_contains": None,
                   "reason_absent": "已确认不满足本次硬条件", "filtered": [],
                   "weakness_contains": "参考条件：综合分不低于60"},
    },
    {
        "name": "missing scope is filtered, never defaults to creator",
        "scored": scored(checks=[{"id": "H6", "status": "FAIL", "evidence": "某条件：不满足"}]),
        "parsed": parsed(must_have=[{"id": "H6", "requirement": "某条件", "source_quote": "需求原文"}]),
        "expect": {"tier": "首选", "decision": "推荐", "final_score": 100, "evaluation_status": "ok",
                   "pending_checks": 0, "failed_checks": 0, "reason_contains": None,
                   "reason_absent": "待确认", "filtered": ["H6"]},
    },
    {
        "name": "T5 supported evidence gap is generated in the reason",
        "scored": scored(content=2, type_level=3,
                         checks=[{"id": "H9", "status": "UNKNOWN", "evidence": "返点后到手单价不超过10000元：返点后净价口径无法由现有证据核验"}],
                         gaps=[{"kind": "missing_content", "condition_ids": []}]),
        "parsed": parsed(must_have=[NET_PRICE]),
        "expect": {"tier": "备选", "decision": "推荐", "final_score": 63.7, "evaluation_status": "ok",
                   "pending_checks": 1, "failed_checks": 0,
                   "reason_contains": "未提供口播样本，无法判断表达能力", "reason_absent": None, "filtered": [],
                   "evidence": {"records": [{"id": "R1", "data": {"视频标题": "红烧肉教程"}}], "profile": {}}},
    },
]


def run_case(namespace, case):
    evidence = case["expect"].get("evidence", json.loads(EVIDENCE))
    result = namespace["main"](
        scored=case["scored"], similarity=0.8, platform="抖音", parse_status="ok",
        normalized_platform="抖音", completeness_score=1.0, parsed=case["parsed"],
        evidence_json=json.dumps(evidence, ensure_ascii=False),
    )["score_result"]
    expect = case["expect"]
    actual = {
        "tier": result["tier"], "decision": result["decision"], "final_score": result["final_score"],
        "evaluation_status": result["evaluation_status"], "pending_checks": len(result["pending_checks"]),
        "failed_checks": len(result["failed_checks"]),
    }
    mismatches = {key: {"expected": value, "actual": actual.get(key)}
                  for key, value in expect.items()
                  if key in actual and actual.get(key) != value}
    if expect.get("reason_contains") and expect["reason_contains"] not in result["reason"]:
        mismatches["reason_contains"] = {"expected": expect["reason_contains"], "actual": result["reason"]}
    if expect.get("reason_absent") and expect["reason_absent"] in result["reason"]:
        mismatches["reason_absent"] = {"expected": "absent", "actual": result["reason"]}
    filtered = [item.get("id") for item in result["model_output_diagnostics"]["final"]["filtered_conditions"]]
    if "filtered" in expect and filtered != expect["filtered"]:
        mismatches["filtered"] = {"expected": expect["filtered"], "actual": filtered}
    if expect.get("weakness_contains") and not any(expect["weakness_contains"] in item for item in result["weaknesses"]):
        mismatches["weakness_contains"] = {"expected": expect["weakness_contains"], "actual": result["weaknesses"]}
    return mismatches, result


def run():
    source = sys.argv[1] if len(sys.argv) > 1 else None
    loaded = load_source(source)
    namespace = compile_node(loaded["codes"], "final")
    failed = []
    for case in CASES:
        mismatches, result = run_case(namespace, case)
        if mismatches:
            failed.append({"case": case["name"], "mismatches": mismatches, "reason": result["reason"]})
    print(json.dumps({"meta": loaded["meta"], "checks": len(CASES), "passed": len(CASES) - len(failed),
                      "failed": failed}, ensure_ascii=False, indent=2))
    return bool(failed)


if __name__ == "__main__":
    sys.exit(run())
