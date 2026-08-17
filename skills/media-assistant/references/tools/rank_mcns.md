# rank_mcns

Risk tier: automatic Provider operation.

This is the fourth fixed Provider call. Call after the successful `search_creators` result has been saved locally with `ypscan_save_excel_artifact` (including a successful zero-match result), then pass the exact current `id` and platform. Do not mix platform or requirement IDs.

Provider risk labels, supply multipliers, institution count, and `recommended_action` are display information. They do not prohibit, shrink, or preselect institutional inquiry. Never invent `medium_risk_confirmation` or recommend loosening the user's requirements merely because supply is low.

## Presentation

After every successful response, before any other text or user interaction, use every candidate supplier from that same real response, in response order. Show one compact Markdown table; never replace it with bullets or a numbered list:

| 机构名 | 返点 | 综合分 | 本机构预估覆盖达人数 |
| ------ | ---- | ------ | -------------------- |

Each row's values must come from that supplier's own object. For the coverage column, copy that supplier's `candidate_count` value exactly. `mcn_covered_creator_count` is cumulative and must never be shown as the current supplier's count. Never add a row to preceding rows, convert it to a running total, derive it by subtracting adjacent rows, or replace it with other aggregate/cumulative coverage. Never show `supplier_id` as the name or reconstruct omitted rows. Summarize only real platform-level fields if present. Missing values remain unknown; do not fill a row from aggregate coverage or history.

When no suppliers are returned, keep the same header and add exactly one empty-state row:

```markdown
| 机构名       | 返点 | 综合分 | 本机构预估覆盖达人数 |
| ------------ | ---- | ------ | -------------------- |
| 暂无匹配机构 | —    | —      | —                    |
```

If both aggregate institutional coverage and recommended manual sourcing count are present, show their raw counts and reduced integer ratio. When manual sourcing is zero, say it is unnecessary and omit the ratio.

Immediately after the full table, show the absolute `data.file_path` returned by the preceding `ypscan_save_excel_artifact` call; do not output `creators_export_path` or the Excel download URL to the user. Do not open the URL with Browser, substitute a historical value, or use any other downloader/writer. If the current search genuinely omitted the exact save arguments, state that the workbook could not be saved instead of inventing a path.

Only after writing the full table and showing the saved local path as user-visible body text, call host `AskUserQuestion` with options `询价机构` and `人工拓展并提报` when the table is non-empty. When the result is empty, output the empty-state table, show the same saved path, and use `人工拓展并提报` and `结束本次`. Only the current Ask answer chooses the next path; an initial user request like “直接手扒” does not count as that answer and does not skip the table, save, local path, or question. Do not rerank merely to ask the question or recover supplier names.

Stop on a failed envelope or a result too incomplete to identify suppliers truthfully.
