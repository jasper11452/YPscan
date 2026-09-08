# ypscan_summarize_manual_scores

Risk tier: local read and aggregate workbook save; no remote calls.

Only for manual sourcing. Call after normalized links are saved and after every `manual_score_batch` save. The sole argument is `requirement_id`, the current requirement ID. Do not supply paths, counts, recommendation labels or a batch size.

The tool uses registered requirement mode/platform/quantity, hash-verified normalized links, observed native completion success/failure IDs and saved scoring workbooks. It selects at most `3 × quantityTotal` distinct candidates in original order, schedules at most 20 at a time, and counts distinct creators with the exact conclusion `推荐`; `不推荐` does not count. Other verdicts, conflicting duplicates, changed files, foreign IDs/platforms/requirements or missing context stop automatic processing. All-failed completion batches (no csv_file) are still registered with their failed_author_ids, so failed creators are not rescheduled; an explicit retry that succeeds supersedes the earlier failure record.

- `next_action=complete_next_batch`: use only `next_author_ids` for the current platform native completion tool (Xiaohongshu `page_count=1`), then upload only this batch’s completion CSV and score it. Do not prefetch later batches.
- `next_action=await_scores`: completed creators still lack scoring rows. Wait only for the current submitted job; if already terminal, report missing rows and stop instead of resubmitting or guessing.
- `next_action=deliver`: recommendation target reached or candidates exhausted. Show `delivery.local_file_link` if present and stop further completion/scoring. Report `recommended_count`, `target_count`, `scored_count`, `unprocessed_count`, `completion_failed_count` and `shortfall` accurately. No file means no claimed delivery.

The final workbook has `推荐达人` (top N of the scored recommendations by comprehensive score) and `已评分达人` (all scored rows). Unscored candidates are not labeled as rejected. Sorting the scored rows does not establish global optimality across unscored candidates. Intermediate files remain preserved, repeated identical summaries are idempotent.

On exhausted shortage, deliver real results first, then review and suggest one relaxation under the Skill; wait for explicit confirmation. Never use this tool for inquiry retrieval. Gateway reset removes source registrations; missing context is an explicit stop, not authorization to recreate a requirement or repeat paid scoring.

Errors use `YPSCAN_MANUAL_SCORE_*`: source/context mismatch, changed sources, missing/ambiguous headers, unknown verdict, invalid score, conflicting results, limits and read/save failures. Keep prior files and report the error. Never fall back to shell scripts or guess the recommendation count.
