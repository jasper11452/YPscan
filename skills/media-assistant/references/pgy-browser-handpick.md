# 蒲公英 Playwright CLI 人工拓展

只有完成 `ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns`、输出完整 MCN Markdown 表格和本地路径，并由用户选择“人工拓展并提报”后，才进入本流程。

## 最小 SOP

1. 调用 `ypscan_manual_research(operation=start, requirement_id, platform=pgy, facts, keywords)`。读取返回的 `run_id`、`hard_requirements` 和固定 `playwright_session=ypscan`。
2. 读取并使用 YP Action 自带 playwright 技能，通过 `playwright_cli.sh` 操作该 session。未打开时以 `--headed --persistent` 打开 `https://pgy.xiaohongshu.com/solar/pre-trade/note/kol`；禁止调用宿主原生 Browser。
3. 先 snapshot 整页并等待重定向稳定。必须同时确认 URL、页面内容和筛选区都属于蒲公英达人广场，才关闭可安全关闭的普通弹窗并开始筛选；登录、全局验证码和安全验证不得关闭或绕过。
4. 首关键词完成全部页面可表达硬筛后再提交关键词，后续关键词保留筛选集、只换关键词。菜单开关、输入提交、导航、分页或详情切换后都重新 snapshot，旧 ref 不得复用。无法稳定表达的条件记录为未验证并转入详情硬复核。
5. 合作报价必须锁定正确图文/视频筛选组，填入区间后逐项回读；两种合作形式不得互换。以客户原始值为锚点按 50%–120% 验收，不使用 Provider 的 70%–120% 搜索区间。
6. 每个稳定结果页用限定作用域的 run-code 读取 `source_url`、`page_number`、`price_tier` 和同一行关联的 `rows`，传给 `capture_list`。翻页继续由 Playwright CLI 完成；关键词结束时用 `keyword_complete=true` 记录最终筛选证据。
7. 按当前运行候选打开详情，用 run-code 读取当前 URL 和可见证据字段，传给 `capture_detail`。昵称或小红书 ID 搜索只用于定位当前候选，不得另建名单；单个详情不可访问时记录并继续。
8. 列表和详情完成后调用 `finalize`。处理返回的 `review_batch`，分批调用 `apply_reviews` 直到 `review_remaining=0`，再按用户选择生成提报表。

## 动态控件与证据规则

- 类目、人设、地域等级联菜单逐层 hover，并把父项与新出现的子列绑定；同名项不能仅按第一个匹配。
- 一个未缩小范围的菜单若出现多个区间组，必须先由可见标题和当前合作形式消除歧义，无法唯一定位就不提交并转入详情复核。
- 列表候选按平台 ID 或稳定主页链接去重。粉丝性别不能替代达人本人性别；价格或列表硬条件失败者不得推荐；证据缺失写“未知”或“待商务确认”。
- 不读取或保存 Cookie、Token、请求头、签名和原始私有响应，不主动重放私有 API，不触发平台原生导出。
- 普通弹窗、重定向、筛选复位和定位失败由 Agent 在同一 session 内最多换策略恢复两次；只有全局登录、验证码或安全验证阻断整个平台时才调用 `AskUserQuestion`。
