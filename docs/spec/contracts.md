# 参数契约与预检

`src/contract/registry.js` 是 Provider 面向流程共用的参数边界：确定性、无损归一化 + 无状态预检，不保留 workflow 状态。

## 1. 常量

| 常量                               | 值                                                               | 说明                                                                |
| ---------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `BUSINESS_MODE_VALUES`             | `["询价机构", "手动拓展"]`                                       | 用户侧业务模式                                                      |
| `PROVIDER_MANUAL_BUSINESS_MODE`    | `直接手扒`                                                       | 手动拓展的 Provider 兼容线值，仅出站边界映射，Agent 不得使用或展示  |
| `HOST_PREFIXES`                    | `mcp__ypscan__`、`ypscan__`、`mcp__ypmcn__`、`ypmcn__`、`test__` | 工具名前缀（命名空间），按最后一个 `__` 后段匹配实际工具名          |
| 平台别名                           | `xhs`/`小红书`→`xiaohongshu`；`dy`/`抖音`→`douyin`               | 归一化规则                                                          |
| `MAX_FOLLOWER_COUNT`               | `999_999_999`                                                    | 粉丝技术上限                                                        |
| `UNRESTRICTED_FOLLOWERCOUNT_RANGE` | `"[0,999999999]"`                                                | 粉丝无要求时的落库值                                                |
| `TOOL_REGISTRY`                    | 19 个业务工具名                                                  | 含已弃用工具名，供 `stripHostPrefix` 做宿主工具名匹配；不代表白名单 |

## 2. Provider MCP 白名单（manifest `toolFilter.include`）

`validate_requirement`、`search_creators`、`rank_mcns`、`select_inquiry_form_fields`、`create_with_distributions`、`sync_mcn_inquiry_status`、`ingest_mcn_submissions`、`get_ingest_job`、`manual_source_creators`、`manual_source_creators_status`、`score_manual_source_csv`、`score_manual_source_csv_status`、`rank_creators`（共 13 个）。

明确不暴露：`get_workflow_state`、`create_submission_batch`、`get_creator_detail`、`get_creator_detail_export`、`get_selected_inquiry_form_fields`（已弃用）。

## 3. validate_requirement 参数契约

`VALIDATE_REQUIREMENT_PARAMS` 共 64 个已声明字段；未声明字段在预检中被拒。

### 必填（10 个）

`status`、`platform`、`brandName`、`projectName`、`quantityTotal`、`submissionDeadlineAt`、`rebate`、`followercount`、`contentTag`、`rawMessagesJson`。

> Provider v1.9.4 schema 的 required 为 8 个（不含 `brandName`、`followercount`）；本地预检仍按上表 10 个必填执行，不随 Provider 放宽。

- `status` 固定 `"ready"`；`projectName` 由 Agent 根据需求自行总结生成，不弹窗询问。
- `platform` 只允许 `xiaohongshu` / `douyin`。
- `contentTag` 必须来自本次解析结果、非空字符串数组；缺失或无效时重新解析，禁止询问或自补。
- `rawMessagesJson` 必须含非空 `original`（原文）、`parse_outputs`（本次契约输出对象）、以及用户侧 `business_mode`（`询价机构` 或 `手动拓展`）；弹窗答案写回 `rawMessagesJson.clarifications`，同字段新答案覆盖旧答案。

### 数值区间字段（31 个，`VALIDATE_REQUIREMENT_RANGE_PARAMS`）

