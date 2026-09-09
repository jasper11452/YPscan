# 本地工具契约

`index.js` 注册 5 个本地工具（`contracts.tools` 同列）。所有工具结果经 `src/tools/tool-result.js` 包装：`content` 为 JSON 文本（成功/失败结构见各工具），失败时附 `isError: true`，需要宿主展示的详情放 `details`。

| 工具                        | 职责                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `ypscan_parse_requirement`  | 解析当前单个平台的完整最新需求（Dify 代理）                           |
| `ypscan_save_artifact`      | 按 artifact kind 受控保存 Provider 返回的 Excel 或 links CSV          |
| `ypscan_save_creator_links` | 归一化受控三列 links CSV（手动拓展传 Provider 原始 links CSV 路径，询价回收传受控预览 xlsx），并登记为合法 links 来源                        |
| `file_bridge`               | 合并 links CSV 与多批达人补全 CSV；按 flow 决定本地交付或校验上传 OSS |
| `ypscan_summarize_manual_scores` | 按受控来源累计手动拓展评分，返回下一批或生成最终汇总 Excel |

## 1. ypscan_parse_requirement

### 参数（`additionalProperties: false`）

| 字段            | 类型   | 必填 | 约束                                                                                                                                           |
| --------------- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `demand`        | string | 是   | `minLength: 1`；当前单个平台完整最新需求原文；首次解析及用户修改业务条件后必传；手动拓展首次澄清改变有效需求或确认放宽后，传应用全部当前有效答案的无冲突完整需求全文，与 rawMessagesJson.original 一致；全文和最近成功解析输入相同且结果有效时不重调；其余重传只合并原始表述与人工改口，禁止回填历史解析输出或未确认放宽值 |
| `business_mode` | string | 是   | enum：`询价机构` / `手动拓展`；来自用户明确表达，未明确或语义冲突时经模式选择确定                                                              |

### 实现事实

- POST `https://dfi.eshypdata.com/v1/workflows/run`，`response_mode: "blocking"`，`AbortSignal.timeout(60_000)`，`user` 为 `ypscan-<demand sha256 前 24 位>`；凭据为内置公开 Workflow Key 常量（`DIFY_PUBLIC_WORKFLOW_KEY`）。

### 输出

`success: true` + `data.outputs`，`outputs` 只保留以下字段中实际返回的键（缺失字段省略，不补空值）：

- 8 个可选 Label：`growBloggerTypeLabel`、`contentFeatureLabel`、`contentThemeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`industryTagLabel`、`growTalentTypeLabel`；`contentTag`
- 品牌：`brandName`、`xhsbrandName`、`dybrandName`
- 数值：`followercount`、`rebate`；报价 `kolOfficialPrice`/`L1/L2/L3`/`xhs_kolOfficialPrice`/`dy_kolOfficialPrice`；`cpm`/`L1/L2/L3`/`xhs_cpm`/`dy_cpm`；`cpe`/`L1/L2/L3`/`xhs_cpe`/`dy_cpe`。其中 `followercount` 缺失或解析为“不限”时，由 `validate_requirement` 本地边界默认落库全量区间 `[0,999999999]`，不省略、不弹窗；历史坏值 `[1,999999999]` 归一为 `[0,999999999]`。

### 错误码

| 错误码                    | 触发                          |
| ------------------------- | ----------------------------- |
| `INVALID_INPUT`           | demand 非空失败               |
| `INVALID_BUSINESS_MODE`   | business_mode 非法            |
| `DIFY_API_KEY_MISSING`    | 凭据不可用                    |
| `DIFY_CLIENT_UNAVAILABLE` | 无 fetch 实现                 |
| `DIFY_TIMEOUT`            | 60s 超时                      |
| `DIFY_REQUEST_FAILED`     | 请求失败（非超时）            |
| `DIFY_INVALID_RESPONSE`   | 响应非 JSON                   |
| `DIFY_HTTP_ERROR`         | 非 2xx                        |
| `DIFY_WORKFLOW_FAILED`    | `data.status !== "succeeded"` |
| `DIFY_OUTPUT_INVALID`     | 缺少 outputs 对象             |

## 2. ypscan_save_artifact

⚠️ 破坏性变更：原 `ypscan_save_excel_artifact` 与 `ypscan_save_csv_artifact` 已移除。调用方统一改用本工具，并把格式专用的 URL 参数改为 `file_url`；文件格式只由 `artifact_kind` 决定。

### 参数

| 字段            | 类型     | 必填 | 约束                                                                                                                                                   |
| --------------- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifact_kind` | string   | 是   | enum：`creator_detail_export`、`mcn_ranking`、`mcn_creator_preview`、`manual_source`、`manual_score_batch`、`ranked_submission`、`manual_creator_links`、`mcn_creator_links` |
| `artifact_id`   | string   | 是   | 关联 ID：除 `creator_detail_export` 用 batch/task ID 外，其余用 `requirement_id`                                                                       |
| `file_url`      | string   | 是   | Provider 返回的原始 Excel 或 CSV 下载 URL                                                                                                              |
| `mcn_names`     | string[] | 否   | 仅 `mcn_ranking` 使用：当前排序结果中的机构名称，用于保存后生成收件机构选择弹窗                                                                        |

