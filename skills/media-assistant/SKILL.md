---
name: media-assistant
description: MANDATORY — 只要用户提到悦普识星、YPscan、达人筛选、找达人、找博主、蒲公英、小红书、星图、抖音、MCN、询价或提报，就必须在首次相关操作前完整读取本 Skill 一次。
---

# YPscan Media Assistant

## 连续推进与用户交互

用户已明确的需求、修改或继续执行指令直接落实；未修改的有效澄清继续使用，不以“确认后我再执行”重复索取同一决定。解析、复核、保存、补全与轮询等已可执行步骤连续推进，进度通知不成为等待回复的关卡。必要业务选择、发送确认、字段页提交和真实阻塞仍按各分支处理。

面向用户只说当前业务进度、结果、是否需要操作及原因；不主动展示 requirement ID、batch ID、工具名称、“落库”等实现细节。用户要求诊断时才提供必要技术证据。没有文件的零结果如实说未找到达人，不说“已交付”。

## 进入流程与业务模式

只处理媒介助手范围内的达人筛选、询价和提报任务。工具能力只按宿主完整名称中最后一个 `__` 后的实际工具名判断；单一匹配时使用宿主展示的完整名称，多个同名匹配时才询问用户，无匹配时才报告缺失。

解析需求前先确定业务模式：

- 用户明确说“询价机构”“机构询价”或“MCN 询价”时，直接使用 `询价机构`。
- 用户明确说“手动拓展”“人工拓展”“直接手扒”“手扒”或“手捞筛选”时，统一使用用户侧模式 `手动拓展`；旧说法只作为输入别名。
- 未明确模式、同时出现两种模式或语义冲突时，调用 `AskUserQuestion`，选项固定为“询价机构”和“手动拓展”。用户回答前不解析、不落库。

选定后将用户侧模式传入 `ypscan_parse_requirement.business_mode`，并写入 `validate_requirement.rawMessagesJson.business_mode`。插件在 Provider 边界把 `手动拓展` 规范为兼容线值 `直接手扒`；Agent 不得自行使用或展示该内部值。该模式决定本次新建 requirement 进入的功能。

询价机构：`ypscan_parse_requirement → 复核 → validate_requirement → search_creators → rank_mcns → MCN 排名表 → 选择收件机构 → 选择字段 → 发送确认 → create_with_distributions → 用户说机构已回填 → sync_mcn_inquiry_status(requirement_id, project_id, supplierIds) → 用其返回的 inquiry_ids 直接 ingest_mcn_submissions → get_ingest_job（到 succeeded/partially_succeeded）→ 保存机构达人预览表 → 询问用户是否补全 → ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV → 原生达人补全(20/批，YP Action 外部宿主工具) → file_bridge(flow=manual_source，内部合并并上传) → score_manual_source_csv → score_manual_source_csv_status 轮询 → 保存打分排序 Excel`

手动拓展：`ypscan_parse_requirement → 复核 → validate_requirement → select_inquiry_form_fields → manual_source_creators(requirement_id) → 同步 links CSV 直接保存，或 manual_source_creators_status(requirement_id, batch_id, num) 轮询 → 保存并归一化 links CSV → ypscan_summarize_manual_scores 取得当前批 → 原生达人补全(最多20人/批，YP Action 外部宿主工具) → file_bridge(flow=manual_source，仅合并上传当前批) → score_manual_source_csv → score_manual_source_csv_status 轮询 → 保存单批 manual_score_batch → 再汇总（达标交付，否则下一批）`

每次真正开始新的询价机构或手动拓展都必须先创建独立的新 requirement。即使同一会话、同一平台、业务条件未变，或询价完成/停止后改用手动拓展（反之亦然），也必须重新调用 `ypscan_parse_requirement`、按下文复核并调用 `validate_requirement`；不得跨功能复用 requirement 或已提交字段配置，新 requirement 必须重新调用 `select_inquiry_form_fields`。两个功能不得并行执行，也不得复用旧机构、达人、batch、CSV 或 Excel。用户过去对其他 requirement 说过“以后不用再选字段”等不算当前 requirement 已提交字段的证据。字段选择 URL 输出后本轮必须结束并等待；只有用户为这个 requirement 提交字段页并明确回复“好了”后才恢复原分支，禁止同一轮试调搜索、手动拓展或打分。

