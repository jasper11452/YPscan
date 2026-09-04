# 架构

## 1. 系统形态

ypscan 是 OpenClaw 插件（`private: true`，ESM，无 TypeScript 源文件，类型安全靠 JSDoc + `tsc --checkJs`）。运行时依赖仅 `playwright-core`（为遗留 browser 工具保留，当前未注册任何 browser 工具）。

```
OpenClaw 宿主
  └─ index.js（插件入口）
       ├─ 注册 5 个本地工具（src/tools/*）
       ├─ 注册 3 个流程 Hook + 2 个 Gateway 生命周期 Hook
       ├─ manifest 声明 Provider MCP 连接与工具白名单
       └─ skills/media-assistant（业务行为权威，随包发布）

远端：
  ├─ Provider MCP  https://mcp.eshypdata.com/mcp（Streamable HTTP，14 个白名单工具）
  └─ Dify Workflow  https://dfi.eshypdata.com/v1/workflows/run（需求解析）
```

## 2. 组件地图

| 组件 | 职责 | 关键事实 |
| --- | --- | --- |
| `index.js` | 入口：注册工具与 Hook | 5 工具、5 Hook；`gateway_start`/`gateway_stop` 调 `resetTransientState()` |
| `openclaw.plugin.json` | 插件清单 | Provider MCP 白名单 14 工具；`connectionTimeoutMs: 5000`、`requestTimeoutMs: 330000`；`configSchema` 仅 `testMode`/`testAdapterBaseUrl`；`contracts.tools` 列 5 个本地工具 |
| `src/tools/parse-requirement.js` | 需求解析代理 | 直连 Dify（blocking 模式，60s 超时），`data.outputs` 只返回契约消费字段 |
| `src/tools/save-excel-artifact.js` | Excel 受控保存 | 5 种 artifact_kind；主域校验、禁止重定向、20 MiB/20s 上限、有限重试、原子发布与幂等 |
| `src/tools/save-csv-artifact.js` | links CSV 受控保存 | 2 种 artifact_kind；约束同 Excel 保存 |
| `src/tools/creator-csv.js` | CSV 解析/序列化助手 | 引号转义、表头归一化、必选列查找、数据行计数 |
| `src/tools/merge-creator-csv.js` | links CSV × 补全 CSV 合并 | 保持 links 原顺序；flow 三值；输出名含平台/需求/哈希 |
| `src/tools/upload-creator-csv.js` | merged CSV 上传 | 空文件/格式/500 行上限校验；测试模式 mock 上传；无生产契约时报错 |
| `src/tools/popup-questions.js` | AskUserQuestion 统一弹窗载荷 | 每行最多 20 个 Unicode 字符；每题 2–4 选项、1–4 题 |
| `src/tools/tool-result.js` | 本地工具结果包装 | `content` 为 JSON 文本 + 可选 `details`/`isError` |
| `src/tools/test-adapter.js` | 隔离测试 adapter | `testMode` 下解析 loopback origin；下载重定向到 `/mock/artifact` |
| `src/contract/registry.js` | 参数归一化 + 预检 | 无状态；`normalizeToolCallParams`、`validateRequirementPreflight`；模式/平台/区间常量 |
| `src/hooks/register-flow-directives.js` | 流程指令注入 | 3 个流程 Hook（priority 90、timeout 5s）；瞬态映射随 gateway 启停清空 |
| `skills/media-assistant/` | 业务行为权威 | `SKILL.md` 固定链路/复核/放宽/幂等规则 + `references/` 工具卡 |
| 遗留 `src/tools/manual-browser-*`、`manual-research*`、`select-cascade.js`、`set-filter-range.js` | 废弃的 native Browser 手扒 | 保留在仓库，不在 `index.js` 注册、不在发布包 `files` 内；不重新启用 |

## 3. 边界划分

- **插件负责**：链路编排指令、`validate_requirement` 本地预检与参数归一化、交付物受控保存与合并、上传校验、弹窗载荷构造。
- **Provider 负责**：搜索/排名/打分/入库/企微发送，机构名匹配、合并去重、同 requirement/机构幂等，字段配置持久化（`select_inquiry_form_fields`）。
- **Dify 负责**：需求文本解析，返回 32 个契约内输出字段（8 个可选 Label + `contentTag` + 品牌/粉丝/返点 + 报价/CPM/CPE 及平台、档位变体）。
- **Agent 负责**：需求文本整理、复核解析结果、按指令调用工具、弹窗答案的收集与写回。

## 4. 数据流

### 询价机构链路

