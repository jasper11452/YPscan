# Hook 契约

`src/hooks/register-flow-directives.js` 注册 3 个流程 Hook（`HOOK_OPTIONS = { priority: 90, timeoutMs: 5000 }`），`index.js` 注册 2 个 Gateway 生命周期 Hook。Smoke 断言 Hook 集合固定为 5 个：`before_prompt_build`、`before_tool_call`、`tool_result_persist`、`gateway_start`、`gateway_stop`。

## 1. 注册形态

| Hook                  | 注册位置                 | 作用                                                  |
| --------------------- | ------------------------ | ----------------------------------------------------- |
| `before_prompt_build` | register-flow-directives | 每轮注入模式指令；每会话首次另注入静态启动指令块      |
| `before_tool_call`    | register-flow-directives | 仅对 `validate_requirement` 做归一化 + 预检，失败阻断 |
| `tool_result_persist` | register-flow-directives | 记录瞬态映射并按工具结果追加下一步指令                |
| `gateway_start`       | index.js                 | 重置瞬态状态                                          |
| `gateway_stop`        | index.js                 | 重置瞬态状态                                          |

每轮提示插件相对模块解析得到的 `media-assistant/SKILL.md` 实际绝对路径，要求首次相关操作前完整读取（已读不重复），兼容宿主技能目录漏列的情况；这不等于验证宿主已经读取。解析成功提示区分解析器缺失与用户缺失，明确原文数值复用和首次完整澄清。手动拓展首次澄清改变有效需求时，动态指令要求合成无冲突全文、以同一全文重解析并替换 `parse_outputs`；输入未变化且结果有效时不重复解析，询价放宽仍保留原文。启动指令要求已明确修改直接执行，并使用业务进度文案。

## 2. 瞬态状态（不持久化）

