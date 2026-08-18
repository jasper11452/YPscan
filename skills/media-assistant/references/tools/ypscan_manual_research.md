# ypscan_manual_research

人工拓展抓取阶段。必须先由 `ypscan_manual_select_filters` 完成当前关键词筛选并取得 `run_id/selection_id`；本工具先只读复核筛选状态，再执行“列表采集 → 详情页被动响应采集 → 本地精筛 → Agent 分批复核 → 同一 Excel”。本工具不得重置、搜索或修改页面筛选。

必填参数：

- `requirement_id`：当前真实 Provider 需求 ID。
- `platform`：`xingtu` / `douyin` 或 `pgy` / `xiaohongshu`。
- `run_id`、`selection_id`：原样使用选择工具的 `collection_args`。

可选参数：

- 当前分支完成但仍需其他关键词时，响应为 `awaiting_filter_selection`；把 `next_selection_args` 原样调用选择工具。

复核写回参数：

- 抓取使用选择工具返回的 `operation=collect`。最终详情完成后返回最多 20 条 `review_batch`。
- Agent 结合原始需求、详情字段和最多 3 条近期内容，生成 `candidate_ref`、`decision=include|exclude`、`reasons`、`evidence`。
- 用 `operation=apply_reviews`、当前 `requirement_id`、`platform`、`artifact.run_id` 和 `reviews` 调回工具；每批最多 20 条，持续处理下一批直到 `review_remaining=0`。

直接向本工具传 facts/keywords/page_url/original_brief 属于旧一体化调用；工具返回 `YPSCAN_MANUAL_SELECTION_REQUIRED` 和 `selector_args`，且不会连接 Browser。完整原文由 Agent 保留用于语义复核。

响应 `status`：

- `complete`：所有本次分支完成采集与导出。
- `awaiting_filter_selection`：当前关键词抓取完成；原样调用 `next_selection_args`。
- `partial`：返回了真实候选或可审计的分支失败；读取 `failed_branches` / 导出状态继续，不要求用户处理普通 UI。
- `failed`：达人广场打开失败、参数或其他 Agent 可修复问题；修正参数后做一次有界重试，不自行打开其他页面，也不调用 `AskUserQuestion`。
- `needs_user_action`：只用于登录失效或真实 CAPTCHA；必须调用 `AskUserQuestion`。

`needs_user_action` 会同时给出 `user_action.resume_tool`、`user_action.resume_args` 和 `interruption.phase`。用户完成验证后必须原样调用这些恢复参数：列表阶段返回同一关键词的筛选参数，详情阶段返回同一 run/selection 的 collect 参数；不得根据 `next_branch` 猜测恢复位置。

每个分支返回已验证筛选、结果数、页数、页面摘要和导出结果。顶层候选按平台 ID 合并，缺 ID 时只按详情链接合并；没有稳定身份的同名记录不会自动合并。每页结果都会增量追加到当前项目的 `checkpoint.jsonl` 并强制落盘；同一 run 从选择工具建立的计划恢复。响应最多携带 20 条候选与 20 条详情任务预览，完整记录读取 `artifact.checkpoint_path` 或 `artifact.excel_path`。

价格计划由选择工具从客户原始事实编译，达人单价独立扩展为客户值的 50%–120%；抓取工具只按 checkpoint 中的同一计划验收候选，不重算区间或报价口径。

响应同时返回报价初筛和列表硬筛两组统计与 `delivery_shortfall`。CPM、粉丝等列表证据一旦失败即在详情前淘汰；字段缺失只能标记待补证。`price_check.status=rejected` 或 `list_hard_evaluation.status=fail` 不进入目标名单或详情任务，不得推荐。人数不足时必须报告缺口，不能用硬条件失败者凑数。昵称/平台 ID 搜索只用于定位响应中已有的 `detail_tasks`。

工具会自动关闭已知普通弹窗，并对普通页面跳转/响应失败执行一次有限恢复；详情出现 401/403/429 或安全验证时立即暂停且不重试。工具严格串行打开当前账号可见的详情页，在点击/切换前注册响应监听，只归一化页面真实 XHR/fetch 的字段和 pathname；不主动重放私有 API，不保存原始响应、Cookie、请求头或签名。每个达人完成后追加 checkpoint 并原子刷新同一个 Excel；工作簿按正式达人推荐 List 模板排版，只含“达人推荐List”和“候选达人”两个 Sheet，最终纳入者写入前者，完整候选池集中写入后者。此本地产物不消耗平台导出额度。工具不登录、不关闭宿主 Browser，也不代替 Agent 做语义判断。

详情页不会假设数据只位于固定 Tab。工具先读取首屏证据，再按当前缺失字段组观察可见 tab、button、menuitem、option 和带 `aria-haspopup/aria-expanded` 的控件；每次只对语义相关且无提交、发送、支付等副作用的控件执行真实 hover/click，并在动作后重新观察页面，因此可以逐层进入动态挂载的级联菜单。动作必须产生响应、正文或菜单状态变化才记为有效，每个字段组有固定探索预算；仍未取得证据时返回 `missing_groups` 和脱敏的 `navigation` 审计记录并标为 `partial`，不得猜值或把任意字段存在误报为详情完整。

近期内容只接受真实作品卡片或页面动作产生的作品响应，达人清单、用户协议和全局导航不得作为内容证据。城市、人群画像或近期内容等复核证据缺失时，`review_batch.evidence_gaps` 会明确列出缺口，Agent 不得提交 `include`。
