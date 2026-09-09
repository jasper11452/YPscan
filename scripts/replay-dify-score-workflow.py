#!/usr/bin/env python3
"""Offline regression replay for the exported Dify scoring workflow."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

import yaml


DEFAULT_WORKFLOW = Path("dify工作流/达人评分（完整能力逻辑修正版）.yml")
EXPECTED_SHA256 = "0c865b2a60fd29a20460afb23762e92c8123a6cdbf737a3edfc5aaa4756b9bcc"


def load_nodes(path: Path) -> dict[str, dict]:
    source = path.read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    if digest != EXPECTED_SHA256:
        raise AssertionError(
            f"workflow SHA-256 changed: expected {EXPECTED_SHA256}, got {digest}; "
            "review the export and replay expectations before updating the baseline"
        )
    workflow = yaml.safe_load(source)
    return {
        node["id"]: node["data"] for node in workflow["workflow"]["graph"]["nodes"]
    }


def compile_node(nodes: dict[str, dict], node_id: str) -> dict:
    namespace: dict = {}
    exec(compile(nodes[node_id]["code"], node_id, "exec"), namespace)
    return namespace


def replay_deterministic_checks(nodes: dict[str, dict]) -> None:
    first_code = nodes["score_json"]["code"]
    retry_code = nodes["score_retry_json"]["code"]
    assert first_code.replace("ATTEMPT = 1", "ATTEMPT = 2") == retry_code

    cases = [
        ("定制报价不超过5千", {"定制视频价格": 4000}, "PASS"),
        ("定制报价低于5万", {"定制视频价格": 50000}, "FAIL"),
        ("粉丝5万-20万", {"粉丝数": 22000}, "FAIL"),
        (
            "粉丝数至少10万，定制报价不超过5000",
            {"粉丝数": 150000, "定制视频价格": 20000},
            "FAIL",
        ),
        (
            "定制报价不超过2000",
            {"定制视频价格": 1000, "定制视频报价": 5000},
            "UNKNOWN",
        ),
        ("定制报价不高于5000元", {"定制视频价格": "4k"}, "PASS"),
        ("粉丝数不少于10万", {"粉丝数": "12w"}, "PASS"),
    ]

    for node_id in ("score_json", "score_retry_json"):
        namespace = compile_node(nodes, node_id)
        for requirement, profile, expected in cases:
            parsed = {"must_have": [{"id": "H1", "requirement": requirement}]}
            checks = namespace["deterministic_checks"](parsed, {"profile": profile})
            actual = [item["status"] for item in checks]
            assert actual == [expected], (node_id, requirement, checks)


def scored(checks: list[dict] | None = None) -> dict:
    return {
        "content_relevance": {"level": 4},
        "type_relevance": {"level": 4},
        "coverage": 1.0,
        "constraint_results": checks or [],
        "strengths": ["有真实作品证据"],
        "weaknesses": [],
        "reason": "内容与类型匹配。",
    }


def reviewed(verdict: str = "推荐") -> dict:
    return {
        "content_relevance": {"level": 4},
        "type_relevance": {"level": 4},
        "coverage": 1.0,
        "verdict": verdict,
        "strengths": ["复核证据有效"],
        "weaknesses": [],
        "reason": "整体复核通过。",
        "corrections": [],
    }


def replay_final_statuses(nodes: dict[str, dict]) -> None:
    main = compile_node(nodes, "final")["main"]
    empty = {"must_have": [], "must_not": [], "secondary_conditions": []}

    def run(
        parsed: dict,
        checks: list[dict] | None = None,
        review: dict | None = None,
        review_error: str = "",
    ) -> dict:
        return main(
            scored(checks),
            0,
            "douyin",
            "ok",
            "douyin",
            1,
            parsed,
            "{}",
            reviewed=review,
            review_error=review_error,
        )["score_result"]

    pending_parsed = {
        "must_have": [{"id": "H1", "requirement": "男博主"}],
        "must_not": [],
        "secondary_conditions": [],
    }
    pending_checks = [
        {"id": "H1", "status": "UNKNOWN", "evidence": "男博主：资料不足"}
    ]
    cases = [
        (run(empty, review_error="review unavailable"), "不推荐", "review_failed", False),
        (run(empty, review=reviewed()), "推荐", "ok", True),
        (
            run(pending_parsed, pending_checks, reviewed()),
            "不推荐",
            "qualification_pending",
            False,
        ),
        (
            run(empty, review=reviewed("不推荐")),
            "不推荐",
            "review_conflict",
            False,
        ),
    ]
    for result, decision, status, score_valid in cases:
        assert result["decision"] == decision
        assert result["evaluation_status"] == status
        assert result["score_valid"] is score_valid


def replay_evidence_pipeline(nodes: dict[str, dict]) -> None:
    """extract_images -> score_json 的真实证据链：单位、别名冲突、缺失字段。"""
    extract = compile_node(nodes, "extract_images")
    score = compile_node(nodes, "score_json")

    def evidence(creator: dict) -> dict:
        bundle = extract["main"](
            json.dumps(creator, ensure_ascii=False), "douyin", "vision-model", ""
        )
        return json.loads(bundle["evidence_json"])

    base = {
        "星图ID": "123",
        "粉丝数": "12w",
        "定制视频价格": "4k",
        "达人类型": "科技",
        "近15条视频表现": [{"视频标题": "测试", "播放量": 10000}],
    }
    cases = [
        (base, "粉丝数不少于10万", "PASS"),
        (base, "定制报价不高于5000元", "PASS"),
        ({**base, "定制视频报价": "5000"}, "定制报价不超过2000", "UNKNOWN"),
        (
            {key: value for key, value in base.items() if key != "粉丝数"},
            "粉丝数不少于10万",
            "UNKNOWN",
        ),
    ]
    for creator, requirement, expected in cases:
        parsed = {"must_have": [{"id": "H1", "requirement": requirement}]}
        checks = score["deterministic_checks"](parsed, evidence(creator))
        actual = [item["status"] for item in checks]
        assert actual == [expected], (requirement, checks)


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_WORKFLOW
    nodes = load_nodes(path)
    replay_deterministic_checks(nodes)
    replay_final_statuses(nodes)
    replay_evidence_pipeline(nodes)
    print(
        "Dify scoring replay passed: 14 deterministic checks, "
        "4 final-status checks, 4 evidence-pipeline checks"
    )


if __name__ == "__main__":
    main()
