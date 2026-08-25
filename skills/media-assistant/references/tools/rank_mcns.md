# rank_mcns

Risk tier: automatic Provider operation.

This is the fourth fixed Provider call. Call directly after a successful `search_creators` result, including a successful zero-match result; do not save the search workbook. Pass the exact current requirement ID as `id` and the current platform. The requirement ID is the `validate_requirement` result's `data.requirement_id`, falling back to `data.id` only when absent; never use `data.demand_id`, `demand_version`, or another workflow's ID.

Provider risk labels, supply multipliers, institution count, and `recommended_action` are internal response context. They do not prohibit, shrink, or preselect institutional inquiry, and they are not user-visible ranking output. Never invent `medium_risk_confirmation` or recommend loosening the user's requirements merely because supply is low.

## Presentation

Do not design an institution table from the response schema. Extra fields in the response are internal context, never optional display columns. Do not reuse a table format from an earlier turn, example, or prior version.

After every successful response, before any other text or user interaction, use every candidate supplier from that same real response, in response order. Show one compact Markdown table; never replace it with bullets or a numbered list:

| 排名 | 机构 | 覆盖达人 | 返点 | 综合分 |
| ---- | ---- | -------- | ---- | ------ |

This five-column table is the entire user-visible institution result. Number rows from 1 in response order. Do not add columns or show `supplier_id`, candidate totals, matched-institution count, recommended quantity, supply multipliers, recommended MCN count, manual-research count, MCN-to-manual ratio, recommendation reasons, risk labels, `recommended_action`, or any other `rank_mcns` fields or summaries inside or outside the table.

Although `supplier_id` is never user-visible, retain each current response object's exact institution-name-to-`supplier_id` association in the same conversation. If the user later supplies or nominates an institution name for inquiry, a unique exact match in this same requirement and platform takes first priority: use its non-empty `supplier_id` in `supplierIds`. Use the original name in `supplier_name` only when the current rank response has no exact match or the matching object has no ID. Never reuse an ID across requirements, platforms, or runs, and never fuzzy-match or choose among multiple matching objects locally.

Each row's values must come from that supplier's own object. For the coverage column, copy that supplier's `candidate_count` value exactly. `mcn_covered_creator_count` is cumulative and must never be shown as the current supplier's count. Never add a row to preceding rows, convert it to a running total, derive it by subtracting adjacent rows, or replace it with other aggregate/cumulative coverage. Never show `supplier_id` as the name or reconstruct omitted rows. Missing values remain unknown; do not fill a row from aggregate coverage or history.

When no suppliers are returned, keep the same header and add exactly one empty-state row:

```markdown
| 排名 | 机构         | 覆盖达人 | 返点 | 综合分 |
| ---- | ------------ | -------- | ---- | ------ |
| —    | 暂无匹配机构 | —        | —    | —      |
```

Immediately after the full table, use the Hook-provided `SAVE_EXCEL_ARTIFACT_ARGS` to save the current `rank_mcns` workbook as `artifact_kind="mcn_ranking"`. Do not output its Provider URL, open it with Browser, substitute a historical value, or use another downloader/writer. After the save succeeds, show the current MCN-ranking absolute local path. If the current response genuinely omitted exact save arguments, state that the MCN-ranking workbook could not be saved instead of inventing a path.

Only after writing the full table, saving the MCN-ranking workbook, and showing its local path as user-visible body text, call host `AskUserQuestion` with options `询价机构` and `人工拓展并提报` when the table is non-empty. When the result is empty, output the empty-state table, save the returned workbook when present, show its path, and use `人工拓展并提报` and `结束本次`. Only the current Ask answer chooses the next path; an initial user request like “直接手扒” does not count as that answer and does not skip the table, save, local path, or question. Do not rerank merely to ask the question or recover supplier names.

Stop on a failed envelope or a result too incomplete to identify suppliers truthfully.
