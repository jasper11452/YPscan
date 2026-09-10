#!/usr/bin/env python3
"""Replay the Douyin schema and normalizer from the manual-search workflow."""

import json
from pathlib import Path
import sys


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "tests/fixtures/dify-hand-douyin.json"
    data = json.loads(path.read_text())
    if "workflow" in data:
        nodes = data["workflow"]["graph"]["nodes"]
        schema = next(n for n in nodes if n["id"] == "1787628416303")["data"]["structured_output"]["schema"]
        code = next(n for n in nodes if n["id"] == "1788900000001")["data"]["code"]
    else:
        schema, code = data["schema"], data["code"]
    namespace = {}
    exec(compile(code, "douyin_normalizer", "exec"), namespace)
    normalize = namespace["main"]
    enums = schema["properties"]["tag_level_two"]["items"]["enum"]
    payload = {"tag": ["美食"], "tag_level_two": ["美食教程"],
               "author_id": "家常菜制作，菜谱教学", "follower__ge": "10000", "follower__le": "1000000",
               "price_by_video_type": "植入视频", "price_by_video_type__ge": "0", "price_by_video_type__le": "100000"}
    result = normalize(payload)
    checks = {
        "schema accepts tutorial": "美食教程" in enums,
        "schema and code enums agree": enums == namespace["FIELDS"]["tag_level_two"]["items"]["enum"],
        "normalizer preserves tutorial": result["tag_level_two"] == ["美食教程"],
        "followers unchanged": (result["follower__ge"], result["follower__le"]) == ("10000", "1000000"),
        "price widens once": (result["price_by_video_type__ge"], result["price_by_video_type__le"]) == ("0", "120000"),
        "keywords preserved": result["author_id"] == payload["author_id"],
        "unknown tag rejected": normalize({"tag_level_two": ["not-a-real-tag"]})["tag_level_two"] == [],
        "adjacent tag preserved": normalize({"tag_level_two": ["乡村野食"]})["tag_level_two"] == ["乡村野食"],
        "duplicates removed": normalize({"tag_level_two": ["美食教程", "美食教程"]})["tag_level_two"] == ["美食教程"],
    }
    try:
        normalize({"follower__ge": "100000", "follower__le": "10000"})
        checks["inverted range rejected"] = False
    except ValueError:
        checks["inverted range rejected"] = True
    failed = [name for name, passed in checks.items() if not passed]
    print(json.dumps({"checks": len(checks), "passed": len(checks) - len(failed), "failed": failed},
                     ensure_ascii=False, indent=2))
    return bool(failed)


if __name__ == "__main__":
    sys.exit(main())
