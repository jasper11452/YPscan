# AGENTS.md — 悦普识星（ypscan）项目级工作指南

> 本文件只写本项目特有、agent 在此仓库工作必须知道的事实与约束。通用执行/修改/验证原则见全局 `~/.codex/AGENTS.md`。业务行为权威是 `skills/media-assistant/SKILL.md`；本文件与它冲突时，以 SKILL.md 和用户最新要求为准。

## 这是什么

- `ypscan`（悦普识星）是 OpenClaw 插件（`id: ypscan`，`private: true`）：客户端集成层，注册 2 个本地工具，通过 Streamable HTTP 连接远端 Provider MCP（`https://mcp.eshypdata.com/mcp`）。
- 当前主线形态（`feat/dual`）支持**双业务功能**：`询价机构` + `手动拓展`（由 Provider 后端 `manual_source_creators` 完成）。初次落库按所选功能进入链路；同会话需求未变、前一功能完成或明确停止后可复用同一 requirement 顺序执行另一功能。native Browser 拓展分支已废弃。
- 技术栈：Node.js `>=22.22.2`、ESM（`"type": "module"`）。**没有 TypeScript 源文件**，类型安全靠 JSDoc + `tsc --checkJs`。运行时依赖仅 `playwright-core`（为遗留 browser 工具保留，当前插件未注册任何 browser 工具）。

## 常用命令（仓库根执行）

- `npm test` — `node --test tests/*.test.mjs`，必须全绿。
- `npm run lint` — ESLint（flat config）。
- `npm run typecheck` — `tsc -p tsconfig.json`（checkJs），必须 0 错。
- `npm run smoke` — 加载插件断言注册形态：`tools=2, hooks=5`，遗留 browser 工具未注册，且 `openclaw.plugin.json.version === package.json.version`。
- `npm run format:check` / `npm run format` — Prettier；`format` 会全量重排，只在明确要求时用。

改完代码至少跑 `npm run lint && npm run typecheck && npm test && npm run smoke`。

## 架构地图（当前形态）

- `index.js` — 入口：注册 2 个本地工具 `ypscan_parse_requirement`、`ypscan_save_excel_artifact`；注册 5 个 Hook：`before_prompt_build`、`before_tool_call`、`tool_result_persist`、`gateway_start`、`gateway_stop`（后两个只重置瞬态状态）。
- `openclaw.plugin.json` — 清单：Provider MCP 白名单（含 `manual_source_creators`/`manual_source_creators_status`）、测试 adapter、`contracts.tools`、`skills`。`configSchema` 只有 `testMode`/`testAdapterBaseUrl`，后者仅 `testMode=true` 时使用且必须是无凭据 loopback origin。
- `src/tools/` — 本地工具与辅助：
  - `parse-requirement.js` — 直连 Dify 的需求解析代理；`data.outputs` 只返回当前 Provider 契约消费的字段，缺失字段省略。
  - `save-excel-artifact.js` — 保存 Provider 返回的 Excel 并产出可点击的本地文件链接。
  - `test-adapter.js`、`tool-result.js`、`popup-questions.js` — 测试下载、结果适配与统一弹窗载荷。
  - `manual-browser-*`、`manual-research-*`、`select-cascade.js`、`set-filter-range.js` — **遗留 native Browser 手扒工具**：保留在仓库但不在 `index.js` 注册、不在发布包 `files` 内。不要重新注册。
- `src/contract/registry.js` — 参数归一化、平台别名、`business_mode` 常量与 `validate_requirement` 预检。
- `src/hooks/register-flow-directives.js` — 注入双功能链路、顺序复用与交付指令；`before_tool_call` 只做 `validate_requirement` 预检，不做功能互斥或企微发送确认门禁。
- `skills/media-assistant/` — **业务行为权威**：`SKILL.md`（固定链路、复核、放宽顺序、Provider 幂等规则）+ `references/`（工具卡）。涉及达人/询价/手扒/提报的任务，首次相关操作前必须完整读一遍。
- `spec/*.json` — 声明式规范（含遗留 `browser-assist.json`），只读参考，不是运行时代码。
- `docs/review-checklist.md` — 用户维护的验收清单；改业务链路后核对相关条目。
- `benchmarks/requirement-parser/RESULTS.md` — 解析器评测记录。

## 关键不变量

