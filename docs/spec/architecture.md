# 架构

## 1. 系统形态

ypscan 是 OpenClaw 插件（`private: true`，ESM，无 TypeScript 源文件，类型安全靠 JSDoc + `tsc --checkJs`）。运行时依赖为 `ali-oss`、`read-excel-file`（受控预览/评分解析）、`write-excel-file`（保留的 Excel 写入依赖）、`fflate`（ZIP 预检及模板打包）与 `xml2js`（评分模板 XML 解析与合并）。

```
OpenClaw 宿主
  └─ index.js（插件入口）
       ├─ 注册 5 个本地工具（src/tools/*）
       ├─ 注册 3 个流程 Hook + 2 个 Gateway 生命周期 Hook
       ├─ manifest 声明 Provider MCP 连接与工具白名单
       └─ skills/media-assistant（业务行为权威，随包发布）

远端：
  ├─ Provider MCP  https://mcp.eshypdata.com/mcp（Streamable HTTP，15 个白名单工具）
  └─ Dify Workflow  https://dfi.eshypdata.com/v1/workflows/run（需求解析）
```

## 2. 组件地图

| 组件                                                                                              | 职责                         | 关键事实                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.js`                                                                                        | 入口：注册工具与 Hook        | 5 工具、5 Hook；`gateway_start`/`gateway_stop` 调 `resetTransientState()`                                                                                                                      |
| `openclaw.plugin.json`                                                                            | 插件清单                     | Provider MCP 白名单 15 工具；`connectionTimeoutMs: 5000`、`requestTimeoutMs: 330000`；`configSchema` 含 `testMode` / `testAdapterBaseUrl` / `fileBridgeOss`；`contracts.tools` 列 5 个本地工具 |
| `src/tools/parse-requirement.js`                                                                  | 需求解析代理                 | 直连 Dify（blocking 模式，60s 超时），`data.outputs` 只返回契约消费字段                                                                                                                        |
| `src/tools/save-artifact.js`                                                                      | Excel/links CSV 受控保存     | 单一工具、8 种 artifact_kind；kind 决定扩展名，共用主域校验、下载限制、重试、原子发布与幂等逻辑                                                                                                |
| `src/tools/manual-score-summary.js`                                                               | 手动拓展评分汇总             | 从哈希校验的受控来源重算进度，精确累计推荐人数，返回下一批或生成最终汇总 Excel（沿用 Provider 单表模板）                                                                                             |
| `src/tools/merge-creator-csv.js`                                                                  | `file_bridge` 的内部合并实现 | 非公开工具；包含 CSV 编解码，保持 links 原顺序，输出名含 flow/平台/需求/哈希                                                                                                                   |
| `src/tools/file-bridge.js`                                                                        | CSV 合并与可选上传           | 调内部合并实现；mcn_complete_only/超限只本地交付，其余按插件配置 `fileBridgeOss` → 打包内置凭据读取（内部测试/集成可显式注入 env）并上传，再校验公网可读 URL                                     |
| `src/tools/popup-questions.js`                                                                    | AskUserQuestion 统一弹窗载荷 | 每行最多 20 个 Unicode 字符；每题 2–4 选项、1–4 题                                                                                                                                             |
| `src/tools/tool-result.js`                                                                        | 本地工具结果包装             | `content` 为 JSON 文本 + 可选 `details`/`isError`                                                                                                                                              |
| `src/tools/test-adapter.js`                                                                       | 隔离测试 adapter             | `testMode` 下解析 loopback origin；下载重定向到 `/mock/artifact`                                                                                                                               |
| `src/contract/registry.js`                                                                        | 参数归一化 + 预检            | 无状态；`normalizeToolCallParams`、`validateRequirementPreflight`；模式/平台/区间常量                                                                                                          |
| `src/hooks/register-flow-directives.js`                                                           | 流程指令注入                 | 3 个流程 Hook（priority 90、timeout 5s）；瞬态映射随 gateway 启停清空，手动评分来源按项目持久化并按需恢复                                                                                      |
| `skills/media-assistant/`                                                                         | 业务行为权威                 | `SKILL.md` 固定链路/复核/放宽/幂等规则 + `references/` 工具卡                                                                                                                                  |

## 3. 边界划分

- **插件负责**：链路编排指令、`validate_requirement` 本地预检与参数归一化、交付物受控保存与合并、上传校验、弹窗载荷构造。
- **Provider 负责**：搜索/排名/打分/入库/企微发送，机构名匹配、合并去重、同 requirement/机构幂等，字段配置持久化（`select_inquiry_form_fields`）。
- **Dify 负责**：需求文本解析，返回 32 个契约内输出字段（8 个可选 Label + `contentTag` + 品牌/粉丝/返点 + 报价/CPM/CPE 及平台、档位变体）。
- **宿主 YP Action 负责**：原生达人补全（小红书 `get_xhs_author_business_card`、抖音 `get_douyin_author_business_card`）；登录窗口、Cookie 与内部回调地址均由宿主工具内部处理，插件不干预。
- **Agent 负责**：需求文本整理、复核解析结果、按指令调用工具、弹窗答案的收集与写回。

## 4. 数据流

### 询价机构链路

```
业务模式确定 → ypscan_parse_requirement → 复核 → validate_requirement（预检+归一化）
→ search_creators → rank_mcns → 五列机构表 + ypscan_save_artifact(mcn_ranking)
→ 选择收件机构 → select_inquiry_form_fields（已提交则复用；首次字段页用 get_inquiry_form_fields_status 自动确认提交）→ 发送确认弹窗
→ create_with_distributions → sync_mcn_inquiry_status（返回 inquiry_ids）
→ ingest_mcn_submissions → get_ingest_job（轮询至 succeeded/partially_succeeded）
→ ypscan_save_artifact(mcn_creator_preview) → 询问是否补全
→ ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV → 原生补全(20/批)
→ file_bridge(manual_source，内部合并并上传) → score_manual_source_csv → score_manual_source_csv_status 轮询
→ 保存打分排序 Excel（最终交付）
```

### 手动拓展链路

```
业务模式确定 → ypscan_parse_requirement → 复核 → validate_requirement（预检+归一化）
→ select_inquiry_form_fields（首次字段页用 get_inquiry_form_fields_status 自动确认提交，超时/重选等用户确认已提交）→ manual_source_creators(requirement_id)
→ 同步返回 links CSV：保存 manual_creator_links → 归一化 → ypscan_summarize_manual_scores → 当前批原生补全(最多20人)
  → file_bridge(manual_source，内部合并并上传) → score_manual_source_csv → score_manual_source_csv_status 30s×10 轮询
  → 保存 manual_score_batch → ypscan_summarize_manual_scores（达标交付汇总表，否则下一批）
