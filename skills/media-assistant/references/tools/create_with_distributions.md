# create_with_distributions

Risk tier: one-time side-effect confirmation (`确认发送`). Provider write plus WeCom distribution.

This is the institutional inquiry creation entry point.

## When to call

Call whenever the user asks to send and the exact recipients, message, and requirement ID are available after field selection has been submitted for that requirement. Construct one complete call and follow the single final authorization flow in [HITL](../hitl.md).

## Recipient and field preparation

Resolve recipients before field selection:

- Map every user-selected agency name only from currently available name/ID results. Absence from a displayed top-N is not absence from the full candidate set or supplier library. Do not rerun `rank_mcns` merely to inspect more rows, promise a nonexistent name-search capability, or inspect plugin files.
- If any recipient cannot be mapped, stop preparation before field selection and offer only executable choices: choose a currently mapped agency or provide an accurate `supplier_id`/system full name.
- After recipients resolve, run [field selection](select_inquiry_form_fields.md) for the exact current requirement when needed. Submission persists the fields in the Provider database; do not retrieve them or carry them through Agent context.

## Send stages

The normal path uses exactly two `create_with_distributions` invocations and one user confirmation:

1. The first complete invocation generates one preview containing the institution list (name and ID) and full message. `HITL_REQUIRED` includes both `ASK_USER_QUESTION_ARGS` in the block text and the structured `askUserQuestion` payload.
2. The Hook-generated `AskUserQuestion` with `确认发送 / 取消` is the only user confirmation; it does not send by itself. The immediate retry with the exact unchanged arguments is the first real Provider send attempt.

After the real attempt, `MCP_INVALID_PARAMS` proves the business tool did not run. Any ordinary business error, timeout, incomplete response, or unknown result may have sent and must not be described as definitely unsent. A Provider operation or distribution reference proves task creation; only explicit per-supplier `sent` evidence proves delivery.

## Remote arguments

- Required: `requirement_id` (string), `supplierIds` (string[]), `description` (non-empty string), `wechat_notification_message` (non-empty string).
- Do not pass `columns`; the Provider resolves the persisted selection from `requirement_id`.
- Treat all four arguments above as required even if the live MCP schema displays `description` or `wechat_notification_message` as optional or nullable. Pass them directly at the top level, never under `payload`. Complete and cross-check all four before the first invocation; do not use repeated tool calls as a form validator.

## Local constraints

- `requirement_id` equals the bound value and `supplierIds` is non-empty.
- In a multi-platform case, use only the current child workflow's bound requirement ID, suppliers, and body. The Provider must resolve that requirement's persisted field configuration; never consume another platform's evidence.
- The in-memory confirmation binds the exact complete client payload, which excludes `columns`.
- The Hook retains the current `rank_mcns` name/ID mapping per conversation scope for 24 hours, independently of the 10-minute send grant. If any requested ID lacks a verified non-empty name, it blocks before creating the confirmation instead of displaying an unknown-name fallback.
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
The confirmation interaction follows [HITL](../hitl.md). It binds final authorization to the unchanged payload for ten minutes and one use. Confirmation state is in memory and survives host run rollover within the same Gateway process; Gateway restart invalidates it.

## Local block codes

- `INVALID_INPUT` / `LOCAL_RESTRICTION`: execute the supplied `read` recovery, rebuild and recheck all four arguments together, then make at most one corrected preflight call.
- `INQUIRY_RECIPIENT_NAME_MISSING`: stop; an institution ID cannot be mapped uniquely to its displayed name.
- `HITL_REQUIRED` / `GRANT_EXPIRED`: call the supplied `AskUserQuestion` unchanged. Retry the exact original arguments only after authorization.
- `RESULT_UNKNOWN_RETRY`: verify whether the original action took effect; retry only after the user confirms it did not.
- A definite `MCP_INVALID_PARAMS` means the Provider tool did not run; reread this card and correct contract-proven arguments once. Other errors or timeouts may have reached the Provider.

## Successful evidence

- Evidence records distribution, sent, pending, and failed supplier IDs plus `all_distributed` and `all_sent`. Only explicit per-supplier `sent` details correlated with requested `supplierIds` prove sending; generic success or an aggregate list does not.
- A production `distributions.created` row correlated with the returned project and requested supplier proves distribution creation for status synchronization, but `notification_status: queued` or `submission_state.is_sent: false` does not prove sending.
- Synchronization may include every supplier with verified per-supplier distribution-creation evidence, including queued or pending notifications; do not describe those suppliers as sent. Retrying or replacing a failed distribution requires new confirmation.
- A successful response does not invalidate the persisted field version; later institutional inquiry outputs may reuse it. YPscan links are rendered only in the host conversation and never opened through Browser.

## Stop conditions

Do not resend automatically when the result is unknown. Treat absence of per-supplier details as an unknown result.
