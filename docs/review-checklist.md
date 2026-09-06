# 用户要求 Review Checklist

> 角色约定：**用户**＝发起需求/选择/确认/修改的人；**Agent**＝OpenClaw 模型（按工具卡与 Hook 指令执行）；**界面**＝宿主渲染的弹窗、Markdown 表格与本地文件链接（由插件载荷与 Hook 指令决定）；**后端**＝Provider MCP（搜索/排名/发送/入库/打分/手动拓展任务）与 Dify（需求解析）。
>
> 每一条按「触发 → 各角色行为」写：**用户/Agent/后端 做了什么时**，Agent、界面、后端各自会怎样。核对时逐条打勾。

## 一、用户动作触发

- [ ] **用户第一次提出询价机构或手动拓展（真正开始新功能）**：Agent 必须先 `ypscan_parse_requirement → 复核 → validate_requirement` 创建独立的新 requirement，不复用旧 requirement、字段配置、机构、达人、batch、CSV 或 Excel；两功能不得并行或处理中切换，前一功能完成/停止后切换也必须重新建需并重新提交字段配置；界面不弹窗（模式不明除外）；后端只在新 requirement 落库后收到搜索/发送等调用。
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
- [ ] **Agent 调用 `validate_requirement` 时**：界面（插件预检）一次性校验全部必填字段与格式——通过才放行，阻断则 Provider 未写入，Agent 先用弹窗收齐全部用户值再重提，禁止逐字段、逐类型盲试；品牌、项目名、数量、截止时间、可选项目日期必须有 `rawMessagesJson.original` 或非空 `clarifications` 中的明确值证据，空澄清键、解析默认值、Agent 推断不算证据（解析标签不适用此证据门禁）；后端只收到一次完整合法写入，真实 Provider 错误只按明确错误处理。
- [ ] **Agent 处理解析输出**：八个可选 Label 数组原样落库（保留元素与顺序），缺失或 `null` 直接省略，不做映射、不推断、不询问；唯一合法数值直接采用；只有数值缺失、多候选、冲突或需选择映射时才弹数值澄清；`contentTag` 缺失/无效时重新解析，不问用户、不自补；未知字段不向 Provider 塞。后端收到的字段与解析结果一致。
- [ ] **Agent 调 `search_creators` 成功后**：忽略 `creators_export_path` 等表格链接，直接用同一 requirement 调 `rank_mcns({id, platform})`；仅询价分支允许调用 `search_creators`。后端检索单价只按原价下 30%、上 20% 扩展一次；Agent 不得把该扩展区间回写需求参数。
- [ ] **Agent 调 `select_inquiry_form_fields`**：必须按当前 live schema 传 `platform` 与当前真实 `requirement_id`；新建 requirement（含跨功能切换）必须重新选择，只有同一 requirement 已有提交证据时才复用，其他 requirement 的字段配置或历史“不再选字段”要求不能跳过；原样展示 URL 后本轮结束，用户为该 requirement 提交并明确回复“好了”前不得试调后续搜索、手动拓展或打分；后端持久化字段配置。
- [ ] **Agent 调 `manual_source_creators`**：只传 `{requirement_id[, demand]}`，不带 `num`；`demand` 只传当前完整未改写的用户原文，不传解析输出或 `rawMessagesJson`，schema 不支持 `demand` 时不猜字段名；后端异步生成或同步返回 links CSV。
- [ ] **Agent 调 `manual_source_creators_status`**：`num` 只在当前环境 live schema required 时传（每批 URL 数量，正整数）；Hook 先通过 `MANUAL_SOURCE_TARGET_NUM` 提示该值。提交后先等 30 秒再第 1 次查询，之后每 30 秒一次，单轮累计最多 10 次；第 10 次未完成如实报告并停止，不弹窗、不查第 11 次、不重复提交或换 ID；后端返回终态 links CSV 后 Agent 保存 `manual_creator_links`，再用 `ypscan_save_creator_links` 归一化为受控三列 CSV（短链或无法推导 creator_id 时报错停止，不进入补全），再按平台分 20 个 author 一批原生补全（小红书 `get_xhs_author_business_card` 固定 `page_count=1`；抖音 `get_douyin_author_business_card`）。
- [ ] **Agent 调 `ypscan_save_creator_links`（两链路归一化）**：传当前 `requirement_id`、`platform` 与 `links_csv_path`（手动拓展：`ypscan_save_artifact` 保存的原始 links CSV）或 `preview_file_path`（询价回收：已登记且哈希未变的预览 xlsx），二者互斥；工具解析并归一化出 `source_record_id,creator_id,url` CSV 并登记为当前 requirement 的合法 links 来源：links CSV 只有 url 列时按平台主页规则推导 creator_id，短链或无法推导、ID 与主页不匹配时整份报错停止；界面原样展示本地链接，随后按 20/批原生补全 → `file_bridge(flow=manual_source)` → 打分；非法行或去重后为空时报错，不得用 Browser/脚本代写。
- [ ] **Agent 调原生达人补全工具**：每批只信 `csv_file`、`successful_author_ids`、`failed_author_ids`；部分成功保留成功 CSV，不自动重试整批；某批 `csv_file` 缺失则停止后续 merge/upload/打分，界面如实报告失败达人。
- [ ] **Agent 调 `file_bridge`**：一次传 links CSV 与全部补全 CSV，由工具内部合并；links 与补全文件必须都是 `.csv`，且必须是当前 requirement 受控保存的 links CSV 与 YP Action 原生补全产物，否则工具返回 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED` 且不上传；merged CSV 数据行超过 500 时必须跳过上传并交付本地文件；未超限才使用返回的服务器侧 `csv_file_path` 调 `score_manual_source_csv({requirement_id, csv_file_path})`。
- [ ] **Agent 调 `score_manual_source_csv`**：后端返回 `job_id` 时按 30 秒间隔、单轮最多 10 次轮询 `score_manual_source_csv_status({job_id})`，终态后才保存 manual_source Excel；后端同步返回 Excel 时直接保存（兼容降级路径，不进 `rank_creators`、`create_submission_batch` 或补充达人信息弹窗）。打分提交/状态返回缺字段配置时不把 `success_count` 当完成、不重搜/补全/file_bridge；同 requirement 重新选择字段，用户回复“好了”后只用本轮原始可信 `csv_file_path` 重提一次打分（Hook 附精确 `SCORE_MANUAL_SOURCE_CSV_ARGS` 时原样使用）。
- [ ] **Agent 调 `file_bridge`**：空 CSV 与数据行 >500 在上传前阻断；配置读取顺序固定为插件配置 `fileBridgeOss` → 打包内置凭据（prepack 注入的 `src/tools/file-bridge-oss-defaults.json`），不隐式读取宿主进程环境变量（内部测试/集成可显式注入）；`region`/`bucket`/`objectPrefix` 回落到内置非敏感默认值；links 与补全路径必须都是 `.csv`（否则 `YPSCAN_FILE_BRIDGE_INVALID_INPUT`），merged 内容必须合法 CSV（否则 `YPSCAN_FILE_BRIDGE_INVALID_CSV`），links CSV 必须是当前 requirement 受控保存的产物（`ypscan_save_artifact` 保存的 `manual_creator_links` 或 `ypscan_save_creator_links` 生成的 links CSV）、补全 CSV 必须来自当前 requirement 的 YP Action 原生补全工具（否则 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED`，均不上传）；对象键固定为 `<Object 前缀>/<flow>/<requirement_id>/<sha256>.csv`；上传后必须校验返回的未签名 OSS URL 可匿名读取，失败时报 `YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE`，不得把坏链接继续传给下游。
- [ ] **Agent 需要用户输入或决策**：必须用 `AskUserQuestion` 弹窗，提供简短可执行选项——数值澄清正文先说明原需求为何无法确定该值，再提示“请选择或自定义输入”，不得只问“报价上限是多少”或展示“落库”等内部术语；每题 3 个互斥且可直接回答该字段的具体值、显式 `multiSelect:false`，禁用“1 个数值 + 返回修改/取消”二按钮结构；`header`/`question`/`label`/`description` 每行最多 20 个 Unicode 字符，只在整行将超过 20 字符时断行（先填满接近 20，断行时优先语义边界），禁止逐分句、逐字段拆行；长机构名换行在匹配前还原；不得用普通聊天问句停住流程。界面按该载荷渲染。
- [ ] **Agent 调 `create_with_distributions`**（required=`requirement_id`、`description`、`wechat_notification_message`）：发送前必须弹警示确认——一次 `AskUserQuestion` 只一个问题、恰好两个选项“确认发送/返回修改”、不设 `multiSelect`；最终机构名单与完整企微消息写入问题正文、保留消息原有行结构（只对超 20 字符单行断行），不得拆成选项；`description` 与 `wechat_notification_message` 内容一致；`supplierIds` 与 `supplier_name` 始终为数组、空侧传 `[]`、至少一侧非空。本地 `before_tool_call` 只做 `validate_requirement` 预检，不做发送内容确认门禁；后端执行发送。
- [ ] **Agent 发现机构/达人结果不足**：禁止直接放宽——先复核原需求、解析输出、实际落库参数和各轮可见实际搜索参数；跨 requirement 的 keyword 差异只能作为线索。确认正确后才按固定顺序向用户逐项建议放宽（刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → `contentFeatureLabel` → `contentThemeLabel` → `kolPersonaLabel` → `industryTagLabel`），每轮只展示实际数量/目标数量/缺口和唯一下一项；提出该项后本轮结束，用户明确确认后才建新 requirement 重跑，总体授权不替代逐轮确认。平台、品牌、数量、截止时间、内容形式、抖音视频类型、`contentTag` 与主达人类型标签永不放宽；重跑的 `ypscan_parse_requirement.demand`/`rawMessagesJson.original` 保留未改写原始需求，累计放宽进 clarifications 和本轮顶层参数；`manual_source_creators.demand` 必须携带已应用放宽值的有效搜索文本（原文对应字段替换为放宽后值），搜索返回后核对实际搜索参数与放宽值一致，不一致时如实报告放宽未传导；足量后界面在结果前汇总全部放宽记录。

