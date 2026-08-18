# search_creators

Risk tier: automatic Provider operation.

Call immediately after `validate_requirement` succeeds in the normal new-requirement path. Pass only `id`, using `data.requirement_id` or, only when that field is absent, compatible `data.id`. Never substitute `data.demand_id`, `demand_version`, a host run ID, or a historical ID.

`contentTag` is stored on the requirement and is not a search argument. Use only real result fields such as `data.total_matched` and `data.supply_assessment`. Do not invent missing counts or repair inconsistent Provider arithmetic locally.

Preserve the exact Hook-provided `SAVE_EXCEL_ARTIFACT_ARGS` from this current response and immediately call `ypscan_save_excel_artifact` before `rank_mcns`. Its `excel_file_url` is an internal saver input only: never output `creators_export_path` or the Excel download URL to the user. After saving, call `rank_mcns`, output the complete MCN Markdown table, and show the returned absolute `data.file_path` before the rank branch `AskUserQuestion`. Do not open the URL with Browser, reuse a value from another requirement/platform, or replace the saver with Browser, shell, curl, `web_fetch`, Python, or a generic writer. If the exact save arguments are genuinely absent, report that the workbook cannot be saved instead of inventing them, then continue to ranking.

After success, including a real zero-match result, call `rank_mcns` with the same requirement ID and platform. Do not open Browser before ranking. Stop on a failed envelope, an ID mismatch, or internally inconsistent required result values; if the next step needs user input, use `AskUserQuestion`.
