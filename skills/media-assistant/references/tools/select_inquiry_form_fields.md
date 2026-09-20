# select_inquiry_form_fields

Risk tier: internal preparation. This Provider MCP tool creates a field-selection link; it is not a workflow gate.

## When to call

本工具按是否传 `requirement_id` 区分两种用途：

- 只扒达人信息（不传 `requirement_id`）：用户只想按达人 ID 或链接导出指定字段的达人表、不建需求、不询价时，传 `platform` + `creator_ids`/`creator_links`，返回 `field_id` 和字段选择页 URL。用户提交字段页后，用 `field_id` 补全达人和导出，不涉及 requirement。
- 需求维度（传 `requirement_id`）：见下。

同一会话首次选择字段；后续新 requirement（含放宽、纠错和跨功能）通过 `select_inquiry_form_fields` 传 `source_requirement_id`，来源只取本会话最近一次用户已提交或 Provider 已确认 `configured`/`copied` 的真实需求，不跨会话、不猜测 ID。用户明确要求重新勾选时才传 `force_reselect=true` 并省略来源。新参数须为当前 live schema 支持，否则说明接口未支持并暂停。`success=true` 且 `status=configured`/`copied`、返回需求 ID 与当前调用一致时直接继续；字段页状态 `selection_required` 或 `opened` 只展示 URL，并按 [get_inquiry_form_fields_status](get_inquiry_form_fields_status.md) 自动确认提交（预检 `unavailable` 后每 30 秒轮询、最多 8 次，`submitted` 恢复；预检即 `submitted`、`invalid`、未知、失败、到上限或无法确认预检结果时改等用户确认已提交）；`force_reselect=true` 或继承场景禁止轮询。继承失败或平台不兼容时暂停，不自动重选；不读取、缓存或传递 `columns`。

Resuming recipient selection from this requirement's current `rank_mcns` list after `暂不询价`, dialog close/cancel, or no answer keeps the same requirement: reuse submitted fields, or call this tool now if they were not submitted. For institutional inquiry, resolve recipients before asking the user to select fields: choosing the “询价机构” function alone does not nominate a recipient, so first ask the user to identify one or more recipients from the current MCN list, by explicit institution name, or both. Never infer recipients from rank, coverage, rebate, score, or recommendation order; an explicit user request such as `前 5 家` is a recipient selection by the current response order, not an inference. A unique exact current-list match with a non-empty `supplier_id` goes to `supplierIds`; an unmatched or ID-less original name stays in `supplier_name`.

## Call

Call the directly exposed Provider MCP `select_inquiry_form_fields` using its current published schema. In the current workflow:

- 需求维度：Pass the exact current requirement ID as `requirement_id` so the submitted selection is associated with the correct requirement. It comes from `validate_requirement.data.requirement_id`, falling back to `data.id` only when absent; never use `data.demand_id`.
- 只扒达人信息：不传 `requirement_id`，也不传 `source_requirement_id` / `force_reselect`（无来源需求可继承，每次都是首次选字段）；传 `creator_ids`（达人 ID 列表）和/或 `creator_links`（达人链接列表），两者至少其一；Provider 返回 `field_id` 和字段选择页 URL。
- `platform`: required, pass exactly `xiaohongshu` or `douyin`.
- Pass optional link/wait parameters only when the Provider contract requires them.

Do not add local-only correlation fields or substitute `runId`, `sessionKey`, institution names, or supplier names for Provider parameters. If the live Provider schema changes, follow that schema rather than this example.

## New parameters and results

| Parameter             | Type     | Required | Meaning                                                                                                 |
| --------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------- |
| requirement_id        | string   | no       | Current target requirement ID; omit for creator-detail runs                                             |
| platform              | string   | yes      | xiaohongshu or douyin                                                                                   |
| creator_ids           | string[] | no       | Creator IDs for creator-detail runs; at least one of creator_ids/creator_links when no requirement_id   |
| creator_links         | string[] | no       | Creator links for creator-detail runs; at least one of creator_ids/creator_links when no requirement_id |
| source_requirement_id | string   | no       | Same-conversation configured source requirement ID; never for creator-detail runs                       |
| force_reselect        | boolean  | no       | Default false; true opens the field page and ignores source; never for creator-detail runs              |

