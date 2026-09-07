# 本地工具契约

`index.js` 注册 4 个本地工具（`contracts.tools` 同列）。所有工具结果经 `src/tools/tool-result.js` 包装：`content` 为 JSON 文本（成功/失败结构见各工具），失败时附 `isError: true`，需要宿主展示的详情放 `details`。

| 工具                        | 职责                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `ypscan_parse_requirement`  | 解析当前单个平台的完整最新需求（Dify 代理）                           |
| `ypscan_save_artifact`      | 按 artifact kind 受控保存 Provider 返回的 Excel 或 links CSV          |
| `ypscan_save_creator_links` | 归一化受控三列 links CSV（手动拓展传 Provider 原始 links CSV 路径，询价回收传受控预览 xlsx），并登记为合法 links 来源                        |
| `file_bridge`               | 合并 links CSV 与多批达人补全 CSV；按 flow 决定本地交付或校验上传 OSS |

## 1. ypscan_parse_requirement

### 参数（`additionalProperties: false`）

| 字段            | 类型   | 必填 | 约束                                                                                                                                           |
| --------------- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `demand`        | string | 是   | `minLength: 1`；当前单个平台完整最新需求原文；首次解析及用户修改业务条件后必传；手动拓展确认放宽后传应用全部累计放宽的完整需求全文，与 rawMessagesJson.original 一致；其余重传只合并原始表述与人工改口，禁止回填历史解析输出或未确认放宽值 |
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
| `artifact_kind` | string   | 是   | enum：`creator_detail_export`、`mcn_ranking`、`mcn_creator_preview`、`manual_source`、`ranked_submission`、`manual_creator_links`、`mcn_creator_links` |
| `artifact_id`   | string   | 是   | 关联 ID：除 `creator_detail_export` 用 batch/task ID 外，其余用 `requirement_id`                                                                       |
| `file_url`      | string   | 是   | Provider 返回的原始 Excel 或 CSV 下载 URL                                                                                                              |
| `mcn_names`     | string[] | 否   | 仅 `mcn_ranking` 使用：当前排序结果中的机构名称，用于保存后生成收件机构选择弹窗                                                                        |

### 格式与保存约束

- `creator_detail_export`、`mcn_ranking`、`mcn_creator_preview`、`manual_source`、`ranked_submission` 保存为 `.xlsx`；`manual_creator_links`、`mcn_creator_links` 保存为 `.csv`。URL 中没有符合 kind 的文件名时，使用下述确定性回退名称。CSV kind 只做受控下载落盘，不解析内容，不是受控 links 来源；受控三列 links CSV 由 `ypscan_save_creator_links` 归一化产出（见 §4）。
- URL 必须是 `https:` 且 hostname 为 `eshypdata.com` 或其子域，无端口、无用户信息、无 hash。
- 下载 `redirect: "error"`（重定向即失败）；总预算 20s；内容上限 20 MiB。
- 有限重试（间隔为 `[1000, 2000, 4000]` ms，带抖动），仅对 `429/500/502/503/504`、超时与下载失败重试；遵守 `retry-after`。
- 文件名从 URL `file_path` 参数或 pathname 推导；Excel 兼容 base64 `file_path`。没有明确文件名时回退为 `<artifact_kind>-<sha256 前 16 位>.<格式扩展名>`。
- 保存到 `workspaceDir`（宿主提供的绝对路径，`realpath` 校验为目录）：临时文件 0600 写入 → `link()` 原子发布；目标已存在且 sha256 相同视为幂等成功，不同则 `YPSCAN_ARTIFACT_SAVE_CONFLICT`，拒绝覆盖。

### 输出（成功）

- `data`：`artifact_kind`、`artifact_id`（原样回显调用关联元数据）、`file_name`、`file_path`、`byte_count`、`sha256`、`idempotent`、`download_attempts`。
- `delivery`：`local_path`、`local_file_link`（可点击 Markdown 链接，Agent 必须原样展示，不得只输出裸路径）、`display_required`、`display_before_next_action`、`user_visible_message`；`mcn_ranking` 额外附 `next_tool: "AskUserQuestion"`、`next_args`（收件机构弹窗）、`next_action`。

### 错误码

