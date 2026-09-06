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
- 映射只是路由辅助：模式/平台在设计上总可从参数或结果再推导，不把映射当唯一真相。
- `gateway_start`/`gateway_stop` 调用 `resetTransientState()` 清空全部映射；会话重启后指令会重新注入。

## 3. before_prompt_build

每轮都在 `prependContext` 开头注入精简的业务模式指令及固定 `BUSINESS_MODE_QUESTION_ARGS`；每个 scope 只追加一次完整启动指令块。完整启动块的要点：

- 工具名只认宿主完整名称最后一个 `__` 后的实际工具名，前缀（含 `test__`）只是命名空间。
- 业务模式识别：明确表达直接用；未明确/冲突/同时出现时先弹 `BUSINESS_MODE_QUESTION_ARGS`（选项固定 `询价机构`/`手动拓展`），回答前不解析不落库；`手动拓展` 在 Provider 边界映射为兼容线值，Agent 不得改写。
- 两条链路总览（见 [flows.md](./flows.md)）。
- 需求创建规则：每次真正开始新功能都重新解析、复核、创建独立 requirement；禁止跨功能复用 requirement/字段配置/机构/达人/batch/CSV/Excel；两功能不得并行。
- 续办规则：`rank_mcns` 列表后“暂不询价”等未回答状态可在同会话恢复原询价分支，不重新解析/落库/搜索/排名。
- 弹窗规范：每行最多 20 个 Unicode 字符；发送确认弹窗固定一题两选项 `确认发送`/`返回修改`。
- 数值格式锁：`validate_requirement` 数值字段全部用无空格 `"[min,max]"`（`min < max`），返点 `"[min,1]"`。
- 澄清规则：Dify 已给的唯一数值直接采用不再问；八个可选 Label 有则原样保留、无则省略；`contentTag` 必须来自解析结果，缺失时重新解析。

细节以 `skills/media-assistant/SKILL.md` 为权威；Hook 指令是其运行时投影。

## 4. before_tool_call

- 仅对 `validate_requirement` 做阻断预检；已知业务工具另保留下一步指令必要的调用关联元数据，不修改外部工具 schema。
- 流程：`normalizeToolCallParams`（确定性、无损归一化，见 [contracts.md](./contracts.md)）→ `validateRequirementPreflight`。
- 预检有 issue 时返回 `{ block: true, blockReason }`，`blockReason` 以 `YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED` 开头，含「一次性修正项：field: reason…」、区间格式契约与澄清弹窗规则；Provider 不收到本次写入。
- 预检通过时：`rawMessagesJson` 序列化为字符串传给 Provider（`serializeProviderRawMessages`）；按 scope 记录 `business_mode` 与 `platform`；参数有变化时返回 `{ params }`，否则不干预。
- 不做功能互斥、不做企微发送确认门禁（Provider 边界）。

## 5. tool_result_persist

1. 从结果解析 `requirement_id`/`platform`，成功时写入 `platformByRequirement`；当前 requirement 按 scope 隔离，原生补全 success=true 的 `csv_file` 只能登记到可信发起调用快照的 requirement；`sync_mcn_inquiry_status` 成功且返回非空 `inquiry_ids` 时写入 `inquiryIdsByRequirement`；score/ingest 链路成功且带 job_id 时按 job_id 记录 requirement_id 映射（ingest 缺 requirement_id 时按 inquiry_ids 反查）。
2. 调 `flowDirective(toolName, message, params, ...)` 生成指令，追加到结果消息尾部（`appendDirective`）；`get_ingest_job` / `score_manual_source_csv_status` 调用参数缺 `requirement_id` 时先按 job_id 映射补齐再生成指令。
3. 保存共用的 `manual_source` 打分 Excel 时，按当前 scope 记录的业务模式选择收尾策略：询价回收只交付真实结果并说明缺口，不注入手动拓展放宽策略；手动拓展保留放宽建议。来源未确认时提示先确认来源，不直接应用放宽建议。
4. 需求解析成功后单独注入截止时刻复核规则：当前有效原文与澄清均无截止时间证据时必须询问，不从旧 requirement 或默认值回填；只有日期没有具体时刻时必须澄清，不默认时刻、不宣称无需澄清；已有小时和分钟且可唯一确定未来时间时仅补秒，不重复询问。只解析、不落库的请求仍指出缺失，但不得继续下游。该规则不依赖 persist 事件携带调用参数，也不新增日期解析器或状态。

