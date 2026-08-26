# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 SSE 调用 Provider；人工拓展默认由后端 `manual_source_creators` 完成并返回 Excel。所有达人筛选固定执行：

`ypscan_parse_requirement → validate_requirement → search_creators → rank_mcns → 完整 MCN Markdown 表格 → 保存并展示 MCN 排名表本地文件超链接 → AskUserQuestion`

用户选择“人工拓展并提报”后，若当前对话已经确认同一 requirement ID 的字段选择已提交，则直接复用 Provider 持久化字段并调用 `manual_source_creators`；否则先通过 `select_inquiry_form_fields` 选择字段。调用默认手扒前优先查看其实际 input schema：若有明确的需求原文可选字段，传当前完整、未改写的原始需求文本；schema 不支持或仅因未知参数拒绝时，去掉该字段，仅用同一 requirement ID 和 `size` 重试一次。不得猜字段名、传解析输出或 `rawMessagesJson`。Provider 返回字段未配置时再回退到字段选择。“手扒”“手动拓展”“人工拓展”“直接手扒”“手捞筛选”都默认走这个 MCP 链路。后台返回 Excel 后立即使用 `ypscan_save_excel_artifact(artifact_kind=manual_source)` 保存，并原样展示本地文件 Markdown 超链接作为交付。

## 当前组成

- `index.js`：注册 2 个本地能力工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：调用固定需求解析 Workflow，在 `data.outputs` 中完整透传原始输出；解析返回的标签数组合法非空时直接采用，不向用户确认，可选标签缺失时省略；但小红书 `pgyBloggerTypeLabel` 或抖音 `xtTalentTypeLabel` 解析为 `null` 时必须先询问用户。用户明确品牌优先，否则采用当前平台唯一且非占位的品牌候选。数值字段先合并原文与最新有效弹窗答案，只有仍缺失、模糊或冲突时才询问；已确认且未修改的值不得重复询问。抖音报价、CPM、CPE 固定映射为 L2=植入视频、L3=定制视频，不使用 L1；解析片段仍带旧档位名但视频类型明确时，保持数值不变并确定性路由，不重复询问。同平台多个达人类型只有总量时保留一个 requirement，合并全部类型标签和条件，不拆分子需求。
- Provider 询价字段选择直接使用远端 MCP `select_inquiry_form_fields`，用户提交后按 requirement ID 在后端持久化；Agent 不调用已弃用的字段查询工具，也不向后续工具传 `columns`。
- `src/tools/save-excel-artifact.js`：保存 Provider 返回的 Excel 下载结果；初始链路只保存 MCN 排名表和默认手扒结果，不保存 `search_creators` 的表格。
- `src/hooks/register-flow-directives.js`：注入固定链路、需求澄清与数值格式锁、Provider 询价结果与交付指令；`validate_requirement` 调用前执行规范化和完整预检，优先复用已有澄清答案。MCN 排名表与默认手扒结果都会先保存为本地 Excel，再展示可点击的本地文件链接。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_save_excel_artifact`

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 2 个、字段选择由远端 MCP 直接暴露且旧字段查询工具不再暴露、自定义 Browser 状态机入口未注册、Hook 集合包含流程指令、`validate_requirement` 调用前完整预检与 Gateway 生命周期事件，不包含企微发送前后门禁。
