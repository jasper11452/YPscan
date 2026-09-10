#!/usr/bin/env python3
"""Replay price-verification routing against the candidate Dify scoring code.

Migrated from the 2026-09-10 price-alias replay: the 12 native-alias cases keep their
business expectations and now carry scope/price_basis; quote-only net-price conditions
must stay UNKNOWN instead of being compared as if they were net price.

Usage: python3 scripts/replay-dify-price-alias.py [frozen-workflow.json]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dify_replay_support import compile_node, load_source  # noqa: E402


def condition(identifier, requirement, scope, basis=None):
    item = {"id": identifier, "requirement": requirement, "source_quote": "需求原文", "scope": scope}
    if basis:
        item["price_basis"] = basis
    return item


TEXT = "视频单价最高10万元，没有最低价"

# name, parsed group, condition, profile, expected (id, status) list
CASES = [
    ("native price", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频报价": "1500"}, [("H2", "PASS")]),
    ("native limit", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频报价": "100000"}, [("H2", "PASS")]),
    ("native over budget", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频报价": "100001"}, [("H2", "FAIL")]),
    ("native units", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频报价": "12万"}, [("H2", "FAIL")]),
    ("legacy field", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频笔记报价": "1500"}, [("H2", "PASS")]),
    ("same aliases", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频报价": "1500", "视频笔记报价": 1500}, [("H2", "PASS")]),
    ("conflicting aliases", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频报价": "1500", "视频笔记报价": 2000}, [("H2", "UNKNOWN")]),
    ("missing price", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {}, [("H2", "UNKNOWN")]),
    ("empty price", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"视频报价": ""}, [("H2", "UNKNOWN")]),
    ("wrong form", "must_have", condition("H2", TEXT, "creator_commercial", "quoted"),
     {"图文报价": "1500"}, [("H2", "UNKNOWN")]),
    ("douyin implant", "must_have",
     condition("H2", "植入视频报价最高10万元", "creator_commercial", "quoted"),
     {"植入视频报价": "20000"}, [("H2", "PASS")]),
    ("douyin custom", "must_have",
     condition("H2", "定制视频报价最高10万元", "creator_commercial", "quoted"),
     {"定制视频报价": "120000"}, [("H2", "FAIL")]),
]

NET_PRICE = "返点后到手单价不超过10000元"
NET_CASES = [
    ("net price quote over limit", "must_have", condition("H3", NET_PRICE, "creator_commercial", "rebate_net"),
     {"视频报价": "12000"}, [("H3", "UNKNOWN")]),
    ("net price quote within limit", "must_have", condition("H3", NET_PRICE, "creator_commercial", "rebate_net"),
     {"视频报价": "8000"}, [("H3", "UNKNOWN")]),
    ("unspecified basis", "must_have", condition("H4", "合作预算不超过10000元", "creator_commercial", "unspecified"),
     {"视频报价": "8000"}, [("H4", "UNKNOWN")]),
    ("net price wording without price keyword", "must_have",
     condition("H7", "返点后到手价不超过10000元", "creator_commercial", "rebate_net"),
     {"视频报价": "8000"}, [("H7", "UNKNOWN")]),
    ("net basis on objective scope stays UNKNOWN", "must_have",
     condition("H8", "返点后到手价不超过10000元", "creator_objective", "rebate_net"),
     {"视频报价": "8000"}, [("H8", "UNKNOWN")]),
    ("net price in must_not", "must_not", condition("N1", NET_PRICE, "creator_commercial", "rebate_net"),
     {"视频报价": "12000"}, [("N1", "UNKNOWN")]),
    ("net price in preference", "secondary_conditions",
     condition("S1", NET_PRICE, "creator_commercial", "rebate_net"),
     {"视频报价": "12000"}, [("S1", "UNKNOWN")]),
    ("quoted preference unchanged", "secondary_conditions",
     condition("S2", TEXT, "creator_commercial", "quoted"), {"视频报价": "120001"}, []),
    ("project budget not checked", "must_have",
     condition("H5", "总预算不超过100000元", "project"), {"视频报价": "120001"}, []),
    ("delivery rule not checked", "must_have",
     condition("H6", "综合分不低于60", "delivery"), {"视频报价": "120001"}, []),
]


def run():
    source = sys.argv[1] if len(sys.argv) > 1 else None
    loaded = load_source(source)
    results = []
    for node_id in ("score_json", "score_retry_json"):
        namespace = compile_node(loaded["codes"], node_id)
        for case in CASES + NET_CASES:
            name, group, item, profile, expected = case
            parsed = {"must_have": [], "must_not": [], "secondary_conditions": []}
            parsed[group] = [item]
            actual = [(entry["id"], entry["status"])
                      for entry in namespace["deterministic_checks"](parsed, {"profile": profile})]
            results.append({"node": node_id, "case": name, "group": group,
                            "expected": expected, "actual": actual, "pass": actual == expected})
    failed = [item for item in results if not item["pass"]]
    print(json.dumps({"meta": loaded["meta"], "checks": len(results),
                      "passed": len(results) - len(failed), "failed": failed},
                     ensure_ascii=False, indent=2))
    return bool(failed)


if __name__ == "__main__":
    sys.exit(run())