指令覆盖的工具与行为（详见 [flows.md](./flows.md)）：

| 工具                                                               | 成功时                                                                                                                                                                                                                                                                                                        | 失败/特殊时                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ypscan_parse_requirement`                                         | 复核指令 + `DIFY_RESOLVED_FIELDS`/`DIFY_MISSING_FIELDS`                                                                                                                                                                                                                                                       | `flowPauseDirective`（重试/结束弹窗）                                                                                           |
| `validate_requirement`                                             | 按模式给 `SEARCH_CREATORS_ARGS` 或 `SELECT_INQUIRY_FORM_FIELDS_ARGS`；手动拓展另注入字段选择门规则（URL 后结束本轮，历史“不再选字段”不算提交证据，禁试调后续工具）                                                                                                                                            | 预检阻断文本 → 修正指令；其余 pause                                                                                             |
| `search_creators`                                                  | `RANK_MCNS_ARGS`（忽略导出链接）                                                                                                                                                                                                                                                                              | pause                                                                                                                           |
| `rank_mcns`                                                        | 五列表格锁定 + `SAVE_ARTIFACT_ARGS(mcn_ranking)`（或字段选择+机构弹窗）；空列表给复核/放宽策略                                                                                                                                                                                                                | pause                                                                                                                           |
| `select_inquiry_form_fields`                                       | `FIELD_SELECTION_URL` 原样输出 + 字段选择门规则；若 Provider 自动打开失败但链接有效，则如实展示链接并等待用户回复“好了”                                                                                                                                                                                       | pause                                                                                                                           |
| `create_with_distributions`                                        | 逐机构发送状态摘要；无收件机构回到机构选择；项目非进行中时原样展示错误并停止，不调用旧状态工具                                                                                                                                                                                                                | —                                                                                                                               |
| `sync_mcn_inquiry_status`                                          | `INGEST_MCN_SUBMISSIONS_ARGS`（sync 直接返回 `inquiry_ids`，立即 ingest，不回读 `get_workflow_state`）                                                                                                                                                                                                        | pause                                                                                                                           |
| `ingest_mcn_submissions`                                           | `GET_INGEST_JOB_ARGS`；缺 `job_id` 给恢复弹窗                                                                                                                                                                                                                                                                 | pause                                                                                                                           |
| `get_ingest_job`                                                   | Excel-only 终态 → `SAVE_ARTIFACT_ARGS(mcn_creator_preview)`（requirement_id 优先取调用参数，缺失时按 job_id 反查 ingest 记录）；`partially_succeeded` 额外给 `INGEST_PARTIAL_SUMMARY`；终态成功但缺 requirement_id 时 pause 而非继续轮询；未到终态继续轮询（上限 10 次）                                      | `failed`/`cancelled`/`canceled`/`error` 终态 pause，不再轮询                                                                    |
| `manual_source_creators`                                           | 分三态：links CSV→`SAVE_ARTIFACT_ARGS(manual_creator_links)`；Excel→`SAVE_ARTIFACT_ARGS(manual_source)` 降级交付+放宽策略（完整放宽规则只在结果时刻注入，启动块只保留精简短fall规则）；batch_id→`MANUAL_SOURCE_CREATORS_STATUS_ARGS`（只带 `requirement_id`+`batch_id`；目标数量按 live schema 决定是否并入） | 缺字段配置→字段选择；其余 pause                                                                                                 |
| `manual_source_creators_status`                                    | 同三态（Excel 交付同样附完整放宽规则）；`BATCH_NOT_READY` 继续 30s 轮询（上限 10 次；续接优先沿用上一轮实际使用的 `num` 作为 `MANUAL_SOURCE_TARGET_NUM`，缺失时回落到落库 `quantityTotal`；只有当前环境 live schema required `num` 时才并入远端调用）                                                         | pause                                                                                                                           |
| `get_xhs_author_business_card` / `get_douyin_author_business_card` | `COMPLETION_CSV_FILE` + 成功/失败 ID，提示汇总后调用 `file_bridge`；固定注入 `FILE_BRIDGE_FLOW=manual_source`（两分支统一合并上传后打分）                                                                                                                                                                     | pause                                                                                                                           |
| `score_manual_source_csv`                                          | `job_id` → `SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS`（30s 轮询）；全失败不生成空 Excel                                                                                                                                                                                                                            | 缺字段配置→同 requirement 字段选择，保留到本轮可信 `csv_file_path` 时附精确 `SCORE_MANUAL_SOURCE_CSV_ARGS` 重提参数；其余 pause |
| `score_manual_source_csv_status`                                   | 终态 → `SAVE_ARTIFACT_ARGS(manual_source)`（requirement_id 优先取调用参数，缺失时按 job_id 反查打分记录）；终态成功但缺 requirement_id 时 pause 而非继续轮询；未完成继续 30s 轮询（上限 10 次）                                                                                                               | 缺字段配置→同 requirement 字段选择（按 job 记录回填 `csv_file_path` 并附精确重提参数）；其他失败终态 pause                      |
| `rank_creators`                                                    | 已废弃：正式链路不再调用；若被调用仍给 `SAVE_ARTIFACT_ARGS(ranked_submission)`（遗留）；全失败不生成空提报表                                                                                                                                                                                                  | pause                                                                                                                           |
| `ypscan_save_artifact`                                             | 按 kind 给下一步：mcn_ranking→机构弹窗/字段选择；mcn_creator_preview→询问是否补全（ypscan_save_creator_links 读取预览并派生 links CSV→原生补全）；manual_source→最终打分排序交付；ranked_submission→结束（遗留）；manual_creator_links→`SAVE_CREATOR_LINKS_ARGS(requirement_id,platform,links_csv_path)` 归一化→20/批补全；mcn_creator_links→无指令（遗留）                          | pause                                                                                                                           |
| `ypscan_save_creator_links`                                        | `CREATOR_LINKS_LOCAL_PATH`/`LOCAL_LINK`，提示按 20/批原生补全 → `file_bridge(manual_source)` → 打分                                                                                                                                                                                                       | pause                                                                                                                           |
| `file_bridge`                                                      | 展示 merged CSV 本地链接；`mcn_complete_only` 直接交付；行数>500 跳过上传并停止；`manual_source` 上传成功后给 `SCORE_MANUAL_SOURCE_CSV_ARGS`；`mcn_rank` 上传成功后给兼容 `RANK_CREATORS_ARGS(requirement_id,csv_file_path)`，仅供 live schema 明确升级后使用                                                 | 合并或上传失败 pause；已有本地文件时仍先展示                                                                                    |
| 遗留 `ypscan_select_cascade`/`ypscan_set_filter_range`             | Browser 验证/恢复提示                                                                                                                                                                                                                                                                                         | —                                                                                                                               |

失败且无专门处理时：`ypscan_parse_requirement`、`validate_requirement`、`search_creators`、`rank_mcns` 给 `flowPauseDirective`（`YPSCAN_FLOW_DIRECTIVE=<阶段> 已暂停（code）` + `ASK_USER_QUESTION_ARGS` 重试/结束），其余工具返回 null（不追加）。

## 6. Gateway 生命周期

`gateway_start`、`gateway_stop` 仅调用 `hookRuntime.resetTransientState()`，无其他副作用；不向宿主输出、不影响工具注册。