1. **SKILL.md 优先**：业务行为（模式判定、复核、放宽、交付）一律以 `skills/media-assistant/SKILL.md` 及其 references 为准，本文件只补充工程约束。
2. **双功能顺序复用**：同一 requirement 不得并行或在功能处理中切换；同会话、同平台、业务条件未变且前一功能完成或明确停止后，可复用 requirement 和已提交字段配置执行另一功能。用户修改任何业务条件时才撤销自动放宽、恢复用户原始需求并新建 requirement；不得复用旧机构、达人、batch 或 Excel。
3. **复核先于放宽**：询价机构不足禁止直接放宽，先复核当前有效需求、解析输出与实际落库参数；确认正确后才按 SKILL 固定顺序逐项放宽，每项只调一次并提前告知。平台、品牌、数量、截止时间、内容形式等永不自动放宽。手动拓展 Excel 保存后即为最终手动拓展结果，不再精排、生成提报表或触发放宽。
4. **Provider 边界**：企微发送确认、机构名匹配、合并去重、同 requirement/机构幂等全部由 Provider 负责；插件不预检发送、不缓存发送状态、不暴露已弃用的查询工具。
5. **结果归属**：所有结果、链接、文件只用当前 requirement、当前平台、本轮真实 Provider 证据；不跨需求/平台/账号/历史 run 混用或补齐。
6. **数值与字段契约**：区间一律无空格字符串 `"[min,max]"` 且 `min < max`；返点 `"[min,1]"`；抖音报价/CPM/CPE 只用 L2=植入、L3=定制；未知字段省略，检索放宽区间不回写需求参数。
7. **分析 vs 修改**：默认只做分析评审，用户明确要求才改代码；改动最小化，不顺手重构或重排无关文件。
8. **不增多余机制**：不新增无必要的状态、缓存、账本、校验实体或权限门禁；共同逻辑保持共享。

## 迭代方向偏好（修改/评审时的建议导向）

本项目的价值在业务规矩的编码质量，不在代码量；做修改或 review 时，建议与结论优先往以下方向引导。这些只是建议偏好：不改变上面的最小改动、不增多余机制、默认只分析等约束，落地前仍需用户明确认可。

1. **行为回归评测（最高优先）**：SKILL.md 是 prompt 契约，模型或 Provider 变化可能让规矩静默失效。涉及业务链路的改动，优先建议在 `benchmarks/` 或 `tests/` 补行为回归用例（该问才问、复核先于放宽、放宽顺序、双功能顺序复用），而不是只补单元断言。
2. **契约对齐自动化**：工具卡、Hook 预检、Provider MCP schema 三处手工对齐是反复出 bug 的根源（字符串化 JSON、未知字段、类型不符）。遇到契约漂移类问题，优先建议 schema 校验/对齐方向，而不是叠加手工修补。
3. **上下文按需注入**：Hook directive 持续瘦身；新增指令优先按流程阶段注入片段，避免整条链路每轮全量注入。
4. **数据回流**：涉及 rank/询价回收链路时，可提示"回收结果反哺排序"的数据回流机会（Provider 侧实现，仅作建议，不在插件内自建账本）。
5. **遗留清理**：发现遗留 browser 工具、`playwright-core`、worktree、`*.tgz` 被误用时，建议归档/清理方向，不重新启用。

## 常见坑

- **npm `EPERM`（cache root-owned）**：本机 `~/.npm` 有 root 属主残留，用 `--cache /tmp/ypscan-npm-cache` 绕过，不要 `sudo chown`。
- **`*.tgz` 是发布产物**：已被 `.gitignore` 忽略，不要提交；发布用 `npm pack`（`files` 已裁剪），产物命名沿用 `ypscan-<version>.tgz`。
- **版本同步**：发布前必须让 `openclaw.plugin.json.version` 与 `package.json.version` 一致，否则 smoke 直接失败。
- **typecheck 靠 JSDoc**：新增解构参数/对象字面量时若 tsc 报 Property/excess property，先补 `@param` 类型，不要关 `checkJs`。
- **playwright-core 别误用**：它是遗留依赖，当前插件不注册任何 browser 工具；勿把 `manual-browser-*` 工具加回 `index.js`。
- **`spec/`、`docs/`、`benchmarks/` 已入库**：spec 只读参考；`docs/review-checklist.md` 是用户验收清单，勿擅自删除。

## 验证清单（改完必做）

1. `npm run lint` → 0 错
2. `npm run typecheck` → 0 错
3. `npm test` → 全绿
4. `npm run smoke` → `tools=2, hooks=5`
5. 涉及打包/发布：`npm pack --dry-run --cache /tmp/ypscan-npm-cache`，确认发布包只含 `files` 白名单内容（不含遗留 browser 工具与测试文件），发布前核对版本同步。
6. 涉及业务链路：逐条核对 `docs/review-checklist.md` 中与本次改动相关的条目，并说明结论。
