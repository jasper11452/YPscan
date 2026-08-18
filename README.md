# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 SSE 调用 Provider，并在用户选择人工拓展后由 Agent 使用 YP Action Playwright CLI 自主完成双平台手扒。所有达人筛选固定执行：

`ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns → 完整 MCN Markdown 表格 → 本地路径 → AskUserQuestion`

用户选择“人工拓展并提报”后，调用 `ypscan_manual_research(operation=start)` 创建运行。Agent 使用固定的 `ypscan` Playwright session：首次打开使用 `--headed --persistent`，确认已进入目标达人广场后完成筛选、翻页和详情访问。稳定列表页和详情页由 run-code 读取结构化快照，分别传给 `capture_list` / `capture_detail` 持久化；插件本身不执行 shell、不连接宿主 Browser，也不需要 `selection_id`。普通页面问题由 Agent 自动恢复，只有全局登录、验证码或 Playwright 不可用才请求用户。

## 当前组成

- `index.js`：注册 3 个本地能力工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：把紧凑原文证据 facts 编译成 Provider 参数、搜索分组和残余条件。
- Provider 询价字段选择直接使用远端 MCP `select_inquiry_form_fields`，用户提交后按 requirement ID 在后端持久化；Agent 不调用已弃用的字段查询工具，也不向后续工具传 `columns`。
- `src/tools/save-excel-artifact.js`：保存 Provider 返回的 Excel 下载结果。
- `src/tools/manual-research.js`：创建本地运行，校验并保存 Agent 采集的结构化快照，稳定身份去重、复核并生成产物；不控制浏览器页面。
- `src/tools/manual-research/`：保留内部兼容与数据归一化实现，不是当前公开 Browser 执行入口。
- `src/hooks/register-wecom-confirmation-only.js`：注入固定链路和 Playwright CLI 下一步指令，并保留企微外发一次性确认。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_manual_research`
- `ypscan_save_excel_artifact`

人工拓展只在 MCN 分支选择“人工拓展并提报”后启动。Agent 将完整 facts 和 1–4 个关键词传给 `start`；首关键词完成全部硬筛且最后提交关键词，后续在同一 session 内保留筛选集、只替换关键词。页面发生导航、菜单切换、输入提交、分页或详情切换后必须重新 snapshot，旧 ref 不得复用。无法稳定应用的页面条件进入详情硬复核，不中断整批任务。

每页候选写入当前项目的 JSONL checkpoint。`finalize` 按正式达人推荐 List 模板生成本地 `.xlsx`，只含“达人推荐List”和“候选达人”两个 Sheet。手扒价格以客户原始值为锚点按 50%–120% 验收，并绑定正确图文/视频或星图时长档；价格失败者不进入推荐名单，人数不足如实报告缺口。

这个仓库只保存采集结果与复核反馈，无法直接观测 Playwright CLI 的 locator 成功率和动作耗时。真正的“越用越快”应在 YP Action 执行层记录脱敏页面指纹、成功定位策略、回读结果和耗时，经回归验证后提升策略优先级；不得把一次成功的脆弱 ref 或绝对选择器直接固化成本项目规则。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 3 个、字段选择由远端 MCP 直接暴露且旧字段查询工具不再暴露、自定义 Browser 状态机入口未注册、Hook 集合完整，以及企微确认仍按一次性挑战工作。
