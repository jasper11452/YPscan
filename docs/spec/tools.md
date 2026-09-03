# 本地工具契约

`index.js` 注册 5 个本地工具（`contracts.tools` 同列）。所有工具结果经 `src/tools/tool-result.js` 包装：`content` 为 JSON 文本（成功/失败结构见各工具），失败时附 `isError: true`，需要宿主展示的详情放 `details`。

| 工具 | 职责 |
| --- | --- |
| `ypscan_parse_requirement` | 解析当前单个平台的完整最新需求（Dify 代理） |
| `ypscan_save_excel_artifact` | 受控保存 Provider 返回的 Excel 到当前项目 |
| `ypscan_save_csv_artifact` | 受控保存 Provider 返回的 links CSV 到当前项目 |
| `ypscan_merge_creator_csv` | 合并 links CSV 与多批达人补全 CSV |
| `ypscan_upload_creator_csv` | 校验并上传 merged CSV（当前仅测试模式可用） |

## 1. ypscan_parse_requirement

### 参数（`additionalProperties: false`）

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `demand` | string | 是 | `minLength: 1`；当前单个平台完整最新需求原文；首次解析及用户修改业务条件后必传；重传只合并用户原始表述与人工改口，禁止回填历史解析输出或放宽值 |
| `business_mode` | string | 是 | enum：`询价机构` / `手动拓展`；来自用户明确表达，未明确或语义冲突时经模式选择确定 |

### 实现事实

- POST `https://dfi.eshypdata.com/v1/workflows/run`，`response_mode: "blocking"`，`AbortSignal.timeout(60_000)`，`user` 为 `ypscan-<demand sha256 前 24 位>`；凭据为内置公开 Workflow Key 常量（`DIFY_PUBLIC_WORKFLOW_KEY`）。

### 输出

`success: true` + `data.outputs`，`outputs` 只保留以下字段中实际返回的键（缺失字段省略，不补空值）：

- 8 个可选 Label：`growBloggerTypeLabel`、`contentFeatureLabel`、`contentThemeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`industryTagLabel`、`growTalentTypeLabel`；`contentTag`
- 品牌：`brandName`、`xhsbrandName`、`dybrandName`
- 数值：`followercount`、`rebate`；报价 `kolOfficialPrice`/`L1/L2/L3`/`xhs_kolOfficialPrice`/`dy_kolOfficialPrice`；`cpm`/`L1/L2/L3`/`xhs_cpm`/`dy_cpm`；`cpe`/`L1/L2/L3`/`xhs_cpe`/`dy_cpe`

### 错误码

| 错误码 | 触发 |
| --- | --- |
| `INVALID_INPUT` | demand 非空失败 |
| `INVALID_BUSINESS_MODE` | business_mode 非法 |
| `DIFY_API_KEY_MISSING` | 凭据不可用 |
| `DIFY_CLIENT_UNAVAILABLE` | 无 fetch 实现 |
| `DIFY_TIMEOUT` | 60s 超时 |
| `DIFY_REQUEST_FAILED` | 请求失败（非超时） |
| `DIFY_INVALID_RESPONSE` | 响应非 JSON |
| `DIFY_HTTP_ERROR` | 非 2xx |
| `DIFY_WORKFLOW_FAILED` | `data.status !== "succeeded"` |
| `DIFY_OUTPUT_INVALID` | 缺少 outputs 对象 |

## 2. ypscan_save_excel_artifact

### 参数

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `artifact_kind` | string | 是 | enum：`creator_detail_export`、`mcn_ranking`、`mcn_creator_preview`、`manual_source`、`ranked_submission` |
| `artifact_id` | string | 是 | 关联 ID：除 `creator_detail_export` 用 batch/task ID 外，其余用 `requirement_id` |
| `excel_file_url` | string | 是 | Provider 返回的原始 Excel 下载 URL |
| `mcn_names` | string[] | 否 | 仅 `mcn_ranking` 使用：当前排序结果中的机构名称，用于保存后生成收件机构选择弹窗 |

### 保存约束（与 CSV 保存共用核心逻辑）

- URL 必须是 `https:` 且 hostname 为 `eshypdata.com` 或其子域，无端口、无用户信息、无 hash（`validateExcelDownloadUrl`）。
- 下载 `redirect: "error"`（重定向即失败）；总预算 20s（`EXCEL_ARTIFACT_TIMEOUT_MS`）；内容上限 20 MiB（`MAX_EXCEL_ARTIFACT_BYTES`）。
- 有限重试（`EXCEL_ARTIFACT_RETRY_DELAYS_MS = [1000, 2000, 4000]` ms，带抖动），仅对 `429/500/502/503/504`、超时与下载失败重试；遵守 `retry-after`。
- 文件名从 URL `file_path` 参数 / pathname / base64 推导，非法时回退为 `<artifact_kind>-<sha256 前 16 位>.xlsx`；必须是安全的 `.xlsx` 文件名。
- 保存到 `workspaceDir`（宿主提供的绝对路径，`realpath` 校验为目录）：临时文件 0600 写入 → `link()` 原子发布；目标已存在且 sha256 相同视为幂等成功，不同则 `YPSCAN_EXCEL_SAVE_CONFLICT`，拒绝覆盖。

### 输出（成功）

- `data`：`file_name`、`file_path`、`byte_count`、`sha256`、`idempotent`、`download_attempts`。
- `delivery`：`local_path`、`local_file_link`（可点击 Markdown 链接，Agent 必须原样展示，不得只输出裸路径）、`display_required`、`display_before_next_action`、`user_visible_message`；`mcn_ranking` 额外附 `next_tool: "AskUserQuestion"`、`next_args`（收件机构弹窗）、`next_action`。

### 错误码

`YPSCAN_EXCEL_INVALID_INPUT`、`YPSCAN_EXCEL_DOWNLOAD_URL_INVALID`、`YPSCAN_EXCEL_FILE_NAME_INVALID`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_EXCEL_DOWNLOAD_UNAVAILABLE`、`YPSCAN_EXCEL_DOWNLOAD_TIMEOUT`、`YPSCAN_EXCEL_REDIRECT_FORBIDDEN`、`YPSCAN_EXCEL_DOWNLOAD_FAILED`、`YPSCAN_EXCEL_TOO_LARGE`、`YPSCAN_EXCEL_INVALID_XLSX`、`YPSCAN_EXCEL_SAVE_UNSAFE_PATH`、`YPSCAN_EXCEL_SAVE_CONFLICT`、`YPSCAN_EXCEL_SAVE_FAILED`。失败结构统一为 `{ success:false, error:{ code, message, details:{ reason,...details }, retriable } }`。

