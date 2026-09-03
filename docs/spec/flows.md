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
- 检查正确直接落库；发现错误按原需求纠正后重新解析（不算放宽）；歧义用一次 `AskUserQuestion` 收集全部不确定字段。
- 需求 ID 优先 `data.requirement_id`，缺失兼容 `data.id`，绝不使用 `data.demand_id`。

## 3. 询价机构链路

```
validate_requirement → search_creators → rank_mcns → 输出五列表格
→ 保存 mcn_ranking Excel → 选择收件机构 → select_inquiry_form_fields（已提交则复用）
→ 发送确认弹窗 → create_with_distributions
→ 回收：sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job（轮询）
→ 保存 mcn_creator_preview Excel → 保存 mcn_creator_links CSV
→ 分叉：精排并生成提报表 / 只补全达人信息
```

关键约束：

- 仅询价分支调用 `search_creators`；成功后忽略 `creators_export_path` 等表格链接，直接用同一 requirement ID 调 `rank_mcns`（`{id, platform}`）。
- `rank_mcns` 成功后先按响应顺序输出完整五列 Markdown 表格（`排名、机构、覆盖达人、返点、综合分`），覆盖达人取本机构 `candidate_count`，缺失写“未知”；禁止展示 supplier_id、候选达人、供给占比、汇总或历史数据。空列表 → 先复核再放宽（见 §6），不得保存空排名表或猜测机构。
- 收件机构：只在用户选中弹窗机构、选“询价全部机构”或输入机构名时成立；机构名仅在本轮同一 requirement、同一平台的 `rank_mcns.data.mcns` 中唯一精确匹配；命中非空 `supplier_id` 传 `supplierIds`，未命中或无 ID 原名传 `supplier_name`；`supplierIds`/`supplier_name` 始终为数组。不模糊匹配、不跨轮复用。
- 发送确认：`AskUserQuestion` 一题两选项 `确认发送`/`返回修改`，不设 multiSelect；最终机构名单与完整企微消息写入问题正文；只有“确认发送”或无条件肯定回复才调 `create_with_distributions`（`description` 与 `wechat_notification_message` 一致）。机构匹配、去重、幂等由 Provider 负责。
- 回收：`sync_mcn_inquiry_status` 只把本次 `inquiry_ids` 传 `ingest_mcn_submissions`；`get_ingest_job` 用同一 `job_id` 轮询，单轮最多 10 次；完成后先保存预览表再保存 links CSV，两者都成功才弹分叉选择。
- 精排分支：按 20 个一批调用平台原生补全（小红书 `get_xhs_author_business_card` 固定 `page_count=1`；抖音 `get_douyin_author_business_card`）→ `ypscan_merge_creator_csv(flow=mcn_rank)` → `ypscan_upload_creator_csv` → `rank_creators({requirement_id, csv_file_path})` → 保存 `ranked_submission`。不再调用 `create_submission_batch`/`get_creator_detail`/`get_creator_detail_export`。
- 只补全分支：原生补全 → `merge(flow=mcn_complete_only)` → 交付 merged CSV，不上传、不打分；允许同 requirement 同平台会话内继续升级精排。
- 回收后 `rank_creators` 数量不足：交付当前真实结果并说明缺口，不自动发起新一轮询价。

## 4. 手动拓展链路

```
validate_requirement → select_inquiry_form_fields（原样展示 URL，等用户回复“好了”）
→ manual_source_creators(requirement_id, num[, demand])
→ 同步 links CSV：保存 manual_creator_links → 原生补全(20/批) → merge(manual_source)
  → upload → score_manual_source_csv → 保存 manual_source Excel（最终交付）
→ batch_id：提示后台耗时 → manual_source_creators_status 轮询 → 同上 CSV 链路
→ 旧 Provider 返回 Excel：降级路径，保存即交付
```

关键约束：

