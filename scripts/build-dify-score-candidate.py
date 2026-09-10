#!/usr/bin/env python3
"""Assemble the candidate Dify score-workflow JSON from the frozen baseline + fixtures.

The candidate JSON lives in the gitignored dify工作流/ directory; the fixtures under
tests/fixtures/ are the versioned source of truth. This script only copies node code,
prompt text and structured-output schemas onto the frozen baseline and never touches
edges, environment variables or other nodes.

Usage:
  python3 scripts/build-dify-score-candidate.py [--baseline PATH] [--target PATH]
"""

import argparse
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = ROOT / "dify工作流/达人评分（手动拓展验收修复-20260910-脱敏）.json"
DEFAULT_TARGET = ROOT / "dify工作流/达人评分（节点级修复候选-20260910-脱敏）.json"
FIXTURES = ROOT / "tests/fixtures"

CODE_FILES = {
    "parse_json": "dify-parse-json-candidate.py",
    "parse_retry_json": "dify-parse-json-candidate.py",
    "score_json": "dify-score-json-candidate.py",
    "score_retry_json": "dify-score-json-candidate.py",
    "review_json": "dify-review-json-candidate.py",
    "final": "dify-final-candidate.py",
}
PROMPTS = {
    "parse": "dify-parse-prompt-candidate.txt",
    "parse_retry": "dify-parse-prompt-candidate.txt",
    "score": "dify-score-prompt-candidate.txt",
    "score_retry": "dify-score-prompt-candidate.txt",
    "review": "dify-review-prompt-candidate.txt",
}
SCHEMAS = {
    "parse": "dify-parse-schema-candidate.json",
    "parse_retry": "dify-parse-schema-candidate.json",
    "score": "dify-score-schema-candidate.json",
    "score_retry": "dify-score-schema-candidate.json",
    "review": "dify-review-schema-candidate.json",
}


def build(baseline: Path, target: Path) -> dict:
    workflow = json.loads(baseline.read_text())
    nodes = {node["id"]: node for node in workflow["workflow"]["graph"]["nodes"]}
    assert len(nodes) == 28, len(nodes)
    assert len(workflow["workflow"]["graph"]["edges"]) == 30
    for node_id, filename in CODE_FILES.items():
        code = (FIXTURES / filename).read_text()
        if node_id.endswith("_retry_json"):
            assert "ATTEMPT = 1" in code
            code = code.replace("ATTEMPT = 1", "ATTEMPT = 2", 1)
        nodes[node_id]["data"]["code"] = code
    for node_id, filename in PROMPTS.items():
        prompt = nodes[node_id]["data"]["prompt_template"]
        assert len(prompt) == 2 and prompt[0]["role"] == "system"
        prompt[0]["text"] = (FIXTURES / filename).read_text()
    for node_id, filename in SCHEMAS.items():
        nodes[node_id]["data"]["structured_output"]["schema"] = json.loads((FIXTURES / filename).read_text())
    target.write_text(json.dumps(workflow, ensure_ascii=False, indent=2))
    return {"target": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "code": {node_id: hashlib.sha256(nodes[node_id]["data"]["code"].encode()).hexdigest()[:16]
                     for node_id in ("parse_json", "parse_retry_json", "score_json", "score_retry_json",
                                     "review_json", "final")}}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--target", type=Path, default=DEFAULT_TARGET)
    args = parser.parse_args()
    print(json.dumps(build(args.baseline, args.target), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