## 三、后端结果触发

- [ ] **后端 `rank_mcns` 返回结果**：Agent 只输出五列 Markdown 表格（排名、机构、覆盖达人、返点、综合分），映射固定为 排名=`rank_no`（缺失按响应顺序）、机构=`agency_name`、覆盖达人=`candidate_count`、返点=`rebate_rate`、综合分=`rank_score`，缺失写“未知”；覆盖人数只取当前机构 `candidate_count` 原值，不得用累计字段 `mcn_covered_creator_count`、不得与前序累加、不得用相邻行差值替代；不得展示 `supplier_id`、匹配机构数、推荐数量、推荐理由或其他汇总。界面顺序为：完整表格 → 保存 `mcn_ranking` → 本地链接 → 收件机构弹窗，不再询问业务模式；列表为空时 Agent 进入复核与放宽，不保存空排名表、不猜测机构。
- [ ] **后端 `sync_mcn_inquiry_status` 返回 `inquiries[]`（含 `inquiry_id`）**：Agent 只把本次响应的 `inquiry_ids` 传给 `ingest_mcn_submissions`（不跨轮拼接、不用 trace_id），再 `get_ingest_job` 用同一 `job_id` 轮询至 `succeeded`/`partially_succeeded`；终态只回一份预览 Excel（`excel_file_url` + `excel_columns`，无 links CSV），Agent 先保存机构达人预览表，再让用户选择“补全并打分排序 / 暂不补全”。**`partially_succeeded`**：如实报告哪些机构 pending、哪些已回填（`results[]` 里 `DISTRIBUTION_NOT_SUBMITTED` 即 pending）。正式链路不再调用 `get_workflow_state`、`rank_creators`、`create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`。
- [ ] **后端返回真实错误、幂等冲突（如 `INQUIRY_ALREADY_SENT`）或部分成功**：Agent 原样展示逐机构真实状态，不自动重发已成功机构、不把部分成功说成全成功；模糊/不唯一候选由界面展示供用户选择，后端只收选中的真实 ID；机构名匹配、合并去重、同一 requirement/机构幂等全部由后端负责。
- [ ] **后端 `rank_creators`（已废弃）**：正式链路不再调用该工具；若仍被调用并返回成功，Agent 保存 `ranked_submission` 后结束，但不得把该结果当正式链路交付。

