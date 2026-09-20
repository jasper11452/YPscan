# 固定业务链路

业务行为权威是 `skills/media-assistant/SKILL.md`；本文件描述链路的事实形态与关键约束（Hook 指令在 [hooks.md](./hooks.md)）。

## 1. 业务模式确定

- 用户明确表达 → 直接采用（`询价机构`：询价机构/机构询价/MCN 询价；`手动拓展`：手动拓展/人工拓展/直接手扒/手扒/手捞筛选）。
- 未明确、同时出现两种或语义冲突 → `AskUserQuestion`（选项固定两模式），回答前不解析、不落库。
- 模式决定本次新建 requirement 进入的功能；`手动拓展` 在 Provider 出站边界映射为兼容线值，Agent 不得改写。

## 2. 建需与复核（两功能共用）

手动拓展以平台、达人方向、人数为业务必填，缺项一次问齐。三项齐全后首次建需前，用一次“直接开始／补充条件”弹窗列出可选条件；选择补充只收集所选类别，完成后直接继续。已明确直接开始、当前功能已处理过入口、重解析或放宽重建时不重复；关闭/取消不代选。缺品牌和报价不追问，有值仍复核；没有报价/CPM/CPE 档位条件时不问抖音视频类型；缺少任何截止时间语境时由插件填入建需后 30 天的未来绝对时间，并在 `description` 标明系统默认、可覆盖，用户补充具体时间时覆盖。具体交互及 Provider 必填兼容策略以业务 Skill 为准，询价不变。

手动拓展的返点不作为缺失必问项：当前原文、有效澄清和解析结果均未提供返点时，`rebate` 默认 `"[0,1]"`（最低 0%，不限制），不询问用户。默认值只用于建需参数，不写回 `demand`、`rawMessagesJson.original`、`parse_outputs`，不伪造澄清、不因此重解析。已有有效返点继续采用，不覆盖明确要求；已提供但有歧义的条件仍按复核规则处理。询价机构规则不变。本例外优先于通用必填字段澄清要求。

手动拓展的截止时间同样有 Provider 兼容默认：原文、有效澄清和解析结果均没有截止时间语境时，插件以当前建需时间后 30 天作为出站值，并在 `description` 标明“系统默认、建需后 30 天、可覆盖”；这不写回 `original`、`demand`、`parse_outputs` 或 `clarifications`。用户已给出日期、模糊、过期或冲突时间时仍需澄清，询价机构仍要求真实截止时间证据。

`ypscan_parse_requirement → 复核 → validate_requirement`

- 每次真正开始新功能都重新解析、复核、创建独立 requirement；同会话、同平台、条件未变也不跨功能复用 requirement；两功能不得并行或中途切换。
- 复核对照三份内容：用户当前完整有效需求、本次 `data.outputs`、即将发送的 `validate_requirement` 参数；至少检查模式、平台、品牌、数量、截止时间、内容形式、抖音植入/定制类型、粉丝、返点、报价档位、`contentTag`、可选标签、多达人类型是否仍为一个 requirement、是否混入其他平台或旧需求值。
- 解析器 null/缺失不等于用户未提供：原文或有效澄清唯一确定的数值直接采用（如返点25%以上 → `[0.25,1]`）；粉丝未提及或明确“不限/无要求”时按全量区间 `[0,999999999]` 落库、不追问，原文出现“头部/肩部/腰部/尾部/行业头部”等量级描述时必须询问具体粉丝区间，不得自行换算或按全量区间处理。首次复核一次检查全部必要字段和过期日期，必要问题一次问齐。
- 检查正确直接落库；发现错误按原需求纠正后重新解析（不算放宽）；歧义用一次 `AskUserQuestion` 收集全部不确定字段，禁止逐字段分轮弹窗；同一字段已确认的澄清答案在本会话后续轮次与 requirement 重建时直接复用，不再重复确认，等价时间表述（今晚8点前/今晚20:00/当天20:00:00）归一为同一值。手动拓展首次澄清改变当前平台有效需求时，将原始需求与全部最新有效答案合成为无冲突全文，再以同一全文重调解析器并写入 `rawMessagesJson.original`，`parse_outputs` 全量替换；全文与最近成功解析输入相同且结果有效时不重复解析。询价机构放宽仍保留未改写原文。
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
validate_requirement → select_inquiry_form_fields（configured/copied 直接继续；字段页 URL 须先在正文单独一行原样展示，未展示前首次状态查询被本地阻断一次并回带链接；首次选择用 get_inquiry_form_fields_status 自动确认，超时/重选等用户确认已提交）
→ manual_source_creators(requirement_id)
→ 同步 links CSV：ypscan_save_artifact(manual_creator_links) → ypscan_save_creator_links 归一化
  → ypscan_summarize_manual_scores 取得当前批 → 原生补全(最多20人) → file_bridge(manual_source，仅当前批)
  → score_manual_source_csv → score_manual_source_csv_status 轮询 → 保存 manual_score_batch
  → 再次 ypscan_summarize_manual_scores（达标交付汇总表，否则下一批）
