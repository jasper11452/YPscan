# 蒲公英 Browser 人工拓展

只有完成 `ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns`、输出完整 MCN Markdown 表格并展示本地路径，再在 `AskUserQuestion` 中选择“人工拓展并提报”后，才进入本流程。不得向用户输出达人预览表下载链接。

## 最小 SOP

1. 先用宿主 Browser 直接打开蒲公英达人广场 `https://pgy.xiaohongshu.com/solar/pre-trade/note/kol`，不得先打开首页、工作台或其他中转页；页面打开后调用 `ypscan_manual_select_filters`。仅当返回 `ready_for_collection=true` 时，原样使用 `collection_args` 调用 `ypscan_manual_research`。
2. 首次选择传当前 `requirement_id`、`platform=pgy`、精简 `facts` 和可选关键词；后续关键词原样使用 `next_selection_args`。选择工具严格先提交关键词，再应用博主类目、人设、性别、地域、粉丝量与画像、合作报价、CPM、笔记类型等高级筛选。
3. 工具按同一表格行关联字段、逐页读取并按平台 ID 去重。只有浏览器响应与 DOM 结果仍不足、关键字段完全缺失或列表读取异常时，整次运行最多触发一次蒲公英原生文件导出；导出不是起始步骤，也不按关键词分支重复执行。`partial` 且带 `next_branch` 时按其 `branch_index` 显式续跑，Agent 保留并合并前后两次真实结果；导出 fallback 导致的 `partial` 不得重复调用工具消耗次数。
4. 逐个阅读导出文件中的博主链接、主页、近期笔记、商业样本、粉丝与报价证据，按客户需求由 Agent 做最终相关性判断。达人报价以客户值为锚点按 50%–120% 硬筛（如 10 万以内 → 5 万–12 万），不用 Provider 70%–120% 区间；图文报价与视频报价必须读取对应合作形式，禁止互换。
   昵称或小红书 ID 搜索只用于定位工具已返回的 `detail_tasks`，不得绕过候选池另建名单。`price_check.status=rejected` 不得推荐；合格人数不足时如实报告缺口。
5. 每页候选都会写入本地 checkpoint，同计划自动续跑。最终必须展示 `artifact.excel_path`；目标超过 20 人时，对话只给摘要和最多 10 条预览，完整目标名单与候选池交付 Excel。该本地 Excel 与平台原生导出无关，不消耗蒲公英额度。

### 蒲公英级联与复合筛选

1. 博主类目、人设、地域等多层菜单必须按完整路径逐层 hover；每层子列需相对操作前新增或变化，并连续三次快照稳定后才能进入下一层。
2. 同一浮层出现多个同名选项时不得取第一个；无法借父级路径和列位置唯一定位就返回未提交。
3. 合作报价先锁定当前图文/视频 `.filters-item`，再打开该项自己的区间菜单。新增浮层连续稳定后才进入“自定义”，上下限逐个填入并回读 input value。
4. 一个未缩小范围的菜单若同时出现超过两个可编辑数字输入，视为多个区间组歧义，禁止填写。

报价必须使用对应合作形式的真实字段；粉丝性别不能替代达人本人性别。证据缺失写“未知”或“待商务确认”，不补历史数据。

只有登录失效、真实 CAPTCHA 或确实需要用户做业务选择时才调用宿主 `AskUserQuestion`。页面未打开、普通弹窗、native 浮层异常、筛选复位和参数问题由 Agent/工具直接处理；单分支有限恢复仍失败则记录并继续其他关键词，不要求用户刷新或关弹窗。不得索取或代填密码、验证码、Cookie、Token，也不得绕过风控。
