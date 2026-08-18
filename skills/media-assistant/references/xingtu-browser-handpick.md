# 星图 Playwright CLI 人工拓展

只有完成 `ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns`、输出完整 MCN Markdown 表格和本地路径，并由用户选择“人工拓展并提报”后，才进入本流程。

## 最小 SOP

1. 调用 `ypscan_manual_research(operation=start, requirement_id, platform=xingtu, facts, keywords)`。读取返回的 `run_id`、`hard_requirements` 和固定 `playwright_session=ypscan`。
2. 读取并使用 YP Action 自带 playwright 技能，通过 `playwright_cli.sh` 操作该 session。未打开时以 `--headed --persistent` 原样打开 `start.target_url`，其值必须是 `https://www.xingtu.cn/ad/creator/market`；禁止自行搜索、猜测或替换入口，禁止使用 `star.jinritemai.com`、`buyin.jinritemai.com` 或 `https://www.xingtu.cn/` 首页，禁止调用宿主原生 Browser。
3. 先 snapshot 整页并等待重定向稳定。若有带明确关闭按钮的阻塞弹窗（包括 `review-wrapper` 普通公告/提示），优先直接 click 关闭并重新 snapshot，不必先读取完整内容或先 goto；出现登录、全局验证码或安全验证信号时不得关闭或绕过。随后确认 URL、页面内容和筛选区都属于星图达人广场；仅当关闭弹窗后仍明确不在目标页面时才 goto `start.target_url`。
4. 首关键词先完成全部页面可表达硬筛，关键词最后提交；后续关键词保留筛选集、只换关键词。先执行 `start` 返回的 `selection_plan.batches`：每个菜单入口在最新 snapshot 后原样执行一次 `playwright_run_code`，执行后重新 snapshot；只重试 `unresolved_paths` 一次。`fallbacks`、动态项或仍失败路径再按当前页面逐层观察。硬条件没有精确可见选项时不得用近义项替代（例如不能把“职场”静默替换成“职场趣闻”），应记录未表达并转详情语义硬复核。其他菜单开关、输入提交、导航、分页或详情切换后也必须重新 snapshot，旧 ref 不得复用。
5. 达人报价必须分别操作“报价类型”和“报价区间”：先切换并回读正确时长档，需求是 60s+ 时必须确认“60s以上视频”和列表表头，绝不能保留默认“21-60s视频”；再按 `range_execution_plan` 选择报价区间预设档。不要把自定义输入作为必经路径，也不要把报价输入误认成 CPM。工具会按 `creator_price.min/max` 做行级精确二次硬筛；例如目标 10000–24000 时，页面稳定选择 `1w-5w` 召回，超过 24000 的行在落盘前自动淘汰。1–20 秒、21–60 秒、60 秒以上不得跨档借价。
6. 其他数值范围也按 `range_execution_plan.preset_rounds` 分轮召回，每轮在 `filter_evidence` 记录实际档位，最后由工具按行可见值做精确二次硬筛并稳定 ID 去重。开放上界必须跑完所有相交档位：例如粉丝 `≥10w` 依次覆盖 `10w-100w`、`100w-300w`、`300w-500w`、`500w-1000w`、`1000w以上`，全部完成后才能把该关键词标为 complete。自定义输入仅是可选优化，失败一次立即回到预设档方案，不反复调试。
7. 每个稳定结果页用限定作用域的 run-code 读取 `source_url`、`page_number`、`price_tier` 和同一行关联的 `rows`，传给 `capture_list`。工具会拒绝错误报价档位，并在候选落盘前剔除报价、粉丝量等列表可见硬筛失败行，淘汰原因单独保留。翻页继续由 Playwright CLI 完成；最后一页可直接以 `keyword_complete=true` 提交。若最后一页此前已提交，允许用 `rows=[]` 只标记完成；这不会追加空页或覆盖已有候选。
8. 按当前运行候选打开详情，用 run-code 读取当前 URL 和可见证据字段，传给 `capture_detail`。昵称或星图 ID 搜索只用于定位当前候选，不得另建名单；单个详情不可访问时记录并继续。
9. 列表和详情完成后调用 `finalize`。处理返回的 `review_batch`，分批调用 `apply_reviews` 直到 `review_remaining=0`，再按用户选择生成提报表。

## 动态控件与证据规则

- 命中稳定 schema 的级联使用 `selection_plan` 中限定目标容器的批量 run-code；同一菜单入口的多路径只打开和确认一次。星图同一筛选行存在多个一级入口时按入口拆成不同 batch。返回 `partial` 时保留 `selected_paths`，只处理 `unresolved_paths`，不得重复点击成功路径。
- 未命中 schema 的动态级联优先用 Playwright 的 snapshot、hover、click、fill。显式动作不足时才自行编写限定目标容器的 run-code；每次动作后必须回读选中值和结果变化。
- 多层路径逐层绑定父项与新出现的子列；同名项不能仅按第一个匹配。范围输入填入后逐个回读 input value，再提交外层筛选。
- 列表候选按星图 ID 或稳定主页链接去重。价格或列表硬条件失败者不得推荐；证据缺失写“未知”或“待商务确认”，人数不足如实报告缺口。
- 不读取或保存 Cookie、Token、请求头、签名和原始私有响应，不主动重放私有 API，不触发平台原生导出。
- 普通弹窗、重定向、筛选复位和定位失败由 Agent 在同一 session 内最多换策略恢复两次；只有全局登录、验证码或安全验证阻断整个平台时才调用 `AskUserQuestion`。
