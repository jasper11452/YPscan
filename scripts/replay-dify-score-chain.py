#!/usr/bin/env python3
"""End-to-end offline chain replay for the candidate Dify score workflow.

Covers T8 (parse -> score / retry -> review -> final, first and retry code paths),
parse scope/price_basis validation, and frozen old-vs-new contrast for D1/D2/D3.
Model-layer cases are versioned in dify-score-model-cases.json and are NOT run here.

Usage: python3 scripts/replay-dify-score-chain.py [frozen-workflow.json]
"""

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dify_replay_support import compile_node, load_source  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures"

DEMAND = "需要家常菜达人，粉丝数不少于10000，视频报价最高10000元，返点后到手单价不超过8000元，综合分不为0，提报截止3月1日"

PARSE_OUTPUT = {
    "must_have": [
        {"id": "H1", "requirement": "粉丝数不少于10000", "source_quote": "粉丝数不少于10000", "scope": "creator_objective"},
        {"id": "H2", "requirement": "视频报价最高10000元", "source_quote": "视频报价最高10000元",
         "scope": "creator_commercial", "price_basis": "quoted"},
        {"id": "H3", "requirement": "返点后到手单价不超过8000元", "source_quote": "返点后到手单价不超过8000元",
         "scope": "creator_commercial", "price_basis": "rebate_net"},
        {"id": "H4", "requirement": "综合分不为0", "source_quote": "综合分不为0", "scope": "delivery"},
        {"id": "H5", "requirement": "提报截止3月1日", "source_quote": "提报截止3月1日", "scope": "project"},
    ],
    "must_not": [],
    "secondary_conditions": [],
    "soft_preferences": [],
    "ranking_objectives": [],
    "type_required": True,
    "scenario_required": False,
    "target_type_text": "家常菜美食教程达人",
    "target_tracks": ["家常菜"],
    "track_logic": "SINGLE",
    "batch_conditions": [],
}


def score_output(quote_fail=False):
    checks = [
        {"id": "H1", "status": "PASS", "evidence": "粉丝数=150000"},
        {"id": "H2", "status": "FAIL" if quote_fail else "PASS", "evidence": "视频报价=12000"},
        {"id": "H3", "status": "FAIL", "evidence": "按原始报价核验净价"},
        {"id": "H4", "status": "UNKNOWN", "evidence": "综合分不为0：不属于达人条件"},
        {"id": "H5", "status": "UNKNOWN", "evidence": "提报截止3月1日：不属于达人条件"},
    ]
    return {
        "content_relevance": {"level": 4, "evidence_ids": ["R1"], "reason": "多条家常菜作品"},
        "type_relevance": {"level": 4, "evidence_ids": ["R1"], "reason": "账号主线为家常菜"},
        "coverage": 0.8,
        "constraint_results": checks,
        "requirements_complete": False,
        "brief": "家常菜教程选题",
        "strengths": ["多条作品为家常菜制作教学"],
        "weaknesses": [],
        "reason": "账号主线为家常菜教学，与需求匹配。",
        "evidence_gaps": [{"kind": "unverified_price_basis", "condition_ids": ["H3"]}],
    }


def review_output(verdicts):
    return {
        "content_relevance": {"level": 4, "evidence_ids": ["R1"], "reason": "多条家常菜作品"},
        "type_relevance": {"level": 4, "evidence_ids": ["R1"], "reason": "账号主线为家常菜"},
        "coverage": 0.8, "priority": "优先", "verdict": "推荐",
        "strongest_support": "多条作品为家常菜制作教学", "main_objection": "",
        "corrections": [], "business": {}, "reason": "账号主线为家常菜教学，与需求匹配。",
        "strengths": ["多条作品为家常菜制作教学"], "weaknesses": [],
        "condition_reviews": [{"id": identifier, "verdict": verdict, "reason": "逐条件依据"}
                              for identifier, verdict in verdicts.items()],
        "evidence_gaps": [],
    }


def evidence(quote=8000):
    records = [{"id": "R" + str(index), "data": {"视频标题": "红烧肉教程%d" % index,
                                                    "正文": "步骤", "评论原文": "跟做了"}}
               for index in range(1, 6)]
    return {"profile": {"粉丝数": 150000, "视频报价": quote}, "records": records}


def check(results, name, expected, actual):
    results.append({"name": name, "expected": expected, "actual": actual, "pass": expected == actual})