- `manual_source_creators` 只传新版 schema：required 为 `requirement_id:string` 与 `num:integer`；可选需求原文字段只在其 schema 明确支持时传 `demand`（当前完整未改写原文），不支持时不猜字段名。
- 异步轮询：提交成功后等 30 秒再第 1 次查询，之后每 30 秒一次，单轮累计最多 10 次；第 10 次未完成如实报告并停止，不弹窗、不自动查第 11 次、不重复提交或换 ID。
- links CSV 到达后：先 `ypscan_save_csv_artifact(manual_creator_links)` 并原样展示本地链接；原生补全每批只信任 `csv_file`、`successful_author_ids`、`failed_author_ids`；部分成功保留成功 CSV，不自动重试整批；某批 `csv_file` 缺失则停止 merge/upload/打分并报告失败达人。
- merge 后若数据行 > 500 必须在上传前阻断，如实交付当前 merged CSV；未超限才 `ypscan_upload_creator_csv`，再把 `csv_file_path` 传 `score_manual_source_csv`；成功才保存最终手动拓展 Excel。
- 生产环境无上传契约时 `ypscan_upload_creator_csv` 返回 `YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE`（见 [tools.md](./tools.md)），不得猜测真实接口。
- 降级路径：旧 Provider 同步/异步返回 Excel 时，仅保存并交付当前 Excel，不进 CSV 补全/打分链路，不调 `manual_source_creators_status`、`rank_creators` 或 `create_submission_batch`。
- 手动拓展 Excel 保存后即为最终手动拓展结果；不再精排、不生成提报表、不触发放宽。

## 5. 结果不足：先复核，再放宽

- 触发点：询价分支 `rank_mcns` 为空；手动拓展仅在 Provider 响应明确给出可信实际数量为 0 或少于 `num` 时（数量未知不猜测、不自动放宽，当前交付物即最终结果）。
- 禁止直接放宽：先对照当时有效需求、本次解析输出、实际落库参数复核；确认正确后才按固定顺序逐项放宽。
- 固定顺序：刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → `contentFeatureLabel` → `contentThemeLabel` → `kolPersonaLabel` → `industryTagLabel`；不存在的字段跳过；每项只调一次。
  - 刊例价/CPM/CPE/粉丝：下界 ×0.8、上界 ×1.2，整数上下界向外取整；返点 `[min,1]`→`[min×0.8,1]`；多报价指标每轮只调一个；标签阶段每轮移除一个完整非核心偏好字段。
- 永不自动放宽：平台、模式、品牌、数量、截止时间、内容形式、抖音视频类型、`contentTag`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`growBloggerTypeLabel`、`growTalentTypeLabel`。
- 每轮放宽前先可见告知用户本轮唯一修改项，再以“原始需求 + 已公开累计放宽”重新解析、复核、创建新 requirement 并按原模式重跑；足量后在结果前汇总全部放宽记录。
- 全部允许项用完仍不足：询价问“手动修改需求 / 改用手动拓展 / 结束”，手动拓展问“手动修改需求 / 改用询价机构 / 结束”。切换功能时撤销本轮全部自动放宽，恢复用户当前真实需求后重新建需。

## 6. 续办例外（“暂不询价”）

`rank_mcns` 列表后用户选“暂不询价”、关闭/取消弹窗或当轮未回答，仅暂停发送；同会话内之后明确要求给该列表机构发询价（含“前 5 家”等可按当前排名唯一确定的表达），且期间未修改业务条件或平台、未开始其他功能、未创建更新的 requirement，视为恢复当前询价分支：沿用原 requirement、平台与 `rank_mcns` 机构映射，不重新解析/落库/搜索/排名；已提交字段配置复用，否则再调 `select_inquiry_form_fields`。任一条件不满足则按新功能重新建需。

## 7. 用户修改需求与交付物归类

- 用户主动修改任何业务条件：回到原始需求合并最新人工修改，撤销全部自动放宽，重新解析、复核、创建新 requirement 并沿原模式重跑；不复用旧 requirement/机构/达人/batch/CSV/Excel。
- 中间产物：MCN 排名表、机构达人预览表、merged CSV（只补全分支时是最终交付）。
- 最终交付：手动拓展 Excel、最终提报表（ranked_submission）。
- 所有结果只用当前 requirement、当前平台、本轮真实 Provider 证据；不跨需求/平台/账号/历史 run 混用或补齐。