| 映射                              | 键                     | 值                                 | 写入点                                                                                                                                               |
| --------------------------------- | ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startupScopes`                   | scopeKey               | Set 标记                           | `before_prompt_build` 首见 scope                                                                                                                     |
| `businessModeByScope`             | scopeKey               | `询价机构`/`手动拓展`              | `before_tool_call` 预检通过时                                                                                                                        |
| `platformByScope`                 | scopeKey               | `xiaohongshu`/`douyin`             | 同上                                                                                                                                                 |
| `currentRequirementIdByScope`     | scopeKey               | requirement_id                     | 仅已知业务工具 success=true 的可信 requirement 更新；原生补全绑定发起调用时的 requirement，结果不得借用最近 ID                                       |
| `platformByRequirement`           | requirement_id         | 平台                               | `tool_result_persist` 中 `validate_requirement` 成功或其他工具带平台成功时                                                                           |
| `inquiryIdsByRequirement`         | scope + requirement_id | inquiry_ids 数组                   | `sync_mcn_inquiry_status` 成功且返回非空 `inquiry_ids` 时                                                                                            |
| `scoreJobRecoveryByScope`         | scope + job_id         | `{requirement_id, csv_file_path?}` | `score_manual_source_csv` / `score_manual_source_csv_status` 成功且带 job_id+requirement_id 时（保留本轮可信 `csv_file_path`，供缺列恢复时精确重提） |
| `requirementIdByIngestJobId`      | scope + job_id         | requirement_id                     | `ingest_mcn_submissions` / `get_ingest_job` 成功且带 job_id+requirement_id 时（ingest 缺失时按 inquiry_ids 反查 `inquiryIdsByRequirement`）          |
| `linksCsvPathsByRequirement`      | requirement_id         | 受控 links CSV 路径集              | `ypscan_save_artifact` 保存 `manual_creator_links` 时；`ypscan_save_creator_links` 生成 links CSV 时（`recordLinksCsv`）                             |
| `completionCsvPathsByRequirement` | requirement_id         | 原生补全 CSV 路径集                | `get_xhs_author_business_card` / `get_douyin_author_business_card` 成功且带 `csv_file` 时                                                            |

- `scopeKey` 取 `sessionKey/sessionId/runId/run_id` 中第一个非空值，缺省 `"global"`。
- `pendingCalls` 仅使用已安装 YP Action 两个 Hook 均传递的 `sessionKey + toolCallId` 关联（兼容 event/context 字段）；只保留 id、平台、数量、inquiry_ids、job/batch、flow、kind 与模式，不保存完整需求或下载 URL——唯一例外是 `score_manual_source_csv` 调用的可信 `csv_file_path`，缺列恢复需要它精确重提。结果到达立即消费，失败/合成结果也释放，Gateway 重置清空；没有可信调用坐标不借用最近参数或 requirement。
- score/ingest 的 job 映射按 scope 隔离，成功 Excel 或失败终态后删除；状态查询发起时将已知 requirement 保存到该调用快照，避免另一在途查询的终态清理使其丢失归属。inquiry_ids 反查也仅限同 scope，多个 requirement 同时匹配时不推测。
- `get_ingest_job` 返回失败 envelope 时，只有明确的 `JOB_PENDING` 继续轮询；其他错误暂停并保留原始错误，不因恢复出 job_id 而继续轮询。
- 保存结果回显 `data.artifact_kind/artifact_id`，params 缺失时仍可生成预览补全弹窗。
- `previewFilesByRequirement` 记录受控保存 mcn_creator_preview 后的路径与 SHA-256，由 `previewFilesFor` 提供给 links 工具。Gateway 重置时清空，重新保存同一 Provider 预览可恢复登记，不需重新询价。
- 预览保存后平台已知时给出 `SAVE_CREATOR_LINKS_ARGS={requirement_id,platform,preview_file_path}`，缺平台暂停。通用 read 不再读取 xlsx。
- 部分回收的明细分别展示未提交、处理失败和状态未知；无 results 时明确明细未知，不能从失败汇总推断待回填机构，不能把行数当合格人数。
- 业务路由仍来自参数/结果；新增手动拓展汇总只接受已登记的来源，缺失时显式停止，不从模型文本猜测恢复。
- `gateway_start`/`gateway_stop` 调用 `resetTransientState()` 清空全部映射；会话重启后指令会重新注入。

## 3. before_prompt_build

每轮都在 `prependContext` 开头注入精简的业务模式指令及固定 `BUSINESS_MODE_QUESTION_ARGS`；每个 scope 只追加一次完整启动指令块。完整启动块的要点：

- 工具名只认宿主完整名称最后一个 `__` 后的实际工具名，前缀（含 `test__`）只是命名空间。
- 业务模式识别：明确表达直接用；未明确/冲突/同时出现时先弹 `BUSINESS_MODE_QUESTION_ARGS`（选项固定 `询价机构`/`手动拓展`），回答前不解析不落库；`手动拓展` 在 Provider 边界映射为兼容线值，Agent 不得改写。
- 两条链路总览（见 [flows.md](./flows.md)）。
- 需求创建规则：每次真正开始新功能都重新解析、复核、创建独立 requirement；禁止跨功能复用 requirement/机构/达人/batch/CSV/Excel；两功能不得并行。
- 续办规则：`rank_mcns` 列表后“暂不询价”等未回答状态可在同会话恢复原询价分支，不重新解析/落库/搜索/排名。
- 弹窗规范：每行最多 20 个 Unicode 字符，只在整行将超过 20 字符时断行（先填满接近 20），禁止逐分句拆行；发送确认弹窗固定一题两选项 `确认发送`/`返回修改`，正文保留企微消息原有行结构、只对超 20 字符单行断行。
- 数值格式锁：`validate_requirement` 数值字段全部用无空格 `"[min,max]"`（`min < max`），返点 `"[min,1]"`。
- 原生补全工具调用：按 `next_author_ids` 调用当前平台补全工具，首批不超过 min(20, 需求人数)，之后每批最多 20 人（小红书 `get_xhs_author_business_card` 固定 `page_count=1`，抖音 `get_douyin_author_business_card`）；登录窗口与 Cookie 由宿主工具内部处理，Hook 不注入登录准备指令。
- 澄清规则：Dify 已给的唯一数值直接采用不再问；八个可选 Label 有则原样保留、无则省略；`contentTag` 必须来自解析结果，缺失时重新解析。

细节以 `skills/media-assistant/SKILL.md` 为权威；Hook 指令是其运行时投影。

## 4. before_tool_call

- 仅对 `validate_requirement` 做阻断预检；已知业务工具另保留下一步指令必要的调用关联元数据，不修改外部工具 schema。
- 流程：`normalizeToolCallParams`（确定性、无损归一化，见 [contracts.md](./contracts.md)）→ `validateRequirementPreflight`。
- 预检有 issue 时返回 `{ block: true, blockReason }`，`blockReason` 以 `YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED` 开头，含「一次性修正项：field: reason…」、区间格式契约与澄清弹窗规则；`rawMessagesJson` 结构错误时额外要求用对象形式重发并保留已有业务值，不得仅因该结构错误弹窗或新增 clarifications，同时列出的其他独立问题仍照常处理；Provider 不收到本次写入。
- 预检通过时：`rawMessagesJson` 序列化为字符串传给 Provider（`serializeProviderRawMessages`）；按 scope 记录 `business_mode` 与 `platform`；参数有变化时返回 `{ params }`，否则不干预。
- 不做功能互斥、不做企微发送确认门禁（Provider 边界）。

## 5. tool_result_persist

1. 从结果解析 `requirement_id`/`platform`，成功时写入 `platformByRequirement`；当前 requirement 按 scope 隔离，原生补全 success=true 的 `csv_file` 只能登记到可信发起调用快照的 requirement；`sync_mcn_inquiry_status` 成功且返回非空 `inquiry_ids` 时写入 `inquiryIdsByRequirement`；score/ingest 链路成功且带 job_id 时按 job_id 记录 requirement_id 映射（ingest 缺 requirement_id 时按 inquiry_ids 反查）。
2. 调 `flowDirective(toolName, message, params, ...)` 生成指令，追加到结果消息尾部（`appendDirective`）；`get_ingest_job` / `score_manual_source_csv_status` 调用参数缺 `requirement_id` 时先按 job_id 映射补齐再生成指令。
3. 保存共用的 `manual_source` 打分 Excel 时，优先按 requirement 登记的业务模式选择收尾策略（无记录才沿用 scope）：询价回收只交付真实结果并说明缺口，不注入手动拓展放宽策略；手动拓展保留放宽建议。来源未确认时提示先确认来源，不直接应用放宽建议。
4. 需求解析成功后单独注入截止时刻复核规则：当前有效原文与澄清均无截止时间证据时必须询问，不从旧 requirement 或默认值回填；只有日期没有具体时刻时必须澄清，不默认时刻、不宣称无需澄清；已有小时和分钟且可唯一确定未来时间时仅补秒，不重复询问。只解析、不落库的请求仍指出缺失，但不得继续下游。该规则不依赖 persist 事件携带调用参数，也不新增日期解析器或状态。

指令覆盖的工具与行为（详见 [flows.md](./flows.md)）：

| 工具                                                               | 成功时                                                                                                                                                                                                                                                                                                        | 失败/特殊时                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ypscan_parse_requirement`                                         | 复核指令 + `DIFY_RESOLVED_FIELDS`/`DIFY_MISSING_FIELDS`                                                                                                                                                                                                                                                       | `flowPauseDirective`（重试/结束弹窗）                                                                                           |
| `validate_requirement`                                             | 按模式给 `SEARCH_CREATORS_ARGS` 或 `SELECT_INQUIRY_FORM_FIELDS_ARGS`；手动拓展另注入字段选择门规则（URL 后结束本轮，configured 后直接继续，禁试调后续工具）                                                                                                                                            | 预检阻断文本 → 修正指令；其余 pause                                                                                             |
| `search_creators`                                                  | `RANK_MCNS_ARGS`（忽略导出链接）                                                                                                                                                                                                                                                                              | pause                                                                                                                           |
| `rank_mcns`                                                        | 五列表格锁定 + `SAVE_ARTIFACT_ARGS(mcn_ranking)`（或字段选择+机构弹窗）；空列表给复核/放宽策略                                                                                                                                                                                                                | pause                                                                                                                           |
| `select_inquiry_form_fields`                                       | configured 且 success=true、需求 ID 与调用一致时直接恢复原分支；error 或继承返回 URL 时暂停；selection_required/旧版 URL 则 `FIELD_SELECTION_URL` 原样输出 + 字段选择门规则；若 Provider 自动打开失败但链接有效，则如实展示链接并等待用户回复“好了”                                                                                                                                                                                       | pause                                                                                                                           |
| `create_with_distributions`                                        | 逐机构发送状态摘要；无收件机构回到机构选择；项目非进行中时原样展示错误并停止，不调用旧状态工具                                                                                                                                                                                                                | —                                                                                                                               |
| `sync_mcn_inquiry_status`                                          | `INGEST_MCN_SUBMISSIONS_ARGS`（sync 直接返回 `inquiry_ids`，立即 ingest，不回读 `get_workflow_state`）                                                                                                                                                                                                        | pause                                                                                                                           |
| `ingest_mcn_submissions`                                           | `GET_INGEST_JOB_ARGS`；缺 `job_id` 给恢复弹窗                                                                                                                                                                                                                                                                 | pause                                                                                                                           |
| `get_ingest_job`                                                   | Excel-only 终态 → `SAVE_ARTIFACT_ARGS(mcn_creator_preview)`（requirement_id 优先取调用参数，缺失时按 job_id 反查 ingest 记录）；`partially_succeeded` 额外给 `INGEST_PARTIAL_SUMMARY`；终态成功但缺 requirement_id 时 pause 而非继续轮询；未到终态继续轮询（上限 10 次）                                      | `failed`/`cancelled`/`canceled`/`error` 终态 pause，不再轮询                                                                    |
| `manual_source_creators`                                           | 分三态：links CSV→`SAVE_ARTIFACT_ARGS(manual_creator_links)`；Excel→`SAVE_ARTIFACT_ARGS(manual_source)` 降级交付+放宽策略（完整放宽规则只在结果时刻注入，启动块只保留精简短fall规则）；batch_id→`MANUAL_SOURCE_CREATORS_STATUS_ARGS`（只带 `requirement_id`+`batch_id`；目标数量按 live schema 决定是否并入） | 缺字段配置→字段选择；其余 pause                                                                                                 |
| `manual_source_creators_status`                                    | 同三态（Excel 交付同样附完整放宽规则）；`BATCH_NOT_READY` 或 live 中间态（success + completed=false）继续 30s 轮询（上限 10 次；续接优先用落库 `quantityTotal` 按梯度计算 `MANUAL_SOURCE_TARGET_NUM`，缺少需求记录时沿用上一轮实际使用的 `num`；只有当前环境 live schema required `num` 时才并入远端调用）                                                         | pause                                                                                                                           |
| `get_xhs_author_business_card` / `get_douyin_author_business_card` | 手动拓展附仅当前批 `FILE_BRIDGE_ARGS`；机构回收注入 `COMPLETION_CSV_FILE`、成功/失败 ID 与 `FILE_BRIDGE_FLOW=manual_source`，提示全部补全后合并上传打分                                                                                                                                                                     | pause                                                                                                                           |
| `score_manual_source_csv`                                          | `job_id` → `SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS`（30s 轮询）；全失败不生成空 Excel                                                                                                                                                                                                                            | 缺字段配置→同 requirement 字段选择，保留到本轮可信 `csv_file_path` 时附精确 `SCORE_MANUAL_SOURCE_CSV_ARGS` 重提参数；其余 pause |
| `score_manual_source_csv_status`                                   | 终态 → `SAVE_ARTIFACT_ARGS`（手动拓展为 manual_score_batch，机构回收为 manual_source）（requirement_id 优先取调用参数，缺失时按 job_id 反查打分记录）；终态成功但缺 requirement_id 时 pause 而非继续轮询；未完成继续 30s 轮询（上限 10 次）                                                                                                               | 缺字段配置→同 requirement 字段选择（按 job 记录回填 `csv_file_path` 并附精确重提参数）；其他失败终态 pause                      |
| `rank_creators`                                                    | 已废弃：正式链路不再调用；若被调用仍给 `SAVE_ARTIFACT_ARGS(ranked_submission)`（遗留）；全失败不生成空提报表                                                                                                                                                                                                  | pause                                                                                                                           |
| `ypscan_save_artifact`                                             | 按 kind 给下一步：mcn_ranking→机构弹窗/字段选择；mcn_creator_preview→询问是否补全；manual_creator_links→归一化；manual_score_batch→不展示内部表、直接汇总（询价误存例外按最终交付）；manual_source→最终交付；ranked_submission→结束（遗留）；mcn_creator_links→无指令（遗留）                          | pause                                                                                                                           |
| `ypscan_save_creator_links`                                        | 手动拓展附 `CREATOR_LINKS_LOCAL_PATH` 与 `SUMMARIZE_MANUAL_SCORES_ARGS` 取得首批；机构回收附 `CREATOR_LINKS_LOCAL_PATH` 并提示按 20/批完成全部原生补全；归一化 links CSV 属内部产物，不主动向用户展示                                                                                                                                                | pause                                                                                                                           |
| `file_bridge`                                                      | merged CSV 为内部产物、不主动展示；`mcn_complete_only`（遗留）交付本地链接；行数>500 跳过上传并停止；`manual_source` 上传成功后给 `SCORE_MANUAL_SOURCE_CSV_ARGS`；`mcn_rank` 上传成功后给兼容 `RANK_CREATORS_ARGS(requirement_id,csv_file_path)`，仅供 live schema 明确升级后使用                                                 | 合并或上传失败 pause；如实报告失败原因，不主动展示内部 CSV                                                                            |
| 遗留 `ypscan_select_cascade`/`ypscan_set_filter_range`             | Browser 验证/恢复提示                                                                                                                                                                                                                                                                                         | —                                                                                                                               |