`rebate`、`followercount`、`interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`photoInteract`、`userlikecount`、`likeIncrement`、`avgview`、`avglike`、`avgcomment`、`avgcollect`、`avginteract`、`femaleRate`、`age1Rate`–`age6Rate`、`cpeL1/L2/L3`、`cpmL1/L2/L3`、`kolOfficialPriceL1/L2/L3`。

格式锁：无空格 JSON 区间字符串 `"[min,max]"` 且 `0 ≤ min < max`；禁止数组、对象、单值、百分号文本或自然语言。特例：

- `rebate` 表示最低返点，固定 `"[min,1]"`。
- CPM/CPE（`cpmL*`、`cpeL*`）表示最大可接受值，固定 `"[0,max]"`。
- 比例字段（`interactionRate`、`femaleRate`、`age*Rate`）区间必须位于 0–1。
- `followercount` 上限不得超过 `999999999`；未明确或原文表达“无/不限/无要求”时落库 `"[0,999999999]"`（零到最大值），不省略字段、不弹窗；历史坏值 `[1,999999999]` 归一为 `[0,999999999]`。

### 平台标签数组

- 小红书：`contentFeatureLabel`、`growBloggerTypeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel` + `contentTag`。
- 抖音：`contentThemeLabel`、`growTalentTypeLabel`、`industryTagLabel`、`xtTalentTypeLabel` + `contentTag`。
- 8 个可选 Label 有则原样落库（保留元素与顺序），null/缺失则省略；不做映射、不推断、不询问。

### 平台档位约束

- 抖音：报价/CPM/CPE 只用 L2=植入视频、L3=定制视频；出现 L1 字段即预检失败；提交的 L2/L3 字段必须与需求中的明确视频类型一致。
- 小红书：不传任何 L3 字段（`kolOfficialPriceL3`、`cpmL3`、`cpeL3`）。

## 4. 归一化行为（`normalizeToolCallParams`，仅 validate_requirement）

| 字段                   | 规则                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`             | 别名归一化到 `xiaohongshu`/`douyin`                                                                                                                                                                                                                                                                                        |
| `status`               | 缺失/空时补 `"ready"`                                                                                                                                                                                                                                                                                                      |
| `brandName`            | 单元素字符串数组解包；优先采用当前平台 Dify 唯一合法品牌；若 Dify 当前平台品牌缺失，但 `rawMessagesJson.original` 中存在明确 `品牌：...` / `品牌名称：...` / `合作品牌：...` 标注，则可确定性兜底为该值；`暂无品牌` / `无品牌` 等占位值一律视为无效                                                                        |
| `quantityTotal`        | 归一化为正整数字符串；非法则删除该字段（交预检报错）                                                                                                                                                                                                                                                                       |
| 区间字段               | 标量→`[v,v]` 起步；百分号字符串（如 `"20%"`、`"10%-30%"`）解析并换算比例；中文区间 `-~～至到` 解析；`rebate`→`"[min,1]"`；粉丝“无/不限”→`"[0,999999999]"`；粉丝超上限截断到 `999999999`；CPM/CPE 标量→`"[0,v]"`；报价标量→`[floor(v×0.7), ceil(v×1.2)]`（Provider 检索单价只按原价下 30%/上 20% 扩展一次，不回写需求参数） |
| `submissionDeadlineAt` | 归一化为 `YYYY-MM-DD HH:mm:ss`，仅当晚于当前时间；兼容中文日期加冒号时钟（如 `2026年9月26日16:00`，含全角冒号）；两位年份固定按 20xx 解释（`26年9月26日 16:00` → `2026-09-26 16:00:00`），与原文/最新澄清做等价比较，保留原始证据；过期、非法日期及冲突仍阻断                                                                                                                                   |
| 标签数组               | 字符串化 JSON 数组解包；Dify `parse_outputs` 中仅当前平台标签/品牌/数值唯一值自动补入缺失字段；数值保留无平台前缀的既有兼容结构，另一平台 `dy_`/`xhs_` 片段不参与回填或 parsed 证据（抖音按视频类型对齐 L2/L3）                                                                                                            |
| `rawMessagesJson`      | `business_mode` 出站映射为 Provider 兼容线值（序列化为字符串在 `before_tool_call` 完成）                                                                                                                                                                                                                                   |
| 空值清洗               | 非必填字段的 `null`/`"null"` 删除                                                                                                                                                                                                                                                                                          |

