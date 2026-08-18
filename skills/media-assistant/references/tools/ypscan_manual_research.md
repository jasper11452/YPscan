# ypscan_manual_research

人工拓展的数据与产物工具。浏览器交互由 Agent 使用 YP Action Playwright CLI 完成；本工具不执行 shell、不连接宿主 Browser，也不会自行读取 Playwright session。

## 固定操作

1. `start`：传 `requirement_id`、`platform`、完整 `facts` 和 1–4 个 `keywords`，可选 `fresh_run=true`。返回 `run_id`、固定 `playwright_session=ypscan`、目标 URL、`hard_requirements`、稳定级联的 `selection_plan` 和快照字段要求。
2. `capture_list`：传同一 `requirement_id/platform/run_id`、当前 `keyword`、`keyword_complete`、Playwright run-code 读取的 `list_snapshot`，以及可选 `filter_evidence`。`list_snapshot` 至少包含当前 `source_url` 和同一列表行关联的 `rows`。
3. `capture_detail`：传同一运行、`candidate_ref` 和当前详情页的 `detail_snapshot`；快照至少包含 `url` 与可见 `fields`。单个详情失败时记录后继续，不用历史数据补齐。
4. `finalize`：传同一运行，生成或刷新 checkpoint 与 Excel，并返回待复核批次、缺口和产物路径。
5. `apply_reviews`：每批传 1–20 条 `candidate_ref`、`decision=include|exclude`、非空 `reasons` 和 `evidence`。持续处理到 `review_remaining=0`。
6. `create_submission`：只在用户选择直接生成提报表后调用，传同一运行，产物只包含本轮最终纳入达人。

公开入口没有 `collect`、`selection_id`、`page_url`、`original_brief` 或独立筛选工具。不得猜测或构造这些旧参数。

## Playwright 快照边界

- 使用返回的固定短 session 和 `target_url`。未打开时以 `--headed --persistent` 原样打开 `target_url`；禁止自行搜索、猜测域名或改用平台官网首页，禁止调用宿主原生 Browser。星图的 `target_url` 固定为 `https://www.xingtu.cn/ad/creator/market`。
- 页面发生导航、菜单开关、输入提交、分页或详情切换后必须重新 snapshot；ref 只属于最新 snapshot。
- snapshot 中出现带明确关闭按钮的阻塞弹窗时，优先直接 click 关闭并重新 snapshot；`review-wrapper` 等普通公告/提示不必先读取完整内容或先 goto。若出现登录、验证码或安全验证信号则不得关闭。
- 先处理 `selection_plan.batches`：每个 batch 在最新 snapshot 后原样执行 `playwright_run_code`，同一菜单入口的多路径只打开和确认一次；随后重新 snapshot，并回读 `selected_paths`、`unresolved_paths`、已选条件和结果变化。只重试失败路径一次，`fallbacks` 与动态项再按当前页面探索。
- 其他常规交互优先使用 snapshot/click/hover/fill。goto 仅用于首次打开 session，或关闭弹窗并重新 snapshot 后仍明确不在目标达人广场的恢复场景。只有动态级联或 teleported 浮层无法表达时才自行编写限定目标容器的 run-code，并回读提交结果。
- `capture_list` / `capture_detail` 只接受当前页面真实可见或页面自身加载得到的结构化证据。`capture_list` 会拒绝与 `plan.price_view` 不一致的报价档位，并在候选落盘前剔除报价、粉丝量等列表可见硬筛失败行；淘汰项及原因单独记录。不得读取 Cookie/Token，不主动重放私有 API，不保存原始响应或敏感头。
- 数值硬筛按 `start.range_execution_plan` 使用稳定预设档分轮召回，每轮通过 `filter_evidence` 记录实际档位，再由工具按列表行可见值执行精确二次硬筛。开放范围必须跑完所有 `preset_rounds`，不得只选一个有限档位。自定义输入仅为可选优化，失败一次就回退到预设档，不作为正确性的依赖。硬条件没有精确可见选项时不得选择近义项“将就”，应保留为未表达并进入详情硬复核。
- 最后一页可以直接带 `keyword_complete=true` 提交。若此前已经提交最后一页，可再传 `rows=[]` 仅完成关键词；工具不会追加空页面事件，也不会覆盖既有候选。
- 登录、全局 CAPTCHA 或安全验证返回 `needs_user_action`，必须用 `AskUserQuestion`。普通重定向、弹窗、旧 ref 和定位失败由 Agent 在同一 session 内重新 snapshot 并换策略恢复。

## 交付规则

候选按平台稳定 ID 或详情链接去重；同名但没有稳定身份的记录不自动合并。价格以客户原始事实为锚点按 50%–120% 验收并绑定正确合作形式或时长档；价格及其他硬条件失败者不进入推荐名单。证据不足必须标为缺口，人数不足如实报告。

每次采集增量写入当前项目的 `checkpoint.jsonl`。Excel 只含“达人推荐List”和“候选达人”两个 Sheet；最终纳入者写入前者，完整候选池写入后者。结果只来自当前需求、平台和 run，不与历史记录混用。