→ batch_id：提示后台耗时 → manual_source_creators_status({requirement_id, batch_id, num}) 30s×10 轮询
  → 同上 CSV 链路
→ 旧 Provider 返回 Excel：降级路径，保存即交付
```

关键约束：

- 新 requirement 必须重新调用 `select_inquiry_form_fields`；同一会话已提交字段通过 source_requirement_id 继承，用户要求重选才传 force_reselect=true；configured/copied 时直接继续。`selection_required`/`opened` 只表示字段页已生成、等待提交，不等于 configured/copied；首次选择的字段页 URL 输出后用 `get_inquiry_form_fields_status({requirement_id})` 自动确认：先即时预检，`unavailable` 才每 30 秒轮询、累计最多 8 次，`submitted` 后调用 `manual_source_creators`；预检即 `submitted`（该需求此前已有配置）、`invalid`、未知状态、调用失败或到上限时停止轮询并等待用户确认已提交；无法确认预检结果时同样按预检即 `submitted` 处理。`force_reselect` 与继承场景禁止轮询（状态会在用户提交前就返回 `submitted`）。任何情况下都不得试调后端探测是否会强制报错。
- `manual_source_creators` 传 `{requirement_id}`，live schema required `num` 时附（num=用户想要的达人数量，取 Hook 注入的 MANUAL_SOURCE_NUM；缺可信人数先问清），不传 `demand`，需求由 Provider 从后台读取；完整有效需求、澄清及已确认放宽须先通过 `validate_requirement` 保存，放宽重跑传同一 num。状态查询按当前 live schema 传入梯度取数 `num`。
- 异步轮询：提交返回 batch_id 后等 30 秒再第 1 次查询状态工具；当前环境 schema required `num` 时，按目标人数梯度取数（示例：5 人→15、10 人→30、20 人→50、30 人→60、50 人→100，非穷举，表外人数同样按同一梯度计算）作为取数数量，通过 `MANUAL_SOURCE_TARGET_NUM` 提示并在远端调用时附带，提示值已是梯度值，不得重复乘倍数；缺少需求记录时沿用上次查询 num。最终交付目标与不足判断仍使用用户需求人数。之后每 30 秒一次，单轮累计最多 10 次；第 10 次未完成如实报告并停止，不弹窗、不自动查第 11 次、不重复提交或换 ID。
- 状态响应成功且 `completed=true、selected_count=0`（success_count 缺失或为0），无文件时进入零结果复核；不再轮询、不盲目重试、不生成空文件或宣称已交付。参数一致才按下文优先调整关键词和人设；仍不足再提示其他条件并等待该项确认。
- 打分阶段：`score_manual_source_csv({requirement_id, csv_file_path})` 返回 job_id 后，按 30s×10 轮询 `score_manual_source_csv_status({job_id})`，终态后保存 manual_score_batch；该单批表是内部中间产物，不展示表格、路径或链接，再调用本地汇总工具决定下一步。打分提交或状态结果若返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED` / `REQUIREMENT_COLUMNS_UNAVAILABLE`（含明确缺少 selected inquiry columns 消息，即使外层包裹通用任务错误也必须识别），停止轮询并为同一 requirement 按字段工具卡恢复配置；configured/copied 或确认字段页已提交（自动轮询到 `submitted` 或用户确认已提交）后只用同一 requirement 与本轮 `file_bridge` 原始 `csv_file_path` 重提一次打分——Hook 保留到该可信路径时直接附带精确 `SCORE_MANUAL_SOURCE_CSV_ARGS`，按原样重提，不重搜、不重补全、不重跑 `file_bridge`，也不把 `success_count` 当最终成功。
- links CSV 到达后：先 `ypscan_save_artifact(artifact_kind="manual_creator_links", file_url=<当前 Provider URL>)`（内部产物，不主动向用户展示）；再用 `ypscan_save_creator_links({requirement_id, platform, links_csv_path})` 归一化为受控三列 links CSV（缺 `creator_id` 时按平台主页规则从 url 推导，短链或无法推导、ID 与主页不匹配时整份失败停止，不进入补全）；登录窗口与 Cookie 由宿主补全工具内部处理；宿主未开放对应补全工具时如实报告并停止补全链路。原生补全每批只信任 `csv_file`、`successful_author_ids`、`failed_author_ids`；部分成功保留成功 CSV，不自动重试整批；某批 `csv_file` 缺失则停止 file_bridge/打分并报告失败达人，该批失败名单已登记，汇总不再重排；用户明确要求重试且成功后以成功记录继续。
- 手动拓展先调用 `ypscan_summarize_manual_scores({requirement_id})` 获取当前批（首批不超过 min(20, 需求人数)，之后每批最多 20 人，候选池按梯度计算（10 人→30、20 人→50、50 人→100））；`file_bridge` 接收完整受控 links CSV 和仅当前批补全 CSV，禁止累计重评。merged CSV 数据行 > 500 时跳过上传并停止打分（merged CSV 是内部中间产物，不主动向用户展示）；未超限才上传并把返回的 `csv_file_path` 传 `score_manual_source_csv`。`csv_file_path` 只接受当前 `file_bridge` 返回值，绝不传本机工作区路径或自行构造的路径；`score_manual_source_csv_status` 终态后保存单批表并汇总，去重推荐人数达到原始 N 或候选耗尽才生成最终汇总表。
- `file_bridge` 成功后返回未签名 OSS URL；若对象虽已上传但匿名不可读，则返回 `YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE`，不得继续把该 URL 传给 `score_manual_source_csv`。
- 降级路径：旧 Provider 同步/异步返回 Excel 时，仅保存并交付当前 Excel，不进 CSV 补全/打分链路，不调 `manual_source_creators_status`、`rank_creators` 或 `create_submission_batch`，也不得通过 Bash、Python、Node、PowerShell 或其他临时脚本解析 `xlsx` 强行补链路。
- 单批评分表是内部中间产物，不向用户展示表格、路径或链接；汇总终态才交付。只计精确“推荐”，不计“不推荐”或处理成功数；未知结论和来源冲突停止。综合分为 0 的评分行不写入最终表（0 分通常来自评分失败、资料无效或数据不足，也可能是有效评估但内容/类型相关度均为 0 级），不计数推荐、不算缺行，按 `excluded_zero_score_count` 说明。当前批任一补全成功达人缺评分行时先返回 `await_scores` 与明确标注的阶段性 `progress`（单批表不是最终表），即使推荐已达标或候选已耗尽也不得提前交付。候选耗尽不足时先交付再复核并建议放宽。机构回收不启用分批早停。