→ 返回 batch_id：提示后台耗时 → manual_source_creators_status 30s×10 轮询（`num` 的位置按当前环境 live schema required 决定）→ 同上 CSV 链路
→ 旧 Provider 返回 Excel：降级路径，保存即交付，不进 CSV 链路
```

## 5. 设计取舍（Alternatives & Trade-offs）

### 5.1 用 Hook 注入指令，而不是只靠 SKILL.md

- **选择**：`before_prompt_build` 每轮注入精简的业务模式指令、每会话首次另注入完整静态规则；`tool_result_persist` 按每个工具的真实结果追加下一步动态参数（如 `RANK_MCNS_ARGS={...}`、`ASK_USER_QUESTION_ARGS={...}`）。
- **为什么**：纯 SKILL.md 无法把「当前结果的 requirement_id、平台、下载 URL」直接喂给下一步；动态指令消除了 Agent 从结果里自行找字段的偏差空间。
- **代价**：指令体量大、与 SKILL.md 内容部分重叠，两处需保持一致；`HOOK_OPTIONS`（priority 90、timeout 5s）下指令生成必须同步且轻量。

### 5.2 本地预检而不是依赖 Provider 报错

- **选择**：`before_tool_call` 对 `validate_requirement` 做归一化 + 完整预检，失败即 `block`，Provider 不收到写入。
- **为什么**：Provider schema 类型表达不足（历史审计），依赖其报错会导致逐字段盲试；本地预检可一次性列出全部问题并给出格式契约与弹窗规则。
- **代价**：预检规则（必填、区间格式、证据门禁）需要与 Provider 实际校验保持同步，是漂移高发区。

### 5.3 受控保存（而非直接下载）

- **选择**：Excel 与 Provider links CSV 共用 `ypscan_save_artifact`；`artifact_kind` 唯一决定扩展名，URL 统一由 `file_url` 传入。仅接受 `eshypdata.com` 主域 HTTPS 且无端口/凭据/hash 的下载 URL；`redirect: "error"`；20 MiB / 20s 预算；临时文件 + `link()` 原子发布；sha256 相同视为幂等成功，不同则拒绝覆盖。派生 links CSV 与 merged CSV 对已有目标先拒绝符号链接或非普通文件，再读取比较内容，绝不跟随链接写出工作区。旧 Provider 仅返回 Excel 时按降级链路直接交付，不再用临时脚本拆 `xlsx` 强补 CSV。
- **为什么**：交付物来自 Provider 受信域；防重定向防外跳、防覆盖用户已有文件、防超大文件拖垮宿主。
- **代价**：旧格式下载 URL（如非主域 CDN）会被拒绝，需 Provider 侧配合。

### 5.4 CSV 中心链路（替代旧 Excel 直接链路）

- **选择**：links CSV 是达人补全与排序的正式中间产物；`file_bridge` 接收 links CSV 与当前手动拓展批次（机构回收为全部批次）的补全 CSV，在内部合并并按 flow 决定是否上传，不暴露单独的合并工具或 `merged_csv_path` 中间参数。`score_manual_source_csv` 消费它返回的 OSS `csv_file_path`，是手动拓展与询价回收两链路共用的通用打分步骤；询价回收链的 links CSV 由 `ypscan_save_creator_links` 直接读取已受控保存的 Excel 派生。`rank_creators`、`create_submission_batch`、`get_creator_detail`、`get_creator_detail_export` 已从正式链路移除。
- **为什么**：达人补全结果需要可合并、可校验行数；CSV 显式上传后打分/精排，交付物与评分口径一致。
- **代价**：合并与上传共享一个工具边界，单独重跑上传需重新执行幂等合并；旧 Provider 返回 Excel 时保留降级保存路径。

### 5.5 上传工具不做生产猜测

- **选择**：`file_bridge` 在合并成功后直接读取本地运行时 OSS 配置，用 `ali-oss` 上传到 `Object/<flow>/<requirement_id>/<sha256>.csv`，对象按当前要求设置 `public-read`，并在返回前校验未签名公网 URL确实可匿名读取；`mcn_complete_only` 或超过 500 行时不读取配置、不上传。
- **为什么**：下游 Provider 需要稳定可读的远端 `csv_file_path`；固定对象键消除时间戳抖动，同内容哈希路径便于幂等与排障。
- **代价**：生产 CSV 链路暂不可用，见未决问题。

## 6. 风险

| 风险           | 说明                                                                                                                    | 缓解                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 契约漂移       | 工具卡、Hook 指令、Provider MCP schema 三处手工对齐；`rank_creators` 已废弃但仍暴露于 Provider | smoke + 行为回归用例 + `scripts/audit-provider-tools.mjs` 审计；长期看自动 schema 校验              |
| 预检过严/过松  | 证据门禁（品牌/数量/截止/粉丝/返点/报价）误伤合法需求或放过编造值                                                       | `tests/registry.test.mjs` 与 `tests/requirement-parser.test.mjs` 代码回归；`docs/review-checklist.md` 行为验收（不能以代码测试替代）            |
| 瞬态状态丢失   | 映射在 gateway 启停时清空；手动评分来源已按项目持久化，可按需恢复                                                      | 常规路由仍从参数/结果推导；评分汇总缺少来源时显式停止并保留已有文件，不猜测恢复或重复外部调用                                       |
| testMode 误开  | `testMode=true` 允许受控读取 loopback adapter                                                                           | `resolveTestAdapterBaseUrl` 强制校验 loopback origin（无凭据、无 query/hash）                       |
| OSS 匿名读策略 | 对象上传成功但 Bucket/账号策略仍可能阻断未签名访问，导致下游拿到坏链接                                                  | `file_bridge` 上传后立即匿名 `HEAD/GET` 校验；失败即返回 `YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE` |
| 遗留代码误用   | 遗留 browser 工具被重新注册或进包                                                                                       | smoke 断言未注册、`npm pack --dry-run` 核对 `files` 白名单                                          |

## 7. 可观测性

插件不包含独立日志、指标或告警设施；工具结果经 `hostToolResult` 序列化为 JSON 文本交回宿主，可观测性依赖宿主与 Provider 侧日志。异步任务（`manual_source_creators_status`、`get_ingest_job`、`score_manual_source_csv_status`）与字段状态轮询（`get_inquiry_form_fields_status`，每 30 秒一次、上限 8 次，含预检共 9 次查询，避开宿主全局无进展断路器）的上限由指令约束，插件不自行记账。
