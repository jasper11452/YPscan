# 用户要求 Review Checklist

> 角色约定：**用户**＝发起需求/选择/确认/修改的人；**Agent**＝OpenClaw 模型（按工具卡与 Hook 指令执行）；**界面**＝宿主渲染的弹窗、Markdown 表格与本地文件链接（由插件载荷与 Hook 指令决定）；**后端**＝Provider MCP（搜索/排名/发送/入库/打分/手动拓展任务）与 Dify（需求解析）。
>
> 每一条按「触发 → 各角色行为」写：**用户/Agent/后端 做了什么时**，Agent、界面、后端各自会怎样。核对时逐条打勾。

## 一、用户动作触发

- [ ] **用户第一次提出询价机构或手动拓展（真正开始新功能）**：Agent 必须先 `ypscan_parse_requirement → 复核 → validate_requirement` 创建独立的新 requirement，不复用旧 requirement、机构、达人、batch、CSV 或 Excel；两功能不得并行或处理中切换，前一功能完成/停止后切换也必须重新建需并按字段继承规则配置字段；界面不弹窗（模式不明除外）；后端只在新 requirement 落库后收到搜索/发送等调用。
- [ ] **用户同时给出多个达人类型、只给总量**：Agent 只建一个 requirement，保留原始总量、合并全部类型标签与条件，不拆分、不重复落库、不重复搜索；后端不收到子需求或多份落库。
- [ ] **用户明确说出模式**（“询价机构/机构询价/MCN 询价”→“询价机构”；“手动拓展/人工拓展/直接手扒/手扒/手捞筛选”→“手动拓展”）：Agent 直接采用，旧说法只作输入别名，不弹窗；**用户未明确、两种模式同时出现或语义冲突**：界面弹二选一（询价机构/手动拓展），Agent 回答前不解析、不落库。模式指令每轮注入，避免只在会话启动时出现；选定后用户侧模式同时进 `ypscan_parse_requirement.business_mode` 与 `rawMessagesJson.business_mode`；后端只在出站边界把“手动拓展”映射为兼容线值，Agent 不得使用或展示该内部值。
- [ ] **用户在 `rank_mcns` 列表后选“暂不询价”、关闭/取消弹窗或当轮未回答，之后明确要求给该列表机构发询价（如“前 5 家”，可按当前排名唯一确定），且需求、平台未变、没有更新的功能或 requirement**：Agent 恢复当前询价分支——沿用原 requirement、平台和 `rank_mcns` 机构映射，不重新解析、落库、搜索或排名；已提交字段配置复用，否则再调 `select_inquiry_form_fields`；界面重新进入收件机构选择。任一条件不满足则按真正的新功能重新建需。
- [ ] **用户主动修改任何业务条件**：Agent 回到用户原始需求、合并最新人工修改、撤销本轮全部放宽，重新解析、复核并创建新 requirement；后端收到新落库。
- [ ] **用户提供或提名机构名**：Agent 先在本轮同一 requirement、同一平台的 `rank_mcns` 结果中做唯一精确匹配——命中非空 `supplier_id` 放 `supplierIds`（不再传同名 `supplier_name`），未命中或无 ID 的原名放 `supplier_name`；不做本地模糊匹配、不跨需求/平台/run 复用 ID；模糊候选由用户选择后，Agent 只使用 Provider 返回的真实 ID；后端负责最终机构匹配。
- [ ] **用户在字段选择页提交并回复“好了”**：Agent 按原分支恢复——询价进入发送确认，手动拓展用原 `requirement_id` 调 `manual_source_creators`；字段配置已由后端直接持久化，Agent 不得在上下文读取、重建或缓存 `columns`、不得轮询 callback、不得调已弃用的 `get_selected_inquiry_form_fields`。
- [ ] **用户选中机构、选“询价全部机构”或输入机构名称**：界面选项成立，Agent 才继续询价；空输入、未明确、无法解析、冲突或歧义时 Agent 不得继续询价，重新弹机构选择或结束本轮；“暂不询价”不得与机构/“询价全部机构”同时成立。
- [ ] **用户说机构已回填、“填好了”或“生成表格”**：Agent 第一步调 `sync_mcn_inquiry_status({requirement_id, project_id, supplierIds})`，随后按后端返回进入回收链（见“三、后端结果触发”）。
- [ ] **用户点“确认发送”或明确说“可以发/发吧/按这个发/就这样发送”**：Agent 调用一次 `create_with_distributions`；否定、修改或带条件的表达不算确认，界面重新弹确认。后端负责企微发送、机构匹配、去重与幂等。
- [ ] **用户保存机构达人预览表后选择是否补全**：选“补全并打分排序”时 Agent 先 `ypscan_save_creator_links` 用 `preview_file_path + platform` 直接读取受控预览并派生 links CSV → 按 20/批原生补全 → `file_bridge(flow=manual_source)` 合并并上传 → `score_manual_source_csv` 打分 → 保存打分排序 Excel；选“暂不补全”则保留预览表并结束。`partially_succeeded` 时界面如实展示哪些机构 pending、哪些已回填，不得把部分成功当全部完成。

