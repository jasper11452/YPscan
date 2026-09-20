# 更新日志

## 1.0.28 — 2026-09-20

- 解析输出白名单新增 `fallback`：Dify 解析工作流除正常搜索条件外还输出一组自动召回放宽计划（有序数组，顺序即执行顺序；每层 `{ change: [{ field, value }] }`，`value` 为该字段应用本层后的最终值，`value: null` 表示取消该条件）。此前 `contractedOutputs()` 白名单静默丢弃该字段，而 Provider 搜索执行侧读取的是落库的 `parse_outputs.fallback`，导致自动放宽整体失效；现在原样透传进 `rawMessagesJson.parse_outputs`，不重排、不去重、不改写、不执行，也不参与本地归一化回填。允许自动调整的字段仅限小红书 `keyword`、`contentTag`、`personalTags` 与抖音 `author_id`、`tag_level_two`、`tag`。
- 放宽语义边界同步：Agent 永不自动放宽任何条件；Provider 搜索执行侧按已保存 fallback 计划自动调整内容召回字段属于执行侧召回策略，不算用户或 Agent 放宽，不需确认、不据此触发复核或重建。人工放宽建议前先对照 `parse_outputs.fallback`，执行侧已覆盖的动作不再重复建议；搜索返回后核对实际搜索参数时，差异仅限 fallback 允许字段不算放宽未传导。
- 同步 SKILL、`ypscan_parse_requirement` 工具卡、`MANUAL_SOURCE_RELAXATION_RULE`／`SEARCH_PARAMETER_REVIEW_RULE`／`RELAXATION_REVIEW_COMPACT_RULE` 三条 Hook 指令、`docs/spec/contracts.md`／`flows.md`、验收清单与 AGENTS 不变量 6；manifest 工具白名单、注册数量与 file_bridge/save_artifact/评分汇总链路未变。
- 验证：`npm run lint`／`typecheck`／`test`（644 项，新增 fallback 逐字透传回归样本）／`smoke`（tools=5, hooks=5）通过。未验证：真实 Provider 搜索时是否按落库 fallback 应用（无观测字段，需真实搜索 E2E 核实）、询价机构 `search_creators` 是否也消费 fallback（相关规则已写成分支中立）、未执行模型多轮行为验收与 YP Action 桌面验收。

## 1.0.27 — 2026-09-17

- 手动拓展需求收集精简为“三项必填 + 一次可选补充”：平台、达人方向、人数缺失时一次问齐（复用宿主 AskUserQuestion，不新增 UI、Hook 状态或 Provider 字段）；三项齐全后首次建需前提供一次“直接开始／补充条件”入口，正文列出品牌、报价等可选条件，只收集用户主动选择补充的项目。用户已明确直接开始、补充完成，或本轮为重解析、放宽重建时不重复提示；取消或关闭停止当轮、不代选。品牌与报价未提供时省略（有值仍校验），无报价、CPM、CPE 档位条件不追问抖音视频类型；询价机构的必填、澄清与弹窗规则不变。
- 手动拓展兼容默认值落在本地 `validate_requirement` 边界：原文、有效澄清与解析结果均无返点时，`rebate` 默认 `[0,1]`（最低 0%，不限制）；完全没有截止时间语境时，填入建需后 30 天的未来绝对 `submissionDeadlineAt`，并在 `description` 追加“提报截止时间由系统默认设置为 …（建需后30天，可覆盖）”。两个默认值都不写回 `original`、`demand`、`parse_outputs` 或 `clarifications`，不生成占位品牌或零报价；用户已提供返点或时间（含模糊、过期、冲突）仍按原规则校验或澄清，`[1,999999999]` 归一为 `[0,999999999]` 等既有归一不变。
- 预检豁免只覆盖上述默认值自身的来源证据：手动拓展不再强制品牌、报价与截止时间证据，默认标记在用户随后给出真实时间或原文出现截止语境时被清除并重新校验；Hook 出站不再补品牌/报价，改为注入一次补充入口指令。其他字段、粉丝默认与询价分支不放宽。
- 同步 SKILL、解析/建需/AskUserQuestion 工具卡、contracts/flows/hooks/tools Spec、README、AGENTS、验收清单与回归样本，并新增记录 `docs/verification/2026-09-16-manual-intake.md`、`docs/verification/2026-09-16-manual-rebate-default.md`；manifest 入参、Provider 白名单与工具注册数量未变。
- 验证：`npm run lint`／`typecheck`／`test`（637 项，新增 `registry` 与 `flow-directives` 样本覆盖默认值、来源豁免与误拦截）／`smoke`（tools=5, hooks=5）通过。真实 Provider 只验证过 `rebate` 默认值可建需与 stored_fields 回读（`requirement_id=ee50e300b2334864a701ead7e415826c`）；30 天截止时间默认值未在真实 Provider 落库核查，未执行模型多轮行为验收与 YP Action 桌面验收，1.0.27 未安装到运行中的应用。