引导原生达人补全的指令（`ypscan_summarize_manual_scores` 的 `complete_next_batch`、`ypscan_save_creator_links`、`ypscan_save_artifact(mcn_creator_preview)`、`get_ingest_job` 终态，以及 `manual_source_creators(_status)` 返回 links CSV 时）只给出补全工具、名单与下一批参数；登录窗口与 Cookie 由宿主补全工具内部处理，Hook 不注入登录准备指令，也不为登录状态登记状态。补全结果仍按原有 `csv_file`/成功失败名单链路处理。

手动拓展状态成功、`data.completed=true` 且 `data.selected_count=0`（`success_count` 缺失或为0），并且没有 CSV/Excel 时，追加 `YPSCAN_NEXT_ACTION=REVIEW_EMPTY_MANUAL_SOURCE_RESULT`：停止轮询，先核对参数，再决定纠错或调整同主题关键词、减少非核心人设限定；优先阶段其他搜索条件保持原值，用户已明确要求放宽时直接执行，未授权时等待确认；调整后仍不足再提示其他可放宽条件并等待该项确认；不附通用重试弹窗或保存参数。CSV/Excel 分支仍优先，未知数量和失败不当作零结果。

失败且无专门处理时：`ypscan_parse_requirement`、`validate_requirement`、`search_creators`、`rank_mcns` 给 `flowPauseDirective`（`YPSCAN_FLOW_DIRECTIVE=<阶段> 已暂停（code）` + `ASK_USER_QUESTION_ARGS` 重试/结束），其余工具返回 null（不追加）。

