# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 SSE 调用 Provider。用户明确表达业务模式时直接采用，未明确或语义冲突时再询问；确定模式后解析、复核并落库：

- 询价机构：`选择模式 → 解析落库 → search_creators → rank_mcns → 选择机构和字段 → 企微询价 → 回收 → rank_creators → 提报表`
- 直接手扒：`选择模式 → 解析落库 → 选择字段 → manual_source_creators → 详情列表 → rank_creators → 提报表`

直接手扒由后端 `manual_source_creators` 完成 API 搜索、详情抓取和筛选，再用 `manual_source_creators_status` 轮询详情 Excel。详情列表保存并展示后继续 `rank_creators` 和 `create_submission_batch`，最终交付提报表。用户主动修改任何业务条件时，都会从用户原始需求合并最新人工修改、撤销自动放宽、重新解析和复核，并从原业务模式重新执行。

## 当前组成

- `index.js`：注册 2 个本地能力工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：调用固定需求解析 Workflow，`data.outputs` 只返回当前 Provider 契约消费的字段；解析返回的标签数组合法非空时直接采用，不向用户确认，任何标签（包括 `pgyBloggerTypeLabel` / `xtTalentTypeLabel`）缺失或为 `null` 时直接省略。当前平台唯一且非占位的品牌候选直接采用。数值字段先合并原文与最新有效弹窗答案，只有仍缺失、模糊或冲突时才询问；已确认且未修改的值不得重复询问。抖音报价、CPM、CPE 固定映射为 L2=植入视频、L3=定制视频，不使用 L1。同平台多个达人类型只有总量时保留一个 requirement，合并全部类型标签和条件，不拆分子需求。
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

Smoke 断言本地工具为 2 个、字段选择由远端 MCP 直接暴露且旧字段查询工具不再暴露、自定义 Browser 状态机入口未注册、Hook 集合包含流程指令、`validate_requirement` 调用前完整预检与 Gateway 生命周期事件；`before_tool_call` 仅做 `business_mode` 分支互斥，不包含企微发送确认门禁。
