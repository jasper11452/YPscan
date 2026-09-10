#!/usr/bin/env python3
"""Shared offline loader for Dify score-workflow replays.

Candidate fixtures are the versioned source of truth; a frozen workflow JSON export
may be passed explicitly to replay the exact build (scripts print the loaded path
and node fingerprints so the two cannot be confused).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests/fixtures"

CANDIDATE_FILES = {
    "parse_json": "dify-parse-json-candidate.py",
    "parse_retry_json": "dify-parse-json-candidate.py",
    "score_json": "dify-score-json-candidate.py",
    "score_retry_json": "dify-score-json-candidate.py",
    "review_json": "dify-review-json-candidate.py",
    "final": "dify-final-candidate.py",
}

LEGACY_FILES = {
    "score_json": "dify-score-json.py",
    "review_json": "dify-review-json.py",
    "final": "dify-final.py",
}


def _with_attempt(code: str, node_id: str) -> str:
    if node_id.endswith("_retry_json") and "ATTEMPT = 1" in code:
        return code.replace("ATTEMPT = 1", "ATTEMPT = 2", 1)
    return code


def _fingerprint(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()[:16]


def load_source(source=None, legacy: bool = False) -> dict:
    """Load node code from fixture files (default) or a frozen workflow JSON export."""
    files = LEGACY_FILES if legacy else CANDIDATE_FILES
    if source:
        path = Path(source)
        raw = path.read_bytes()
        index = {node["id"]: node for node in json.loads(raw)["workflow"]["graph"]["nodes"]}
        codes = {}
        for node_id, filename in files.items():
            code = index[node_id]["data"].get("code", "")
            if not code:
                raise AssertionError("node %s has no code in %s" % (node_id, path))
            codes[node_id] = code
        return {
            "codes": codes,
            "meta": {"source": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                     "kind": "workflow-json",
                     "fingerprints": {node_id: _fingerprint(code) for node_id, code in codes.items()}},
        }
    codes = {}
    for node_id, filename in files.items():
        code = (FIXTURES / filename).read_text()
        codes[node_id] = _with_attempt(code, node_id)
    return {
        "codes": codes,
        "meta": {"source": "tests/fixtures/" + ("legacy" if legacy else "candidate"),
                 "kind": "fixture",
                 "fingerprints": {node_id: _fingerprint(code) for node_id, code in codes.items()}},
    }


def compile_node(codes: dict, node_id: str) -> dict:
    namespace: dict = {}
    exec(compile(codes[node_id], node_id, "exec"), namespace)
    return namespace


def report(source=None, legacy: bool = False) -> dict:
    return load_source(source, legacy)["meta"]