评分分支误用恢复：`manual_score_batch` 保存成功且当前记录模式为询价机构时，复用 `manual_source` 最终交付指令与本次真实本地链接，不再引导汇总、重存或重评；手动拓展单批保存只注入汇总参数，不展示表格、路径或链接，旧版 `manual_source` Excel 交付不变。保存的 `manual_score_batch` 所属 requirement 缺少模式记录时，不借用会话级模式；停止并保留文件，不展示最终交付、不汇总、不重存或重评，也不附重试弹窗。汇总的 MODE_NOT_APPLICABLE 仅引导交付当前需求已有的成功保存结果，无可信结果时停止；CONTEXT_UNAVAILABLE 只停止，不推断模式或完成状态。两者均不附重试弹窗，不重建需求或重评。

## 6. Gateway 生命周期

`file_bridge` 上传后的评分指令区分用户文案与内部参数：正文只提示“数据已合并上传，正在启动打分。”，不复述 OSS 完整/截断地址、对象路径或工具参数；`SCORE_MANUAL_SOURCE_CSV_ARGS.csv_file_path` 仍原样用于评分。机构精排兼容分支同样禁止复述地址。

`gateway_start`、`gateway_stop` 仅调用 `hookRuntime.resetTransientState()`，无其他副作用；不向宿主输出、不影响工具注册。

