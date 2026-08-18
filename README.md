# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 SSE 调用 Provider，并在用户选择人工拓展后由 Agent 使用宿主原生 Browser 自主完成双平台手扒。所有达人筛选固定执行：

`ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns → 完整 MCN Markdown 表格 → 本地路径 → AskUserQuestion`

用户选择“人工拓展并提报”后，先调用 `ypscan_manual_research(operation=start)` 创建运行。随后 Agent 使用宿主原生 Browser 自主导航、关闭普通弹窗、按需求选择页面筛选项、处理级联菜单、翻页和打开详情；稳定页面只用 `capture_list` / `capture_detail` 读取并持久化，不需要 `selection_id`。普通页面问题由 Agent 自动恢复，只有全局登录、验证码或 Browser 不可用才请求用户。

## 当前组成

- `index.js`：注册 4 个本地能力工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：把紧凑原文证据 facts 编译成 Provider 参数、搜索分组和残余条件；调用方只提交事实语义，工具补齐来源与默认元数据，不生成平台专用手扒任务。
- Provider 询价字段选择直接使用远端 MCP `select_inquiry_form_fields`，用户提交后按需求 ID 在后端持久化；Agent 不再调用 `get_selected_inquiry_form_fields`，也不向后续工具传 `columns`。
- `src/tools/save-excel-artifact.js`：保存 Provider 返回的 Excel 下载结果。
- `src/tools/manual-research.js`：创建手扒运行，只读采集 Agent 已打开的当前列表页或详情页，去重、复核并生成产物；不控制页面交互。
- `src/tools/manual-research-artifact.js`：每页追加 checkpoint，同 run 恢复，并生成固定五张工作表。
- `src/tools/manual-research/`：星图、蒲公英各自的 Playwright 定位器、动态浮层、真实键鼠、报价视图和导出适配器。
- `src/hooks/register-wecom-confirmation-only.js`：注入固定链路的无状态下一步指令，并保留企微外发一次性确认。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_select_cascade`
- `ypscan_manual_research`
- `ypscan_save_excel_artifact`

Browser 阶段只有在 MCN 分支选择“人工拓展并提报”后启动。Agent 把完整 facts 和关键词交给 `start`，然后使用宿主原生 Browser 操作星图或蒲公英。筛选项根据当前页面可见文字动态决定；普通菜单继续使用原生 Browser，只有级联菜单无法稳定完成悬停和子列选择时才调用 `ypscan_select_cascade`，并传入 Agent 从当前页面决定的筛选名与可见路径。无法稳定应用的页面条件转入详情硬复核，不中断整批任务。每一页候选都会写入当前项目的 JSONL checkpoint，`finalize` 生成本地五表 `.xlsx`。

手扒价格只接受客户原始标量或原始区间边界，避免二次扩展。候选采集后会按对应报价档位再次验收上下界；价格失败者保留在完整候选池但不进入目标名单，合格人数不足时响应和 Excel 都明确给出缺口。

本地工具总数为 4。`playwright-core@1.62.1` 只连接现有 `browserCdpUrl`，用于读取 Agent 已打开的当前页面，以及在原生 Browser 无法处理时执行单次通用级联选择；它不负责导航、关键词、翻页、详情点击或业务筛选决策，也不下载、启动或关闭独立浏览器。checkpoint 按需求、平台和筛选计划指纹隔离，只保存当前页面公开候选证据；工具不调用私有接口、不读取 Cookie/Token，也不在工具内执行语义判断。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 4 个、字段选择由远端 MCP 直接暴露且旧字段查询工具不再暴露、自定义 Browser 状态机入口未注册、Hook 集合完整，以及企微确认仍按一次性挑战工作。
