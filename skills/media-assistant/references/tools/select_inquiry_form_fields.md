# select_inquiry_form_fields

Risk tier: internal preparation. This Provider MCP tool creates a field-selection link; it is not a workflow gate.

## When to call

Call when the current institutional inquiry or submission request needs a persisted field configuration. Resolve recipients before asking the user to select fields. These Provider fields apply to the institutional inquiry/export path; the native Browser path reads the platform's own visible/exported fields and does not accept or generate a project-side column template.

## Call

Call the directly exposed Provider MCP `select_inquiry_form_fields` using its current published schema. In the current workflow:

- Pass the exact current requirement ID using the live Provider schema's field name so the submitted selection is associated with the correct requirement.
- `platform`: `xiaohongshu` or `douyin` when required by the live schema.
- Pass optional link/wait parameters only when the Provider contract requires them.

Do not add local-only correlation fields or substitute `runId`, `sessionKey`, institution names, or supplier names for Provider parameters. If the live Provider schema changes, follow that schema rather than this example.

## Link and persistence

- Extract the real non-empty `url` from the response. When the Provider returns `success=false` with exact message `浏览器打开请求未成功` but the selection URL is valid, treat only the automatic-open action as failed and continue with the generated link.
- Output the unchanged selection URL once on its own line. Do not wrap it in Markdown, rewrite it, open it with Browser, or select fields for the user.
- Submission on the selection page persists the chosen fields in the Provider database under that requirement ID. `get_selected_inquiry_form_fields` is deprecated: never call it or poll a callback.

## Result

Do not read, reconstruct, validate, cache, or pass `columns` through the Agent context. Downstream Provider tools receive only their published business arguments and resolve the persisted field configuration internally from the requirement association.
