# 固定业务链路

业务行为权威是 `skills/media-assistant/SKILL.md`；本文件描述链路的事实形态与关键约束（Hook 指令在 [hooks.md](./hooks.md)）。

## 1. 业务模式确定

- 用户明确表达 → 直接采用（`询价机构`：询价机构/机构询价/MCN 询价；`手动拓展`：手动拓展/人工拓展/直接手扒/手扒/手捞筛选）。
- 未明确、同时出现两种或语义冲突 → `AskUserQuestion`（选项固定两模式），回答前不解析、不落库。
- 模式决定本次新建 requirement 进入的功能；`手动拓展` 在 Provider 出站边界映射为兼容线值，Agent 不得改写。

## 2. 建需与复核（两功能共用）

`ypscan_parse_requirement → 复核 → validate_requirement`

- 每次真正开始新功能都重新解析、复核、创建独立 requirement；同会话、同平台、条件未变也不跨功能复用 requirement 或已提交字段配置；两功能不得并行或中途切换。
- 复核对照三份内容：用户当前完整有效需求、本次 `data.outputs`、即将发送的 `validate_requirement` 参数；至少检查模式、平台、品牌、数量、截止时间、内容形式、抖音植入/定制类型、粉丝、返点、报价档位、`contentTag`、可选标签、多达人类型是否仍为一个 requirement、是否混入其他平台或旧需求值。
- 检查正确直接落库；发现错误按原需求纠正后重新解析（不算放宽）；歧义用一次 `AskUserQuestion` 收集全部不确定字段，禁止逐字段分轮弹窗；同一字段已确认的澄清答案在本会话后续轮次与 requirement 重建时直接复用，不再重复确认，等价时间表述（今晚8点前/今晚20:00/当天20:00:00）归一为同一值。
- 需求 ID 优先 `data.requirement_id`，缺失兼容 `data.id`，绝不使用 `data.demand_id`。

## 3. 询价机构链路

```text
validate_requirement → search_creators → rank_mcns → 输出五列表格
→ ypscan_save_artifact(mcn_ranking) → 选择收件机构 → select_inquiry_form_fields（已提交则复用）
→ 发送确认弹窗 → create_with_distributions
→ 回收：sync_mcn_inquiry_status(requirement_id, project_id, supplierIds) → 用返回的 inquiry_ids 直接 ingest_mcn_submissions
→ get_ingest_job（轮询至 succeeded/partially_succeeded）
→ ypscan_save_artifact(mcn_creator_preview) → 询问是否补全
→ ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV → 原生补全(20/批)
→ file_bridge(manual_source，内部合并并上传) → score_manual_source_csv → score_manual_source_csv_status 轮询
→ 保存打分排序 Excel（最终交付）
```

关键约束：

- 仅询价分支调用 `search_creators`；成功后忽略 `creators_export_path` 等表格链接，直接用同一 requirement ID 调 `rank_mcns`（`{id, platform}`）。
- `rank_mcns` 成功后先按响应顺序输出完整五列 Markdown 表格（`排名、机构、覆盖达人、返点、综合分`），覆盖达人取本机构 `candidate_count`，缺失写“未知”；禁止展示 supplier_id、候选达人、供给占比、汇总或历史数据。空列表 → 先复核再放宽（见 §6），不得保存空排名表或猜测机构。
- 收件机构：只在用户选中弹窗机构、选“询价全部机构”或输入机构名时成立；机构名仅在本轮同一 requirement、同一平台的 `rank_mcns.data.mcns` 中唯一精确匹配；命中非空 `supplier_id` 传 `supplierIds`，未命中或无 ID 原名传 `supplier_name`；`supplierIds`/`supplier_name` 始终为数组。不模糊匹配、不跨轮复用。
- 发送确认：`AskUserQuestion` 一题两选项 `确认发送`/`返回修改`，不设 multiSelect；最终机构名单与完整企微消息写入问题正文，保留企微消息原有行结构、只在单行将超过 20 字符时断行；只有“确认发送”或无条件肯定回复才调 `create_with_distributions`（`description` 与 `wechat_notification_message` 一致）。机构匹配、去重、幂等由 Provider 负责。
- 回收：用户确认机构已回填后第一步调 `sync_mcn_inquiry_status({requirement_id, project_id, supplierIds})`，用其返回的 `data.inquiries[].inquiry_id` 直接调 `ingest_mcn_submissions({inquiry_ids})`，不依赖 `get_workflow_state`。随后 `get_ingest_job` 用同一 `job_id` 轮询至 `succeeded`/`partially_succeeded`（单轮最多 10 次）；终态只回一份预览 Excel（`excel_file_url` + `excel_columns`，没有 links CSV），先保存预览表，再询问用户是否补全。
- 补全分支：选“补全并打分排序”时 `ypscan_save_creator_links({requirement_id, preview_file_path, platform})` 直接读取受控预览并派生 links CSV → 按 20/批调平台原生补全（小红书 `get_xhs_author_business_card` 固定 `page_count=1`；抖音 `get_douyin_author_business_card`）→ `file_bridge(flow=manual_source)` 合并并上传 → `score_manual_source_csv` → `score_manual_source_csv_status` 轮询 → 保存打分排序 Excel。
- `partially_succeeded`：如实报告哪些机构 pending、哪些已回填，让用户选“补全并打分排序 / 暂不补全”，不把部分成功当全部完成。摘要中的 `inquiry_id` 兼容字符串和安全整数。
- 回收后达人不足：交付当前真实结果并说明缺口，不自动发起新一轮询价、不自动放宽。正式链路不再调用 `get_workflow_state`、`rank_creators`、`create_submission_batch`、`get_creator_detail`、`get_creator_detail_export`。