## 二、Agent 动作触发

- [ ] **Agent 调用 `validate_requirement` 前**：必须先对照“用户当前完整需求、本次解析输出、即将发送的参数”三份内容复核；发现错误按原需求纠正后重新解析（纠正不算放宽）。所有数值字段（`rebate`、`followercount`、报价、CPM、CPE 等）第一次调用前一次性规范为无空格区间字符串 `"[min,max]"` 且 `min < max`（返点固定 `"[min,1]"`），禁止 `[v,v]`、数组、对象、单值、百分号文本或自然语言。抖音只用 L2=植入、L3=定制，不传 L1 档位；小红书不传任何 L3 字段；模糊档期不转换成具体日期。金额、数量、比例、范围、平台、合作形式与指标档位按当前契约解析，纯格式差异由本地边界一次性规范化，未知或不支持的字段省略或保留在 Brief 中。粉丝数未明确或明确“不限/无要求”时，`followercount` 落库全量区间 `[0,999999999]`，不省略字段、不弹窗；历史坏值 `[1,999999999]` 归一为 `[0,999999999]`。
- [ ] **Agent 调用 `validate_requirement` 时**：界面（插件预检）一次性校验全部必填字段与格式——通过才放行，阻断则 Provider 未写入：`rawMessagesJson` 容器结构错误本身只要求用对象形式重发并保留已有业务值，不得仅因该结构错误弹窗；同时列出的其他独立缺项仍由 Agent 按原因处理，确需用户补充时一次弹窗收齐后重提，禁止逐字段、逐类型盲试；品牌、项目名、数量、截止时间、可选项目日期必须有 `rawMessagesJson.original` 或非空 `clarifications` 中的明确值证据，空澄清键、解析默认值、Agent 推断不算证据（解析标签不适用此证据门禁）；无年份中文日期在项目/档期语境中可按已解析的同年日期通过，证据自带年份时必须同年；后端只收到一次完整合法写入，真实 Provider 错误只按明确错误处理。
- [ ] **Agent 处理解析输出**：八个可选 Label 数组原样落库（保留元素与顺序），缺失或 `null` 直接省略，不做映射、不推断、不询问；唯一合法数值直接采用；只有数值缺失、多候选、冲突或需选择映射时才弹数值澄清；`contentTag` 缺失/无效时重新解析，不问用户、不自补；未知字段不向 Provider 塞。后端收到的字段与解析结果一致。
- [ ] **Agent 调 `search_creators` 成功后**：忽略 `creators_export_path` 等表格链接，直接用同一 requirement 调 `rank_mcns({id, platform})`；仅询价分支允许调用 `search_creators`。后端检索单价只按原价下 30%、上 20% 扩展一次；Agent 不得把该扩展区间回写需求参数。
- [ ] **Agent 调 `select_inquiry_form_fields`**：必须按当前 live schema 传 `platform` 与当前真实 `requirement_id`；新建 requirement（含放宽和跨功能切换）用 source_requirement_id 继承本会话已提交配置，configured 且需求 ID 一致后直接继续；首次或用户主动 force_reselect=true 才打开字段页；继承失败/平台不兼容/接口不支持时暂停；原样展示 URL 后本轮结束，用户为该 requirement 提交并明确回复“好了”前不得试调后续搜索、手动拓展或打分；后端持久化字段配置。
- [ ] **Agent 调 `manual_source_creators`**：只传 `{requirement_id}`，不带 `demand` 或 `num`；需求由 Provider 从后台读取，完整需求、澄清和已确认放宽须先解析、复核并通过 `validate_requirement` 保存；后端异步生成或同步返回 links CSV。
- [ ] **Agent 调 `manual_source_creators_status`**：`num` 只在当前环境 live schema required 时传（每批 URL 数量，正整数，按目标人数梯度取数：如 5 人→15、10 人→30、20 人→50、30 人→60、50 人→100（示例非穷举，表外人数同样按同一梯度计算）；交付目标仍为用户需求人数）；Hook 先通过 `MANUAL_SOURCE_TARGET_NUM` 提示梯度值，轮询不得重复乘倍数。提交后先等 30 秒再第 1 次查询，之后每 30 秒一次，单轮累计最多 10 次；第 10 次未完成如实报告并停止，不弹窗、不查第 11 次、不重复提交或换 ID；后端返回终态 links CSV 后 Agent 保存 `manual_creator_links`，再用 `ypscan_save_creator_links` 归一化为受控三列 CSV（短链或无法推导 creator_id 时报错停止，不进入补全），再按平台分 20 个 author 一批原生补全（小红书 `get_xhs_author_business_card` 固定 `page_count=1`；抖音 `get_douyin_author_business_card`）。
- [ ] **Agent 调 `ypscan_save_creator_links`（两链路归一化）**：传当前 `requirement_id`、`platform` 与 `links_csv_path`（手动拓展：`ypscan_save_artifact` 保存的原始 links CSV）或 `preview_file_path`（询价回收：已登记且哈希未变的预览 xlsx），二者互斥；工具解析并归一化出 `source_record_id,creator_id,url` CSV 并登记为当前 requirement 的合法 links 来源：links CSV 只有 url 列时按平台主页规则推导 creator_id，短链或无法推导、ID 与主页不匹配时整份报错停止；归一化 links CSV 是内部中间产物，界面不主动展示其表格、链接或本地路径，随后按 20/批原生补全 → `file_bridge(flow=manual_source)` → 打分；非法行或去重后为空时报错，不得用 Browser/脚本代写。
- [ ] **Agent 调原生达人补全工具**：每批按 20 人调用当前平台补全工具（小红书 `get_xhs_author_business_card` 固定 `page_count=1`，抖音 `get_douyin_author_business_card`）；登录窗口与 Cookie 由宿主工具内部处理，不自行打开登录页、不读取 Cookie；宿主未开放对应补全工具时如实报告并停止补全链路。补全本身每批只信 `csv_file`、`successful_author_ids`、`failed_author_ids`；部分成功保留成功 CSV，不自动重试整批；某批 `csv_file` 缺失则停止后续 merge/upload/打分，界面如实报告失败达人。
- [ ] **Agent 调 `file_bridge`**：手动拓展仅传当前批补全 CSV 与完整 links，机构回收一次传全部补全 CSV 与 links，由工具内部合并；links 与补全文件必须都是 `.csv`，且必须是当前 requirement 受控保存的 links CSV 与 YP Action 原生补全产物，否则工具返回 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED` 且不上传；merged CSV 数据行超过 500 时必须跳过上传并停止打分（merged CSV 是内部中间产物，不主动向用户展示）；未超限才使用返回的服务器侧 `csv_file_path` 调 `score_manual_source_csv({requirement_id, csv_file_path})`。
- [ ] **Agent 展示表格**：用户可见的表格只有最终评分表、汇总表、MCN 排名表和机构回填预览表；手动拓展单批 `manual_score_batch`、links CSV、补全 CSV 和 merged CSV 都是内部中间产物，界面不主动展示表格、下载链接或本地文件路径，也不作为交付物报告（汇总失败但存在已核验的当前需求本批表时，按“本批评分结果，汇总未完成”标注交付；用户明确索取或要求诊断时除外）；merged CSV 超过 500 行、上传失败或打分全失败时只报告真实原因和行数，不把内部 CSV 当降级交付物。
- [ ] **询价评分误入汇总恢复**：已确认询价模式误存 manual_score_batch 后按兼容最终交付展示本次评分表并结束，不再汇总；保存的 manual_score_batch 缺少所属 requirement 模式记录时停止并保留文件，不借用会话模式、不展示最终交付；误调汇总返回 MODE_NOT_APPLICABLE，不弹重试、不重存/重评/建需。没有当前成功保存结果时不得宣称交付；Gateway 重置后模式与来源按项目恢复（恢复后逐文件重校验），持久记录缺失导致的 CONTEXT_UNAVAILABLE 仍停止，不推断为询价机构；手动拓展汇总因其他错误失败但仍有路径、哈希、需求 ID 与平台校验通过的当前需求评分表时，标注“本批评分结果，汇总未完成”交付，不重搜/重补全/重打分。手动拓展正常分批只保存单批内部表、不展示表格/路径/链接，旧版 manual_source Excel 兼容交付不变。代码回归不代替模型及桌面验收。
- [ ] **上传后不展示 OSS 地址**：助手正文、进度及最终回复不复述完整或截断 OSS 地址、对象路径或 csv_file_path 参数；评分工具仍收到原始地址。上传后提示“数据已合并上传，正在启动打分。”。原始工具面板显示另由宿主验收。
- [ ] **保存 `manual_source` / `manual_score_batch` Excel 遇到同名不同内容**：保留原文件，按需求关联 ID 哈希与内容哈希生成确定性回退名称；`manual_source` 作为用户可见交付时使用本次返回的真实本地链接，手动拓展 `manual_score_batch` 单批中间表不展示表格、路径或链接。重复保存相同内容幂等复用，回退文件被修改或任一路径为符号链接时仍报错。其他 artifact kind 的同名异内容继续报冲突。此项仅验收保存，分批行为另按下一项验收。
- [ ] **Agent 调 `score_manual_source_csv`**：后端返回 `job_id` 时按 30 秒间隔、单轮最多 10 次轮询 `score_manual_source_csv_status({job_id})`，终态后手动拓展保存 manual_score_batch 内部中间表且不展示表格/路径/链接、直接汇总，机构回收保存 manual_source 最终表；后端同步返回 Excel 时直接保存（兼容降级路径，不进 `rank_creators`、`create_submission_batch` 或补充达人信息弹窗）。打分提交/状态返回缺字段配置时不把 `success_count` 当完成、不重搜/补全/file_bridge；同 requirement 按字段工具卡恢复配置，configured 或字段页提交并回复“好了”后只用本轮原始可信 `csv_file_path` 重提一次打分（Hook 附精确 `SCORE_MANUAL_SOURCE_CSV_ARGS` 时原样使用）。
- [ ] **Agent 调 `file_bridge`**：空 CSV 与数据行 >500 在上传前阻断；配置读取顺序固定为插件配置 `fileBridgeOss` → 打包内置凭据（prepack 注入的 `src/tools/file-bridge-oss-defaults.json`），不隐式读取宿主进程环境变量（内部测试/集成可显式注入）；`region`/`bucket`/`objectPrefix` 回落到内置非敏感默认值；links 与补全路径必须都是 `.csv`（否则 `YPSCAN_FILE_BRIDGE_INVALID_INPUT`），merged 内容必须合法 CSV（否则 `YPSCAN_FILE_BRIDGE_INVALID_CSV`），links CSV 必须是当前 requirement 受控保存的产物（`ypscan_save_artifact` 保存的 `manual_creator_links` 或 `ypscan_save_creator_links` 生成的 links CSV）、补全 CSV 必须来自当前 requirement 的 YP Action 原生补全工具（否则 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED`，均不上传）；对象键固定为 `<Object 前缀>/<flow>/<requirement_id>/<sha256>.csv`；上传后必须校验返回的未签名 OSS URL 可匿名读取，失败时报 `YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE`，不得把坏链接继续传给下游。
- [ ] **Agent 需要用户输入或决策**：必须用 `AskUserQuestion` 弹窗，提供简短可执行选项——数值澄清正文先说明原需求为何无法确定该值，再提示“请选择或自定义输入”，不得只问“报价上限是多少”或展示“落库”等内部术语；每题 3 个互斥且可直接回答该字段的具体值、显式 `multiSelect:false`，禁用“1 个数值 + 返回修改/取消”二按钮结构；`header`/`question`/`label`/`description` 每行最多 20 个 Unicode 字符，只在整行将超过 20 字符时断行（先填满接近 20，断行时优先语义边界），禁止逐分句、逐字段拆行；长机构名换行在匹配前还原；不得用普通聊天问句停住流程。界面按该载荷渲染。
- [ ] **Agent 调 `create_with_distributions`**（required=`requirement_id`、`description`、`wechat_notification_message`）：发送前必须弹警示确认——一次 `AskUserQuestion` 只一个问题、恰好两个选项“确认发送/返回修改”、不设 `multiSelect`；最终机构名单与完整企微消息写入问题正文、保留消息原有行结构（只对超 20 字符单行断行），不得拆成选项；`description` 与 `wechat_notification_message` 内容一致；`supplierIds` 与 `supplier_name` 始终为数组、空侧传 `[]`、至少一侧非空。本地 `before_tool_call` 只做 `validate_requirement` 预检，不做发送内容确认门禁；后端执行发送。
- [ ] **Agent 发现机构/达人结果不足**：禁止直接放宽——先复核原需求、解析输出、实际落库参数和各轮可见实际搜索参数；跨 requirement 的 keyword 差异只能作为线索。放宽优先在原有搜索条件上替换同主题关键词、减少非核心人设限定（kolPersonaLabel）；这一阶段报价、CPM、CPE、粉丝范围、返点及其他条件保持原值。用户明确要求放宽即按此优先范围执行，不重复要求逐项确认；未授权时先提出具体关键词和人设调整建议并等待确认。调整后仍不足，复核正确后再按刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → contentFeatureLabel → contentThemeLabel → industryTagLabel 的顺序建议其他可放宽条件，跳过未设置或已无放宽空间的项；每轮说明实际数量、目标数量、缺口及下一项的当前值和建议值，等待用户明确确认该项后才重跑，不自动改动其他条件。平台、品牌、数量、截止时间、内容形式、抖音视频类型、`contentTag` 与主达人类型标签永不放宽；手动拓展重跑的 `ypscan_parse_requirement.demand`/`rawMessagesJson.original` 全文替换为应用全部已确认放宽的完整需求，`parse_outputs` 全量使用本轮新结果；询价机构仍保留未改写原文，累计放宽进 clarifications 和本轮顶层参数；已确认放宽值必须通过 `validate_requirement` 保存，由 Provider 从后台读取，搜索返回后核对实际搜索参数与放宽值一致，不一致时如实报告放宽未传导；足量后界面在结果前汇总全部放宽记录。