## 四、Agent 自律与工程验证

- [ ] **Agent 执行全程**：自主完成所有可执行步骤并持续推进，不要求用户代为操作、整理信息、输入“完成”或排错；仅在缺少必要授权、必要输入、登录或真实 CAPTCHA 时暂停。
- [ ] **Agent 使用结果**：所有结果、链接、文件与状态只用当前 requirement、当前平台、本轮真实 Provider 证据；同一需求多批结果按平台稳定 ID 去重，不混入其他需求/平台/账号/历史 run 数据；粗召回、复核候选与最终名单明确区分；自有 Excel 遵循客户模板。
- [ ] **Agent/工程契约一致**：工具卡、Skill、Hook、MCP schema、数据库字段与实际流程一致；Provider 白名单含 `score_manual_source_csv_status` 且不含已弃用工具（smoke 断言覆盖）；`rank_mcns` 传 `id+platform`，`select_inquiry_form_fields` 传 `platform+requirement_id`；`get_workflow_state`、`rank_creators` 已废弃、不再作为正式链路入口；询价回收链用 `sync_mcn_inquiry_status` 返回的 `inquiry_ids` 直接 ingest，links CSV 统一由 `ypscan_save_creator_links` 归一化生成（手动拓展传 `links_csv_path`，询价回收传 `preview_file_path + platform` 直接读取）；`score_manual_source_csv` 消费 `file_bridge` 返回的 OSS `csv_file_path` 并用 `score_manual_source_csv_status({job_id})` 轮询终态；平台缺失时不得猜测原生补全工具。
- [ ] **修改代码时**：先定位真实原因，只做最小改动；不新增无必要的状态、缓存、账本、校验实体或权限门禁，共同逻辑保持共享。
- [ ] **测试**：覆盖核心流程、统一 `ypscan_save_artifact` 的 Excel/CSV 保存链路、Provider 发送结果透传与失败路径；mock 不替代真实样本与平台验收。
- [ ] **修改后验证**：执行 lint、typecheck、test、smoke 且全绿；不跳过失败、不降低断言、不修改测试制造成功。
- [ ] **发布前**：验证真实安装流程与包内容；确认 prepack 已把本机 OSS 凭据注入安装包（`src/tools/file-bridge-oss-defaults.json` 在 tgz 内、不在 git 中），未注入时明确警告；Review 结论基于当前代码、真实响应或可复现测试，并区分已验证、推断、未知与外部依赖。