def build_parsed():
    return {"must_have": copy.deepcopy(PARSE_OUTPUT["must_have"]), "must_not": [], "secondary_conditions": []}


def chain_checks(loaded, results):
    codes = loaded["codes"]
    parse_ns = compile_node(codes, "parse_json")
    parse_retry_ns = compile_node(codes, "parse_retry_json")
    score_ns = compile_node(codes, "score_json")
    score_retry_ns = compile_node(codes, "score_retry_json")
    review_ns = compile_node(codes, "review_json")
    final_ns = compile_node(codes, "final")

    raw_parse = json.dumps(PARSE_OUTPUT, ensure_ascii=False)
    first = parse_ns["main"](raw_parse, DEMAND)
    retry = parse_retry_ns["main"](raw_parse, DEMAND)
    check(results, "parse first succeeds", "", first["error"])
    check(results, "parse retry equals first", first["value"], retry["value"])
    check(results, "parse first failure falls through to retry", True,
          bool(parse_ns["main"]("{", DEMAND)["error"]) and not parse_retry_ns["main"](raw_parse, DEMAND)["error"])
    check(results, "parse keeps price_basis", "rebate_net", first["value"]["must_have"][2]["price_basis"])

    # Parse validation failures.
    def parse_error(mutate):
        value = copy.deepcopy(PARSE_OUTPUT)
        mutate(value)
        return parse_ns["main"](json.dumps(value, ensure_ascii=False), DEMAND)["error"]

    check(results, "parse rejects missing scope",
          "模型输出校验失败：constraint_schema",
          parse_error(lambda v: v["must_have"][0].pop("scope")))
    check(results, "parse rejects missing price_basis",
          "模型输出校验失败：price_basis_missing",
          parse_error(lambda v: v["must_have"][2].pop("price_basis")))
    check(results, "parse rejects illegal scope",
          "模型输出校验失败：constraint_scope_enum",
          parse_error(lambda v: v["must_have"][0].update(scope="creator")))
    check(results, "parse rejects illegal price_basis",
          "模型输出校验失败：price_basis_enum",
          parse_error(lambda v: v["must_have"][2].update(price_basis="net")))
    check(results, "parse rejects source_quote not in demand",
          "模型输出校验失败：source_quote_not_in_demand",
          parse_error(lambda v: v["must_have"][0].update(source_quote="不在原文")))
    empty = {key: ([] if isinstance(value, list) else value) for key, value in PARSE_OUTPUT.items()}
    empty["type_required"] = False
    empty["target_tracks"] = []
    empty["target_type_text"] = ""
    empty["track_logic"] = "NONE"
    check(results, "parse accepts legal empty conditions", "",
          parse_ns["main"](json.dumps(empty, ensure_ascii=False), DEMAND)["error"])

    # Score first/retry on the same input, then the full chain.
    parsed = build_parsed()
    evidence_json = json.dumps(evidence(8000), ensure_ascii=False)
    raw_score = json.dumps(score_output(), ensure_ascii=False)
    scored = score_ns["main"](raw_score, parsed, evidence_json)
    retried = score_retry_ns["main"](raw_score, parsed, evidence_json)
    check(results, "score first succeeds", "", scored["error"])
    check(results, "score retry equals first", scored["value"], retried["value"])
    check(results, "score first failure falls through to retry", True,
          bool(score_ns["main"]("{", parsed, evidence_json)["error"])
          and not score_retry_ns["main"](raw_score, parsed, evidence_json)["error"])
    review_caps = compile_node(codes, "review_json")["evidence_caps"](evidence(8000))
    final_counts = compile_node(codes, "final")["_counts"](evidence_json)
    check(results, "review/final content guard counts match", review_caps["counts"]["content"], final_counts["content"])
    check(results, "review/final comment guard counts match", review_caps["counts"]["comments"], final_counts["comments"])
    statuses = {item["id"]: item["status"] for item in scored["value"]["constraint_results"]}
    check(results, "T2/T3 net-price quote-only stays UNKNOWN", "UNKNOWN", statuses.get("H3"))
    check(results, "quoted price still verified", "PASS", statuses.get("H2"))

    reviewed = review_ns["main"](json.dumps(review_output({"H1": "PASS", "H2": "PASS", "H3": "UNKNOWN"}), ensure_ascii=False),
                                 evidence_json, parsed, scored["value"])
    check(results, "review succeeds", "", reviewed["error"])
    result = final_ns["main"](
        scored=scored["value"], similarity=0.9, platform="抖音", parse_status="ok",
        normalized_platform="抖音", completeness_score=1.0, parsed=parsed, evidence_json=evidence_json,
        reviewed=reviewed["value"],
    )["score_result"]
    check(results, "T8 chain stays recommendable", "ok", result["evaluation_status"])
    check(results, "T8 no hard fail", 0, len(result["failed_checks"]))
    check(results, "T8 pending only the net-price condition", ["H3"],
          [item["id"] for item in result["pending_checks"]])
    check(results, "T8 project/delivery filtered", ["H4", "H5"],
          [item["id"] for item in result["model_output_diagnostics"]["final"]["filtered_conditions"]])
    check(results, "T8 reason keeps 待确认 label", True, "待确认：返点后到手单价不超过8000元" in result["reason"])
    check(results, "T5 gap text reaches the reason", True, "返点后净价口径无法核验" in result["reason"])
    check(results, "T8 manual review not required", False, result["manual_review_required"])
    check(results, "T8 diagnostics keep the gap", [{"kind": "unverified_price_basis", "condition_ids": ["H3"]}],
          result["model_output_diagnostics"]["final"]["evidence_gaps"])

    # Quoted over-limit still blocks through the whole chain.
    over = score_ns["main"](json.dumps(score_output(quote_fail=True), ensure_ascii=False), parsed,
                            json.dumps(evidence(12000), ensure_ascii=False))
    over_statuses = {item["id"]: item["status"] for item in over["value"]["constraint_results"]}
    check(results, "quoted over-limit FAIL", "FAIL", over_statuses.get("H2"))
    over_result = final_ns["main"](
        scored=over["value"], similarity=0.9, platform="抖音", parse_status="ok",
        normalized_platform="抖音", completeness_score=1.0, parsed=parsed,
        evidence_json=json.dumps(evidence(12000), ensure_ascii=False),
    )["score_result"]
    check(results, "quoted over-limit blocks", "hard_constraint_fail", over_result["evaluation_status"])

    # P13/P14: existing error paths keep their contracts.
    check(results, "score invalid json", "模型输出校验失败：invalid_json",
          score_ns["main"]("{", parsed, evidence_json)["error"])
    check(results, "score invalid evidence shape", "模型输出校验失败：invalid_evidence",
          score_ns["main"](raw_score, parsed, "[]")["error"])
    check(results, "score malformed evidence json", "模型输出校验失败：invalid_json",
          score_ns["main"](raw_score, parsed, "not-json")["error"])
    gap_parsed = {"must_have": [{"id": "H7", "requirement": "返点后到手价不超过10000元",
                                 "source_quote": "返点后到手价不超过10000元",
                                 "scope": "creator_commercial", "price_basis": "rebate_net"}],
                  "must_not": [], "secondary_conditions": []}
    gap_raw = score_output()
    gap_raw["constraint_results"] = [{"id": "H7", "status": "UNKNOWN", "evidence": "返点后到手价不超过10000元：净价口径无法核验"}]
    gap_raw["evidence_gaps"] = [{"kind": "unverified_price_basis", "condition_ids": ["H7"]}]
    gap_result = score_ns["main"](json.dumps(gap_raw, ensure_ascii=False), gap_parsed, evidence_json)
    check(results, "price gap accepted without price keyword", "", gap_result["error"])
    check(results, "price gap keeps the condition UNKNOWN", "UNKNOWN",
          gap_result["value"]["constraint_results"][0]["status"])
    content_gap = score_output()
    content_gap["evidence_gaps"] = [{"kind": "missing_content", "condition_ids": []}]
    content_gap_result = score_ns["main"](json.dumps(content_gap, ensure_ascii=False), parsed, evidence_json)
    check(results, "ungrounded content gap dropped, score accepted", "", content_gap_result["error"])
    check(results, "dropped content gap leaves no gap", "[]",
          json.dumps(content_gap_result["value"]["evidence_gaps"], ensure_ascii=False))
    check(results, "dropped content gap recorded as diagnostic", "content_present",
          (content_gap_result["diagnostics"].get("dropped_gaps") or [{}])[0].get("reason"))
    missing_id = score_output()
    missing_id["constraint_results"] = missing_id["constraint_results"][:2]
    check(results, "score requires full condition coverage", "模型输出校验失败：constraint_result_coverage",
          score_ns["main"](json.dumps(missing_id, ensure_ascii=False), parsed, evidence_json)["error"])
    bad_status = score_output()
    bad_status["constraint_results"][0]["status"] = "MAYBE"
    check(results, "score rejects illegal status", "模型输出校验失败：constraint_result_status",
          score_ns["main"](json.dumps(bad_status, ensure_ascii=False), parsed, evidence_json)["error"])
    review_absent = final_ns["main"](
        scored=scored["value"], similarity=0.9, platform="抖音", parse_status="ok",
        normalized_platform="抖音", completeness_score=1.0, parsed=parsed, evidence_json=evidence_json,
        review_error="整体复核校验失败：review_conflict",
    )["score_result"]
    check(results, "review failure downgrades to initial scoring", "review_failed",
          review_absent["evaluation_status"])
    check(results, "review failure is visible", True,
          "整体复核未完成，暂采用初评，需人工复核。" in review_absent["reason"])
    check(results, "review failure requires manual review", True, review_absent["manual_review_required"])
    hard_with_review = final_ns["main"](
        scored=over["value"], similarity=0.9, platform="抖音", parse_status="ok",
        normalized_platform="抖音", completeness_score=1.0, parsed=parsed,
        evidence_json=json.dumps(evidence(12000), ensure_ascii=False),
        reviewed=review_output({"H1": "PASS", "H2": "FAIL", "H3": "UNKNOWN"}),
    )["score_result"]
    check(results, "T7 verified hard FAIL survives an ok review", "hard_constraint_fail",
          hard_with_review["evaluation_status"])