## 三、后端结果触发

- [ ] **后端 `rank_mcns` 返回结果**：Agent 只输出五列 Markdown 表格（排名、机构、覆盖达人、返点、综合分），映射固定为 排名=`rank_no`（缺失按响应顺序）、机构=`agency_name`、覆盖达人=`candidate_count`、返点=`rebate_rate`、综合分=`rank_score`，缺失写“未知”；覆盖人数只取当前机构 `candidate_count` 原值，不得用累计字段 `mcn_covered_creator_count`、不得与前序累加、不得用相邻行差值替代；不得展示 `supplier_id`、匹配机构数、推荐数量、推荐理由或其他汇总。界面顺序为：完整表格 → 保存 `mcn_ranking` → 本地链接 → 收件机构弹窗，不再询问业务模式；列表为空时 Agent 进入复核与放宽，不保存空排名表、不猜测机构。
- [ ] **后端 `sync_mcn_inquiry_status` 返回 `inquiries[]`（含 `inquiry_id`）**：Agent 只把本次响应的 `inquiry_ids` 传给 `ingest_mcn_submissions`（不跨轮拼接、不用 trace_id），再 `get_ingest_job` 用同一 `job_id` 轮询至 `succeeded`/`partially_succeeded`；终态只回一份预览 Excel（`excel_file_url` + `excel_columns`，无 links CSV），Agent 先保存机构达人预览表，再让用户选择“补全并打分排序 / 暂不补全”。**`partially_succeeded`**：如实报告哪些机构 pending、哪些已回填（`results[]` 里 `DISTRIBUTION_NOT_SUBMITTED` 即 pending）。正式链路不再调用 `get_workflow_state`、`rank_creators`、`create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`。
- [ ] **后端返回真实错误、幂等冲突（如 `INQUIRY_ALREADY_SENT`）或部分成功**：Agent 原样展示逐机构真实状态，不自动重发已成功机构、不把部分成功说成全成功；模糊/不唯一候选由界面展示供用户选择，后端只收选中的真实 ID；机构名匹配、合并去重、同一 requirement/机构幂等全部由后端负责。
- [ ] **后端 `rank_creators`（已废弃）**：正式链路不再调用该工具；若仍被调用并返回成功，Agent 保存 `ranked_submission` 后结束，但不得把该结果当正式链路交付。

