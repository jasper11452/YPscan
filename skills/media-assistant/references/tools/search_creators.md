# search_creators

Risk tier: automatic Provider operation.

Call immediately after `validate_requirement` succeeds in the normal new-requirement path. Pass only `id`, using `data.requirement_id` or, only when that field is absent, compatible `data.id`. Never substitute `data.demand_id`, `demand_version`, a host run ID, or a historical ID.

`contentTag` is stored on the requirement and is not a search argument. Use only real result fields such as `data.total_matched` and `data.supply_assessment`. Do not invent missing counts or repair inconsistent Provider arithmetic locally.

Do not save or display `creators_export_path` or any other workbook link from this response. Do not open it with Browser or download it with the saver, shell, curl, `web_fetch`, Python, or a generic writer. After success, including a real zero-match result, immediately call `rank_mcns` with the same requirement ID and current platform.

After success, including a real zero-match result, call `rank_mcns` with the same requirement ID and platform. Do not open Browser before ranking. Stop on a failed envelope, an ID mismatch, or internally inconsistent required result values; if the next step needs user input, use `AskUserQuestion`.