### 格式与保存约束

- `creator_detail_export`、`mcn_ranking`、`mcn_creator_preview`、`manual_source`、`manual_score_batch`、`ranked_submission` 保存为 `.xlsx`；`manual_creator_links`、`mcn_creator_links` 保存为 `.csv`。URL 中没有符合 kind 的文件名时，使用下述确定性回退名称。CSV kind 只做受控下载落盘，不解析内容，不是受控 links 来源；受控三列 links CSV 由 `ypscan_save_creator_links` 归一化产出（见 §4）。
- URL 必须是 `https:` 且 hostname 为 `eshypdata.com` 或其子域，无端口、无用户信息、无 hash。
- 下载 `redirect: "error"`（重定向即失败）；总预算 20s；内容上限 20 MiB。
- 有限重试（间隔为 `[1000, 2000, 4000]` ms，带抖动），仅对 `429/500/502/503/504`、超时与下载失败重试；遵守 `retry-after`。
- 文件名从 URL `file_path` 参数或 pathname 推导；Excel 兼容 base64 `file_path`。没有明确文件名时回退为 `<artifact_kind>-<sha256 前 16 位>.<格式扩展名>`。
- 保存到 `workspaceDir`（宿主提供的绝对路径，`realpath` 校验为目录）：临时文件 0600 写入 → `link()` 原子发布；目标已存在且 sha256 相同视为幂等成功，任何路径均不覆盖不同内容、不接受符号链接。
- 仅 `manual_source` / `manual_score_batch`：URL 推导的文件名已存在且内容不同时，改用 `<artifact_kind>-<artifact_id 的 SHA-256 前 16 位>-<内容 SHA-256>.xlsx` 再原子发布一次，保留原文件，兼容不同评分导出同名或复用下载 URL。回退路径同内容幂等成功，内容不同仍报 `YPSCAN_ARTIFACT_SAVE_CONFLICT`，不安全路径仍报错。其他 kind 的同名异内容继续直接报冲突。保存工具只解决碰撞；推荐计数、跨批汇总和下一批决策由评分汇总工具负责。

### 输出（成功）

- `data`：`artifact_kind`、`artifact_id`（原样回显调用关联元数据）、`file_name`、`file_path`、`byte_count`、`sha256`、`idempotent`、`download_attempts`。
- `delivery`：`local_path`、`local_file_link`（可点击 Markdown 链接）、`display_required`、`display_before_next_action`、`user_visible_message`；`mcn_ranking` 额外附 `next_tool: "AskUserQuestion"`、`next_args`（收件机构弹窗）、`next_action`。Excel kind 的 `display_required=true`，Agent 必须原样展示 `local_file_link`，不得只输出裸路径；`manual_creator_links`/`mcn_creator_links` 是内部中间产物，`display_required=false` 且不主动向用户展示表格、链接或本地路径。

### 错误码

