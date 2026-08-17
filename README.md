# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 SSE 调用 Provider，并在用户选择人工拓展后由宿主 Browser + Playwright Core 完成双平台手扒。所有达人筛选固定执行：

`ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns → 完整 MCN Markdown 表格 → 本地路径 → AskUserQuestion`

用户选择“人工拓展并提报”后，Agent 先用宿主 Browser 直接打开当前平台达人广场，再按关键词执行 `ypscan_manual_select_filters → ypscan_manual_research`。前者只负责页面筛选和真实回读，后者只消费选择凭证并分页、去重、补详情和生成产物；语义相关性仍由 Agent 基于候选池、详情和近期内容复核。

## 当前组成

- `index.js`：注册 4 个本地能力工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：把紧凑原文证据 facts 编译成 Provider 参数、搜索分组和残余条件；调用方只提交事实语义，工具补齐来源与默认元数据，不生成平台专用手扒任务。
- Provider 询价字段选择直接使用远端 MCP `select_inquiry_form_fields`，用户提交后按需求 ID 在后端持久化；Agent 不再调用 `get_selected_inquiry_form_fields`，也不向后续工具传 `columns`。
- `src/tools/save-excel-artifact.js`：保存 Provider 返回的 Excel 下载结果。
- `src/tools/manual-filter-selection.js`：逐关键词提交报价口径、级联项和区间条件，回读成功后生成一次选择凭证。
- `src/tools/manual-research.js`：只读复核选择凭证后分页、去重、补详情和恢复，不修改页面筛选。
- `src/tools/manual-research-artifact.js`：每页追加 checkpoint，同 run 恢复，并生成固定五张工作表。
- `src/tools/manual-research/`：星图、蒲公英各自的 Playwright 定位器、动态浮层、真实键鼠、报价视图和导出适配器。
- `src/hooks/register-wecom-confirmation-only.js`：注入固定链路的无状态下一步指令，并保留企微外发一次性确认。
- `skills/media-assistant/`：固定首发链路、AskUserQuestion 规则和 Browser + native 最小 SOP。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_manual_select_filters`
- `ypscan_manual_research`
- `ypscan_save_excel_artifact`

Browser 阶段只有在 MCN 分支选择“人工拓展并提报”后启动。Agent 先用宿主 Browser 直接打开星图或蒲公英达人广场，再把当前需求 ID、平台、精简 facts 和关键词交给选择工具；只有它返回 `ready_for_collection=true`，才把 `collection_args` 原样交给抓取工具。达人单价以客户原始值为锚点筛选 50%–120% 区间，并严格绑定蒲公英图文/视频或星图视频时长档位。每一页候选都会先写入当前项目的 JSONL checkpoint，完成或中断时生成本地五表 `.xlsx`；响应只返回最多 20 条预览及完整计数、checkpoint/Excel 绝对路径。列表响应与 DOM 是主路径，平台原生导出仅作为额度受限的 fallback。

手扒价格只接受客户原始标量或原始区间边界，避免二次扩展。候选采集后会按对应报价档位再次验收上下界；价格失败者保留在完整候选池但不进入目标名单，合格人数不足时响应和 Excel 都明确给出缺口。

这是对旧 `ypscan_browser_assist` 的非兼容替换，本地工具总数为 4。运行时唯一新增依赖是 `playwright-core@1.62.1`；它只连接现有 `browserCdpUrl`，不下载、启动或关闭独立浏览器。checkpoint 按需求、平台和筛选计划指纹隔离，只保存规范化筛选回执与当前页面公开候选证据；工具不调用私有接口、不读取 Cookie/Token，也不在工具内执行语义判断。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 4 个、字段选择由远端 MCP 直接暴露且旧字段查询工具不再暴露、旧手扒与标签解析入口未注册、Hook 集合完整，以及企微确认仍按一次性挑战工作。
