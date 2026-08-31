---
name: media-assistant
description: MANDATORY — 只要用户提到悦普识星、YPscan、达人筛选、找达人、找博主、蒲公英、小红书、星图、抖音、MCN、询价或提报，就必须在首次相关操作前完整读取本 Skill 一次。
---

# YPscan Media Assistant

## 进入流程与业务模式

只处理媒介助手范围内的达人筛选、询价和提报任务。工具能力只按宿主完整名称中最后一个 `__` 后的实际工具名判断；单一匹配时使用宿主展示的完整名称，多个同名匹配时才询问用户，无匹配时才报告缺失。

解析需求前先确定业务模式：

- 用户明确说“询价机构”“机构询价”或“MCN 询价”时，直接使用 `询价机构`。
- 用户明确说“手动拓展”“人工拓展”“直接手扒”“手扒”或“手捞筛选”时，统一使用用户侧模式 `手动拓展`；旧说法只作为输入别名。
- 未明确模式、同时出现两种模式或语义冲突时，调用 `AskUserQuestion`，选项固定为“询价机构”和“手动拓展”。用户回答前不解析、不落库。

选定后将用户侧模式传入 `ypscan_parse_requirement.business_mode`，并写入 `validate_requirement.rawMessagesJson.business_mode`。插件在 Provider 边界把 `手动拓展` 规范为兼容线值 `直接手扒`；Agent 不得自行使用或展示该内部值。该模式只决定首次落库后的初始功能。

询价机构：`ypscan_parse_requirement → 复核 → validate_requirement → search_creators → rank_mcns → MCN 排名表 → 选择收件机构 → 选择字段 → 发送确认 → create_with_distributions → 回收 → rank_creators → create_submission_batch`

手动拓展：`ypscan_parse_requirement → 复核 → validate_requirement → select_inquiry_form_fields → manual_source_creators → manual_source_creators_status → 保存并交付最终手动拓展表`

同一会话、同一平台的最近成功 requirement 在业务条件未变时，可以在前一功能完成或明确停止后复用于另一功能。“改用询价机构”或“改用手动拓展”本身不算需求修改，不重新调用 `ypscan_parse_requirement` 或 `validate_requirement`；已提交过字段配置时直接复用，尚未提交时才调用 `select_inquiry_form_fields`。两个功能不得并行执行，也不得复用旧机构、达人、batch 或 Excel。用户修改任何业务条件时仍按下文创建新 requirement。

## 解析后、落库前必须复核

每次 `ypscan_parse_requirement` 成功后，先在内部对照三份内容，再调用 `validate_requirement`：

1. 用户当前完整有效需求；
2. 本次 `data.outputs`；
3. 即将发送的完整 `validate_requirement` 参数。

至少检查模式、平台、品牌、数量、截止时间、内容形式、抖音植入/定制类型、粉丝、返点、刊例价/CPM/CPE 档位、`contentTag`、可选标签、同平台多达人类型是否仍为一个 requirement，以及是否混入其他平台或旧需求值。

检查正确时直接落库，不展示复核摘要，不等待用户确认。原文未逐字出现但语义合理、且不与需求冲突的解析标签继续原样采用；不得只因措辞不同删除标签。

发现明显错误时，先告诉用户“原需求是什么、哪个字段错了、将按什么理解修正”，然后按完整有效需求重新解析；错误参数不得落库，这次纠正不算需求放宽。存在歧义时，用一次 `AskUserQuestion` 收集全部不确定字段，回答前不落库、不搜索、不放宽。重新解析后仍重复同一明显错误时，停止自动重试，展示原需求、错误字段和候选修正，请用户决定；不得直接覆盖解析器标签。

需求参数细节按 [解析参考](references/tools/ypscan_parse_requirement.md) 和 [validate_requirement](references/tools/validate_requirement.md) 执行。解析器已有唯一合法品牌、粉丝、返点、报价、CPM 或 CPE 时直接采用；缺失、多候选、冲突或用户明确改口时才询问。抖音 L2=植入视频、L3=定制视频，不使用 L1。所有数值区间使用无空格字符串 `"[min,max]"` 且 `min < max`。同平台多个达人类型合并为一个 requirement，保留总量，不拆分人数。

需求 ID 优先取 `data.requirement_id`，缺失时兼容 `data.id`；绝不使用 `data.demand_id`。

## 询价机构分支

`validate_requirement` 成功后调用 `search_creators`，成功后不保存或展示 `creators_export_path`，直接用同一 requirement ID 调用 `rank_mcns`。

`rank_mcns` 非空时，先按响应顺序输出全部机构，再保存排名表。用户可见机构表只能包含以下五列：

| 排名 | 机构 | 覆盖达人 | 返点 | 综合分 |
| ---- | ---- | -------- | ---- | ------ |

覆盖达人只取当前机构自己的 `candidate_count`，缺失写“未知”。不得展示 supplier ID、候选达人、供给占比、手动拓展补量、推荐理由、汇总字段或历史数据。

排名表保存后展示 `delivery.local_file_link`，再让用户从本轮真实机构中选择收件机构。机构名只在本轮同一 requirement、同一平台的 `rank_mcns.data.mcns` 中唯一精确匹配；弹窗换行只用于展示，匹配前去掉换行还原完整名称；不模糊匹配、不跨轮复用。选中机构后，若同一 requirement 已提交字段配置则直接复用，否则调用 `select_inquiry_form_fields`，原样展示 URL，等待用户提交并回复“好了”。

