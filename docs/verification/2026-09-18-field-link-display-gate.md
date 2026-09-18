# 字段页链接未展示：真实失败样本与展示门禁

## 问题

`select_inquiry_form_fields` 返回 `selection_required`/`opened` 字段页 URL 时，模型有时只在正文写“字段页已生成”就调用 `get_inquiry_form_fields_status` 轮询，不把链接展示给用户。`FIELD_SELECTION_URL` 已在同一工具结果里注入，所以不是解析或注入问题，而是模型在工具调用压力下跳过了展示这一步。

## 真实样本（本机 YP Action 会话）

目录：`~/Library/Application Support/YP Action/openclaw/state/agents/main/sessions/`

- `aa6c13f3-36a0-49f6-b312-c0cca4e37d3c.jsonl`（2026-09-15T02:48:32，`ypmcn__` 真实 Provider，requirement `a29b5862...`）：`select_inquiry_form_fields` 返回 `status=opened`、URL、`browser_launch_requested=false`、`message="未能自动打开浏览器，请直接打开 url。"`；模型回复 “Field page generated. Prechecking submission status.” 后直接调用状态工具，约 3 秒后才在下一轮补出链接。
- `895a9d91-801e-4fc4-9c10-1ed874cb0db1.jsonl`（2026-09-16T07:41:53，test adapter）：整场会话从未输出链接，模型写 “A field-selection page is open.”，5 次状态查询后返回 `submitted`，直接进入 `manual_source_creators`。
- 统计本机会话目录：93 次 `select_inquiry_form_fields` 调用中 9 次在下一次回复直接调 `get_inquiry_form_fields_status` 且正文无 URL，其中 3 场会话整场从未出现该链接；跨 Deepseek-V4-Flash/Pro、GPT-5.6-Luna、gpt-5.6-sol。

`browser_launch_requested=false` 表示 Provider 没有在用户机器上打开页面；宿主也没有可验证的外链打开能力，正文链接是唯一入口，因此漏输出等于用户无法选择字段，链路可能按旧配置继续。

## 已实施修复

- `src/hooks/register-flow-directives.js`：生成可轮询字段页时按 requirement 登记待展示 URL；`before_tool_call` 对链接未展示前的首次 `get_inquiry_form_fields_status` 返回 `block:true` + `YPSCAN_FIELD_PAGE_LINK_NOT_SHOWN` 与 URL，只阻断一次；`unavailable` 轮询指令在链接待展示时回带一次 URL；`submitted`/`invalid` 或网关启停时清理。Provider 查询次数与恢复判定不变。
- 指令文本去掉“说明是否已自动打开”的诱导，明确要求正文单独一行原样输出 URL；自动打开失败时不得说“页面已打开”，要让用户自己打开。
- `force_reselect`/继承不登记该门禁（这两条路径本来就禁止轮询）。
- 同步 `skills/media-assistant/SKILL.md`、两张字段工具卡、`docs/spec/flows.md`、`docs/spec/hooks.md` 与 `docs/review-checklist.md`。

## 可重复判据与限制

- 代码层：`tests/flow-directives.test.mjs` 覆盖阻断一次、重试放行、轮询回带 URL、重选/继承不登记、宿主重启清理；`tests/hard-controls.test.mjs` 覆盖展示指令文本与长度上限。
- 模型行为层：尚无自动跑批。复现判据是“`select_inquiry_form_fields` 返回字段页 URL 后，第一次 `get_inquiry_form_fields_status` 前正文必须已含该 URL”；用上面的真实样本重放，或按 [开发与验证](../wiki/development.md) 记录模型标识、输入和完整工具轨迹。
- 真实宿主层：桌面端正文渲染、字段页提交后的恢复仍需重新验收；本记录不声称已完成桌面验收。