截止时间的参数规范化与绝对日期证据比较共享解析：支持 `T`/空格、斜杠日期、中文“点/时、分、秒”。明确截止字段中的“明天16:00”按本地日期加一天，“12点前”按当天12:00；过期不顺延，无关事件不作为截止证据。相对时间证据支持逗号分隔及“请在明天16:00前提交”等后置提交语境。带 `Z` 或时区偏移的绝对时间不作为本地时间证据，不能截去时区后放行。数量证据支持“人”、全角数字及 1–9999 的规范中文整数，不匹配更长数字尾部或金额/比例；“人民币”“人均”不算人数单位。

## 5. 预检规则（`validateRequirementPreflight`）

返回 `{ field, reason }[]`；`rawMessagesJson` 缺失或 null 同样聚合问题，不抛 TypeError；`before_tool_call` 据此阻断。除上述必填与格式外：

- 未知字段：`不是 validate_requirement 的已声明参数`。
- 证据门禁（来自 `rawMessagesJson.original` 与 `clarifications` 拼合的文本证据）：
  - `brandName` 必须原样使用当前平台唯一 Dify 解析品牌；仅解析缺失/多候选时使用最新弹窗答案，或在原文存在明确 `品牌：...` / `品牌名称：...` / `合作品牌：...` 标注时做确定性本地兜底。
  - `quantityTotal`、`submissionDeadlineAt` 必须有与提交值一致的原文/澄清证据。截止时间的等价同日表述归一为同一值：`今晚8点前`/`今晚20:00`/`当天20:00:00` 同指当天 20:00:00；同一会话内已确认的澄清答案在后续轮次与 requirement 重建时原样带入 `clarifications` 直接复用，不重复询问。
  - `rebate`、报价：要么 Dify 给出唯一合法区间且提交值与其等价，要么原文/澄清中有对应证据。
  - `followercount` 无证据门禁：缺失或“不限”由本地边界默认落库全量区间 `[0,999999999]`，`[0,999999999]` 是合法落库值，不弹窗。
  - `projectStartStart`/`projectStartEnd`（可选）：只能传明确日期，需原文或澄清中带项目/档期语境的证据；无年份中文日期可匹配已解析的同年日期，证据自带年份时必须同年，且开始不晚于结束。
- 布尔字符串字段（`hasOrganization`、`hasOrder30day`、`hasSocial30day`）必须是 `"true"`/`"false"`。
- 字符串字段类型校验；`rawMessagesJson` 结构校验。
- 容器不可读（不是对象，或缺非空 `original`/对象 `parse_outputs`）时，不额外报告依赖容器取证的品牌、数量、返点、报价、截止时间、抖音视频类型和可选项目日期问题，避免把同一结构问题级联成业务值“没有证据”的假错误；其他可独立判断的缺失或格式问题仍照常聚合。

预检是「完整性 + 规范格式」硬门禁；语义选择（放宽等）由 Agent 按 SKILL.md 在预检通过前完成，预检不代做业务决策。

## 6. 宿主工具名匹配

`stripHostPrefix` 先做全名精确匹配，再按 `前缀__业务名` 后缀匹配；不匹配返回 null（Hook 不处理）。这使 Provider 工具与本地工具在不同宿主命名空间下都能被 Hook 识别。

宿主 YP Action 的原生达人补全（`get_xhs_author_business_card`/`get_douyin_author_business_card`）同样按完整名称最后一个 `__` 后匹配。插件不注册也不校验其 schema，不干预登录窗口、Cookie 或内部回调地址。

## 7. 关键 Provider 工具契约（v1.9.4）