机构列表展示后的“暂不询价”是唯一的续办例外：用户选择“暂不询价”、关闭/取消机构选择弹窗或当轮未回答后，只要仍在同一会话，之后明确要求给该列表中的机构发询价（包括“前 5 家”等可按当前排名唯一确定的表达），且期间未修改业务条件或平台、未开始其他功能、未创建更新的 requirement，就视为恢复当前询价分支，而不是开始新询价。继续使用该列表所属 requirement、平台和 `rank_mcns` 机构映射，不重新解析、落库、搜索或排名；当前 requirement 已提交字段配置时复用，否则再调用 `select_inquiry_form_fields`。“暂不询价”只暂停发送，不算明确停止整个询价功能。任一条件不满足时不得把历史列表当作当前证据，按真正的新功能开始处理。

## 解析后、落库前必须复核

每次 `ypscan_parse_requirement` 成功后，先在内部对照三份内容，再调用 `validate_requirement`：

解析器缺失字段或返回 null 不代表用户未提供。先核对当前原文与有效澄清：例如“返点25%以上”已唯一确定最低返点25%，直接保存 `"[0.25,1]"`，不再问最低返点。粉丝未明确（包括只有“行业头部”描述）按全量区间处理，不追问量级。第一次复核必须一次检查全部必要字段，包括截止时间是否过期；确需澄清时一次问齐，不先问数值再由预检发现日期错误。


1. 用户当前完整有效需求；
2. 本次 `data.outputs`；
3. 即将发送的完整 `validate_requirement` 参数。

至少检查模式、平台、品牌、数量、截止时间、内容形式、抖音植入/定制类型、粉丝、返点、刊例价/CPM/CPE 档位、`contentTag`、可选标签、同平台多达人类型是否仍为一个 requirement，以及是否混入其他平台或旧需求值。

截止时间必须由当前完整有效需求和最新澄清唯一确定为未来时间。当前有效原文与当前有效澄清均没有截止时间证据时必须询问，不得从旧 requirement、系统默认值或推测中回填。只有日期没有具体时刻时必须澄清，不得默认 18:00、23:59:59 或其他时刻，也不得宣称“无需补充澄清”；已有明确小时和分钟时只补省略的秒为 00，不重复询问。中文日期的两位年份按 20xx 归一，例如“26年9月26日 16:00”即 `2026-09-26 16:00:00`，保留原文证据，不要求用户改写四位年份；仍检查日期合法、未来时间及最新澄清冲突。`T`/空格、斜杠日期、中文点分是等价时间写法；明确截止语境中的“明天16:00”按本地次日，“12点前”按本地当天且必须未来，不要求改写格式、不自动顺延。数量“三十位达人”与“30人”等明确人数同样直接采用，不要求重写阿拉伯数字。同一会话内用户已确认的澄清答案（含截止时间）持续有效：后续轮次与 requirement 重建必须原样带入新 `rawMessagesJson.clarifications` 直接复用，不得重复询问；等价时间表述（今晚8点前/今晚20:00/当天20:00:00）归一为同一值，不重复确认。用户只要求解析、暂不落库时仍须指出缺失时刻，但不得创建需求或继续下游。

发现明显错误时，先告诉用户“原需求是什么、哪个字段错了、将按什么理解修正”，然后按完整有效需求重新解析；错误参数不得落库，这次纠正不算需求放宽。存在歧义时，用一次 `AskUserQuestion` 收集全部不确定字段（禁止逐字段分轮弹窗），回答前不落库、不搜索、不放宽。重新解析后仍重复同一明显错误时，停止自动重试，展示原需求、错误字段和候选修正，请用户决定；不得直接覆盖解析器标签。

