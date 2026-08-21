# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 SSE 调用 Provider，并在用户选择浏览器详细手扒后由插件 Runner 连接宿主 Browser CDP 完成双平台采集。所有达人筛选固定执行：

`ypscan_parse_requirement → validate_requirement → search_creators → rank_mcns → 完整 MCN Markdown 表格 → 保存并展示 MCN 排名表本地路径 → AskUserQuestion`

用户选择“人工拓展并提报”后，若当前对话已经确认同一 requirement ID 的字段选择已提交，则直接复用 Provider 持久化字段并调用 `manual_source_creators`；否则先通过 `select_inquiry_form_fields` 选择字段。Provider 返回字段未配置时再回退到字段选择。“手扒”“手动拓展”“人工拓展”“直接手扒”“手捞筛选”都默认走这个 MCP 链路；只有用户明确说要用浏览器手扒或选择“浏览器详细手扒”后，才激活 Runner 并调用 `ypscan_manual_research(operation=start)` 创建运行。Runner 复用宿主 Browser 的 Profile、Cookie 和登录态，依次尝试完整硬筛、仅关键词、无筛选广场和通用可见 DOM。星图登录态首页会自动进入达人工作区；详情页优先读取真实网络响应和弹窗下 DOM，普通资质提示不阻断采集，真实验证码则保存当前证据并暂停。每页结果增量写入 checkpoint 并刷新 Excel，用户处理登录、验证、宿主 Browser 启动或网络恢复后用同一 `run_id` 调用 `resume`；终态失败后用 `fresh_run=true` 新建运行。Agent 不直接接管 Browser、shell 或页面快照。

## 当前组成

- `index.js`：注册 3 个本地能力工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：把紧凑原文证据 facts 编译成 Provider 参数、搜索分组和残余条件。
- Provider 询价字段选择直接使用远端 MCP `select_inquiry_form_fields`，用户提交后按 requirement ID 在后端持久化；Agent 不调用已弃用的字段查询工具，也不向后续工具传 `columns`。
- `src/tools/save-excel-artifact.js`：保存 Provider 返回的 Excel 下载结果；初始链路只保存 MCN 排名表，不保存 `search_creators` 的表格。
- `src/tools/manual-research-runner.js`：执行有界的双平台筛选、降级、分页、原始详情 HTML 采集、Agent 分块提炼、恢复和产物刷新。
- `src/tools/manual-research/browser-runtime.js`：管理插件独立的持久 Chrome Profile 和单运行互斥。
- `src/tools/manual-research-artifact.js`：稳定身份去重、checkpoint、复核以及三 Sheet Excel 产物。
- `src/hooks/register-flow-directives.js`：注入固定链路、Runner 恢复、Provider 询价结果与交付指令；企微发送匹配和幂等由 Provider 负责。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_manual_research`
- `ypscan_save_excel_artifact`

人工拓展只在 MCN 分支选择“人工拓展并提报”后启动。Agent 将完整 facts 和 1–4 个关键词传给 `start`；公开操作仅有 `start`、`resume`、`apply_reviews`、`create_submission`。旧 `capture_list`、`capture_detail`、`finalize` 和 `collect` 协议已停用。

初始状态先写入当前项目的 JSONL checkpoint 和本地 `.xlsx`。Excel 固定包含“达人推荐List”“候选达人”“运行说明”三个 Sheet，并单列“报价类型”；未复核、降级或通用 DOM 召回只进入候选表。手扒价格以客户原始值为锚点按 50%–120% 验收，蒲公英绑定图文/视频笔记报价，星图绑定植入视频/定制视频报价；“全部报价/起”只作展示，不参与目标类型价格验收。价格失败者不进入推荐名单，人数不足如实报告缺口。只有初始 Excel 无法创建才属于无产物硬失败。

Runner 总预算为 180 秒，并预留 15 秒落盘；单分支最多 5 页、整轮最多 12 页，详情目标为 `min(需求人数, 10)` 个成功记录。详情失败会记录诊断并继续用后续候选补位；未补足时只能返回 `partial`，同时通过 `detail_progress.shortfall` 报告缺口。终态重放校验并复用原 Excel，不改写文件。它保证在工作区可写时交付状态 Excel，并在页面可用时尽力交付候选；不保证目标人数或最终推荐数量。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 3 个、字段选择由远端 MCP 直接暴露且旧字段查询工具不再暴露、自定义 Browser 状态机入口未注册、Hook 集合仅包含流程指令与 Gateway 生命周期事件，不包含企微发送前后门禁。
