# create_with_distributions

Risk tier: Provider-enforced idempotent side effect. Provider write plus WeCom distribution; no plugin-side send confirmation.

This is the institutional inquiry creation entry point.

## When to call

Call once after the user has chosen the inquiry branch, field selection has been submitted for the requirement, and the recipient IDs plus any unmatched user-nominated institution names and the complete message are available. Do not make a preview call or ask for another send confirmation.

## Recipient and field preparation

- Always pass both recipient arrays. Use `[]` for an empty side, and require at least one array to be non-empty.
- `supplier_id` is the first-priority recipient identity. For every institution name supplied or nominated by the user, first inspect only the current requirement and platform's real `rank_mcns.data.mcns` response. When the name has one exact match and that object has a non-empty `supplier_id`, put that ID in `supplierIds` and do not also put the same institution in `supplier_name`.
- Put the user's original institution name in `supplier_name` only when no current rank object matches it exactly or the matching object has no `supplier_id`. Do not fuzzy-match locally, choose among multiple matching objects, rerun ranking, or read an ID from another requirement, platform, or run. The Provider owns matching for names that remain in `supplier_name`.
- Both arrays may be non-empty in the same call when some requested institutions resolve to current rank IDs and others remain names.
- Run [field selection](select_inquiry_form_fields.md) for the exact current requirement when needed. Submission persists the fields in the Provider database; do not retrieve them or carry them through Agent context.

## Recipient cases

1. Every requested institution resolves to a current rank ID: `supplierIds: ["..."]`, `supplier_name: []`.
2. No requested institution resolves to a current rank ID: `supplierIds: []`, `supplier_name: ["..."]`.
3. Mixed resolution: resolved IDs go in `supplierIds`, only unresolved original names go in `supplier_name`; the Provider resolves the union and ensures each requirement/institution pair is sent at most once.

One complete invocation is the real Provider attempt. `MCP_INVALID_PARAMS` proves the business tool did not run. Any ordinary business error, timeout, incomplete response, or unknown result may have partially sent and must not be described as definitely unsent. A Provider operation or distribution reference proves task creation; only explicit per-supplier `sent` evidence proves delivery.

## Remote arguments

- Required: `requirement_id` (string), `supplierIds` (string[]), `supplier_name` (string[]), `description` (non-empty string), `wechat_notification_message` (non-empty string).
- Do not pass `columns`; the Provider resolves the persisted selection from `requirement_id`.
- Pass all five arguments directly at the top level, never under `payload`. Both recipient arrays must be present, an empty side is `[]`, and at least one side must contain a real value. Complete and cross-check the call once; do not use repeated calls as a form validator.

## Local constraints

- `requirement_id` equals the bound value; `supplierIds` and `supplier_name` contain only the current inquiry's recipients and are not both empty.
- In a multi-platform case, use only the current child workflow's bound requirement ID, suppliers, and body. The Provider must resolve that requirement's persisted field configuration; never consume another platform's evidence.
- The Agent performs only the exact current-rank name-to-`supplier_id` reuse described above. The plugin does not query the supplier library, fuzzy-match, preview, block, confirm, deduplicate, or keep transient send state. The Provider remains the sole authority for unresolved institution-name matching and `(requirement_id, supplier)` idempotency.
- Both `description` and `wechat_notification_message` are required. Never pass `null`, a blank string, or placeholders such as `询价` or `请报价` that do not explain the requirement.
- Both fields use the same confirmed customer requirements and remain semantically consistent. Include every applicable confirmed project, brand/product, platform/content, creator quantity, price, creator filter, submission deadline, project schedule, and special requirement. Omit absent optional facts; never invent them. Never include the rebate requirement in either field; it stays internal.
- When the requirement manifest derives a reference creator from labeled `originalBrief`/`description` text, the WeCom body must include the exact `参考达人：...` and/or `参考达人链接：...` lines immediately after `合作内容`. Omit an absent value and never infer one reference value from the other.
- `description` is a structured Chinese description suitable for project-detail display. `wechat_notification_message` uses this fixed Chinese skeleton and changes field values only:

  ```text
  【达人询价｜{项目名称}】

  各位合作伙伴好，现有以下达人合作需求，请按要求提报：

  项目名称：{项目名称}
  品牌 / 产品：{品牌名称} / {产品名称}
  投放平台：{小红书或抖音}
  合作内容：{内容要求}
  参考达人：{参考达人昵称}
  参考达人链接：{参考达人链接}
  达人数量：{达人数量}
  价格要求：{价格要求}
  达人要求：
  1. {筛选条件1}
  2. {筛选条件2}

  提报截止：{提报截止时间}
  项目档期：{项目档期}
  其他要求：{其他特殊要求}

  请在提报截止时间前提交符合要求的达人信息及报价，谢谢。
  ```

- Title, salutation, field order, and closing are fixed. Never add freeform copy. The optional brand line accepts `品牌 / 产品：`, `品牌/产品：`, or `品牌：`; delete the entire line when absent. Delete the entire corresponding block when `达人要求`, `项目档期`, or `其他要求` is absent; do not write an empty-value placeholder such as `待定` or `未指定`. When both brand and product are supplied, use `品牌名 / 产品名`; when only one exists, use it directly without an empty slash. Number creator requirements continuously from `1. ` for the actual count.
- Validation supports CRLF/LF, line-edge whitespace, and blank-line-count differences. Preserve the user's original wording and units in field content; never polish, infer, convert, or supplement requirements.
- Before the call, verify the requirement facts covered by both fields item by item. Complete a missing confirmed requirement before calling.
- Put platform budget text only in current-platform `description`. The production schema has no budget field; never construct a legacy field.

## Matching and idempotency results

- Exact name matches are sent immediately. If other names are fuzzy or non-unique, the Provider may have already sent the exact matches before returning candidates.
- Preserve and display the original Provider result, including every successful institution, unresolved name, candidate institution, match rate, and duplicate-send error. Do not replace it with a generic failure summary.
- For fuzzy or non-unique names, call `AskUserQuestion` with only the real returned candidates. After the user selects, create a new call containing only the selected candidate IDs in `supplierIds`, with `supplier_name: []`; exclude every institution already sent by the earlier call.
- When the Provider reports that the current requirement has already sent an inquiry to an institution, show that error and stop retrying that institution.
- A definite `MCP_INVALID_PARAMS` means the Provider tool did not run; reread this card and correct contract-proven arguments once. Other errors or timeouts may have reached the Provider and must not trigger an automatic full-payload retry.

## Successful evidence

- Evidence records distribution, resolved supplier IDs, sent, pending, and failed suppliers plus `all_distributed` and `all_sent`. Only explicit per-supplier `sent` details correlated with the resolved recipients prove sending; generic success or an aggregate list does not.
- A production `distributions.created` row correlated with the returned project and requested supplier proves distribution creation for status synchronization, but `notification_status: queued` or `submission_state.is_sent: false` does not prove sending.
- Synchronization may include every resolved supplier with verified per-supplier distribution-creation evidence, including queued or pending notifications; do not describe those suppliers as sent. Use the Provider-returned IDs for name-resolved institutions. Retrying a fuzzy selection must exclude already successful institutions; duplicate-send errors are terminal for that requirement/institution pair.
- A successful response does not invalidate the persisted field version; later institutional inquiry outputs may reuse it. YPscan links are rendered only in the host conversation and never opened through Browser.

## Stop conditions

Do not resend automatically when the result is unknown. Treat absence of per-supplier details as an unknown result.