## 手动拓展分批投影

字段页结果 `selection_required` 必须有与调用参数一致的 requirement_id；旧版无 status/ID 链接兼容，有 ID 不一致则暂停且不输出 FIELD_SELECTION_URL。force_reselect 的 URL 指令限定提交后只更新配置，仅恢复对话明确的等待字段配置的未完成步骤，不重启已完成或停止的业务。恢复限制由指令表达，不新增宿主任务状态或门禁。

`manualScoreSourcesByRequirement` 在 validate 成功后记录需求模式，保存归一化 links 时登记路径+哈希，原生补全的可信调用坐标关联成功/失败 ID（csv_file=null 的全失败批次同样登记失败名单），单批评分保存时登记路径+哈希。相同路径不同来源记录标记冲突；同一达人重试成功后以成功记录取代旧失败。不持久化任务进度，每次汇总从源记录重新计算；当前批缺评分行优先返回 `await_scores`，不被推荐达标或候选耗尽覆盖。Gateway 生命周期清空这些记录，缺失时汇总停止。

手动拓展 links 归一化及 manual_score_batch 保存后注入 `SUMMARIZE_MANUAL_SCORES_ARGS`；manual_score_batch 是内部中间表，不展示表格、路径或链接。汇总工具返回下一批时注入 `NEXT_AUTHOR_IDS` 与对应原生工具名；await_scores 先要求展示阶段性 `progress.user_visible_message`（不代表最终汇总），只等待当前任务，任务仍在跑时沿用 30s×10 上限，终态缺行则报告 `pending_score_author_ids` 并停止；deliver 携带 `excluded_zero_score_count` 并要求按 0 分行未写入汇总表如实说明（不写成未评分、补全失败或达人被筛掉），明确禁止再补全/评分，只有推荐缺口大于0才建议复核和放宽。机构回收继续全量补全、一次评分、manual_source 最终交付。before_tool_call 仍只阻断 validate 预检，不新增早停门禁；这些测试证明指令生成，模型遵守与桌面验收另行验证。

字段配置按字段工具卡执行：同一会话新需求传 source_requirement_id 继承最近已提交/已配置的需求；用户主动重选才传 force_reselect=true。configured 后直接继续；URL 等待提交；继承失败、平台不兼容或 live schema 不支持新参数时暂停。具体字段仅由 Provider 保存和复制。
