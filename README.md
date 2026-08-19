# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 SSE 调用 Provider，并在用户选择人工拓展后由插件内专用持久 Chrome Runner 完成双平台手扒。所有达人筛选固定执行：

`ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns → 完整 MCN Markdown 表格 → 本地路径 → AskUserQuestion`

用户选择“人工拓展并提报”后，调用 `ypscan_manual_research(operation=start)` 创建运行。Runner 使用独立持久 Profile，依次尝试完整硬筛、仅关键词、无筛选广场和通用可见 DOM，并在动作失败后恢复页面、重试一次。每页结果增量写入 checkpoint 并刷新 Excel；登录或全局验证码时保留当前 Excel，用户处理后用同一 `run_id` 调用 `resume`。Agent 不接管 Browser、shell 或页面快照。

## 当前组成

- `index.js`：注册 3 个本地能力工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：把紧凑原文证据 facts 编译成 Provider 参数、搜索分组和残余条件。
- Provider 询价字段选择直接使用远端 MCP `select_inquiry_form_fields`，用户提交后按 requirement ID 在后端持久化；Agent 不调用已弃用的字段查询工具，也不向后续工具传 `columns`。
- `src/tools/save-excel-artifact.js`：保存 Provider 返回的 Excel 下载结果。
- `src/tools/manual-research-runner.js`：执行有界的双平台筛选、降级、分页、详情采集、恢复和产物刷新。
- `src/tools/manual-research/browser-runtime.js`：管理插件独立的持久 Chrome Profile 和单运行互斥。
- `src/tools/manual-research-artifact.js`：稳定身份去重、checkpoint、复核以及三 Sheet Excel 产物。
- `src/hooks/register-wecom-confirmation-only.js`：注入固定链路、Runner 恢复与交付指令，并保留企微外发一次性确认。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_manual_research`
- `ypscan_save_excel_artifact`

人工拓展只在 MCN 分支选择“人工拓展并提报”后启动。Agent 将完整 facts 和 1–4 个关键词传给 `start`；公开操作仅有 `start`、`resume`、`apply_reviews`、`create_submission`。旧 `capture_list`、`capture_detail`、`finalize` 和 `collect` 协议已停用。

初始状态先写入当前项目的 JSONL checkpoint 和本地 `.xlsx`。Excel 固定包含“达人推荐List”“候选达人”“运行说明”三个 Sheet；未复核、降级或通用 DOM 召回只进入候选表。手扒价格以客户原始值为锚点按 50%–120% 验收，并绑定正确图文/视频或星图时长档；价格失败者不进入推荐名单，人数不足如实报告缺口。只有初始 Excel 无法创建才属于无产物硬失败。

Runner 总预算为 180 秒，并预留 15 秒落盘；单分支最多 5 页、整轮最多 12 页、详情最多 10 位。它保证在工作区可写时交付状态 Excel，并在页面可用时尽力交付候选；不保证目标人数或最终推荐数量。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 3 个、字段选择由远端 MCP 直接暴露且旧字段查询工具不再暴露、自定义 Browser 状态机入口未注册、Hook 集合完整，以及企微确认仍按一次性挑战工作。
