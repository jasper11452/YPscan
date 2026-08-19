# ypscan_manual_research

产物优先的双平台手扒 Runner。浏览器交互由插件内专用持久 Chrome 完成，Agent 不得调用 Browser、Bash、Playwright CLI 或旧快照协议。

## 操作

1. `start`：传 `requirement_id`、`platform`、完整 `facts` 和 1–4 个 `keywords`，可选 `quote_type`、`fresh_run=true`。星图 `quote_type` 只支持“植入视频/定制视频”，蒲公英支持“图文/视频”（兼容“图文笔记/视频笔记”）。单次运行只允许一种报价类型；同一次调用创建 run、先写初始 Excel，再有界执行筛选、降级、分页，并以成功详情数为准补位到 `min(需求人数, 10)`。
2. `resume`：仅在 `needs_user_action` 或 `busy` 后原样使用返回的 `resume_args`。
3. `apply_reviews`：可选；每批写回 1–20 条详情语义复核。
4. `create_submission`：可选；只使用详情硬条件通过且明确纳入的达人。

公开入口没有 `capture_list`、`capture_detail`、`finalize`、`collect`、`selection_id`、`page_url` 或 `original_brief`。

## 结果

- `complete`：已取得目标数量的完整详情；详情目标为 `min(需求人数, 10)`。
- `partial`：已有候选，但完整详情未达到目标，或因时间预算、异常提前结束。不得把“尝试过 10 位”表述为“已取得 10 位详情”。
- `empty`：所有真实抓取和降级均耗尽，仍无候选。
- `needs_user_action` / `busy`：先交付当前 Excel，再按用户选择使用 `resume_args`。
- `failed_with_artifact`：运行异常但已有可交付 Excel。

结果中的 `detail_progress` 必须按 `target / attempted / completed / partial / failed / shortfall` 如实展示；`detail_failures` 给出失败达人、阶段、错误码、脱敏消息和耗时。普通资质提示即使遮挡页面，也先读取已返回的网络响应和页面 DOM；真实验证码不关闭、不绕过，保存已采集证据后返回 `needs_user_action`。

所有上述状态都必须展示真实 `artifact.excel_path`。Excel 含“达人推荐List”“候选达人”“运行说明”，达人表独立展示“报价类型”；蒲公英“全部报价（起）”不得作为图文或视频精确报价验收。未验证、硬条件失败或降级召回者不得进入推荐表。终态 `resume` 只读取并校验原 Excel，不得重新生成。旧报价语义的有价断点不可续跑，需重新 `start`；无报价旧断点仍可恢复。只有初始 Excel 无法写入时才允许无产物 `failed`。