`YPSCAN_ARTIFACT_INVALID_INPUT`、`YPSCAN_ARTIFACT_DOWNLOAD_URL_INVALID`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_ARTIFACT_DOWNLOAD_UNAVAILABLE`、`YPSCAN_ARTIFACT_DOWNLOAD_TIMEOUT`、`YPSCAN_ARTIFACT_REDIRECT_FORBIDDEN`、`YPSCAN_ARTIFACT_DOWNLOAD_FAILED`、`YPSCAN_ARTIFACT_TOO_LARGE`、`YPSCAN_ARTIFACT_INVALID_CONTENT`、`YPSCAN_ARTIFACT_SAVE_UNSAFE_PATH`、`YPSCAN_ARTIFACT_SAVE_CONFLICT`、`YPSCAN_ARTIFACT_SAVE_FAILED`。失败结构统一为 `{ success:false, error:{ code, message, details:{ reason,...details }, retriable } }`。

## 3. file_bridge

⚠️ 破坏性变更：原 `ypscan_merge_creator_csv` 已移除。合并能力保留为 `file_bridge` 的内部步骤，调用方直接传 links CSV 与本次补全 CSV（手动拓展仅当前批，机构回收全部批次），不再传中间 `merged_csv_path`。

### 参数

| 字段                   | 类型     | 必填 | 约束                                                   |
| ---------------------- | -------- | ---- | ------------------------------------------------------ |
| `requirement_id`       | string   | 是   | 当前 requirement                                       |
| `platform`             | string   | 是   | enum：`xiaohongshu`、`douyin`                          |
| `flow`                 | string   | 是   | enum：`manual_source`、`mcn_rank`、`mcn_complete_only` |
| `links_csv_path`       | string   | 是   | 已保存 links CSV 的绝对路径                            |
| `completion_csv_paths` | string[] | 是   | 一批或多批补全 CSV 的绝对路径，`minItems: 1`           |

### 合并语义

- links/补全输入拒绝首尾空白路径，不对歧义路径 trim 后授权再读原路径。CSV 输入仍要求绝对路径；来源登记可把无首尾空白的宿主相对路径按 workspaceDir 规范化。

- links CSV 必含 `source_record_id`、`creator_id`、`url` 三列（表头归一化匹配，`-`/空格/大小写不敏感）。
- 每批补全 CSV 按平台选择第一个存在的 ID 列：抖音 `creator_id → 请求星图ID → 星图ID → xt_id → 请求kw_uid → kw_uid → author_id → authorid → id`；小红书保留 `creator_id → 请求kw_uid → kw_uid → xt_id → author_id → authorid → id`。表头归一化同 links（首尾 BOM 由 trim 去除）；优先列存在但值为空或不匹配时，不逐行回退或按匹配率猜列。
- ID 始终按字符串关联，按 ID 去重取首条；19 位星图 ID 不转换为 Number。
- 输出保持 links 原顺序；headers = `source_record_id, creator_id, url` + 各补全 CSV 的非保留详情列（排除 ID 列与 `source_record_id`/`creator_id`/`url`）。
- 未匹配到的 creator_id 计入 `missing_creator_ids`（不中断）。它只表示缺少所传补全 CSV 的匹配行；仅传某批 CSV 时也包含其他未开始批次的达人，不能直接当作失败或待重试名单。
- 输出文件名：`<flow 前缀>-<平台>-<requirement_id>-<sha256 前 8 位>.csv`，前缀映射 `manual_source→manual-source`、`mcn_rank→mcn-rank`、`mcn_complete_only→mcn-complete`；同名文件内容一致则复用，不一致报 `YPSCAN_CREATOR_CSV_MERGE_CONFLICT`。
- merged CSV 没有数据行时返回 `YPSCAN_FILE_BRIDGE_EMPTY`（`retriable=false`），不上传；`error.details` 保留完整合并详情（含行数、匹配/未匹配 ID 和关联列诊断），`delivery` 仍保留本地文件信息供诊断，但不主动向用户展示。
- `flow=mcn_complete_only` 时合并完成即返回，不读取 OSS 配置、不上传。
- `manual_source`/`mcn_rank` 数据行超过 500 时返回合并成功和本地文件，`upload_skipped="row_limit_exceeded"`，不上传、不进入后续打分或精排。

### 上传

- 仅 `flow=manual_source` 或 `flow=mcn_rank` 且数据行在 1–500 时上传。
- 使用 `ali-oss` 直连 OSS；配置读取顺序固定为：插件配置 `fileBridgeOss` → 打包内置凭据（`src/tools/file-bridge-oss-defaults.json`，由 prepack 从本机 `.env`/环境变量注入安装包，不进 git）。运行时不隐式读取宿主进程环境变量，内部测试/集成可显式注入；`region`/`bucket`/`objectPrefix` 未配置时回落到内置非敏感默认值（`oss-cn-shanghai`/`ypmisc`/`action`），仅 AK/SK 缺失才报 `YPSCAN_FILE_BRIDGE_CONFIG_MISSING`。
- 精确配置键：插件配置与打包内置凭据使用 `accessKeyId`、`accessKeySecret`、`region`、`bucket`、`objectPrefix`（插件配置嵌套在 `fileBridgeOss` 下）；显式注入的环境变量使用 `AccessKeyId`、`AccessKeySecret`、`Region`、`Bucket`、`Object`。对象前缀规范化后参与对象键拼接。
- 上传前强制来源与格式校验：links 与补全路径必须都是 `.csv`（否则 `YPSCAN_FILE_BRIDGE_INVALID_INPUT`）；merged CSV 内容必须以 `source_record_id,creator_id,url` 开头且不含控制字符（否则 `YPSCAN_FILE_BRIDGE_INVALID_CSV`）；links CSV 必须是当前 requirement 受控保存的产物（`ypscan_save_artifact` 保存的 `manual_creator_links`/`mcn_creator_links` 原始下载物，或 `ypscan_save_creator_links` 归一化生成并登记的 links CSV），补全 CSV 必须来自当前 requirement 的 YP Action 原生补全工具返回的 `csv_file`（否则 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED`，保留本地交付，不上传）。只有 url 列等不合三列契约的原始下载物会在 merge 阶段被 `YPSCAN_CREATOR_LINKS_CSV_INVALID` 拒绝；正式流程必须经 `ypscan_save_creator_links` 归一化。
- 对象键固定为 `<Object 前缀>/<flow>/<requirement_id>/<sha256>.csv`；当前用户要求下默认形态为 `action/<flow>/<requirement_id>/<sha256>.csv`，不依赖时间戳，同内容幂等落到同一路径。
- 上传时设置 `Content-Type: text/csv; charset=utf-8` 与 `x-oss-object-acl: public-read`。
- 成功后构造未签名公网 URL `https://<bucket>.<region>.aliyuncs.com/<encoded object key>`，并以有限次匿名 `HEAD/GET` 校验确认 URL 可读；不可读则返回专门错误，不把坏链接交给下游。

