# select_inquiry_form_fields

Risk tier: internal preparation. This Provider MCP tool creates a field-selection link; it is not a workflow gate.

## When to call

同一会话首次选择字段；后续新 requirement（含放宽、纠错和跨功能）通过 `select_inquiry_form_fields` 传 `source_requirement_id`，来源只取本会话最近一次用户已提交或 Provider 已确认 `configured` 的真实需求，不跨会话、不猜测 ID。用户明确要求重新勾选时才传 `force_reselect=true` 并省略来源。新参数须为当前 live schema 支持，否则说明接口未支持并暂停。`success=true` 且 `status=configured`、返回需求 ID 与当前调用一致时直接继续；字段页状态 `selection_required` 或 `opened` 只展示 URL 并等待提交及“好了”。继承失败或平台不兼容时暂停，不自动重选；不读取、缓存或传递 `columns`。

Resuming recipient selection from this requirement's current `rank_mcns` list after `暂不询价`, dialog close/cancel, or no answer keeps the same requirement: reuse submitted fields, or call this tool now if they were not submitted. For institutional inquiry, resolve recipients before asking the user to select fields: choosing the “询价机构” function alone does not nominate a recipient, so first ask the user to identify one or more recipients from the current MCN list, by explicit institution name, or both. Never infer recipients from rank, coverage, rebate, score, or recommendation order; an explicit user request such as `前 5 家` is a recipient selection by the current response order, not an inference. A unique exact current-list match with a non-empty `supplier_id` goes to `supplierIds`; an unmatched or ID-less original name stays in `supplier_name`.

## Call

Call the directly exposed Provider MCP `select_inquiry_form_fields` using its current published schema. In the current workflow:

- Pass the exact current requirement ID as `requirement_id` so the submitted selection is associated with the correct requirement. It comes from `validate_requirement.data.requirement_id`, falling back to `data.id` only when absent; never use `data.demand_id`.
- `platform`: required, pass exactly `xiaohongshu` or `douyin`.
- Pass optional link/wait parameters only when the Provider contract requires them.

Do not add local-only correlation fields or substitute `runId`, `sessionKey`, institution names, or supplier names for Provider parameters. If the live Provider schema changes, follow that schema rather than this example.

## New parameters and results

| Parameter             | Type    | Required | Meaning                                                     |
| --------------------- | ------- | -------- | ----------------------------------------------------------- |
| requirement_id        | string  | yes      | Current target requirement ID                               |
| platform              | string  | yes      | xiaohongshu or douyin                                       |
| source_requirement_id | string  | no       | Same-conversation configured source requirement ID          |
| force_reselect        | boolean | no       | Default false; true opens the field page and ignores source |

Keep existing optional parameters unchanged. Only send new parameters if the live schema supports them; otherwise pause when inheritance or reselection is needed.

Provider precedence: force reselection → retain existing target configuration → copy submitted source configuration after ownership/platform checks → first selection page. Failed inheritance returns an error without generating a page or changing target configuration.

- `success=true, status=configured`: `requirement_id` must match the current call. `configuration_source` is `existing` or `inherited`; inherited results also return `source_requirement_id`. Continue the original branch immediately, without a URL or waiting for “好了”. Do not bypass inquiry recipient selection or sending confirmation. For scoring recovery, resubmit scoring once using the original trusted arguments; do not repeat search/completion/upload.
- `status=selection_required` or `status=opened`: return `url` and `requirement_id` matching the current call; missing or mismatched IDs pause without displaying the page. `opened` means the field page was generated and is waiting for submission; it is not `configured`. A legacy response without status or requirement ID may still provide a valid URL; if it includes an ID, that ID must match. If an inheritance call returns a URL instead of configured, pause and report missing inheritance support; do not ask the user to select again. A forced reselection must return a page, not configured.
- `status=error` or failed inheritance: report `error_code`/`message` and pause, without automatically reopening the page or continuing downstream.

## Link and persistence

- Output the real URL unchanged once on its own line. Do not wrap it in Markdown, rewrite it, open it with Browser, or select fields for the user.
- Legacy `success=false` with exact message `浏览器打开请求未成功` and a valid URL means only automatic opening failed; display the link honestly. Explicit `status=error` takes precedence.
- After outputting the URL, end the turn. Resume only after the user submitted the page and explicitly replied “好了”. Never poll a callback or call deprecated `get_selected_inquiry_form_fields`.
- For explicit reselection, submission only updates configuration unless the conversation clearly identifies an unfinished step waiting for fields. Resume only that step. Never restart completed/stopped search, scoring or inquiry confirmation; if no pending step is clear, acknowledge the update and stop.
- The Provider saves or copies configuration under the target requirement. Agent only passes IDs; never read, reconstruct, cache, or pass `columns`. Existing target configuration is not overwritten by inheritance. A newly submitted selection becomes the source for later requirements in this conversation.