- 修正 Provider 数值字段契约漂移：线上手动拓展在“阅读中位数≥10000”上被 Provider 返回 `INVALID_PAYLOAD`（`could not convert string to float: '[10000,999999999]'`），说明后端把 `viewMedium` 按单值读取；本地却把它列入区间字段，且单值会被归一为 `[v,v]` 后判 `min < max` 失败，该字段在插件内无法产出合法值。现在 `VALIDATE_REQUIREMENT_RANGE_PARAMS` 收敛为 Provider 实际按区间校验的 19 个字段（依据 2026-09-18 对 test Provider `validate_requirement` 探测返回的 `invalid_range_fields`），新增 `VALIDATE_REQUIREMENT_SCALAR_PARAMS`（`interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`femaleRate`、`age1Rate`–`age6Rate`）并只接受单个非负数值字符串（比例 0–1）；无法用单值表达时省略该字段并保留原文，本地不把区间折算成单值。预检对单值字段收到区间时直接给出明确原因，不再等到 Provider 报错；区间字段的格式、归一化与证据规则不变。
- 手动拓展缺少截止时间语境时，工具卡明确要求**省略** `submissionDeadlineAt`，不要自行算时间或写默认说明，否则 `description` 缺少规范标记会被预检判为“没有截止时间证据”；默认值仍由插件填入。同时明确 `refNickname`/`refUrl` 各为单个字符串，多个参考达人只写入 `description` 的标注文本。
- 同步 `validate_requirement` / `ypscan_parse_requirement` 工具卡、`docs/spec/contracts.md`、`docs/review-checklist.md`、AGENTS 不变量 6 与 Hook 格式锁指令；新增记录 `docs/verification/2026-09-18-numeric-field-contract-split.md`。
- 验证：`npm run lint`／`typecheck`／`test`（642 项，新增 `registry` 样本覆盖单值字段拒区间、单值/数值归一与区间-单值清单互斥）／`smoke`（tools=5, hooks=5）通过。真实 Provider 未重验证：12 个单值字段中只有 `viewMedium` 有线上报错证据，其余依据同一白名单推断，单值语义（下限/精确值）以 Provider 为准；未执行模型行为与 YP Action 桌面验收。

## 1.0.26 — 2026-09-14

- 机构回填预览改为行级容错：`read-creator-preview.js` 原先只要有一行非法（ID/主页缺失、平台主页与 ID 不匹配、格式不受支持或含控制字符）就整表报 `YPSCAN_CREATOR_PREVIEW_ROWS`，个别机构回填错误会阻断其余机构的补全与评分。现在逐行排除错误行，正确行继续派生 links CSV；`data.preview.problems` 保留原表行号、所属机构（表内存在“所属机构”列时，缺失只报行号不猜测）与原因，`total_row_count` 改为含排除行并新增 `excluded_row_count`，原始预览表字节不变。全部行无效时仍报 ROWS 且保留原表，不生成空评分表；来源、哈希、唯一工作表、表头歧义校验仍阻断。
- links 保存成功后 Hook 注入 `PREVIEW_ROW_WARNINGS`，要求按机构、原表行号与原因提示用户，正确行继续补全和评分，不等待错误机构修正、不重跑整批。`partially_succeeded` 的失败明细补上 Provider `error.message`，指令明确“有本轮预览表时先保存交付成功结果、按真实原因单独提示失败机构、不等待修正、不重跑成功机构”；只有真实错误支持时才归因为填写不正确。
- 同步 SKILL、`ypscan_save_creator_links`／`get_ingest_job` 工具卡、Spec（flows/hooks/tools）、验收清单与工程 Wiki 入口，并新增修复与阻断分级记录 `docs/verification/2026-09-14-institution-partial-failure.md`；manifest 入参、注册数量、README 主流程与 AGENTS 不变量未变，无需改动。
- 验证：`npm run lint`／`typecheck`／`test`（629 项，新增隔离样本覆盖混合错误行、全部错误、原文件不变与 Hook 继续指令）／`smoke`（tools=5, hooks=5）全部通过。未执行模型行为验收与真实 YP Action 桌面验收；远端 Provider 能否在混合失败机构时返回预览表未验证，测试环境 metadata 审计只核对工具元数据。

## 1.0.25 — 2026-09-10

- 修复宿主参数保留缺口：`select_inquiry_form_fields` 的 `force_reselect` 与 `source_requirement_id` 此前不在 `before_tool_call` 的 `pendingCalls` 白名单里，而 `tool_result_persist` 优先用这份最小记录当参数，导致两个值恒为缺失、重选与继承分支在真实宿主从不执行。后果是单独重选字段后用户确认提交，模型拿到的是“首次选择”指令（即时预检 + 无条件“用户确认已提交后按原分支恢复”），会重启已完成的手动拓展搜索：实测同一已交付需求在修复前连续两次空跑新批次（候选池已取空、后台返回 0 人）。保留这两个调用参数即修复分支判定，不新增状态、缓存或门禁；`force_reselect` 未返回字段页、继承未返回 `configured`/`copied`、需求 ID 不一致等既有暂停条件不变。

- 重选分支的“用户确认已提交后”语句改为条件式：只确认字段配置已更新、不调用任何下游工具；仅当本轮对话明确存在等待字段配置的未完成步骤时才按原分支恢复，无法确定时到此结束，首轮字段页轮询路径仍保持无条件恢复。同时把重选分支的“提交确认后再继续”改为“提交确认后的动作以下方恢复边界为准”，避免同一条指令里出现两处互相拉扯的恢复要求。

- 真实宿主验收：在应用内对已交付需求复跑“`force_reselect` 重选 → 提交字段页 → 确认提交”，注入指令已走重选分支（禁轮询 + 恢复边界 + 条件式恢复），Agent 只确认字段配置已更新并说明原交付有效，未调用 `manual_source_creators`；修复前同一场景两次都发起了新的搜索批次。诊断证据为会话 JSONL 中实际注入的指令原文与 Hook 收到的参数集合，不靠提示词推断。

- 回归新增跨 Hook 用例：先用 `before_tool_call` 记录调用参数，再用不含 params 的结果事件调 `tool_result_persist`（真实宿主形状），断言重选分支生效、继承返回字段页时暂停；临时移除保留字段时该用例失败，修复后通过。Hook、Spec（hooks）与回归测试同步；SKILL、字段工具卡与验收清单无需修改——业务规则本就要求“重选提交后只更新配置”，本次是让实现追上规则。lint/typecheck/test（628 项）/smoke（tools=5, hooks=5）通过。1.0.24 的汇总表底色重算、全列超链接与字段页措辞改动本轮未在 App 内复测。

## 1.0.24 — 2026-09-10

- 交付文件名可读化：Provider 的评分导出名（`manual_source_score_<hash>_<hash>.xlsx`）用户无法分辨，`manual_source` / `manual_score_batch` 两类评分表与手动拓展汇总表统一改为本地可读名 `<项目名>-<达人评分排序表|手动拓展评分表|手动拓展汇总表>-<本地 YYYYMMDD-HHmmss>.xlsx`。项目名取 Agent 在 `validate_requirement` 时自行总结的 `projectName`（经 Hook 随来源记录持久化，清洗非法字符、折叠空白、最长 20 字），缺失时省略首段。同一秒内重复保存同内容幂等复用；恰好同一秒内出现同名异内容（含本地已修改的文件）时在末尾补内容 SHA-256 前 8 位另存，保留两份且不覆盖，符号链接仍拒绝。相比原先“同内容永远复用同一文件”，跨秒重复保存会多出一个带新时间戳的文件。工具卡、Spec（tools/hooks）、README、验收清单与回归测试同步；真实宿主交付文件名未验收。

- 字段状态轮询收紧为每 30 秒一次、累计最多 8 次：宿主会对同一工具同一参数连续 16 次相同结果触发全局无进展断路器，原“10 秒×5 加 30 秒×7、共 12 次”接近该阈值；现改为预检后每次间隔 30 秒、用一次 sleep 等待而非脚本循环调用，含预检共 9 次查询。同时补上“无法确认预检是否曾返回 `unavailable` 时，按预检即 `submitted` 处理（等待用户回复“好了”）”，避免把存量 `submitted` 误判成本轮提交完成。Hook 指令、SKILL、字段工具卡、Spec（contracts/hooks/flows/architecture）、AGENTS/README、验收清单与回归测试同步。

- 宿主工具名匹配拆分业务与本地工具：`stripHostPrefix` 恢复只识别业务工具（裸名、受限的 `<前缀>__<工具名>`，并兼容扁平 MCP 形态 `mcp-<server>_<工具名>`，如 `mcp-04b79900_validate_requirement`），不再把本地工具名当宿主工具全名；Hook 路由改用 `resolveFlowToolName`，本地工具保留裸名 / 最后一个 `__` 后段匹配并兼容扁平名称。修复宿主扁平化工具名时 Hook 全部静默跳过、最终报 `YPSCAN_MANUAL_SCORE_CONTEXT_UNAVAILABLE` 的问题，同时让本地工具参数不再进入 Provider 参数归一化。SKILL、启动指令、Spec（contracts/hooks/tools）、AGENTS/README、验收清单与回归测试同步；真实 pi 内核宿主未复测。

- 分批评分模板样式兼容：单行批次会省略隔行底色等末尾样式定义，汇总时只合并共有编号定义与其他样式元数据完全一致的样式表，补齐末尾定义并保留原编号引用；两种批次顺序都可汇总，单批原表不变。同编号定义冲突、其他样式元数据不兼容、共享字符串不一致仍按 `YPSCAN_MANUAL_SCORE_TEMPLATE` 停止并保留可信分批交付。SKILL、Spec（tools）、验收清单与隔离回归同步。

- 手动拓展汇总表隔行底色按最终行序重算：多批合并排序后，原批次自带的行底色不再与最终行序一致（单行批次还可能省略填充定义）。写表时改用模板自身的两份填充按最终行序重新交替——只接受除 `fillId` 外定义完全一致、一对一且方向一致的样式配对；配对不唯一、缺少另一半或与原行序不符时整表保持原样并照常交付，不新增样式定义、不半带。排序、0 分排除后的行序与源批次表均不受影响。

- 汇总表超链接范围从「星图主页/抖音主页/小红书主页」三列放宽为数据区任意列：整格为合法 HTTP(S) URL 的文本都写为 OOXML 外部超链接（含「蒲公英主页」），非 URL 文本不转换；显示文本、单元格样式、数字格式与单批原表不变。

- 字段页提交确认不再要求用户回复固定口令：`get_inquiry_form_fields_status` 轮询仍是主路径，提示词统一改为「等用户确认已提交」，需要用户回应时只说提交完成后告诉我；预检 `submitted`、`invalid`/未知/失败、8 次上限、重选与继承等兜底路径保留，用户任何明确的完成确认仍是有效恢复信号。Hook、SKILL、字段与打分工具卡、Spec（hooks/flows/architecture/contracts）、AGENTS/README、验收清单与回归测试同步，并新增「指令中不得出现回复固定口令」的负向断言。

- 以上改动已过 lint/typecheck/test（627 项）/smoke（tools=5, hooks=5）；真实宿主的交付文件名、轮询时长回退、双批样式合并、扁平工具名交互与字段页措辞均未在桌面验收，不以单元回归代替；新增的汇总表底色重算与全列超链接已用真实批次文件在隔离工作区逐项核对（源表 SHA 不变、样式与关系数符合预期），真实 App 内呈现仍待重跑汇总后确认。

## 1.0.23 — 2026-09-10

- 字段页提交自动续接：Provider 新增并已进入插件白名单的 `get_inquiry_form_fields_status({requirement_id})` 用于自动确认用户是否已提交字段页，解决“填完后必须手动回复好了”的体验断点。实测（2026-09-10，app MCP 代理 + 服务端 1.9.4）取值仅 `unavailable`（该需求当前无已提交配置）/`submitted`（已有配置，含继承复制）/`invalid`，响应不回显 `requirement_id`、无时间戳与页面实例标识，pending 响应字节恒定。因此状态是需求级存量状态，不能区分“本次打开的页面刚提交”与“此前已有配置”：仅在首次选择且即时预检为 `unavailable` 时轮询（预检 `unavailable` 后 10 秒×5 加 30 秒×7，累计最多 12 次，`submitted` 后立即续接原分支；预检即 `submitted`、`invalid`、未知状态、调用失败或到上限时停止轮询并保留“好了”兼容路径；`force_reselect=true` 与继承场景禁止轮询（会在用户提交前就返回 `submitted`）。上限 12 次是硬约束：宿主对同一工具同一参数连续 16 次相同结果触发全局无进展断路器。Hook、SKILL、字段工具卡（新增 `get_inquiry_form_fields_status.md`）、Spec（contracts/hooks/flows/config/README/architecture）、AGENTS/README、验收清单与回归测试同步；lint/typecheck/test（612 项，其中新增 6 项）通过。真实 App 宿主端到端与超时回退未验收；Provider 若补页面实例 token 或每次变化的状态字段，可评估放宽到 30 轮。

- 宿主工具名匹配兼容扁平 MCP 命名空间：`stripHostPrefix` 除全名和 `<前缀>__<工具名>` 外，按 `mcp-<server>_<工具名>`（如 `mcp-04b79900_validate_requirement`）解析业务工具与本地工具；流程指令的本地工具判断改用同一裸名，不再各自正则。修复宿主扁平化工具名时 Hook 全部静默跳过、最终报 `YPSCAN_MANUAL_SCORE_CONTEXT_UNAVAILABLE` 的问题。SKILL、启动指令、Spec（contracts/hooks）、回归测试同步；真实 pi 内核宿主未复测。

- 字段继承适配 Provider 实际返回的状态名：`select_inquiry_form_fields` 继承成功现返回 `status=copied`（旧契约名 `configured`，现网 payload 不含 `configuration_source`），插件按已配置处理，直接恢复原分支，不再落入“字段选择返回未知状态”暂停；`force_reselect` 未返回字段页、需求 ID 不一致、缺少成功证据或 `status=error` 仍暂停。入口仍是同一继承规则，不新增状态、缓存或门禁。Hook 指令、工具卡、Skill、Spec（contracts/hooks/flows）、AGENTS/README、验收清单与回归测试同步；lint/typecheck/test（603 项）覆盖 `copied` 继承成功、强制重选、`copied` 三种无效 payload 与未知状态回退。真实 App 宿主交互与 Provider 后续状态名变更未重新验收。

## 1.0.22 — 2026-09-10

- 手动拓展来源登记按项目持久化到 `<workspaceDir>/.ypscan/manual-score-sources.json`：需求模式、平台、目标人数、links 路径与哈希、每批原生补全成功/失败名单、各批评分表路径与哈希及冲突标记。Gateway 重置清空内存后，在下一次 Hook 事件或汇总调用时按需读回，并恢复 links 上传白名单，使已评分批次不因重启失效；恢复后仍逐文件重校验 SHA-256，通过才继续汇总或分批，不重搜、不重补全、不重打分。内存记录优先，持久文件写入失败不影响本次工具结果。
- 汇总失败（询价 `YPSCAN_MANUAL_SCORE_MODE_NOT_APPLICABLE` 除外）时逐个复核已登记评分表，路径、SHA-256、需求 ID 与平台全部通过者随错误结果返回 `data.partial_delivery.batch_files`；Hook 注入 `MANUAL_SCORE_BATCH_LINKS`，要求以“本批评分结果，汇总未完成”标注交付本地链接，不当作最终汇总，不重搜、不重补全、不重打分、不新建 requirement，也不要求用户整轮重做。校验不过的批次不展示、不猜测、不补文件。
- `CONTEXT_UNAVAILABLE` 语义收窄为“持久来源记录中缺少可信上下文且没有可交付的已核验评分表”，仍是不可重试的停止，不据此推断为询价机构或已完成。
- Skill、工具卡、Spec（contracts/hooks/tools 等）、验收清单、README 与开发 Wiki 同步；lint/typecheck/test（597 项）/smoke 全绿。持久文件的真实跨重启恢复、Hook 注入后模型对“本批评分结果，汇总未完成”的实际表达与桌面交互未在真实宿主验收。

## 1.0.21 — 2026-09-10

- 本版是首次随包分发性价比混合分的正式安装包：最终汇总“综合得分”列改写为 0.7×Provider 相关度分＋0.3×同批同平台性价比分，按混合分降序、同分按性价比降序；“匹配等级”仍取 Provider 相关度档位，Provider 原始分为 0 的行仍排除。性价比在同批同平台内按商业成本做百分位归一化（成本越低分越高）：抖音用“植入视频-预期CPM”60%＋“植入视频-预期CPE”40%；小红书用“视频笔记一口价÷合作_视频&图文_阅读中位数×1000”（缺失回落日常阅读中位数）与“一口价÷合作互动中位数”（缺失回落日常互动中位数）代理。缺失数据按同批中位数代入并返回 `cost_effectiveness_pending_count`；批内成本取值不足两个不同值（整批无数据、仅一人有数据或全部相同）时保留原相关度分。1.0.20 打包构建于混合分实现之前，本版为首次包含该改动；混合分与排序只有单元和隔离回归，真实宿主运行尚未验收。
- `manual_source_creators_status` 的 `num` 指令改为要求取 Hook 注入的 `MANUAL_SOURCE_TARGET_NUM` 原值，括号内示例（5 人→15、10 人→30、20 人→50、30 人→60、50 人→100）明确不是档位表也不是穷举；表外人数同样按 `manualSourcePoolSize` 梯度公式（10 人以内 3 倍、20 人以内 2n+10、更大取 max(2n, n+30)）算好注入。指令生成有回归测试，模型实发值一致性待真实运行验收。
- `validate_requirement` 本地预检放宽项目日期证据：项目/档期语境中的无年份中文日期可按已解析同年日期通过，证据自带年份时必须同年；没有明确日期证据的日期仍被拒绝。
- Dify 解析与评分工作流完成节点级修复（scope 与 price_basis 路由、净价缺口径稳定 UNKNOWN、复核改为逐 id 判定、final 按 scope 过滤并在理由中生成受控缺证说明），已发布并用线上 service API 直连验收；仓库同步回放脚本、夹具、修复方案与验证记录。真实业务端到端（App 内完整手动拓展交付、Provider 批次编排）未执行。
- Skill、工具卡、Spec、验收清单、开发 Wiki 与回归测试同步；lint/typecheck/test/smoke 全绿。

## 1.0.20 — 2026-09-09

- 最终评分汇总为“星图主页”“抖音主页”“小红书主页”列中的合法 HTTP(S) URL 增加 Excel 超链接，按排序后的达人行关联目标，保留原文本、样式和单批原表；不放开已有超链接模板的合并限制。补充 N=20 两批累计、跨批去重、剩余候选早停与幂等的隔离回归。
- 字段选择适配 `source_requirement_id` 继承与 `force_reselect` 主动重选：同一会话新需求可继承已提交配置，`configured` 后直接继续，字段页才等待提交；继承失败或接口不支持新参数时暂停。需求仍独立创建，具体字段由 Provider 保存和复制。
- 字段页归属与重选恢复：`selection_required` 与 Provider 实际返回的 `opened` 都表示字段页等待提交，缺少需求 ID 或与当前调用不一致时不展示链接；`opened` 不得当作 `configured`，旧版无 ID 响应保持兼容。单独重选只更新配置，仅恢复明确等待字段配置的未完成步骤，不重启已完成或停止的业务。
- 手动拓展单批 `manual_score_batch` 作为内部中间产物，不展示表格、路径或链接，保存后继续汇总；询价误存该类型时仍按 Hook 指示交付真实评分表。
- Skill、工具卡、Spec、验收清单及回归测试已同步。代码层检查已在本次变更完成时通过；Provider 新参数、真实字段继承及模型/宿主交互尚未验收，测试环境最近一次 schema 核对仍未提供新增参数。

## 1.0.19 — 2026-09-09

- 手动拓展候选池由固定三倍改为按目标人数梯度取数：10 人→30、20 人→50、50 人→100；首批不超过 `min(20, 需求人数)`，之后每批最多 20 人。Hook、Skill、工具卡、Spec、验收清单和回归测试已同步，Provider 是否按 `num` 真实取足仍待 live 验收。
- 评分汇总完整性：当前批存在已补全但缺评分行的达人时，优先返回 `await_scores` 和阶段性进度，不被推荐达标或候选耗尽覆盖，也不生成最终汇总；综合分为 0 的评分行不写入最终表并按 `excluded_zero_score_count` 如实说明，全部为 0 时不生成汇总文件。
- 误用恢复收紧：询价评分误存为 `manual_score_batch` 时仍按当前真实评分表交付，不进入汇总；汇总误用于询价返回 `MODE_NOT_APPLICABLE` 且不重试。保存 `manual_score_batch` 时若所属 requirement 没有已登记模式，停止并保留文件，不借用会话级模式、不汇总、不重存或重评。手动拓展首次澄清改变有效需求时，使用合成后的完整需求全文重解析并全量替换解析输出。
- 用户文案收敛：`file_bridge` 上传后只提示“数据已合并上传，正在启动打分。”，不复述 OSS 地址、对象路径或 `csv_file_path`；内部参数仍原样传给评分工具。
- 同步修复方案、Spec 与文档基线；Dify 评分工作流回放脚本更新导出 SHA，并新增内嵌 API Key 与未解析环境变量引用检查。Python 缓存文件加入 gitignore。
- 验证：`lint`/`typecheck`/`test`/`smoke` 全绿；Dify 离线回放通过确定性核验、终态组合和证据链检查。真实 Provider 梯度取数、线上工作流部署及真实宿主端到端行为未在本版打包中重新验收。

## 1.0.18 — 2026-09-09

- 粉丝量级不再换算成数值：原文出现“头部/肩部/腰部/尾部/行业头部”等量级描述时，SKILL 与解析工具卡改为必须询问用户具体粉丝区间，不再自行换算、也不再按全量区间落库；未提及粉丝或明确“不限/无要求”仍落库全量区间 `[0,999999999]`。配套 Dify 手扒解析工作流删除小红书/抖音的量级换算表（已发布验证）。
- 标签去兜底：Dify 小红书博主类目/博主人设、抖音二级标签改为优先具体标签，不选以“其他”结尾的兜底标签，只能落到兜底类目时输出 `[]`（工作流侧，与本次解析规则同步）。
- 验证：`lint`/`typecheck`/`test`/`smoke` 全绿；Dify draft/run 多次验证量级词不再换算、显式粉丝数字保留、标签不再落“其他”。插件侧行为（App 追问粉丝区间）需安装本版后在新会话验收。

## 1.0.17 — 2026-09-08

- 插件代码与行为无变更；本版作为评分工作流 v3.6 的配套发布标记。
- 评分工作流 v3.6：代表图上限由 8 张降为 3 张；视觉模型调用关闭思考（`enable_thinking=false`）并把 `max_tokens` 由 800 降到 400。实测视觉节点耗时 14.1s → 3.0s，小红书单次运行 41.4s → 29.2s，回到 Provider 45 秒读超时以内。
- 验证：`lint`/`typecheck`/`test`/`smoke` 全绿；工作流草稿运行计时 3 次；真实小红书批次重跑 9/9 成功、`last_error=null`，交付表 74 列/9 行、结论二值、分数数值并通过消费方校验。
- 已知边界：Provider 调 Dify 的 45 秒读超时未变（`score_manual_source_csv` schema 无该参数），仍需后端提高以留余量。

## 1.0.16 — 2026-09-08

- 取消原生达人补全前的登录准备提示：不再要求 Agent 每批先调用 `pgy_auth_prepare`/`douyin_auth_prepare`。宿主 YP Action 的补全工具（`get_xhs_author_business_card`/`get_douyin_author_business_card`）自身处理登录态、按需打开登录窗口；插件不再注入 `AUTH_PREPARE_TOOL`/`AUTH_PREPARE_ARGS`，也不保留两张登录准备工具卡。SKILL、工具卡、Hook、Spec、验收清单与测试同步。
- `validate_requirement` 本地预检修正：`rawMessagesJson` 结构不可读时，不再连带误报依赖它取证的 brandName/quantityTotal/rebate 等证据缺失，只报告可独立判断的缺失与格式问题。
- 验证：`lint`/`typecheck`/`test`/`smoke` 全绿；回归断言改为确认补全指令不再包含 `auth_prepare`。真实桌面 E2E（抖音、小红书手动拓展）在 1.0.15 规则下已验证补全与交付链路本身可用；取消登录准备提示后的宿主补全路径以宿主工具自述的“内部处理登录”为准，未在登录失效场景下复测。
- 已知边界：Provider 报价上限未传导（确认值与实际检索值不一致）为 Provider 侧问题，本轮未修。

## 1.0.15 — 2026-09-08

- 用户可见产物收敛：只展示评分表、汇总表、MCN 排名表和机构回填预览表；links CSV、补全 CSV、merged CSV 均为内部中间产物，不主动展示表格、下载链接或本地文件路径，也不作为交付物，用户明确索取或要求诊断时除外。
- 工具层同步：`ypscan_save_artifact` 的 `manual_creator_links`/`mcn_creator_links`、`ypscan_save_creator_links` 和 `file_bridge`（除遗留 `mcn_complete_only` 分支）返回 `display_required=false`，本地路径仍保留供下游使用；Hook 不再注入 CSV 展示链接令牌，改用 `CREATOR_LINKS_LOCAL_PATH` 等路径令牌，并保留评分表、汇总表、排名表和预览表的展示指令。
- 合并失败、超过 500 行或打分全失败时不再把内部 CSV 当降级交付物，只报告真实原因与行数；`mcn_complete_only` 因当前流程不可达且本地 merged CSV 是其唯一产物，保留展示。
- 验证：lint/typecheck/test/smoke 全绿，新增展示开关与 Hook 指令回归断言；模型行为与真实宿主展示（含宿主是否自行渲染原生补全附件）尚未验收。

## 1.0.14 — 2026-09-08

- 修复桌面 E2E 实测暴露的两个 Hook 缺陷：`manual_source_creators_status` 的 live 中间态（success + completed=false）不再误注入暂停弹窗指令，改按 BATCH_NOT_READY 继续轮询；原生补全全失败批次（csv_file=null）现在同样登记失败名单，汇总不再重排失败达人，同一达人重试成功后以成功记录取代旧失败。
- 手动拓展最终汇总表改为逐字节保留 Provider 单表模板：工作表名、标题、需求信息、分组表头、列宽、颜色、数字格式、冻结行和单元格类型原样保留，只更新“评分数量”、按综合得分重排全部评分行并同步 dimension/autoFilter；不再输出“推荐达人/已评分达人”双表，也不按推荐结论过滤或截断前 N 位。模板含公式、关联对象、数据区合并或多工作表等无法安全移动的内容时以 `YPSCAN_MANUAL_SCORE_TEMPLATE` 停止，不输出损坏表。新增 `xml2js` 依赖。
- 结果不足的放宽顺序调整为先替换同主题关键词、减少非核心人设限定（`kolPersonaLabel`），该阶段报价、CPM、CPE、粉丝范围、返点及其他条件保持原值；用户明确要求放宽时直接执行，未授权时先给方案等确认。仍不足且复核正确后，再按刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → `contentFeatureLabel` → `contentThemeLabel` → `industryTagLabel` 逐项建议并等待该项确认。
- 已用两份真实 Provider 评分表离线合并并逐像素对比：模板样式、表头、列宽、冻结行、评分值与工作表名一致；未重新调用 Provider 评分，跨批评分尺度与一次性评分是否等价未验证。

## 1.0.13 — 2026-09-08

- 手动拓展增加本地评分汇总：最多三倍候选、20人/批，逐批补全/上传/评分，去重“推荐”人数达标或候选耗尽后交付汇总表；机构回收仍全量处理。新增 `ypscan_summarize_manual_scores` 和 `manual_score_batch`，本地注册改为5工具、5 Hook；未知结论或来源缺失时停止。
- 评分表同名不同内容按需求与内容哈希保留各批文件；新增 write-excel-file 生成最终两表 Excel。真实测试已验证同一测试需求两批独立任务与四条“不推荐”结果；足量早停由本地回归覆盖，模型与桌面行为尚未验收。

- 新增项目开发 Wiki，固化分层定位、最小修复、消融实验、模型行为验证、文档同步矩阵与发布步骤；AGENTS、README、Spec 和验收清单接入同一工程资料入口，并修正相关过时描述。
- smoke 增加 `package-lock.json` 顶层与根包版本校验，连同 package、manifest 共校验四处版本；新增隔离回归测试，覆盖版本漂移与 lock 根包记录缺失。
- 模型行为基线与 OSS 凭据权限核查仍为待执行事项，不代表已通过真实宿主或上传验收。

## 1.0.0 — 2026-09-01

- 首个正式版：双业务功能（询价机构 + 手动拓展）链路与 Provider 契约稳定收敛。相对 0.1.27 仅升版本号，无行为变更。

## 0.1.27 — 2026-09-01

- 询价收件机构恢复自定义机构名输入：用户可直接输入机构名称（含弹窗自定义输入）；命中本轮榜单且带非空 `supplier_id` 的走 `supplierIds`，未命中或无 ID 的原始名称保留到 `supplier_name` 交给 Provider；匹配仍只限本轮同一 requirement、同一平台，不模糊匹配、不跨轮复用。
- 收件机构选择弹窗统一 `multiSelect=true`，避免两选项场景被宿主当成确认弹窗而隐藏自定义输入入口；新增冲突拦截：`暂不询价` 不得与机构或 `询价全部机构` 同时成立，空输入、未明确机构、无法解析、冲突或歧义时不得继续询价。
- 手动拓展可信数量为 0 或不足时，交付当前 Excel 后进入与询价机构共享的“先复核、再逐项自动放宽”流程：每轮提前告知唯一修改项，重新解析、复核、创建新 requirement 并重新选择字段；全部允许项用完仍不足时询问“手动修改需求 / 改用询价机构 / 结束”。数量未知时不猜测、不解析 Excel、不自动放宽，当前 Excel 即最终结果；足量时在最终结果前汇总累计放宽条件。
- `create_submission_batch.submission_batche_page` 首次生成提报表固定传页码 `1`；明确不得用 `rank_creators.run_id`（即使为正整数）、达人数量、缺口、batch ID 等业务数字充当页码，只有用户之后明确要求第 N 页才传对应 N。
- 新增 Provider 侧 MCP 稳定性审计与 `get_workflow_state` 重构方案文档、Provider 工具契约审计脚本，并同步扩展流程与契约回归测试。

## 0.1.25 — 2026-08-31

- 手动拓展结果为 0 或低于目标数量时，仍交付真实 Excel，并明确数量与缺口、建议用户放宽条件。
- 仅依据 Provider 明确返回的可信数量判断不足，不解析 Excel 或猜测数量，也不自动放宽、重跑或复用旧 requirement。
- 每次开始询价机构或手动拓展都重新解析、复核并创建独立的新 requirement，不再跨功能复用 requirement 或字段配置。
- 收紧手动拓展和提报表 batch ID 的正整数与来源契约，缺失或非法时停止，避免使用其他 ID 顶替。
- 统一异步轮询、参考达人字段和同步手动拓展 Excel 保存规则，并补充契约回归测试。

## 0.1.24 — 2026-08-31

- 正式发布 0.1.24：询价机构与手动拓展双业务链路，业务条件不变时顺序复用同一需求。
- 企微发送前改用警示弹窗确认，`create_with_distributions` 的 `description` 与 `wechat_notification_message` 内容一致。
- Provider MCP 切换到 HTTP；小红书与抖音提报表均支持达人信息补全，导出轮询持续携带当前平台。

## 0.1.24-beta93 — 2026-08-31

- 支持询价机构与手动拓展双业务链路，并允许条件不变时顺序复用同一需求。
- 结果不足时先复核再按固定顺序放宽；完善手动拓展状态轮询与工具契约。
- 修复抖音提报表误触发小红书达人补全，补充弹窗载荷校验和相关回归测试。

## 0.1.24-beta90 — 2026-08-27

- 修复需求必填项缺失时未统一询问的问题，并将 `contentTag` 缺失明确为重新解析。
- 修复询价机构选择后未调用 `select_inquiry_form_fields` 的流程指令，补充确定的 requirement 参数。
- 候选机构超过 4 家时改用提示型弹窗，支持询价全部机构或按表格编号/完整名称自定义选择。
- 在 `validate_requirement` Provider 调用前增加未知字段和入参类型预检，并同步工具卡契约。
- 新增上述流程、类型和工具卡契约回归测试，发布包版本更新为 `0.1.24-beta90`。

## 0.1.24-beta89 — 2026-08-27

- 精简工具结果 Hook 中重复的流程说明，降低模型上下文占用；保留需求 ID、动态调用参数、保存顺序、轮询、发送确认和安全阻断规则。
- `get_workflow_state` 成功结果不再追加重复 directive；搜索结果中的表格链接仍禁止通过 Browser、脚本或其他方式下载，模糊机构候选仍必须使用 `AskUserQuestion`。
- 新增 Hook 精简与安全边界回归测试，发布包版本更新为 `0.1.24-beta89`。

## 0.1.24-beta88 — 2026-08-27

- 修复需求解析结果中的字符串化 JSON 被错误保留到落库边界的问题，统一兼容标签数组、品牌数组和 `dy_`/`xhs_` 数值对象。
- 新增回归测试，覆盖 `contentTag`、`*Label`、`dybrandName`、`dy_kolOfficialPrice`、`dy_cpm`、`dy_cpe` 的字符串化解析输入。
- 发布包版本更新为 `0.1.24-beta88`。

## 0.1.24-beta85 — 2026-08-25

- 统一抖音达人类型字段为 `xtTalentTypeLabel`，清理错误拼写。
- 小红书、抖音主达人类型解析为 `null` 时，先询问用户再进入需求校验。