### 输出（成功）

- `data` 始终包含：`requirement_id`、`platform`、`flow`、`file_name`、`file_path`、`data_row_count`、`matched_creator_ids`、`missing_creator_ids`、`completion_csv_paths`、`completion_id_columns`、`links_csv_path`、`sha256`。`completion_id_columns` 按输入文件顺序记录 `{file_path, id_column}`，列名仅为展示去除首尾空白/BOM。
- 上传成功时额外包含 `csv_file_path`、`object_key`；超过 500 行时额外包含 `upload_skipped`、`upload_limit`。
- 非交付进度消息仅描述数据合并/上传状态，不包含地址或内部展示指令；上传成功为“数据已合并上传。”。`data.csv_file_path` 保留原始地址供打分工具使用，原始工具面板由宿主控制。
- `delivery` 始终包含本地 `local_file_path` 与 `local_file_link`；`manual_source`/`mcn_rank` 与失败结果 `display_required=false`，merged CSV 是内部中间产物、不主动向用户展示；仅遗留 `mcn_complete_only` 分支（本地 merged CSV 即该分支唯一产物）`display_required=true`。

### 错误码

合并阶段：`YPSCAN_CREATOR_CSV_MERGE_INVALID_INPUT`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_CREATOR_LINKS_CSV_INVALID`、`YPSCAN_COMPLETION_CSV_INVALID`、`YPSCAN_CREATOR_CSV_MERGE_CONFLICT`、`YPSCAN_CREATOR_CSV_MERGE_FAILED`。后续阶段：`YPSCAN_FILE_BRIDGE_EMPTY`、`YPSCAN_FILE_BRIDGE_INVALID_INPUT`、`YPSCAN_FILE_BRIDGE_INVALID_CSV`、`YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED`、`YPSCAN_FILE_BRIDGE_CONFIG_MISSING`、`YPSCAN_FILE_BRIDGE_UPLOAD_FAILED`、`YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE`。

## 4. ypscan_save_creator_links

### 参数（`additionalProperties: false`）

| 字段                | 类型   | 必填   | 约束                                                                           |
| ------------------- | ------ | ------ | ------------------------------------------------------------------------------ |
| `requirement_id`    | string | 是     | `minLength: 1`；当前 requirement                                               |
| `platform`          | string | 是     | enum：`xiaohongshu` / `douyin`                                                 |
| `links_csv_path`    | string | 二选一 | 当前 requirement 由 `ypscan_save_artifact(manual_creator_links)` 保存的原始 links CSV 绝对路径，与 `preview_file_path` 互斥 |
| `preview_file_path` | string | 二选一 | 当前 requirement 已保存的预览 xlsx 绝对路径，与 `links_csv_path` 互斥           |

### 行为

- 两个入口共用同一归一化管线，写出表头 `source_record_id,creator_id,url` 的本机 CSV，文件名 `mcn-links-<requirement_id>-<sha256 前 8 位>.csv`，同名内容一致幂等复用，不一致报 `YPSCAN_CREATOR_LINKS_CONFLICT`。
- Provider links CSV 入口（`links_csv_path`）：
  - 必须是当前 requirement 受控保存的原始下载物（来源门禁提供时校验，否则 `YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED`），且必须是当前项目内的普通 `.csv` 文件。
  - `url` 列必填，`creator_id`/`source_record_id` 列可选；缺少或重复表头报 `YPSCAN_CREATOR_LINKS_INVALID_CSV`。
  - 缺 `creator_id` 时按平台主页规则从 url 推导：小红书支持 `www.xiaohongshu.com`/`xiaohongshu.com` 的 `/user/profile/<id>` 与 `pgy.xiaohongshu.com` 的 `/solar/pre-trade/blogger-detail/<id>`；抖音支持 `www.xingtu.cn` 的 `/ad/creator/author-homepage/douyin-video/<id>`。短链等无法推导、或给定 `creator_id` 与 url 不匹配时，整份失败报 `YPSCAN_CREATOR_LINKS_INVALID_ROWS`。
  - `source_record_id` 缺失时回落为稳定行号（1-based）；`creator_id` 重复保留首条、保持 Provider 原顺序。
- 预览 xlsx 入口：行为与错误码同历史契约（哈希校验、唯一工作表与表头、主页匹配校验；`source_record_id` 缺失留空）。
- 校验：`creator_id`/`url` 非空且不含控制字符；去重后无行报 `YPSCAN_CREATOR_LINKS_EMPTY`。
- 保存后通过 `recordLinksCsv` 登记进 `linksCsvPathsByRequirement`，使 `file_bridge` 上传门禁接受该 CSV 为合法 links 来源。

### 输出（成功）

- `data`：`file_name`、`file_path`、`row_count`、`sha256`。
- 预览 xlsx 输入额外返回 `data.preview`：file_path、sha256、sheet、header_row、headers、records（最多前 100 条且累计 cells JSON 不超过 256 KiB，含行号及原始 cells）、total_row_count、records_truncated、duplicate_creator_ids、verification_status=unverified。记录数及去重数不等于合格人数。主页须为对应平台支持的主页格式且路径 ID 与所选 ID 一致，未知格式报错而非猜测。
- `delivery`：`local_path`、`local_file_link`、`display_required=false`、`display_before_next_action=false`、`user_visible_message`；归一化后的 links CSV 是内部中间产物，Agent 不主动向用户展示表格、链接或本地路径，直接继续补全与打分。

### 错误码

`YPSCAN_CREATOR_LINKS_INVALID_INPUT`、`YPSCAN_CREATOR_LINKS_INVALID_CSV`、`YPSCAN_CREATOR_LINKS_INVALID_ROWS`、`YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED`、`YPSCAN_CREATOR_LINKS_EMPTY`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_CREATOR_LINKS_WRITE_FAILED`、`YPSCAN_CREATOR_LINKS_CONFLICT`。

