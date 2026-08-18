# 对外动作预检与确认

## 业务路径

达人筛选固定先完成 `ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns`，再展示完整 MCN Markdown 表格和真实本地路径，最后用 `AskUserQuestion` 选择“询价机构”或“人工拓展并提报”。`creators_export_path` 只作为保存工具参数，不向用户输出下载链接。这条顺序是静态行为指令，不是额外状态机或权限门禁。

选择人工拓展后，Agent 使用 YP Action Playwright CLI 的固定 `ypscan` session 操作星图或蒲公英，禁止调用宿主原生 Browser。平台登录、全局验证码、暂停或结束只通过 `AskUserQuestion` 等待用户；普通页面错误由 Agent 自主恢复，成功交付时不弹完成确认。

## 一次最终确认

正式 `create_with_distributions` 调用仍由现有 Hook 在 Provider 前阻断，创建十分钟有效的一次性内存 challenge。Agent 必须原样调用返回的宿主 `AskUserQuestion` 参数；用户确认后仅原样重试一次，确认不代表送达。

修改接收人、正文、模板、账号或需求参数，或确认过期，都要重新确认。取消、拒绝、关闭、超时或回调错误时不得发送。除这一次企微外发确认外，本流程不新增权限门禁、hash/checksum 或额外防御性校验。

## Provider 询价

用户选择“询价机构”后，继续使用真实 MCN 名称/ID 和现有字段选择、询价工具链。Provider 返回 Excel 下载 URL 时，使用 `ypscan_save_excel_artifact` 保存并交付真实 `file_path`；Browser 人工拓展不调用该下载工具，而由 `ypscan_manual_research` 直接增量保存 checkpoint 并生成本地 Excel。
