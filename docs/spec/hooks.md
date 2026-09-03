# Hook 契约

`src/hooks/register-flow-directives.js` 注册 3 个流程 Hook（`HOOK_OPTIONS = { priority: 90, timeoutMs: 5000 }`），`index.js` 注册 2 个 Gateway 生命周期 Hook。Smoke 断言 Hook 集合固定为 5 个：`before_prompt_build`、`before_tool_call`、`tool_result_persist`、`gateway_start`、`gateway_stop`。

## 1. 注册形态

| Hook                  | 注册位置                 | 作用                                                  |
| --------------------- | ------------------------ | ----------------------------------------------------- |
| `before_prompt_build` | register-flow-directives | 每会话首次注入静态启动指令块                          |
| `before_tool_call`    | register-flow-directives | 仅对 `validate_requirement` 做归一化 + 预检，失败阻断 |
| `tool_result_persist` | register-flow-directives | 记录瞬态映射并按工具结果追加下一步指令                |
| `gateway_start`       | index.js                 | 重置瞬态状态                                          |
| `gateway_stop`        | index.js                 | 重置瞬态状态                                          |

## 2. 瞬态状态（不持久化）

| 映射                              | 键             | 值                     | 写入点                                                                                                                                      |
| --------------------------------- | -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `startupScopes`                   | scopeKey       | Set 标记               | `before_prompt_build` 首见 scope                                                                                                            |
| `businessModeByScope`             | scopeKey       | `询价机构`/`手动拓展`  | `before_tool_call` 预检通过时                                                                                                               |
| `platformByScope`                 | scopeKey       | `xiaohongshu`/`douyin` | 同上                                                                                                                                        |
| `platformByRequirement`           | requirement_id | 平台                   | `tool_result_persist` 中 `validate_requirement` 成功或其他工具带平台成功时                                                                  |
| `creatorLinksCsvUrlByRequirement` | requirement_id | links CSV URL          | `manual_source_creators_status` / `get_ingest_job` 成功且带 CSV URL 时                                                                      |
| `inquiryIdsByRequirement`         | requirement_id | inquiry_ids 数组       | `get_workflow_state` 成功且返回非空 `inquiry_ids` 时                                                                                        |
| `requirementIdByScoreJobId`       | job_id         | requirement_id         | `score_manual_source_csv` / `score_manual_source_csv_status` 成功且带 job_id+requirement_id 时                                              |
| `requirementIdByIngestJobId`      | job_id         | requirement_id         | `ingest_mcn_submissions` / `get_ingest_job` 成功且带 job_id+requirement_id 时（ingest 缺失时按 inquiry_ids 反查 `inquiryIdsByRequirement`） |

- `scopeKey` 取 `sessionKey/sessionId/runId/run_id` 中第一个非空值，缺省 `"global"`。
- 映射只是路由辅助：模式/平台在设计上总可从参数或结果再推导，不把映射当唯一真相。
- `gateway_start`/`gateway_stop` 调用 `resetTransientState()` 清空全部映射；会话重启后指令会重新注入。

## 3. before_prompt_build

每个 scope 只注入一次启动指令块（`prependContext`），内容为静态业务规则的汇总。要点：

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

- 只处理 `validate_requirement`（按 `stripHostPrefix` 归一化工具名）。
- 流程：`normalizeToolCallParams`（确定性、无损归一化，见 [contracts.md](./contracts.md)）→ `validateRequirementPreflight`。
- 预检有 issue 时返回 `{ block: true, blockReason }`，`blockReason` 以 `YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED` 开头，含「一次性修正项：field: reason…」、区间格式契约与澄清弹窗规则；Provider 不收到本次写入。
- 预检通过时：`rawMessagesJson` 序列化为字符串传给 Provider（`serializeProviderRawMessages`）；按 scope 记录 `business_mode` 与 `platform`；参数有变化时返回 `{ params }`，否则不干预。
- 不做功能互斥、不做企微发送确认门禁（Provider 边界）。

## 5. tool_result_persist

1. 从结果解析 `requirement_id`/`platform`，成功时写入 `platformByRequirement`；`manual_source_creators_status`、`get_ingest_job` 成功且含 CSV URL 时写入 `creatorLinksCsvUrlByRequirement`；`get_workflow_state` 成功且返回非空 `inquiry_ids` 时写入 `inquiryIdsByRequirement`；score/ingest 链路成功且带 job_id 时按 job_id 记录 requirement_id 映射（ingest 缺 requirement_id 时按 inquiry_ids 反查）。
2. 调 `flowDirective(toolName, message, params, ...)` 生成指令，追加到结果消息尾部（`appendDirective`）；`get_ingest_job` / `score_manual_source_csv_status` 调用参数缺 `requirement_id` 时先按 job_id 映射补齐再生成指令。

指令覆盖的工具与行为（详见 [flows.md](./flows.md)）：