预览 xlsx 输入错误前缀为 `YPSCAN_CREATOR_PREVIEW_`，后缀：SOURCE_NOT_ALLOWED、SOURCE_CHANGED、LIMIT、HEADERS、ROWS、EMPTY、READ_FAILED。

## 5. ypscan_summarize_manual_scores

实现 `src/tools/manual-score-summary.js`，入口只接受 `{requirement_id}`，来源由 Hook 与本地保存工具登记，不接受模型传入文件路径或推荐人数。模式必须为手动拓展；N 使用 validate 成功调用的 quantityTotal。候选按归一化 links 顺序去重，最多按梯度候选池（10 人→30、20 人→50、50 人→100）；首批按 min(20,N) 排批，之后每批最多 20 人。评分表必须含唯一“需求ID”元数据与“平台”、当前平台 ID（星图ID/蒲公英ID）、“综合得分”、“推荐结论”列；只接受精确“推荐”/“不推荐”。跨表按达人 ID 去重，相同达人不同结果报错，不挑高分覆盖。

返回 `next_action`（complete_next_batch / await_scores / deliver）、`next_author_ids`、`recommended_count`、`scored_count`、`excluded_zero_score_count`、`target_count`、`candidate_count`、`completion_failed_count`、`failed_author_ids`、`pending_score_author_ids`、`unprocessed_count`、`shortfall`、`target_reached`、`stop_reason`（target_reached / candidates_exhausted / null）；`await_scores` 时额外返回 `progress`（`display_required=true`、`is_final=false`、`user_visible_message` 明确标注阶段性结果不代表最终汇总）。只要当前批任一补全成功达人缺评分行，`next_action=await_scores` 且 `stop_reason=null`，优先于 target_reached/candidates_exhausted；不生成交付文件或下一批。成功汇总终态时沿用 Provider 单表模板，保留工作表名、标题、需求信息、分组表头、列宽、颜色、数字格式、冻结行及全部非 0 分评分行，更新评分数量（按写入最终表的行数），按综合得分排序，不按推荐结论筛掉或截断前N人，并返回受控本地链接；综合分为 0 的评分行不写入最终表（0 分通常来自评分失败、资料无效或数据不足，也可能是有效评估但内容/类型相关度均为 0 级），不计数推荐、不算缺行，按 `excluded_zero_score_count` 说明；全部评分行均为 0 时不生成汇总文件；文件内容哈希命名、重复幂等、不覆盖异内容。所有单批原表保留；通过 xml2js 解析工作表 XML、移动原始行和单元格坐标，保留原单元格类型与样式引用，ID 不经过浮点转换、文本不转为公式。各批样式或共享字符串不一致、表头位置不同、数据区合并、公式或关联对象无法安全移动时返回 TEMPLATE 错误并停止，不输出损坏表。