检查正确时直接落库，不展示复核摘要，不等待用户确认。原文未逐字出现但语义合理、且不与需求冲突的解析标签继续原样采用；不得只因措辞不同删除标签。

需求参数细节按 [解析参考](references/tools/ypscan_parse_requirement.md) 和 [validate_requirement](references/tools/validate_requirement.md) 执行。解析器已有唯一合法品牌、粉丝、返点、报价、CPM 或 CPE 时直接采用；粉丝未明确或“不限”时默认落库全量区间 `[0,999999999]`、不询问，其余必要字段在核对原文、有效澄清与解析结果后仍缺失、多候选或冲突时才询问；用户明确改口且新值唯一时直接采用，不重复确认。八个 Dify Label 解析契约保持不变，`talentTypeLabel` 不是 Dify 字段。`validate_requirement` schema 中的 `talentTypeLabel`、`refNickname`、`refUrl` 属于 Provider 可选字段：只有用户明确提供且语义唯一时才传，绝不推断。抖音 L2=植入视频、L3=定制视频，不使用 L1。所有数值区间使用无空格字符串 `"[min,max]"` 且 `min < max`。用户未明确粉丝数、或写“不限/不限粉丝数/无要求”等时，`followercount` 落库全量区间 `"[0,999999999]"`（零到最大值），不省略字段、不为此弹窗；历史坏值 `[1,999999999]` 同样归一为 `[0,999999999]`。同平台多个达人类型合并为一个 requirement，保留总量，不拆分人数。

需求 ID 优先取 `data.requirement_id`，缺失时兼容 `data.id`；绝不使用 `data.demand_id`。

## 询价机构分支

`validate_requirement` 成功后调用 `search_creators`，成功后不保存或展示 `creators_export_path`，直接用同一 requirement ID 调用 `rank_mcns`。

`rank_mcns` 非空时，先按响应顺序输出全部机构，再保存排名表。用户可见机构表只能包含以下五列：

| 排名 | 机构 | 覆盖达人 | 返点 | 综合分 |
| ---- | ---- | -------- | ---- | ------ |

覆盖达人只取当前机构自己的 `candidate_count`，缺失写“未知”。不得展示 supplier ID、候选达人、供给占比、手动拓展补量、推荐理由、汇总字段或历史数据。

排名表保存后展示 `delivery.local_file_link`，再让用户从本轮真实机构中选择收件机构，或明确提供需要发送的自定义机构名称。机构名只在本轮同一 requirement、同一平台的 `rank_mcns.data.mcns` 中唯一精确匹配；弹窗换行只用于展示，匹配前去掉换行还原完整名称；命中非空 `supplier_id` 就放入 `supplierIds`，未匹配或无 ID 的原始名称保留在 `supplier_name` 交给 Provider；不模糊匹配、不跨轮复用。用户当轮暂不询价、关闭/取消弹窗或未回答，之后仍可按上文续办例外从这份当前列表明确选择机构。选中机构后，若同一 requirement 已提交字段配置则直接复用，否则调用 `select_inquiry_form_fields`，原样展示 URL，等待用户提交并回复“好了”。

收到“好了”后立即恢复询价分支。发送前必须用警示弹窗确认：一次 `AskUserQuestion` 只含一个问题、恰好两个选项 `确认发送`/`返回修改`、不设 `multiSelect`；最终机构名单和完整企微消息写在问题正文里，不得把机构或消息拆成选项；正文保留企微消息原有的行结构，只在单行将超过 20 个 Unicode 字符时断行，禁止把短分句、字段或项目名拆成多行。用户点击“确认发送”，或明确回复“可以发”“发吧”“按这个发”“就这样发送”等无条件肯定表达时，调用一次 `create_with_distributions`，`description` 与 `wechat_notification_message` 内容一致；否定、要求修改或带条件的表达不算确认。Provider 负责机构匹配、去重和发送幂等，插件不控制在线表格是否预填或 Provider 如何处理机构回填达人。

