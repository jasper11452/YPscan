# AGENTS.md — 悦普识星（ypscan）项目级工作指南

> 本文件是给在此仓库工作的各类 agent 的**项目级**指引。通用执行/交互原则见全局 `~/.codex/AGENTS.md`（结论先行、最小改动、不编造、先验证、失败先定位原因）。这里只写「本项目特有」且 agent 干活必须知道的事实与约束。

## 这是什么

`ypscan`（悦普识星）是一个 OpenClaw 插件（id `ypscan`，`private: true`，当前版本 `0.1.24-beta37`），是「悦普达人采买」的客户端集成层：注册本地工具、通过 SSE 连远端 MCP（`https://mcp.eshypdata.com/sse`，12 个工具白名单），并在用户选择人工拓展后由 Agent 使用宿主 Browser 配合无状态 native 适配器。

- 技术栈：Node.js `>=22.22.2`、ESM（`"type":"module"`）。**没有 TypeScript 源文件**，类型安全靠 JSDoc + `tsc --checkJs`。

## 常用命令（在仓库根执行）

- `npm test` — `node --test tests/*.test.mjs`，必须全绿。
- `npm run lint` — ESLint（flat config，见 `eslint.config.js`）。
- `npm run typecheck` — `tsc -p tsconfig.json`（checkJs），必须 0 错。
- `npm run smoke` — 加载插件校验注册，期望 `tools=4, hooks=6`。
- `npm run format:check` / `npm run format` — Prettier（`format` 会全量重排，慎用）。

**改完代码至少跑 `npm run lint && npm run typecheck && npm test && npm run smoke`。**

## 架构地图

- `index.js` — 入口：注册 4 个本地能力工具 + 3 个核心 hook + `gateway_start`/`gateway_stop`。
- `openclaw.plugin.json` — 清单：MCP 白名单、测试 adapter、统一 `browserCdpUrl`、`contracts.tools`、`skills`。
- `src/tools/` — 本地工具：
  - `parse-requirement.js` — Provider 需求解析与搜索投影。
  - Provider 询价字段选择由远端 MCP `select_inquiry_form_fields` 直接提供并按需求 ID 在后端持久化；插件不注册同名代理，也不暴露已弃用的查询工具。
  - `save-excel-artifact.js` — 保存 Provider 返回的 Excel。
  - `manual-research.js`、`manual-research/` — 通过 Playwright Core 连接共享 Browser CDP，执行星图/蒲公英多关键词硬筛、报价视图、分页、原生导出和稳定身份去重；无状态，不做语义筛选。
  - `test-adapter.js`、`tool-result.js`、`post-save-questions.js` — 测试下载与结果适配。
- `src/contract/registry.js` — 参数归一化和平台别名。
- `src/hooks/register-wecom-confirmation-only.js` — 唯一门禁：`create_with_distributions` 企微外发需一次性确认（内存态、10 分钟 TTL、challenge 用 canonical-sha256 绑定）。
- `skills/media-assistant/` — 强制 agent 行为规范：`SKILL.md`（固定链路、native Browser 四动作、价格浮动 70%/120%、HITL 规则）+ `references/`（Provider 工具和双平台 SOP）。
- `spec/`、`docs/mcp-developer-tool-by-tool-tickets.md` — 声明式规范与 MCP 侧工单，**只读参考，不是本仓库运行时代码**。
- `skills/media-assistant/references/` — Provider 工具说明和 Browser + native 最小 SOP。

## 关键不变量（改代码必须遵守）

1. **分析 vs 修改**：默认只做分析评审；只有用户明确要求时才改代码。
2. **Provider 与 Browser 不混用**：解析结果只提供 Provider 参数和残余条件；Browser 只在 MCN 分支选择后由 Agent 直接操作，平台证据缺失必须如实标明。
3. **不跨需求混用**：结果只使用当前真实 Provider 或 Browser 证据，不用历史 MCN、达人或覆盖数补齐当前列表。
4. **门禁只有企微确认**：企微确认 challenge 存内存，gateway 重启即失效；固定链路和 native Browser 使用说明是静态下一步指令，不实现状态机或顺序拦截器。
5. **改动最小化**：不顺手重构无关代码；改完跑完整验证清单。

## 常见坑

- **npm 报 `EPERM`（cache root-owned）**：本机 `~/.npm` 有 root 属主残留。用 `--cache /tmp/ypscan-npm-cache` 绕过，不要 `sudo chown`。
- **`.tgz` 是发布产物**：已加入 `.gitignore` 并清理；发布用 `npm pack`（`files` 已裁剪为 `index.js` / `openclaw.plugin.json` / `README.md` / `skills` / `src`）。`docs/` 目前仍 untracked，别擅自删除或提交。
- **typecheck 靠 JSDoc**：这些文件原本没有注解。新增解构参数/对象字面量时，若 tsc 报「Property does not exist / excess property」，先补 `@param` 类型，不要关 `checkJs`。

## 验证清单（改完必做）

1. `npm run lint` → 0 错
2. `npm run typecheck` → 0 错
3. `npm test` → 全绿
4. `npm run smoke` → `tools=4, hooks=6`
5. 若动了打包/发布，`npm pack --dry-run --cache /tmp/ypscan-npm-cache` 确认发布包不含已删除 Runner、选择器脚本和测试文件。