收到“好了”后立即恢复询价分支。发送前必须用警示弹窗确认：一次 `AskUserQuestion` 只含一个问题、恰好两个选项 `确认发送`/`返回修改`、不设 `multiSelect`；最终机构名单和完整企微消息写在问题正文里，不得把机构或消息拆成选项。用户点击“确认发送”，或明确回复“可以发”“发吧”“按这个发”“就这样发送”等无条件肯定表达时，调用一次 `create_with_distributions`，`description` 与 `wechat_notification_message` 内容一致；否定、要求修改或带条件的表达不算确认。Provider 负责机构匹配、去重和发送幂等，插件不控制在线表格是否预填或 Provider 如何处理机构回填达人。

回收固定执行 `sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job → 保存机构达人预览表 → rank_creators → create_submission_batch`。机构回收后的 `rank_creators` 数量不足时，仍生成并交付当前真实结果，说明实际数量和缺口，不自动发起新一轮询价。

## 手动拓展分支

`validate_requirement` 成功后先调用 `select_inquiry_form_fields`；用户提交并回复“好了”后，按 [manual_source_creators](references/tools/manual_source_creators.md) 使用同一 requirement ID 和交付人数提交后端任务。

提交成功后先提示用户后台处理耗时较长，再等待 30 秒，按 [manual_source_creators_status](references/tools/manual_source_creators_status.md) 使用同一 requirement ID 和 `batch_id` 第 1 次查询。结果仍未完成时每隔 30 秒继续查询，单轮累计最多 10 次；第 10 次仍未完成时如实报告并停止，不调用 `AskUserQuestion`，不自动查询第 11 次。用户以后明确要求继续时，保留同一 ID 开始新一轮最多 10 次的查询；不得重复创建任务或猜测、更换 ID。

成功 Excel 是后台搜索、详情抓取和筛选后的最终手动拓展结果：保存并展示后结束本次手动拓展，不调用 `rank_creators`、`create_submission_batch` 或补充达人信息弹窗。不再提供浏览器详细拓展分支。

## 结果不足：先复核，再放宽

结果不足时禁止直接放宽。先重新对照当时有效需求、本次解析输出、实际传给 `validate_requirement` 的参数和当前结果。发现漏检错误时按原需求纠正、重新解析、创建新 requirement 并按原模式重跑；歧义时询问用户。只有确认解析和落库参数正确后，才允许放宽。

触发点：

- 询价分支：`search_creators` 为 0 仍先执行 `rank_mcns`；只有 `rank_mcns` 为空时进入复核和放宽。
- 询价回收后的达人不足不放宽，按上文交付当前真实结果。

每轮放宽前先可见地告诉用户本轮修改的唯一条件，再以“用户原始需求 + 已公开的累计放宽”重新解析、复核、创建新 requirement 并按原模式重跑。每项最多调整一次，不跨 requirement 混合结果。

放宽顺序固定为刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → `contentFeatureLabel` → `contentThemeLabel` → `kolPersonaLabel` → `industryTagLabel`。不存在的字段跳过。

- 刊例价、CPM、CPE、粉丝范围：下界乘 `0.8`，上界乘 `1.2`；整数上下界向外取整。
- 返点 `[min,1]` 改为 `[min×0.8,1]`。
- 同时有多个报价指标时每轮只调整一个。
- 标签阶段每轮移除一个完整的非核心偏好字段。

平台、模式、品牌、数量、截止时间、内容形式、抖音视频类型、`contentTag`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`growBloggerTypeLabel` 和 `growTalentTypeLabel` 永不自动放宽。

自动放宽后的每轮结果仍不足时，再次复核本轮有效需求和实际落库参数，确认正确后才进入下一项。足量后，在结果前汇总全部放宽记录。

全部允许项用完仍无可询价机构时，询问“手动修改需求 / 改用手动拓展 / 结束”。用户只改用另一功能且业务条件未变时复用当前 requirement；用户修改业务条件时撤销全部自动放宽，恢复用户原始需求并创建新 requirement。

## 用户修改需求与最终交付

用户主动修改任何业务条件时，无论是否已生成提报表，都回到用户原始需求，合并用户亲自提出的最新修改，撤销全部自动放宽，重新解析、复核、创建新 requirement，并沿原业务模式重跑。不得复用旧 requirement、机构、询价、达人、batch 或 Excel。

业务条件未变、只是前一功能完成或明确停止后要求另一功能时，复用同一会话中最近成功的 requirement 和已提交字段配置；不重新落库，也不把前一功能的机构、达人、batch 或 Excel 当作新功能结果。

MCN 排名表和机构达人预览表是询价链路中间产物；手动拓展 Excel 是手动拓展最终交付。询价回收后由 `create_submission_batch` 生成的提报表保存时，把当前 requirement 的已确认平台传给本地保存工具并展示 `delivery.local_file_link`。仅小红书提报表再询问是否“补充更新达人信息”；用户选择补充时，唯一映射到 `get_creator_detail`，传 `platform=xhs`、当前 requirement ID 和同一正整数 batch ID，随后用同一 batch 轮询 `get_creator_detail_export` 并保存新版提报表。抖音或平台缺失时不得展示补全选项、调用 `get_creator_detail` 或把平台猜成 `xhs`；不得把补全改成字段配置或再次追问补充什么。

所有结果只使用本轮真实 Provider 证据，不跨需求、平台、账号或历史 run 混用。