用户说机构已回填时，回收第一步固定调用 `sync_mcn_inquiry_status({requirement_id, project_id, supplierIds})`，用其返回的 `inquiry_ids` 直接调用 `ingest_mcn_submissions({inquiry_ids})`，不依赖 `get_workflow_state`。随后轮询 `get_ingest_job` 到 `succeeded` 或 `partially_succeeded`，保存机构达人预览表，再询问用户是否补全。`get_ingest_job` 终态只回一份预览 Excel（`excel_file_url` + `excel_columns`），没有 links CSV。

保存机构达人预览表时，必须使用 `ypscan_save_artifact(artifact_kind="mcn_creator_preview", artifact_id=当前 requirement_id, file_url=本次终态预览 Excel URL)`。本次 ingest 的 `job_id` 仅用于 `get_ingest_job` 查询，绝不得作为 `artifact_id`；保存前核对 `artifact_id` 是当前需求 ID，后续 `ypscan_save_creator_links.requirement_id` 必须与其一致。

- 保存预览表后询问用户是否补全；选“补全并打分排序”时：`ypscan_save_creator_links({requirement_id, preview_file_path, platform})` 直接读取已受控保存的预览 xlsx 并派生 links CSV，返回的原始字段仅供核验，不是合格名单 → 按 20 个一批调用对应平台的原生达人补全工具（小红书 `get_xhs_author_business_card` 且固定 `page_count=1`；抖音 `get_douyin_author_business_card`。两者均由宿主 YP Action 提供、不在 ypscan 白名单内，宿主未开放时如实报告并停止补全，不得改用 Browser 或其他手扒工具）→ 全部批次完成后调用 `file_bridge(flow=manual_source)` 合并并上传 → `score_manual_source_csv` → `score_manual_source_csv_status` 轮询 → 保存打分排序 Excel。
- `partially_succeeded` 时如实报告哪些机构 pending、哪些已回填，让用户选择“补全并打分排序 / 暂不补全”，不把部分成功当全部完成。

机构回收后达人不足时仍交付当前真实结果并说明缺口，不自动发起新一轮询价。正式链路不再调用 `get_workflow_state`、`rank_creators`、`create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`。

## 手动拓展分支

`validate_requirement` 成功后先调用 `select_inquiry_form_fields`；生成字段选择 URL 后原样展示并结束本轮，禁止用“若系统强制会提示”等试错理由提前调用后续工具。用户为该 `requirement_id` 提交字段页并明确回复“好了”后，按 [manual_source_creators](references/tools/manual_source_creators.md) 只传同一 `requirement_id` 提交后端任务，不传 `demand` 或 `num`。需求文本由 Provider 从后台读取；完整有效需求和已确认澄清仍须先解析、复核并通过 `validate_requirement` 保存。

若提交响应同步直接返回 links CSV，则立即保存并归一化 links CSV（见下文），再进入原生达人补全；若返回异步抖音 batch，则先提示用户后台处理耗时较长，再等待 30 秒，按 [manual_source_creators_status](references/tools/manual_source_creators_status.md) 使用同一 requirement ID、`batch_id` 和用户需求人数三倍的 `num`（正整数，即每批取 links URL 的数量）第 1 次查询。Hook 会通过 `MANUAL_SOURCE_TARGET_NUM` 提示当前 requirement 落库的 `quantityTotal × 3`（需求 30 人则取 90）；当前环境 live schema required `num` 时直接把该值并入状态查询，不得再次乘三。缺少需求记录时沿用上一轮已发送的 `num`。最终交付目标仍为用户需求人数。结果仍未完成时每隔 30 秒继续查询，单轮累计最多 10 次；第 10 次仍未完成时如实报告并停止，不调用 `AskUserQuestion`，不自动查询第 11 次。用户以后明确要求继续时，保留同一 requirement ID、batch ID 和当前环境 live schema 对应的目标数量参数开始新一轮最多 10 次的查询；不得重复创建任务或猜测、更换 ID。

