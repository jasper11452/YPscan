# select_inquiry_form_fields

Risk tier: internal preparation. This Provider MCP tool creates a field-selection link; it is not a workflow gate.

## When to call

Call when the current requirement needs a persisted field configuration. If the same conversation already records that the user submitted the field page for this exact requirement, reuse that Provider-persisted configuration and do not call this tool again. Resuming recipient selection from this requirement's current `rank_mcns` list after `暂不询价`, dialog close/cancel, or no answer keeps the same requirement: reuse submitted fields, or call this tool now if they were not submitted. For institutional inquiry, resolve recipients before asking the user to select fields: choosing the “询价机构” function alone does not nominate a recipient, so first ask the user to identify one or more recipients from the current MCN list, by explicit institution name, or both. Never infer recipients from rank, coverage, rebate, score, or recommendation order; an explicit user request such as `前 5 家` is a recipient selection by the current response order, not an inference. A unique exact current-list match with a non-empty `supplier_id` goes to `supplierIds`; an unmatched or ID-less original name stays in `supplier_name`.

## Call

Call the directly exposed Provider MCP `select_inquiry_form_fields` using its current published schema. In the current workflow:

- Pass the exact current requirement ID as `requirement_id` so the submitted selection is associated with the correct requirement. It comes from `validate_requirement.data.requirement_id`, falling back to `data.id` only when absent; never use `data.demand_id`.
- `platform`: required, pass exactly `xiaohongshu` or `douyin`.
- Pass optional link/wait parameters only when the Provider contract requires them.

Do not add local-only correlation fields or substitute `runId`, `sessionKey`, institution names, or supplier names for Provider parameters. If the live Provider schema changes, follow that schema rather than this example.

## Link and persistence

- Extract the real non-empty `url` from the response. When the Provider returns `success=false` with exact message `浏览器打开请求未成功` but the selection URL is valid, treat only the automatic-open action as failed and continue with the generated link.
- Output the unchanged selection URL once on its own line. Do not wrap it in Markdown, rewrite it, open it with Browser as a substitute, or select fields for the user. The current plugin has no verified host-side external-link opener, so automatic-open failure must be reported honestly rather than papered over with internal workarounds.
- Submission on the selection page persists the chosen fields in the Provider database under that requirement ID. `get_selected_inquiry_form_fields` is deprecated: never call it or poll a callback.
- Reuse is based only on visible same-conversation evidence that this exact requirement's field page was submitted. Do not create a local cache or query/rebuild `columns`.

## Result

Do not read, reconstruct, validate, cache, or pass `columns` through the Agent context. Downstream Provider tools receive only their published business arguments and resolve the persisted field configuration internally from the requirement association.