## 4. 手动拓展链路

```text
validate_requirement → select_inquiry_form_fields（原样展示 URL，等用户回复“好了”）
→ manual_source_creators(requirement_id[, demand])
→ 同步 links CSV：ypscan_save_artifact(manual_creator_links) → ypscan_save_creator_links 归一化 → 原生补全(20/批)
  → file_bridge(manual_source，内部合并并上传) → score_manual_source_csv → score_manual_source_csv_status 轮询
  → 保存 manual_source Excel（最终交付）
→ batch_id：提示后台耗时 → manual_source_creators_status({requirement_id, batch_id, num}) 30s×10 轮询
  → 同上 CSV 链路
→ 旧 Provider 返回 Excel：降级路径，保存即交付
```

关键约束：

- 新 requirement 必须重新调用 `select_inquiry_form_fields`；其他 requirement 的字段提交或用户曾说“不再选字段”都不能复用。字段 URL 输出后当前轮次结束，只有用户为该 requirement 提交并明确回复“好了”后才能调用 `manual_source_creators`，不得试调后端探测是否会强制报错。
- `manual_source_creators` / `manual_source_creators_status` 的 `num` 位置按当前环境 live schema 决定：测试基线 `https://test-mcp.eshypdata.com/mcp` 当前为启动工具不带 `num`、状态查询带 `num`；若生产环境 schema 漂移，只允许按 live schema 做确定性兼容，不得靠前台可见的连续试错探测。可选需求原文字段只在 schema 明确支持时传 `demand`（当前完整未改写原文），不支持时不猜字段名。
- 异步轮询：提交返回 batch_id 后等 30 秒再第 1 次查询状态工具；当前环境 schema required `num` 时，取当前 requirement 落库 `quantityTotal` 作为目标数量，通过 `MANUAL_SOURCE_TARGET_NUM` 提示并在远端调用时附带，与用户最新确认不同时以最新确认为准。之后每 30 秒一次，单轮累计最多 10 次；第 10 次未完成如实报告并停止，不弹窗、不自动查第 11 次、不重复提交或换 ID。
- 打分阶段：`score_manual_source_csv({requirement_id, csv_file_path})` 返回 job_id 后，按 30s×10 轮询 `score_manual_source_csv_status({job_id})`，终态后保存 manual_source Excel。打分提交或状态结果若返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED` / `REQUIREMENT_COLUMNS_UNAVAILABLE`（含明确缺少 selected inquiry columns 消息，即使外层包裹通用任务错误也必须识别），停止轮询并为同一 requirement 重新生成字段选择 URL；用户回复“好了”后只用同一 requirement 与本轮 `file_bridge` 原始 `csv_file_path` 重提一次打分——Hook 保留到该可信路径时直接附带精确 `SCORE_MANUAL_SOURCE_CSV_ARGS`，按原样重提，不重搜、不重补全、不重跑 `file_bridge`，也不把 `success_count` 当最终成功。
- links CSV 到达后：先 `ypscan_save_artifact(artifact_kind="manual_creator_links", file_url=<当前 Provider URL>)` 并原样展示本地链接（原始 Provider 下载物，可能只有 url 列）；再用 `ypscan_save_creator_links({requirement_id, platform, links_csv_path})` 归一化为受控三列 links CSV（缺 `creator_id` 时按平台主页规则从 url 推导，短链或无法推导、ID 与主页不匹配时整份失败停止，不进入补全）；原生补全每批只信任 `csv_file`、`successful_author_ids`、`failed_author_ids`；部分成功保留成功 CSV，不自动重试整批；某批 `csv_file` 缺失则停止 file_bridge/打分并报告失败达人。
- `file_bridge` 接收 links CSV 和所有补全 CSV，一次完成合并与后续处理。merged CSV 数据行 > 500 时跳过上传，如实交付本地文件；未超限才上传并把返回的 `csv_file_path` 传 `score_manual_source_csv`。`csv_file_path` 只接受当前 `file_bridge` 返回值，绝不传本机工作区路径或自行构造的路径；`score_manual_source_csv_status` 轮询终态成功后才保存最终手动拓展 Excel。
- `file_bridge` 成功后返回未签名 OSS URL；若对象虽已上传但匿名不可读，则返回 `YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE`，不得继续把该 URL 传给 `score_manual_source_csv`。
- 降级路径：旧 Provider 同步/异步返回 Excel 时，仅保存并交付当前 Excel，不进 CSV 补全/打分链路，不调 `manual_source_creators_status`、`rank_creators` 或 `create_submission_batch`，也不得通过 Bash、Python、Node、PowerShell 或其他临时脚本解析 `xlsx` 强行补链路。
- 手动拓展 Excel 保存后即为最终手动拓展结果；不再精排、不生成提报表、不触发放宽。

## 5. 结果不足：先复核，再放宽

- 触发点：询价分支 `rank_mcns` 为空；手动拓展仅在 Provider 响应明确给出可信实际数量为 0 或少于目标数量时（数量未知不猜测、不自动放宽，当前交付物即最终结果）。
- 禁止直接放宽：先对照当时有效需求、本次解析输出、实际落库参数复核；确认正确后才按固定顺序逐项建议放宽。
- 固定顺序：刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → `contentFeatureLabel` → `contentThemeLabel` → `kolPersonaLabel` → `industryTagLabel`；不存在的字段跳过；每项只调一次。`followercount` 为 `[0,999999999]` 时已是全量区间、无法再放宽，直接跳过粉丝范围。
  - 刊例价/CPM/CPE/粉丝：下界 ×0.8、上界 ×1.2，整数上下界向外取整；返点 `[min,1]`→`[min×0.8,1]`；多报价指标每轮只调一个；标签阶段每轮移除一个完整非核心偏好字段。
- 永不自动放宽：平台、模式、品牌、数量、截止时间、内容形式、抖音视频类型、`contentTag`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`growBloggerTypeLabel`、`growTalentTypeLabel`。
- 每轮放宽只做建议、不自动执行：先可见告知用户实际数量、目标数量、缺口和可放宽的唯一项；提出具体项后本轮结束，“放宽直到足量”等总体授权不替代后续每轮确认。用户明确确认当前项后，仍以完整未改写的原始需求重新解析并保留在 `rawMessagesJson.original`，累计放宽写 `rawMessagesJson.clarifications` 与本轮 validate 顶层参数，再复核、创建新 requirement 并按原模式重跑；重跑搜索时 `manual_source_creators.demand` 传应用了已确认放宽值的有效搜索文本（原文对应字段替换为放宽后值），搜索返回后核对实际搜索参数与放宽值一致，不一致时如实报告放宽未传导；足量后在结果前汇总全部放宽记录。
- 全部允许项用完仍不足：询价问“手动修改需求 / 改用手动拓展 / 结束”，手动拓展问“手动修改需求 / 改用询价机构 / 结束”。切换功能时撤销本轮全部放宽，恢复用户当前真实需求后重新建需。

## 6. 续办例外（“暂不询价”）

`rank_mcns` 列表后用户选“暂不询价”、关闭/取消弹窗或当轮未回答，仅暂停发送；同会话内之后明确要求给该列表机构发询价（含“前 5 家”等可按当前排名唯一确定的表达），且期间未修改业务条件或平台、未开始其他功能、未创建更新的 requirement，视为恢复当前询价分支：沿用原 requirement、平台与 `rank_mcns` 机构映射，不重新解析/落库/搜索/排名；已提交字段配置复用，否则再调 `select_inquiry_form_fields`。任一条件不满足则按新功能重新建需。

## 7. 用户修改需求与交付物归类

- 用户主动修改任何业务条件：回到原始需求合并最新人工修改，撤销全部放宽，重新解析、复核、创建新 requirement 并沿原模式重跑；不复用旧 requirement/机构/达人/batch/CSV/Excel。
- 中间产物：MCN 排名表、机构达人预览表、merged CSV、受控 links CSV。
- 最终交付：打分排序 Excel（`manual_source`）。`ranked_submission`（最终提报表）已从正式链路移除，仅作遗留 kind 保留。
- 所有结果只用当前 requirement、当前平台、本轮真实 Provider 证据；不跨需求/平台/账号/历史 run 混用或补齐。