### 最新会话交互回归（2026-09-07）

以下为待执行的模型/桌面行为验收；Hook 单元测试通过不等于这些交互已实测通过。

- [ ] **原文写“返点25%以上”，解析 rebate=null**：Agent 直接采用最低25%，不要求用户再回答25%；粉丝只有“行业头部”等量级描述时须先询问用户具体粉丝区间，不自行换算成数值或按全量区间落库。
- [ ] **需求同时有过期截止时间及其他必要缺项**：首次复核一次问齐；已明确值不重问，不能先提交过期日期再让用户补救。
- [ ] **用户已确认10万粉丝，随后说“去掉行业头部，明确粉丝数，重新搜索”**：直接合并修改并重解析；10万和未修改截止时间不再确认，新 requirement 自动继承本会话已提交字段配置。
- [ ] **手动拓展首次解析后补充/澄清了有效条件**：若当前平台完整有效需求发生变化，Agent 先生成无冲突全文，以同一全文重调解析器并写入 `rawMessagesJson.original`，`parse_outputs` 全量替换；输入未变化且结果有效时不重复解析。询价机构放宽继续保留未改写原文。
- [ ] **目标10人、当前批补全成功20人、评分只返回19行且已有10人推荐**：汇总返回 `await_scores`、`stop_reason=null`，先展示标注为非最终汇总的阶段性进度，不生成最终交付、不开始下一批；任务仍在跑时只等待当前批，终态仍缺行时报告缺失达人并停止。
- [ ] **提交粉丝10万，搜索回传50万**：说明实际参数偏差，不能称为放宽、要求用户接受50万或断言这是零结果的唯一根因；当前工具不能修复时如实报告限制。
- [ ] **状态成功、completed=true、selected_count=0、无文件**：停止轮询并复核；不出现原参数重试弹窗、不宣称交付。参数正确后仅给下一项具体放宽建议，用户确认前不重跑。
- [ ] **宿主技能目录漏列 media-assistant**：Agent 能从 Hook 提供的当前安装路径读取完整 Skill；同会话已读不重复。
- [ ] **过程反馈**：内部步骤连续推进，进度通知不等待“继续”；文案描述业务状态，默认不输出 requirement ID、batch ID 和“落库”。字段提交后的“好了”仍是当前能力边界，未验收自动续接。