- `rank_mcns`：`data.mcns` 每项字段 = `mcn_recommendation_id`、`supplier_id`、`agency_name`、`candidate_count`、`rank_no`、`rank_score`、`rebate_rate`；成功另有 `mcns_download_url`（`mcns_export_path` 兼容）。五列表格映射：排名=`rank_no`（缺省按响应顺序）、机构=`agency_name`、覆盖达人=`candidate_count`、返点=`rebate_rate`、综合分=`rank_score`。
- `rank_creators`：已废弃，正式链路不再调用。工具仍暴露于 Provider，live schema 为 `inquiry_ids`（array|null）+ `requirement_id`（string|null），不消费 `csv_file_path`。
- `sync_mcn_inquiry_status`：`{requirement_id, project_id, supplierIds}` → `data.inquiries[].inquiry_id`（`created`/`reused`）；返回的 `inquiry_ids` 直接用于 ingest。
- `create_with_distributions`：required = [`requirement_id`, `description`, `wechat_notification_message`]；`supplierIds`/`supplier_name` 可选，业务规则不变（两侧恒传数组、空侧 `[]`、至少一侧非空）。
- `manual_source_creators` 固定只传 `{requirement_id}`，不传 `demand` 或 `num`，需求由 Provider 从后台读取。测试环境 live schema 已确认启动工具只有 `requirement_id`，状态查询为 `manual_source_creators_status({requirement_id, batch_id, num})`。Hook 通过 `MANUAL_SOURCE_TARGET_NUM` 提示状态查询所需的梯度取数数量（示例：5 人→15、10 人→30、20 人→50、30 人→60、50 人→100，非穷举，表外人数同样按同一梯度计算），不能重复乘倍数，交付目标仍为用户需求人数；只有当前环境 live schema required `num` 时才并入远端调用。字段配置缺失时 Provider 应在启动调用返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED` / `REQUIREMENT_COLUMNS_UNAVAILABLE` 并停止，而不是延迟到打分终态；当前插件对启动和打分两处错误均生成同 requirement 字段选择恢复指令，不缓存或重建 columns，只保留本轮可信 `csv_file_path` 用于恢复时精确重提打分。
- `score_manual_source_csv`：`{requirement_id, csv_file_path}` → 返回 `job_id`；`score_manual_source_csv_status({job_id})` 轮询至终态 → final workbook URL。`csv_file_path` 只接受当前 `file_bridge` 返回值（当前实现为未签名 OSS URL），绝不传本机工作区路径或自行构造的 URL。若打分阶段返回缺字段配置错误，字段提交后只用同一 requirement 与该可信 `csv_file_path` 重提打分，不重跑搜索、补全或 `file_bridge`，且处理行数不等于最终成功。
- 回收链：`sync_mcn_inquiry_status({requirement_id, project_id, supplierIds})` → 返回 `data.inquiries[].inquiry_id` → `ingest_mcn_submissions({inquiry_ids})` → `get_ingest_job` 轮询至 `succeeded`/`partially_succeeded`；终态只回一份预览 Excel（`excel_file_url` + `excel_columns`），无 links CSV，之后 ypscan_save_creator_links 读取预览并派生 links CSV → 原生补全 → `file_bridge(manual_source)` → 打分。

## 8. Provider 工具描述（建议文本，待服务端同步）

> 2026-09-09 按当前工作流重写插件可见 13 个 Provider 工具的描述：清除 get_workflow_state 旧链路引用与 type-3/Dify/B CSV 等实现术语，补上 get_ingest_job 缺失的描述，明确“受理≠完成”与遗留工具边界。服务端 tools/list 仍为旧文本，同步部署后才对 Agent 生效；同步前以本表为准。8 个未暴露工具（get_workflow_state、create_submission_batch、get_creator_detail、get_creator_detail_export、get_recommendation_run_detail、dispatch_reference_creator、audit_manual_adjustment、record_client_feedback）描述不改：模型不可见，不影响运行。

| 工具 | 建议描述 |
| --- | --- |
| `validate_requirement` | 校验并创建当前单平台需求记录（会写入）。按当前 customer_demands 列契约直接传顶层参数，不用 payload 包装或旧字段名；platform 只接受 xiaohongshu/douyin，需求完整时 status="ready"。成功后取 data.requirement_id 作为需求 ID（缺失时用 data.id；demand_id 不是需求 ID）。 |
| `search_creators` | 按当前需求的已保存筛选条件检索候选达人并写入候选池，返回实际生效筛选、排除统计与去重候选数。零匹配也是成功结果；本工具不自动切换功能或放宽条件，成功后继续 rank_mcns。 |
| `rank_mcns` | 按当前需求对候选达人所属机构排序，返回每家机构的排名、独立覆盖达人、返点、综合分与机构 ID，并提供排名 Excel 下载地址。本工具不选择收件机构，也不发送询价。 |
| `select_inquiry_form_fields` | 期望支持 source_requirement_id 继承和 force_reselect 强制重选；当前 test live schema 尚未提供这两个参数。configured 表示当前需求配置成功，selection_required/opened 返回 URL 待提交，error 暂停。不返回字段数组。 |
| `create_with_distributions` | 按需求已保存的字段配置创建询价项目并向指定机构分发（含企微发送）。成功只代表分发已创建；是否送达以 Provider 回执为准，不要自动重发。 |
| `sync_mcn_inquiry_status` | 为已分发项目创建或复用机构询价映射。用户报告机构已回填时先调用本工具，用返回的 inquiry_ids 直接调用 ingest_mcn_submissions；同步成功不代表机构已填表。 |
| `ingest_mcn_submissions` | 对非空询价启动机构回填采集，返回 job_id。用 sync_mcn_inquiry_status 返回的 inquiry_ids 调用；受理后用 get_ingest_job 轮询到 succeeded 或 partially_succeeded。 |
| `get_ingest_job` | 查询机构回填采集任务的状态、各询价结果与预览 Excel 下载地址。轮询到 succeeded/partially_succeeded 后保存预览表；partially_succeeded 需如实报告未回填或失败的机构。 |
| `manual_source_creators` | 按指定需求后台保存的完整有效需求启动手动拓展搜索，只传 requirement_id。同步返回候选 links CSV；异步返回 batch_id，用 manual_source_creators_status 查询。 |
| `manual_source_creators_status` | 查询手动拓展任务状态并获取候选 links CSV。未完成时用同一 requirement_id、batch_id、num 继续查询，不要重新提交搜索；num 为本批取候选链接数量，由调用方按目标人数梯度计算并传入（示例：5 人→15、10 人→30、20 人→50、30 人→60、50 人→100，非穷举）。 |
| `score_manual_source_csv` | 为已补全达人详情的 CSV 启动或恢复评分任务，返回 job_id。csv_file_path 传当前 file_bridge 返回的 CSV URL；受理后用 score_manual_source_csv_status 轮询。 |
| `score_manual_source_csv_status` | 查询评分任务的行处理进度与最终工作簿下载地址。仅终态且返回可下载地址时保存工作簿；行评分成功不等于工作簿可交付。 |
| `rank_creators` | 遗留机构提交排序工具：当前询价回收流程不使用（回收走预览表、原生补全与 CSV 评分链路）。仅保留兼容，不要按旧链路调用。 |

## 9. Provider 输出实测与修剪清单（2026-09-09 测试环境）

测量方式：通过 YP Action 本地 MCP 代理直连测试环境，创建 2 个合成需求，跑了 1 次真实手动拓展搜索、1 个真实评分任务及若干错误/边界路径；未调用 `create_with_distributions`（发企微）与 `select_inquiry_form_fields`（打开浏览器窗口）。体积为完整 JSON-RPC 文本字节数。

### 已确认冗余（建议服务端修剪）

1. `validate_requirement.data.customer_demand`：69 键全量数据库行回显（含 `rawMessagesJson` 原文），实测占 data 的 46%–79%；本地无任何消费者（src/ 无引用）。建议不回传；模型所需信息在 `id`、`demand_id`、`demand_version`、`status`、`platform`、`stored_fields`。
2. `manual_source_creators.data.rpa_response`：RPA 原始请求回声，实测占响应的 51%；`headers` 为 22 个网关/代理头（含 `client-ip`、`x-real-ip`、`x-forwarded-*`、sw8 追踪头，属内网细节，不应回显给模型）、`params` 恒为空。建议删除 headers/params；如需核对实际搜索参数，只回传脱敏的 `applied_filters` 摘要。
3. `validate_requirement` 顶层 `workflow_state`：同一响应内再附一份状态快照（实测 316 字符），与 data 内字段重复。建议移除顶层重复回显。

### 实测确认的契约事实与文档更正

1. `score_manual_source_csv_status.last_error` 是结构化对象 `{code, message, details}`，不是字符串。实测终态 `status="failed"` 且 `success_count=15`，同时 `last_error.code="REQUIREMENT_COLUMNS_UNAVAILABLE"`：行评分成功不等于工作簿可交付，模型必须看 `status`/`last_error`，不能只看 `success_count`。
2. `rank_mcns` 计数口径：实测 `total_matched=2`、`total_ranked=2`，但 `data.mcns` 数组有 20 项。机构数量以数组为准；计数器口径需 Provider 修正或定义。
3. `platform` 输出未归一：实测 `validate_requirement="douyin"`、`manual_source_creators_status="dy"`、`score_manual_source_csv_status="抖音"`。建议服务端统一输出 `douyin`/`xiaohongshu`。
4. `search_creators` 成功响应（实测 2.0KB）不含文档所列中间导出路径与向量诊断字段——这些字段并非每次返回。
5. `get_ingest_job` 失败终态含结构化 `job_error`（`{code, message, details}`），无 Excel 字段，体积精简。
6. `ingest_mcn_submissions` 对不存在的 inquiry_id 也返回成功并创建任务（实测任务随后以 `ALL_INQUIRIES_FAILED` 失败）：启动时不校验 inquiry 存在性。

### 实测响应体积（字节，含 JSON-RPC 信封）

| 工具 | 路径 | 体积 |
| --- | --- | --- |
| `validate_requirement` | 成功（简/全需求） | 4061 / 4961 |
| `search_creators` | 成功 | 2005 |
| `rank_mcns` | 成功（20 家机构） | 7197 |
| `manual_source_creators` | 异步受理 | 3146 |
| `manual_source_creators_status` | 运行态 / 完成态 | 494 / 1077 |
| `score_manual_source_csv` | 受理 | 789 |
| `score_manual_source_csv_status` | 运行态 / 失败终态 | 788 / 973 |
| `get_ingest_job` | 失败终态 | 965 |
| `ingest_mcn_submissions` | 受理 | 747 |
| `sync_mcn_inquiry_status` | 错误路径 | 580 |

### 未测路径

`get_ingest_job` 成功终态（results 数组 + Excel 字段，需真实机构回填）、`sync_mcn_inquiry_status` 成功路径（需已分发项目，即先发企微）、`score_manual_source_csv_status` 成功终态（需字段配置）、`select_inquiry_form_fields` 与 `create_with_distributions`（分别会打开浏览器/发企微，未调用）。这些路径的体积与字段未验证。

## 本地手动拓展分批契约

本地汇总新增 `YPSCAN_MANUAL_SCORE_MODE_NOT_APPLICABLE`，区分已登记询价模式与 CONTEXT_UNAVAILABLE；两者均为不可重试错误。来源登记按项目持久化，恢复与部分交付行为见 [hooks.md](./hooks.md)；错误结果可额外携带 `data.partial_delivery.batch_files`（已核验的当前需求评分表）。Provider schema 与工具入参不变。

新增 `ypscan_summarize_manual_scores({requirement_id})` 与 `manual_score_batch` Excel kind；工具入参由 index.js 声明，manifest 同步列入 contracts.tools。registry.js 的 Provider 参数归一化保持不变，Provider 评分工具仍使用原始两个参数，状态工具仍仅 job_id。手动拓展每批评分完成后保存为 manual_score_batch，再由本地汇总精确累计推荐数；机构回收仍使用 manual_source。详细返回、停止条件及已验证契约范围见 [tools.md](./tools.md) 的评分汇总章节。

字段选择新契约见 [入参与出参](../../skills/media-assistant/references/tools/select_inquiry_form_fields.md)。插件已适配；2026-09-09 测试环境 tools/list 尚无 source_requirement_id/force_reselect，真实继承未验收。