## 5. 结果不足：先复核，再放宽

- 触发点：询价分支 `rank_mcns` 为空；手动拓展在汇总终态推荐人数不足时，或旧链路 Provider 响应明确给出可信实际数量为 0 或少于目标数量时（数量未知不猜测、不自动放宽，当前交付物即最终结果）。
- 恢复已确认条件是纠错，不重复索取放宽确认。Agent 参数错误按原意纠正；提交正确但后台执行偏差时报告限制，不承诺盲目重跑可修复。用户明确修改并要求重搜时直接执行，保留未修改澄清；新 requirement 按字段继承规则配置字段。
- 禁止直接放宽：先对照当时有效需求、本次解析输出、实际落库参数复核；确认正确后才建议替换同主题关键词、减少非核心人设限定。
- 放宽优先在原有搜索条件上替换同主题关键词、减少非核心人设限定（kolPersonaLabel）；这一阶段报价、CPM、CPE、粉丝范围、返点及其他条件保持原值。用户明确要求放宽即按此优先范围执行，不重复要求逐项确认；未授权时先提出具体关键词和人设调整建议并等待确认。调整后仍不足，复核正确后再按刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → contentFeatureLabel → contentThemeLabel → industryTagLabel 的顺序建议其他可放宽条件，跳过未设置或已无放宽空间的项；每轮说明实际数量、目标数量、缺口及下一项的当前值和建议值，等待用户明确确认该项后才重跑，不自动改动其他条件。
- 永不自动放宽：平台、模式、品牌、数量、截止时间、内容形式、抖音视频类型、`contentTag`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`growBloggerTypeLabel`、`growTalentTypeLabel`。
- 用户授权后，手动拓展以应用全部已确认放宽的完整需求全文重新解析并整体替换 `rawMessagesJson.original`，`parse_outputs` 全量使用新解析结果；询价机构仍保留未改写原文，累计放宽写 `rawMessagesJson.clarifications` 与本轮 validate 顶层参数，再复核、创建新 requirement 并按原模式重跑；重跑搜索时 `manual_source_creators` 只传 `requirement_id`，由 Provider 从后台读取已保存的完整有效需求，搜索返回后核对实际搜索参数与放宽值一致，不一致时如实报告放宽未传导；足量后在结果前汇总全部放宽记录。
- 全部允许项用完仍不足：询价问“手动修改需求 / 改用手动拓展 / 结束”，手动拓展问“手动修改需求 / 改用询价机构 / 结束”。切换功能时撤销本轮全部放宽，恢复用户当前真实需求后重新建需。