## 四、Agent 自律与工程验证

- [ ] **Agent 执行全程**：自主完成所有可执行步骤并持续推进，不要求用户代为操作、整理信息、输入“完成”或排错；仅在缺少必要授权、必要输入、登录或真实 CAPTCHA 时暂停。
- [ ] **Agent 使用结果**：所有结果、链接、文件与状态只用当前 requirement、当前平台、本轮真实 Provider 证据；同一需求多批结果按平台稳定 ID 去重，不混入其他需求/平台/账号/历史 run 数据；粗召回、复核候选与最终名单明确区分；自有 Excel 遵循客户模板。
- [ ] **Agent/工程契约一致**：工具卡、Skill、Hook、MCP schema、数据库字段与实际流程一致；Provider 白名单含 `score_manual_source_csv_status` 且不含已弃用工具（smoke 断言覆盖）；`rank_mcns` 传 `id+platform`，`select_inquiry_form_fields` 传 `platform+requirement_id`；`get_workflow_state`、`rank_creators` 已废弃、不再作为正式链路入口；询价回收链用 `sync_mcn_inquiry_status` 返回的 `inquiry_ids` 直接 ingest，links CSV 统一由 `ypscan_save_creator_links` 归一化生成（手动拓展传 `links_csv_path`，询价回收传 `preview_file_path + platform` 直接读取）；`score_manual_source_csv` 消费 `file_bridge` 返回的 OSS `csv_file_path` 并用 `score_manual_source_csv_status({job_id})` 轮询终态；宿主 YP Action 提供原生补全（`get_xhs_author_business_card`/`get_douyin_author_business_card`），登录由宿主工具内部处理；平台缺失时不得猜测原生补全工具。
- [ ] **修改代码时**：先定位真实原因，保留“用户有效需求 → 工具参数 → 真实返回 → 模型下一步”证据链，分清解析/参数/模型/宿主/Provider 层；加规则前查已有规则与冲突。只做最小完整改动，不新增无必要的状态、缓存、账本、校验实体或权限门禁，共同逻辑保持共享。消融与候选修复在隔离环境一次改变一个因素，记录样本数及轨迹，不在真实业务关闭安全控制。
- [ ] **资料同步**：按 [Wiki 同步矩阵](wiki/sync-and-release.md) 核对 Skill/工具卡、Hook/契约、Spec、README、AGENTS、验收清单和测试的受影响部分，同任务交付；报告更新项、不适用项及原因，不仅更新最先找到的一份文档。
- [ ] **测试**：覆盖核心流程、统一 `ypscan_save_artifact` 的 Excel/CSV 保存链路、Provider 发送结果透传与失败路径；交互问题按 [开发与验证](wiki/development.md) 保留可重复行为样本，检查调用顺序、参数、停止位置和可见结论，而不只检查提示词。分别报告代码、模型和真实宿主验收，mock 不替代真实样本与平台验收，未执行不得标通过。
- [ ] **修改后验证**：执行 lint、typecheck、test、smoke 且全绿；不跳过失败、不降低断言、不修改测试制造成功。
- [ ] **发布前**：按 [Wiki 发布步骤](wiki/sync-and-release.md) 同步 package、manifest、lock 顶层与 lock 根包四处版本，并更新 CHANGELOG；smoke 必须通过。验证真实安装流程与包内容；确认 prepack 是否注入 OSS bundle（在 tgz 内、不在 git 中），未注入时明确警告且不宣称免配置可上传。`npm pack --dry-run` 也可能写入或删除 bundle。核查包内凭据的权限、有效期和分发范围，不打印秘密；Review 结论基于当前代码、真实响应或可复现测试，区分已验证、推断、未知与外部依赖。

