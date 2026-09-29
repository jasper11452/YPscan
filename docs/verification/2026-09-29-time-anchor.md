# 时间锚：每轮注入当前时间与截止时间阻断提示

## 背景

代码侧的时间判定一直准确（`registry` 的截止时间归一化与未来性校验默认取进程本地时钟），但注入给模型的指令里没有任何具体时间，模型只能自行推算相对时间，算错后本地预检阻断、阻断信息里又没有当前时间，容易反复猜测。本记录只修这条链路，不新增工具、状态或 schema。

## 改动

`src/hooks/register-flow-directives.js`

- 新增 `currentTimeAnchor` / `currentTimeDirective`：只读进程本地时钟（与 `registry` 截止时间归一化同源），输出 `YYYY-MM-DD HH:mm:ss 星期X（时区 <zone> UTC±HH:MM）`，不调用 PowerShell 或终端子进程。
- `before_prompt_build` 在 `startupScopes` 分支之外、静态指令之后追加时间锚行，每轮都在；声明更早轮次的时间作废。
- `requirementPreflightBlockReason` 增加 `now` 入参，仅在 issue 命中 `submissionDeadlineAt` 时附当前时间锚，其他字段阻断不加时间行。
- `before_tool_call` 只取一次 `now`，`normalizeToolCallParams` 与 `validateRequirementPreflight` 共用，避免跨秒漂移。

`tests/flow-directives.test.mjs` 新增三条断言：时间锚在第二次调用（启动块已被作用域裁掉）仍存在；过期截止时间阻断信息带当前时间；非截止时间阻断不带时间行。

同步：`skills/media-assistant/SKILL.md`（时间锚权威规则）、`docs/spec/hooks.md`（§1/§3/§4）、`docs/review-checklist.md`（两条人工验收）、`AGENTS.md` 不变量 6。

## 验证

真实调用 Hook（非仅单元断言）：

```
第1/2/3轮 -> 当前时间：2026-09-29 13:15:51 星期二（时区 Asia/Shanghai UTC+08:00）。…
过去时间 -> 一次性修正项：submissionDeadlineAt: 必须是晚于当前时间的 YYYY-MM-DD HH:mm:ss
            当前时间：2026-09-29 13:15:51 星期二（时区 Asia/Shanghai UTC+08:00）。…
未来时间 -> 无阻断 | block: false
```

进程时钟与 `date '+%Y-%m-%d %H:%M:%S %Z %z'` 一致（`2026-09-29 13:16:04 CST +0800`，同一次运行的差异仅为秒级）。

`npm run lint` / `npm run typecheck` / `npm test`（449 通过）/ `npm run smoke`（`tools=5, hooks=5`）全部通过。

## 未验收 / 边界

- 模型是否真的“先取时间再换算”属行为验收，必须在真实宿主多轮对话里验证；静态断言只证明指令已生成。
- 相对时间（本周/下周/月底等）的**代码侧**归一化仍是第二阶段，本次只把权威时间交给模型；`registry` 目前只对“今天/明天”等有限前缀做归一化。
- Dify 远端解析仍拿到未锚定的原文（例如“下周五截止”）；插件侧换算不改变 Provider 的解析输入。该分工未纳入本次改动。
- 本机安装的是 OpenClaw 内核 YP Action；此改动按 OpenClaw Hook 契约生效，未在 Pi 内核宿主上验收。