拿到 links CSV 后，先调用 `ypscan_save_artifact` 保存为 `manual_creator_links`（原始 Provider 下载物，可能只有 url 列），原样展示本地链接；再用 `ypscan_save_creator_links({requirement_id, platform, links_csv_path})` 读取该文件并归一化为受控三列 links CSV（`source_record_id,creator_id,url`：只有 url 列时按平台主页规则推导 creator_id；短链或无法推导时立即失败并停止，不进入原生补全）。归一化成功后调用 `ypscan_summarize_manual_scores({requirement_id})`，从当前真实候选中按原顺序去重、最多使用 `quantityTotal × 3` 人，按返回的 `next_author_ids` 调用当前平台原生达人补全工具，每批最多 20 人。候选少于三倍时按实际候选处理，不伪造或保证搜够三倍。小红书使用 `get_xhs_author_business_card` 且固定 `page_count=1`，抖音使用 `get_douyin_author_business_card`；两者均由宿主 YP Action 提供、不在 ypscan 白名单内，宿主未开放时如实报告工具未开放并停止补全链路，不得改用 Browser 或其他手扒工具代替。每批只信任 `csv_file`、`successful_author_ids`、`failed_author_ids`；部分成功保留成功 CSV，不自动重试整批；若某批 `csv_file` 缺失则停止后续 file_bridge 和打分，并原样报告失败达人。该批失败达人已登记，后续汇总不会重新排批；用户明确要求重试且成功后，以成功名单取代旧失败记录。

每批补全完成后，按 [file_bridge](references/tools/file_bridge.md) 调用 `file_bridge(flow=manual_source)`，传入完整受控 links CSV 与**仅当前批**补全 CSV；工具内部只输出匹配的达人。禁止累计传入之前已评分的补全 CSV，否则会重复评分。`missing_creator_ids` 包括未开始的后续候选，不等于补全失败名单；失败只认原生工具的 `failed_author_ids`。若 merged CSV 数据行超过 500，工具跳过上传并如实交付本地文件，必须停止后续打分。未超限时把返回的服务器侧 `csv_file_path` 传给 `score_manual_source_csv({requirement_id, csv_file_path})`；`csv_file_path` 只接受当前 `file_bridge` 返回值（当前实现为未签名 OSS URL），绝不传本机工作区路径或自行构造的路径。响应返回 `job_id` 时按 [score_manual_source_csv_status](references/tools/score_manual_source_csv_status.md) 每隔 30 秒轮询（单轮最多 10 次），成功后以 `artifact_kind="manual_score_batch"`、`artifact_id=当前 requirement_id` 保存本批 workbook；同步返回 Excel 时同样按单批保存。这是中间结果，保存并展示链接后立即调用 [ypscan_summarize_manual_scores](references/tools/ypscan_summarize_manual_scores.md)，禁止直接当作最终交付。若 OSS 对象虽已上传但匿名公网地址不可读，则 `file_bridge` 会返回 `YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE`，但仍保留本地 merged CSV 链接；不得继续打分。

汇总工具精确识别评分表的“推荐结论”：仅“推荐”计数，“不推荐”不计数；未知结论、身份/需求/平台不一致、来源文件变化或相同达人结论冲突时停止，不猜测。`next_action=complete_next_batch` 时只补全返回的下一批；`await_scores` 时只等待当前已提交评分任务，若任务已终态但缺行则报告并停止，禁止自动重评或开始下一批；`deliver` 时展示汇总 Excel 并停止，不再处理剩余候选。汇总沿用 Provider 单表模板，保留工作表名、标题、需求信息、分组表头、列宽、颜色、数字格式、冻结行及全部评分行，更新评分数量，按综合得分排序，不按推荐结论筛掉或截断行；不保证未评分者中没有更优人选。候选耗尽仍不足时先交付真实结果、说明推荐人数和缺口，再按下文复核和建议放宽。没有实际文件时不得宣称交付。