## 手动拓展分批评分验收

- [ ] 需求N保持原值，候选按梯度池上限（10 人→30、20 人→50、50 人→100）；归一化后先汇总取得首批名单（不超过 min(20, N)），之后每批最多 20 人；真实候选不足梯度上限时如实报告。
- [ ] N=10，首批10人中有10位“推荐”：生成最终汇总表，剩余20人补全/评分调用均为0；首批10人中6位推荐、次批20人中4位推荐：只新增处理后20人，累计10位后交付；全部耗尽仍不足：交付真实结果并说明推荐缺口。
- [ ] “不推荐”、未知结论、重复达人、其他需求/平台以及处理成功数不能误计推荐。来源文件变化、结论冲突、已终态评分缺行时停止，保留已保存文件，不自动重评；Gateway 重置后来源记录按项目恢复，恢复后逐文件重校验 SHA-256，通过即可继续汇总或分批，不重搜、不重补全、不重打分。
- [ ] 全失败补全批次登记 `failed_author_ids`，失败达人不再被重新排批；用户明确要求重试且成功后，以成功记录取代旧失败。
- [ ] 评分表含综合分 0 的评分行：不写入最终汇总表、不计推荐、不触发缺行等待、不自动重评；交付时按 `excluded_zero_score_count` 如实说明，不写成未评分或补全失败。全部评分行均为 0 时不生成汇总文件。
- [ ] 最终汇总“综合得分”列：改写为 0.7×Provider 相关度分＋0.3×同批同平台性价比分（成本越低分越高；缺失按同批中位数代入并计入 `cost_effectiveness_pending_count`，整批无商业数据时保留原相关度分），按综合分降序、同分按性价比降序；“匹配等级”仍按 Provider 相关度档位，不新增模板列；0 分排除仍以 Provider 原始相关度为准。
- [ ] 单批表为中间产物，最终汇总沿用 Provider 单表模板，保留工作表名、标题、需求信息、分组表头、列宽、颜色、数字格式、冻结行和非 0 分评分行，更新评分数量，不截断推荐前N人；不把未评分者写成“不推荐”。机构回收仍全量补全评分。