```
业务模式确定 → ypscan_parse_requirement → 复核 → validate_requirement（预检+归一化）
→ search_creators → rank_mcns → 五列机构表 + 保存 mcn_ranking Excel
→ 选择收件机构 → select_inquiry_form_fields（已提交则复用）→ 发送确认弹窗
→ create_with_distributions → get_workflow_state（空 inquiry_ids 先 sync_mcn_inquiry_status）
→ ingest_mcn_submissions → get_ingest_job（轮询至 succeeded/partially_succeeded）
→ 保存 mcn_creator_preview Excel → 保存 mcn_creator_links CSV
→ 分叉：精排并生成提报表 / 只补全达人信息
   精排：rank_creators({requirement_id, inquiry_ids}) → 保存 ranked_submission
   只补全：原生补全(20/批) → merge(mcn_complete_only) → 交付 merged CSV
```

### 手动拓展链路

```
业务模式确定 → ypscan_parse_requirement → 复核 → validate_requirement（预检+归一化）
→ select_inquiry_form_fields → manual_source_creators(requirement_id[, demand])
→ 同步返回 links CSV：保存 manual_creator_links → 原生补全(20/批) → merge(manual_source)
  → upload → score_manual_source_csv → score_manual_source_csv_status 30s×10 轮询
  → 保存 manual_source Excel（最终交付）
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

- **选择**：仅接受 `eshypdata.com` 主域 HTTPS 且无端口/凭据/hash 的下载 URL；`redirect: "error"`；20 MiB / 20s 预算；临时文件 + `link()` 原子发布；sha256 相同视为幂等成功，不同则拒绝覆盖。旧 Provider 仅返回 Excel 时按降级链路直接交付，不再用临时脚本拆 `xlsx` 强补 CSV。
- **为什么**：交付物来自 Provider 受信域；防重定向防外跳、防覆盖用户已有文件、防超大文件拖垮宿主。
- **代价**：旧格式下载 URL（如非主域 CDN）会被拒绝，需 Provider 侧配合。

### 5.4 CSV 中心链路（替代旧 Excel 直接链路）

- **选择**：links CSV 是达人补全与排序的正式中间产物；`score_manual_source_csv` 消费上传后的 `csv_file_path`，`rank_creators` 改为消费 `{requirement_id, inquiry_ids}` 并由 `score_manual_source_csv_status` 轮询打分 job 终态；`create_submission_batch`、`get_creator_detail`、`get_creator_detail_export` 从白名单移除。
- **为什么**：达人补全结果需要可合并、可校验行数；CSV 显式上传后打分/精排，交付物与评分口径一致。
- **代价**：链路更长；upload 在生产暂无端点契约（见 README 未决问题），旧 Provider 返回 Excel 时保留降级保存路径。

### 5.5 上传工具不做生产猜测

- **选择**：`ypscan_upload_creator_csv` 只做校验与测试模式 mock（POST `/mock/upload-creator-csv`），无 `testAdapterBaseUrl` 时返回 `YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE`。
- **为什么**：仓库内没有可验证的生产 CSV 暂存端点契约；编造接口会比显式失败更糟。
- **代价**：生产 CSV 链路暂不可用，见未决问题。

## 6. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 契约漂移 | 工具卡、Hook 指令、Provider MCP schema 三处手工对齐 | smoke + 行为回归用例 + `scripts/audit-provider-tools.mjs` 审计；长期看自动 schema 校验 |
| 预检过严/过松 | 证据门禁（品牌/数量/截止/粉丝/返点/报价）误伤合法需求或放过编造值 | `benchmarks/requirement-parser/RESULTS.md` 回归评测；`docs/review-checklist.md` 逐条核对 |
| 瞬态状态丢失 | 映射在 gateway 启停时清空，长会话依赖宿主不重启 | 指令设计保证模式/平台可从参数与结果再推导，不把映射当唯一真相 |
| testMode 误开 | `testMode=true` 允许受控读取 loopback adapter | `resolveTestAdapterBaseUrl` 强制校验 loopback origin（无凭据、无 query/hash） |
| 遗留代码误用 | 遗留 browser 工具被重新注册或进包 | smoke 断言未注册、`npm pack --dry-run` 核对 `files` 白名单 |

## 7. 可观测性

插件不包含独立日志、指标或告警设施；工具结果经 `hostToolResult` 序列化为 JSON 文本交回宿主，可观测性依赖宿主与 Provider 侧日志。异步任务（`manual_source_creators_status`、`get_ingest_job`、`score_manual_source_csv_status`）的轮询上限由指令约束，插件不自行记账。