## 3. ypscan_save_csv_artifact

### 参数

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `artifact_kind` | string | 是 | enum：`manual_creator_links`、`mcn_creator_links` |
| `artifact_id` | string | 是 | 当前 `requirement_id` |
| `csv_file_url` | string | 是 | Provider 返回的原始 CSV 下载 URL |

约束与 Excel 保存一致（主域 HTTPS、禁止重定向、20 MiB / 20s、有限重试、原子发布与幂等）；文件名推导同构，回退为 `<artifact_kind>-<sha256 前 16 位>.csv`。成功输出同构（`data` + `delivery.local_file_link`）。

### 错误码

`YPSCAN_CSV_INVALID_INPUT`、`YPSCAN_CSV_DOWNLOAD_URL_INVALID`、`YPSCAN_CSV_FILE_NAME_INVALID`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_CSV_DOWNLOAD_UNAVAILABLE`、`YPSCAN_CSV_DOWNLOAD_TIMEOUT`、`YPSCAN_CSV_REDIRECT_FORBIDDEN`、`YPSCAN_CSV_DOWNLOAD_FAILED`、`YPSCAN_CSV_TOO_LARGE`、`YPSCAN_CSV_INVALID_FILE`、`YPSCAN_CSV_SAVE_UNSAFE_PATH`、`YPSCAN_CSV_SAVE_CONFLICT`、`YPSCAN_CSV_SAVE_FAILED`。

## 4. ypscan_merge_creator_csv

### 参数

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `requirement_id` | string | 是 | 当前 requirement |
| `platform` | string | 是 | enum：`xiaohongshu`、`douyin` |
| `flow` | string | 是 | enum：`manual_source`、`mcn_rank`、`mcn_complete_only` |
| `links_csv_path` | string | 是 | 已保存 links CSV 的绝对路径 |
| `completion_csv_paths` | string[] | 是 | 一批或多批补全 CSV 的绝对路径，`minItems: 1` |

### 合并语义

- links CSV 必含 `source_record_id`、`creator_id`、`url` 三列（表头归一化匹配，`-`/空格/大小写不敏感）。
- 每批补全 CSV 必须含可识别的 creator ID 列（候选：`creator_id`、`kw_uid`、`xt_id`、`author_id`、`authorid`、`id`）；按 ID 去重取首条。
- 输出保持 links 原顺序；headers = `source_record_id, creator_id, url` + 各补全 CSV 的非保留详情列（排除 ID 列与 `source_record_id`/`creator_id`/`url`）。
- 未匹配到的 creator_id 计入 `missing_creator_ids`（不中断）。
- 输出文件名：`<flow 前缀>-<平台>-<requirement_id>-<sha256 前 8 位>.csv`，前缀映射 `manual_source→manual-source`、`mcn_rank→mcn-rank`、`mcn_complete_only→mcn-complete`；同名文件内容一致则复用，不一致报 `MERGE_CONFLICT`。

### 输出（成功）

`data`：`requirement_id`、`platform`、`flow`、`file_name`、`file_path`、`data_row_count`、`matched_creator_ids`、`missing_creator_ids`、`completion_csv_paths`、`links_csv_path`、`sha256`；`delivery` 含 `local_file_link`。

### 错误码

`YPSCAN_CREATOR_CSV_MERGE_INVALID_INPUT`、`YPSCAN_WORKSPACE_UNAVAILABLE`、`YPSCAN_CREATOR_LINKS_CSV_INVALID`（links CSV 缺列）、`YPSCAN_COMPLETION_CSV_INVALID`（补全 CSV 缺 ID 列）、`YPSCAN_CREATOR_CSV_MERGE_CONFLICT`、`YPSCAN_CREATOR_CSV_MERGE_FAILED`。

## 5. ypscan_upload_creator_csv

### 参数

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `requirement_id` | string | 是 | 当前 requirement |
| `flow` | string | 是 | enum：`manual_source`、`mcn_rank` |
| `merged_csv_path` | string | 是 | merged CSV 的绝对路径 |

### 校验链（上传前全部先过）

1. 参数完整、路径为绝对路径；
2. 文件可读，CSV 可解析；
3. 数据行 `> 0`，否则 `YPSCAN_CREATOR_CSV_EMPTY`；
4. 数据行 `> 500` 时阻断，返回 `YPSCAN_CREATOR_CSV_LIMIT_EXCEEDED`（details 含 `data_row_count` 与 `limit: 500`）。

### 上传

- **测试模式**（`testAdapterBaseUrl` 存在）：POST `<adapter>/mock/upload-creator-csv`，body 为 `{ requirement_id, flow, merged_csv_path, data_row_count, sha256, csv_text }`，20s 超时；成功响应取 `data.csv_file_path ?? csv_file_path`。
- **生产**：仓库未定义生产 CSV 暂存端点契约，返回 `YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE`，不猜测真实接口、不伪造 `csv_file_path`。

### 输出（成功）

`data`：`requirement_id`、`flow`、`merged_csv_path`、`csv_file_path`、`data_row_count`、`sha256`。

### 错误码

`YPSCAN_CREATOR_CSV_UPLOAD_INVALID_INPUT`、`YPSCAN_CREATOR_CSV_UPLOAD_READ_FAILED`、`YPSCAN_CREATOR_CSV_UPLOAD_INVALID_FILE`、`YPSCAN_CREATOR_CSV_EMPTY`、`YPSCAN_CREATOR_CSV_LIMIT_EXCEEDED`、`YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE`、`YPSCAN_CREATOR_CSV_UPLOAD_FAILED`（HTTP 失败/缺 `csv_file_path`/网络异常，网络异常 `retriable: true`）。

## 6. 弹窗载荷（供工具与 Hook 共用）

`src/tools/popup-questions.js` 构造 `AskUserQuestion` 载荷：`{ questions: [...] }`，1–4 题；每题 `header`/`question`/`label`/`description` 每行最多 20 个 Unicode 字符（语义换行优先），选项 2–4 个且标签去重（忽略换行）。固定载荷：业务模式选择、流程重试/结束、入库恢复、Browser 验证、MCN 收件机构选择（`询价全部机构`/`暂不询价`/机构名列表，multiSelect）、回填后续分叉（`精排并生成提报表`/`只补全达人信息`）。