- [ ] N=20、候选50人：按汇总返回名单处理首批20人、再处理20人；两批累计20位推荐后停止，剩余10人不补全/评分；跨批重复一致评分行只计一次，最终表保留40位已评分达人，重复汇总幂等。
- [ ] 最终汇总的“星图主页”“抖音主页”“小红书主页”合法 HTTP(S) URL 可点击且指向同一行达人；排序、0分排除后链接不串行，显示文本和样式不变。源表保留，其他列及无效 URL 不转换；链接结构有效不等于远端网页可访问。

代码回归覆盖上述调度指令和注册工具衔接；勾选仍要求真实模型/宿主验收，不能以单元测试代替桌面通过。

- [ ] **字段页归属**：selection_required 或 opened 缺少 requirement_id 或与当前调用不一致时暂停，不展示链接；opened 只表示字段页已生成、等待提交，不等于 configured；旧版无 status/ID 链接仍可展示，有 ID 时必须匹配。
- [ ] **交付或停止后单独重选字段**：提交并回复“好了”后只更新配置，不重搜、重评或重新发起询价确认；流程中重选仅恢复明确等待字段配置的未完成步骤，无法确定时不调用下游。

字段配置按字段工具卡执行：同一会话新需求传 source_requirement_id 继承最近已提交/已配置的需求；用户主动重选才传 force_reselect=true。configured 后直接继续；URL 等待提交；继承失败、平台不兼容或 live schema 不支持新参数时暂停。具体字段仅由 Provider 保存和复制。