def contrast_checks(loaded, legacy, results):
    """Frozen old-vs-new contrast for D1/D2/D3 (legacy fixtures are the pre-fix baseline)."""
    old_final = compile_node(legacy["codes"], "final")
    new_final = compile_node(loaded["codes"], "final")
    old_score = compile_node(legacy["codes"], "score_json")
    new_score = compile_node(loaded["codes"], "score_json")
    old_review = compile_node(legacy["codes"], "review_json")
    new_review = compile_node(loaded["codes"], "review_json")

    def scored(checks, gaps=None):
        return {
            "content_relevance": {"level": 4, "evidence_ids": ["R1"], "reason": "内容相关"},
            "type_relevance": {"level": 4, "evidence_ids": ["R1"], "reason": "类型相关"},
            "coverage": 0.8, "constraint_results": checks,
            "strengths": ["多条作品为家常菜制作教学"], "weaknesses": [],
            "reason": "账号主线为家常菜教学，与需求匹配。", "evidence_gaps": gaps or [],
        }

    net_parsed = {"must_have": [{"id": "H9", "requirement": "返点后到手单价不超过10000元",
                                 "source_quote": "返点后到手单价不超过10000元",
                                 "scope": "creator_commercial", "price_basis": "rebate_net"}],
                  "must_not": [], "secondary_conditions": []}
    net_fail = [{"id": "H9", "status": "FAIL", "evidence": "返点后到手单价不超过10000元：同口径核验净价 12000 元"}]

    def run_final(namespace, parsed, checks):
        return namespace["main"](scored(checks), 0.8, "抖音", "ok", "抖音", 1.0, parsed,
                                 "{}")["score_result"]

    check(results, "D1 legacy final drops the 返点 label", "ok",
          run_final(old_final, net_parsed, net_fail)["evaluation_status"])
    check(results, "D1 candidate final keeps it", "hard_constraint_fail",
          run_final(new_final, net_parsed, net_fail)["evaluation_status"])

    for quote, legacy_status in (("12000", "FAIL"), ("8000", "PASS")):
        old_status = old_score["deterministic_checks"](net_parsed, {"profile": {"视频报价": quote}})[0]["status"]
        new_status = new_score["deterministic_checks"](net_parsed, {"profile": {"视频报价": quote}})[0]["status"]
        check(results, f"D1 legacy compares quote {quote} as net price", legacy_status, old_status)
        check(results, f"D1 candidate keeps quote {quote} UNKNOWN", "UNKNOWN", new_status)

    # D2: old text-polarity path conflicts on a negated claim; new structured path does not.
    old_value = {
        "content_relevance": {"level": 3, "evidence_ids": ["R1"], "reason": "内容相关"},
        "type_relevance": {"level": 3, "evidence_ids": ["R1"], "reason": "类型相关"},
        "coverage": 0.5, "priority": "备选", "verdict": "推荐",
        "strongest_support": "多条作品相关", "main_objection": "不能确认满足预算",
        "corrections": [], "business": {"price": "价格未提供，不能判断是否满足要求"},
        "reason": "内容与类型匹配，不能确认满足预算要求。",
        "strengths": ["多条作品相关"], "weaknesses": [],
    }
    old_evidence = {"records": [{"id": "R1", "data": {"视频标题": "红烧肉教程", "正文": "步骤"}}], "profile": {"粉丝数": 100000}}
    old_caps = old_review["evidence_caps"](old_evidence)
    failures = [{"id": "H1", "status": "FAIL", "evidence": "报价超出预算"}]
    try:
        old_review["validate"](copy.deepcopy(old_value), old_evidence, old_caps, failures)
        old_d2 = "ok"
    except ValueError as error:
        old_d2 = str(error)
    check(results, "D2 legacy review misreads the negation", "review_conflict", old_d2)

    parsed_price = {"must_have": [{"id": "H1", "requirement": "视频报价不超过100000元",
                                   "source_quote": "视频报价不超过100000元",
                                   "scope": "creator_commercial", "price_basis": "quoted"}],
                    "must_not": [], "secondary_conditions": []}
    new_value = dict(old_value)
    new_value["condition_reviews"] = [{"id": "H1", "verdict": "UNKNOWN", "reason": "报价依据不足"}]
    new_value["evidence_gaps"] = []
    new_result = new_review["main"](raw_text=json.dumps(new_value, ensure_ascii=False),
                                    evidence_json=json.dumps(old_evidence, ensure_ascii=False),
                                    parsed=parsed_price, analysis={"constraint_results": failures})
    check(results, "D2 candidate review keeps the same input non-conflicting", "", new_result["error"])

    # D3: old review deletes the missing-content limitation; candidate routes it through evidence_gaps.
    old_limitation = copy.deepcopy(old_value)
    old_limitation["main_objection"] = ""
    old_limitation["weaknesses"] = ["未提供口播样本，无法判断表达能力"]
    title_only = {"records": [{"id": "R1", "data": {"视频标题": "红烧肉教程"}}], "profile": {}}
    old_caps = old_review["evidence_caps"](title_only)
    old_review["validate"](old_limitation, title_only, old_caps, [])
    check(results, "D3 legacy review deletes the limitation sentence", False,
          any(item == "未提供口播样本，无法判断表达能力" for item in old_limitation["weaknesses"]))

    gap_parsed = {"must_have": [{"id": "H9", "requirement": "返点后到手单价不超过10000元",
                                 "source_quote": "返点后到手单价不超过10000元",
                                 "scope": "creator_commercial", "price_basis": "rebate_net"}],
                  "must_not": [], "secondary_conditions": []}
    gap_result = new_final["main"](
        scored=scored([{"id": "H9", "status": "UNKNOWN", "evidence": "返点后到手单价不超过10000元：净价口径无法核验"}],
                      gaps=[{"kind": "missing_content", "condition_ids": []}]),
        similarity=0.8, platform="抖音", parse_status="ok", normalized_platform="抖音",
        completeness_score=1.0, parsed=gap_parsed,
        evidence_json=json.dumps(title_only, ensure_ascii=False),
    )["score_result"]
    check(results, "D3 candidate regenerates the supported limitation", True,
          "未提供口播样本，无法判断表达能力" in gap_result["reason"])


def model_layer_status(results):
    fixture = json.loads((FIXTURES / "dify-score-model-cases.json").read_text())
    categories = {item["category"] for item in fixture["scenarios"]}
    check(results, "model cases cover required categories",
          {"net_price", "quoted_price", "double_negation", "missing_evidence"}, categories)
    check(results, "model cases are frozen but not run",
          "not_run", fixture["status"])
    check(results, "model cases have at least 5 scenarios", True, len(fixture["scenarios"]) >= 5)


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else None
    loaded = load_source(source)
    legacy = load_source(None, legacy=True)
    results = []
    chain_checks(loaded, results)
    contrast_checks(loaded, legacy, results)
    model_layer_status(results)
    failed = [item for item in results if not item["pass"]]
    print(json.dumps({"meta": {"candidate": loaded["meta"], "legacy": legacy["meta"]},
                      "checks": len(results), "passed": len(results) - len(failed), "failed": failed,
                      "model_layer": "not_run (tests/fixtures/dify-score-model-cases.json frozen)"},
                     ensure_ascii=False, indent=2))
    return bool(failed)


if __name__ == "__main__":
    sys.exit(main())