文件限制：20 MiB，ZIP 声明解压40 MiB/1000项，最多10000行/200列；只读项目内哈希未变的已登记普通文件。错误前缀 `YPSCAN_MANUAL_SCORE_`，包括 CONTEXT_UNAVAILABLE、SOURCE_NOT_ALLOWED、SOURCE_CHANGED、SOURCE_MISMATCH、HEADERS、UNKNOWN_VERDICT、INVALID_SCORE、CONFLICTING_RESULTS、COMPLETION_INVALID、TEMPLATE、LIMIT、READ_FAILED、SAVE_FAILED 等。缺少上下文（含 Gateway 重置）时停止，不自动重建需求或重评。机构回收拒绝使用此工具。

测试环境 2026-09-08 的一个合成需求、两份不重叠 CSV、每份两人已分别返回独立任务及对应 Excel；四人均为“不推荐”。这证明该次测试的任务独立性和抖音负例表结构，不证明生产行为、跨批评分尺度、正例枚举全覆盖或模型/宿主已验收。当前自动回归用合成表验证两平台计数与 registered tool/Hook 衔接（tests/manual-score-summary.test.mjs、tests/manual-score-flow.test.mjs）。

询价机构已登记模式返回 `YPSCAN_MANUAL_SCORE_MODE_NOT_APPLICABLE`（success=false、retriable=false），在读取或修改评分文件前返回；缺少可信上下文仍返回 CONTEXT_UNAVAILABLE。两者的 Hook 均不生成重试弹窗：前者仅引导交付当前需求已有的成功保存结果（没有可信文件则停止），后者停止且不得推断为询价机构或已完成。保存 `manual_score_batch` 时，Hook 只采用该 artifact_id 对应的已登记模式；该 requirement 缺少模式记录时停止并保留文件，不借用会话级模式，也不展示最终交付、汇总、重存或重评。

## 6. 弹窗载荷（供工具与 Hook 共用）

`src/tools/popup-questions.js` 构造 `AskUserQuestion` 载荷：`{ questions: [...] }`，1–4 题；每题 `header`/`question`/`label`/`description` 每行最多 20 个 Unicode 字符（语义换行优先），选项 2–4 个且标签去重（忽略换行）。固定载荷：业务模式选择、流程重试/结束、入库恢复、Browser 验证、MCN 收件机构选择（单选快捷项 + 宿主自定义输入，内置 `询价全部机构` / `暂不询价`，必要时补少量当前机构快捷项）、回填后续分叉（`补全并打分排序`/`暂不补全`）。