Keep existing optional parameters unchanged. Only send new parameters if the live schema supports them; otherwise pause when inheritance or reselection is needed.

Provider precedence: force reselection → retain existing target configuration → copy submitted source configuration after ownership/platform checks → first selection page. Failed inheritance returns an error without generating a page or changing target configuration.

- `success=true` with `status=configured` or `status=copied`: `requirement_id` must match the current call. `copied` is the shipped Provider status for a successful inheritance; `configured` is the older contract name for the same outcome — treat both as configured. When present, `configuration_source` is `existing` or `inherited`, and inherited results also return `source_requirement_id`; the shipped `copied` payload may omit `configuration_source`. Continue the original branch immediately, without a URL or waiting for user confirmation. Do not bypass inquiry recipient selection or sending confirmation. For scoring recovery, resubmit scoring once using the original trusted arguments; do not repeat search/completion/upload.
- `status=selection_required` or `status=opened`: return `url` and `requirement_id` matching the current call; missing or mismatched IDs pause without displaying the page. `opened` means the field page was generated and is waiting for submission; it is not a configured/copied result. A legacy response without status or requirement ID may still provide a valid URL; if it includes an ID, that ID must match. If an inheritance call returns a URL instead of a configured/copied result, pause and report missing inheritance support; do not ask the user to select again. A forced reselection must return a page, not a configured/copied result. For an eligible first-selection page, continue with `get_inquiry_form_fields_status` polling per its card; never poll in the forced-reselection or inheritance case.
- 无 `requirement_id` 的调用（只扒达人信息）：返回 `field_id`（`get_creator_detail_run.run_id`）+ `status=selection_required`/`opened` + `url`；`field_id` 和 `url` 缺一不可，缺则暂停不展示字段页。展示 URL 后继续补全达人和上传 CSV，然后直接调 `excel_export(field_id, ...)`；字段是否已提交由 excel_export 后端查表校验，不轮询 `get_inquiry_form_fields_status`、不主动停下等口头确认。
- `status=error` or failed inheritance: report `error_code`/`message` and pause, without automatically reopening the page or continuing downstream.

## Link and persistence

- Output the real URL unchanged once on its own line in the user-visible reply, and say it is the field-selection page to submit. Before that link appears in the reply, the local Hook blocks the first `get_inquiry_form_fields_status` call once and returns the URL again — do not poll first, and never claim the page is already open when `browser_launch_requested=false` or `browser_launch_error` is present; the user must open the link. Do not wrap the URL in Markdown, rewrite it, open it with Browser, or select fields for the user.
- Legacy `success=false` with exact message `浏览器打开请求未成功` and a valid URL means only automatic opening failed; display the link honestly (the user must open it). Explicit `status=error` takes precedence.
- After outputting the URL, confirm submission with `get_inquiry_form_fields_status` when it is available and the page is an eligible first selection; a clear user confirmation that the fields were submitted always remains a valid resume signal; never ask the user for a fixed phrase. Never call deprecated `get_selected_inquiry_form_fields` and never poll any other callback or tool.
- For explicit reselection, submission only updates configuration unless the conversation clearly identifies an unfinished step waiting for fields. Resume only that step. Never restart completed/stopped search, scoring or inquiry confirmation; if no pending step is clear, acknowledge the update and stop.
- The Provider saves or copies configuration under the target requirement. Agent only passes IDs; never read, reconstruct, cache, or pass `columns`. Existing target configuration is not overwritten by inheritance. A newly submitted selection becomes the source for later requirements in this conversation.