| 工具                                                               | 成功时                                                                                                                                                                                                                                                                        | 失败/特殊时                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `ypscan_parse_requirement`                                         | 复核指令 + `DIFY_RESOLVED_FIELDS`/`DIFY_MISSING_FIELDS`                                                                                                                                                                                                                       | `flowPauseDirective`（重试/结束弹窗） |
| `validate_requirement`                                             | 按模式给 `SEARCH_CREATORS_ARGS` 或 `SELECT_INQUIRY_FORM_FIELDS_ARGS`                                                                                                                                                                                                          | 预检阻断文本 → 修正指令；其余 pause   |
| `search_creators`                                                  | `RANK_MCNS_ARGS`（忽略导出链接）                                                                                                                                                                                                                                              | pause                                 |
| `rank_mcns`                                                        | 五列表格锁定 + `SAVE_EXCEL_ARTIFACT_ARGS`（或字段选择+机构弹窗）；空列表给复核/放宽策略                                                                                                                                                                                       | pause                                 |
| `select_inquiry_form_fields`                                       | `FIELD_SELECTION_URL` 原样输出，等“好了”                                                                                                                                                                                                                                      | pause                                 |
| `create_with_distributions`                                        | 逐机构发送状态摘要；失败分类处理（无收件机构/项目非进行中→`GET_WORKFLOW_STATE_ARGS`）                                                                                                                                                                                         | —                                     |
| `sync_mcn_inquiry_status`                                          | `GET_WORKFLOW_STATE_ARGS`（sync 后不直接 ingest）                                                                                                                                                                                                                             | pause                                 |
| `ingest_mcn_submissions`                                           | `GET_INGEST_JOB_ARGS`；缺 `job_id` 给恢复弹窗                                                                                                                                                                                                                                 | pause                                 |
| `get_ingest_job`                                                   | 预览表+CSV 双 URL → `SAVE_EXCEL_ARTIFACT_ARGS`（requirement_id 优先取调用参数，缺失时按 job_id 反查 ingest 记录）；终态成功但缺 requirement_id 时 pause 而非继续轮询；未到 `succeeded`/`partially_succeeded` 继续轮询（上限 10 次）                                           | pause                                 |
| `manual_source_creators`                                           | 分三态：links CSV→`SAVE_CSV_ARTIFACT_ARGS`；Excel→降级交付+放宽策略；batch_id→`MANUAL_SOURCE_CREATORS_STATUS_ARGS`（带 `requirement_id`+`batch_id`，并按当前 requirement 落库 `quantityTotal` 预填 `num`；与用户最新确认不同时以最新确认为准，未预填时由 Agent 补必填 `num`） | 缺字段配置→字段选择；其余 pause       |
| `manual_source_creators_status`                                    | 同三态；`BATCH_NOT_READY` 继续 30s 轮询（上限 10 次，`num` 必填正整数；续接时优先沿用上一轮实际使用的 `num`，缺失时回落到落库 `quantityTotal`）                                                                                                                               | pause                                 |
| `get_xhs_author_business_card` / `get_douyin_author_business_card` | `COMPLETION_CSV_FILE` + 成功/失败 ID，提示汇总后 merge；按当前业务分支注入 `YPSCAN_MERGE_FLOW`（手动拓展→`manual_source`，询价机构→`mcn_complete_only`）                                                                                                                      | pause                                 |
| `score_manual_source_csv`                                          | `job_id` → `SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS`（30s 轮询）；全失败不生成空 Excel                                                                                                                                                                                            | pause                                 |
| `score_manual_source_csv_status`                                   | 终态 → `SAVE_EXCEL_ARTIFACT_ARGS(manual_source)`（requirement_id 优先取调用参数，缺失时按 job_id 反查打分记录）；终态成功但缺 requirement_id 时 pause 而非继续轮询；未完成继续 30s 轮询（上限 10 次）                                                                         | pause                                 |
| `rank_creators`                                                    | `SAVE_EXCEL_ARTIFACT_ARGS(ranked_submission)`；全失败不生成空提报表                                                                                                                                                                                                           | pause                                 |
| `ypscan_save_excel_artifact`                                       | 按 kind 给下一步（mcn_ranking→机构弹窗/字段选择；mcn_creator_preview→保存 links CSV；manual_source→结果策略+放宽规则；ranked_submission→结束）                                                                                                                                | pause                                 |
| `ypscan_save_csv_artifact`                                         | manual_creator_links→20/批补全；mcn_creator_links→精排（`RANK_CREATORS_ARGS` 带 `requirement_id`+`inquiry_ids`）/只补全弹窗                                                                                                                                                   | pause                                 |
| `ypscan_merge_creator_csv`                                         | 展示链接 + `UPLOAD_CREATOR_CSV_ARGS`（flow 缺省时按当前业务分支推导：手动拓展→`manual_source`，询价机构→`mcn_complete_only`）；`mcn_complete_only` 直接交付；行数>500 阻断提示                                                                                                | pause                                 |
| `ypscan_upload_creator_csv`                                        | `SCORE_MANUAL_SOURCE_CSV_ARGS`（带 `csv_file_path`）；上传仅限 manual_source 分支，精排分支不经 upload/`rank_creators` 不消费 `csv_file_path`                                                                                                                                 | pause                                 |
| 遗留 `ypscan_select_cascade`/`ypscan_set_filter_range`             | Browser 验证/恢复提示                                                                                                                                                                                                                                                         | —                                     |
| `get_workflow_state`                                               | 非空 `inquiry_ids` → `INGEST_MCN_SUBMISSIONS_ARGS`（只传本次 inquiry_ids）；为空（已分发/mcn_planning）→ `SYNC_MCN_INQUIRY_STATUS_ARGS`                                                                                                                                       | pause                                 |

失败且无专门处理时：`ypscan_parse_requirement`、`validate_requirement`、`search_creators`、`rank_mcns` 给 `flowPauseDirective`（`YPSCAN_FLOW_DIRECTIVE=<阶段> 已暂停（code）` + `ASK_USER_QUESTION_ARGS` 重试/结束），其余工具返回 null（不追加）。

## 6. Gateway 生命周期

`gateway_start`、`gateway_stop` 仅调用 `hookRuntime.resetTransientState()`，无其他副作用；不向宿主输出、不影响工具注册。