## 6. 续办例外（“暂不询价”）

`rank_mcns` 列表后用户选“暂不询价”、关闭/取消弹窗或当轮未回答，仅暂停发送；同会话内之后明确要求给该列表机构发询价（含“前 5 家”等可按当前排名唯一确定的表达），且期间未修改业务条件或平台、未开始其他功能、未创建更新的 requirement，视为恢复当前询价分支：沿用原 requirement、平台与 `rank_mcns` 机构映射，不重新解析/落库/搜索/排名；已提交字段配置复用，否则再调 `select_inquiry_form_fields`。任一条件不满足则按新功能重新建需。

## 7. 用户修改需求与交付物归类

- 用户主动修改任何业务条件：回到原始需求合并最新人工修改，撤销全部放宽，重新解析、复核、创建新 requirement 并沿原模式重跑；不复用旧 requirement/机构/达人/batch/CSV/Excel。
- 中间产物：MCN 排名表、机构达人预览表、merged CSV、受控 links CSV。
- 最终交付：手动拓展汇总 Excel；机构评分或旧链路兼容 Excel 使用 `manual_source`。`manual_score_batch` 是手动拓展内部中间表，不向用户展示表格、路径或链接；已确认询价机构误用该 kind 保存评分表时，仍交付本次真实评分表，不进入汇总。保存的 `manual_score_batch` 所属 requirement 缺少模式记录时停止并保留文件，不借用会话模式、不展示最终交付、不汇总或重存。误调汇总的 MODE_NOT_APPLICABLE 不触发重试，只使用当前成功保存的评分表，无可信文件则停止；缺少上下文不视为已完成。`ranked_submission`（最终提报表）已从正式链路移除，仅作遗留 kind 保留。
- 所有结果只用当前 requirement、当前平台、本轮真实 Provider 证据；不跨需求/平台/账号/历史 run 混用或补齐。

字段配置按字段工具卡执行：同一会话新需求传 source_requirement_id 继承最近已提交/已配置的需求；用户主动重选才传 force_reselect=true。configured/copied 后直接继续；URL 等待提交；继承失败、平台不兼容或 live schema 不支持新参数时暂停。具体字段仅由 Provider 保存和复制。单独重选提交后只更新配置，只有明确等待字段配置的未完成步骤才恢复；不重启已完成或停止的业务。

机构局部失败处理：`partially_succeeded` 有本轮预览表时先保存并交付成功结果，失败机构按真实原因单独提示，不等待修正。预览行校验错误仅排除错误行，Hook 按 `preview.problems` 提示机构（有则引用）、行号和原因，正确行继续补全及评分；全部行无效保留原始预览并报告，不生成空表。来源、文件完整性、表头歧义校验仍阻断。代码检查不代表模型或真实宿主验收。
