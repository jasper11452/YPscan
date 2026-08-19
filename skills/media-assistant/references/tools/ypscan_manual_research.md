# ypscan_manual_research

产物优先的双平台手扒 Runner。浏览器交互由插件内专用持久 Chrome 完成，Agent 不得调用 Browser、Bash、Playwright CLI 或旧快照协议。

## 操作

1. `start`：传 `requirement_id`、`platform`、完整 `facts` 和 1–4 个 `keywords`，可选 `fresh_run=true`。同一次调用创建 run、先写初始 Excel，再有界执行筛选、降级、分页和有限详情。
2. `resume`：仅在 `needs_user_action` 或 `busy` 后原样使用返回的 `resume_args`。
3. `apply_reviews`：可选；每批写回 1–20 条详情语义复核。
4. `create_submission`：可选；只使用详情硬条件通过且明确纳入的达人。

公开入口没有 `capture_list`、`capture_detail`、`finalize`、`collect`、`selection_id`、`page_url` 或 `original_brief`。

## 结果

- `complete`：Runner 正常达到候选池目标或耗尽计划。
- `partial`：已有候选，但因时间预算或异常提前结束。
- `empty`：所有真实抓取和降级均耗尽，仍无候选。
- `needs_user_action` / `busy`：先交付当前 Excel，再按用户选择使用 `resume_args`。
- `failed_with_artifact`：运行异常但已有可交付 Excel。

所有上述状态都必须展示真实 `artifact.excel_path`。Excel 含“达人推荐List”“候选达人”“运行说明”；未验证、硬条件失败或降级召回者不得进入推荐表。只有初始 Excel 无法写入时才允许无产物 `failed`。