来源登记仅在当前插件生命周期内保留；Gateway 重置后缺少可信上下文时停止，不通过重新建需、重新评分或临时脚本猜测恢复。机构回收仍全部补全后一次上传评分，不使用本节分批早停。

若旧 Provider 仍同步或异步返回 Excel，则仅作为兼容降级路径：立即保存并交付当前 Excel，不进入 CSV 补全/打分链路。该降级路径不调用 `rank_creators`、`create_submission_batch` 或补充达人信息弹窗。

若 `score_manual_source_csv` 或 `score_manual_source_csv_status` 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED`、`REQUIREMENT_COLUMNS_UNAVAILABLE` 或明确消息 `customer demand has no selected inquiry columns`，不得把 `success_count` 当作最终打分成功，也不得重搜、重做原生补全或重跑 `file_bridge`。使用同一 requirement 调用 `select_inquiry_form_fields`，原样展示 URL 后结束本轮；用户提交并回复“好了”后，若缺列指令已附带 `SCORE_MANUAL_SOURCE_CSV_ARGS` 则原样使用该参数重提一次 `score_manual_source_csv`，不得改写路径；否则只用同一 requirement 和本轮 `file_bridge` 返回的原始 `csv_file_path` 重提，当前对话无法取得该可信路径时如实说明并停止，不自行构造 URL。报告时明确区分 Agent 跳步、Provider 失败与用户操作，不把 Agent 可避免的返工描述成纯系统要求。

## 结果不足：先复核，再放宽

恢复用户已确认条件属于纠错，不是放宽，不要求用户再次确认该条件。Agent 传参错误且可按原意纠正时，告知后按本节纠错流程重建；若传给 Provider 的参数正确但实际搜索参数不一致，则报告偏差和当前工具无法落实的部分，不承诺重跑即可修复、不让用户接受后台错误值或代为决定排错参数。用户已明确修改并要求重搜时直接执行，沿用未修改的有效澄清，仍遵守独立建需与字段选择规则。

结果不足时禁止直接放宽。先重新对照当时有效需求、本次解析输出、实际传给 `validate_requirement` 的参数和当前结果。解释多轮结果差异时还必须核对每轮完整有效需求与 Provider 实际搜索参数；不同 requirement 的 keyword 差异只能作为线索，不能单独证明后台不稳定。Provider 未回传实际搜索参数时明确说无法确认根因，不猜测，也不让用户替后台决定无法由当前工具落实的搜索口径。发现漏检错误时按原需求纠正、重新解析、创建新 requirement 并按原模式重跑；歧义时询问用户。只有确认解析和落库参数正确后，才允许放宽。

触发点：

- 询价分支：`search_creators` 为 0 仍先执行 `rank_mcns`；只有 `rank_mcns` 为空时进入复核和放宽。
- 询价回收后的达人不足不放宽，按上文交付当前真实结果。
- 手动拓展在分批汇总终态 `recommended_count` 少于 `quantityTotal` 时；旧 Excel 降级路径只有在当前 Provider 响应明确给出可信实际数量为 0 或少于用户需求人数 `quantityTotal` 时，才在交付当前真实 Excel 后进入同一复核和放宽建议；数量未知时不猜测，当前真实交付物即最终结果。

放宽优先在原有搜索条件上替换同主题关键词、减少非核心人设限定（kolPersonaLabel）；这一阶段报价、CPM、CPE、粉丝范围、返点及其他条件保持原值。用户明确要求放宽即按此优先范围执行，不重复要求逐项确认；未授权时先提出具体关键词和人设调整建议并等待确认。调整后仍不足，复核正确后再按刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → contentFeatureLabel → contentThemeLabel → industryTagLabel 的顺序建议其他可放宽条件，跳过未设置或已无放宽空间的项；每轮说明实际数量、目标数量、缺口及下一项的当前值和建议值，等待用户明确确认该项后才重跑，不自动改动其他条件。手动拓展确认放宽后，先应用本轮全部已确认放宽值，生成调整后的完整需求全文；整体替换 rawMessagesJson.original，并将同一全文传给 ypscan_parse_requirement.demand，复核后通过 validate_requirement 保存，由 Provider 从后台读取，禁止只追加调整说明或保留冲突的旧条件。rawMessagesJson.parse_outputs 全量替换为本次重解析结果，不拼接旧输出；累计放宽写入 rawMessagesJson.clarifications 对应字段并同步本轮 validate_requirement 顶层参数，其他有效澄清保留。询价机构确认放宽后仍以未改写原文重新解析并保存 original，累计放宽写入 clarifications 和本轮顶层参数。此前用户已确认的其他澄清答案（含截止时间）继续复用，不重复询问。随后重新解析、复核、创建新 requirement 并按原模式重跑。不跨 requirement 混合结果。

放宽必须真实传导到搜索执行。先将应用全部已确认放宽的完整需求、澄清和本次解析结果通过 `validate_requirement` 保存；`manual_source_creators` 只传新 `requirement_id`，由 Provider 从后台读取，不传 `demand`。搜索响应若回传实际搜索参数，必须与已确认放宽值逐项核对：不一致时如实报告“放宽未传导到搜索、实际参数仍为 X”，不得把结果归因于放宽或宣称放宽成功。

复核新参数时，未调整的搜索条件必须沿用上一轮已确认的值；解析器重新输出不得改变这些条件。

平台、模式、品牌、数量、截止时间、内容形式、抖音视频类型、`contentTag`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`growBloggerTypeLabel` 和 `growTalentTypeLabel` 永不自动放宽。

放宽后的每轮结果仍不足时，再次复核本轮有效需求和实际落库参数，确认正确后才建议下一项。足量后，在结果前汇总全部放宽记录。

全部允许项用完仍不足时停止：询价机构仍为空则询问“手动修改需求 / 改用手动拓展 / 结束”，手动拓展仍不足则询问“手动修改需求 / 改用询价机构 / 结束”。切换功能时无论业务条件是否变化，都撤销本轮全部放宽，恢复用户当前真实需求，重新解析、复核并创建新 requirement；不得把前一功能的放宽带入新功能。用户修改业务条件时同样撤销全部放宽，恢复用户原始需求并合并最新人工修改后创建新 requirement。

## 用户修改需求与最终交付

用户主动修改任何业务条件时，无论是否已生成提报表，都回到用户原始需求，合并用户亲自提出的最新修改，撤销全部自动放宽，重新解析、复核、创建新 requirement，并沿原业务模式重跑。不得复用旧 requirement、机构、询价、达人、batch、CSV 或 Excel；未修改字段的已确认澄清答案（含截止时间）必须一并带入新 requirement 的 `rawMessagesJson.clarifications`，直接复用、不重复询问。

业务条件未变、只是前一功能完成或明确停止后要求另一功能时，也必须按当前功能重新解析、复核并创建新 requirement，重新提交字段配置；不得复用前一功能的 requirement、字段配置、机构、达人、batch、CSV 或 Excel。机构列表后的“暂不询价”、弹窗关闭/取消或当轮未回答不属于这里的“明确停止”；满足上文续办条件时继续原询价 requirement。

MCN 排名表和机构达人预览表是询价链路中间产物；merged CSV 可能是最终交付，也可能是进入精排前的中间产物；手动拓展汇总 Excel（或旧链路兼容 Excel）和最终提报表是最终交付，`manual_score_batch` 是中间产物。所有结果只使用本轮真实 Provider 证据，不跨需求、平台、账号或历史 run 混用。