`YPSCAN_ARTIFACT_INVALID_INPUT`、`YPSCAN_ARTIFACT_DOWNLOAD_URL_INVALID`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_ARTIFACT_DOWNLOAD_UNAVAILABLE`、`YPSCAN_ARTIFACT_DOWNLOAD_TIMEOUT`、`YPSCAN_ARTIFACT_REDIRECT_FORBIDDEN`、`YPSCAN_ARTIFACT_DOWNLOAD_FAILED`、`YPSCAN_ARTIFACT_TOO_LARGE`、`YPSCAN_ARTIFACT_INVALID_CONTENT`、`YPSCAN_ARTIFACT_SAVE_UNSAFE_PATH`、`YPSCAN_ARTIFACT_SAVE_CONFLICT`、`YPSCAN_ARTIFACT_SAVE_FAILED`。失败结构统一为 `{ success:false, error:{ code, message, details:{ reason,...details }, retriable } }`。

## 3. file_bridge

⚠️ 破坏性变更：原 `ypscan_merge_creator_csv` 已移除。合并能力保留为 `file_bridge` 的内部步骤，调用方直接传 links CSV 与全部补全 CSV，不再传中间 `merged_csv_path`。

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
- 每批补全 CSV 必须含可识别的 creator ID 列（候选：`creator_id`、`请求kw_uid`、`kw_uid`、`xt_id`、`author_id`、`authorid`、`id`）；按 ID 去重取首条。
- 输出保持 links 原顺序；headers = `source_record_id, creator_id, url` + 各补全 CSV 的非保留详情列（排除 ID 列与 `source_record_id`/`creator_id`/`url`）。
- 未匹配到的 creator_id 计入 `missing_creator_ids`（不中断）。
- 输出文件名：`<flow 前缀>-<平台>-<requirement_id>-<sha256 前 8 位>.csv`，前缀映射 `manual_source→manual-source`、`mcn_rank→mcn-rank`、`mcn_complete_only→mcn-complete`；同名文件内容一致则复用，不一致报 `YPSCAN_CREATOR_CSV_MERGE_CONFLICT`。
- merged CSV 没有数据行时返回 `YPSCAN_FILE_BRIDGE_EMPTY`，但仍通过 `delivery.local_file_link` 交付本地文件。
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

- `data` 始终包含：`requirement_id`、`platform`、`flow`、`file_name`、`file_path`、`data_row_count`、`matched_creator_ids`、`missing_creator_ids`、`completion_csv_paths`、`links_csv_path`、`sha256`。
- 上传成功时额外包含 `csv_file_path`、`object_key`；超过 500 行时额外包含 `upload_skipped`、`upload_limit`。
- `delivery` 始终包含本地 `local_file_path` 与 `local_file_link`；合并后上传或公网校验失败时，错误结果也保留该本地交付信息。

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
- `delivery`：`local_path`、`local_file_link`（Agent 必须原样展示）、`display_required`、`display_before_next_action`、`user_visible_message`。

### 错误码

`YPSCAN_CREATOR_LINKS_INVALID_INPUT`、`YPSCAN_CREATOR_LINKS_INVALID_CSV`、`YPSCAN_CREATOR_LINKS_INVALID_ROWS`、`YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED`、`YPSCAN_CREATOR_LINKS_EMPTY`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_CREATOR_LINKS_WRITE_FAILED`、`YPSCAN_CREATOR_LINKS_CONFLICT`。

预览 xlsx 输入错误前缀为 `YPSCAN_CREATOR_PREVIEW_`，后缀：SOURCE_NOT_ALLOWED、SOURCE_CHANGED、LIMIT、HEADERS、ROWS、EMPTY、READ_FAILED。

## 5. 弹窗载荷（供工具与 Hook 共用）

`src/tools/popup-questions.js` 构造 `AskUserQuestion` 载荷：`{ questions: [...] }`，1–4 题；每题 `header`/`question`/`label`/`description` 每行最多 20 个 Unicode 字符（语义换行优先），选项 2–4 个且标签去重（忽略换行）。固定载荷：业务模式选择、流程重试/结束、入库恢复、Browser 验证、MCN 收件机构选择（单选快捷项 + 宿主自定义输入，内置 `询价全部机构` / `暂不询价`，必要时补少量当前机构快捷项）、回填后续分叉（`补全并打分排序`/`暂不补全`）。
