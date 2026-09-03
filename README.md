# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 Streamable HTTP 连接 Provider MCP，并在本地用 Hook 把正式链路固定到新的 CSV 中心流程。用户明确表达当前功能时直接采用，未明确或语义冲突时再询问；确定后解析、复核并落库。

- 询价机构：`选择模式 → 解析落库 → search_creators → rank_mcns → 选择机构和字段 → 企微询价 → 回收 → get_ingest_job → 保存预览 Excel → 保存 links CSV → 选择“精排并生成提报表 / 只补全达人信息” → 原生补全 → merge → （精排分支）显式上传 → rank_creators → 最终提报 Excel`
- 手动拓展：`选择模式 → 解析落库 → 选择字段 → manual_source_creators → manual_source_creators_status → 保存 links CSV → 原生补全 → merge → 显式上传 → score_manual_source_csv → 最终手动拓展 Excel`

当前实现把 `links CSV` 作为达人补全与排序的正式中间产物：机构回填分支先保存预览 Excel 和 links CSV，再决定是否继续精排；手动拓展分支保存 links CSV 后，按 20 个一批调用平台原生达人补全工具，合并后再显式上传。`rank_creators` 现在直接消费 `csv_file_path` 并返回最终 Excel，本地保存为 `ranked_submission`；正式链路不再调用 `create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`。每次开始询价或手动拓展都必须重新解析、复核并创建独立的新 requirement；即使同一会话、同一平台、需求条件未变且前一功能刚完成或停止，也不得跨功能复用 requirement 或已提交字段配置。

当前仓库对 `ypscan_upload_creator_csv` 只实现了输入校验、500 行上限阻断和测试模式 mock 上传。由于仓库内没有可验证的生产 CSV 暂存端点契约，非测试模式下该工具会明确返回 `YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE`，而不是猜测真实上传接口。

## 当前组成

- `index.js`：注册 5 个本地工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：调用固定需求解析 Workflow，`data.outputs` 只返回当前 Provider 契约消费的字段；解析标签合法时直接采用，缺失或 `null` 时省略。当前平台唯一且非占位的品牌候选直接采用；数值字段只有仍缺失、模糊或冲突时才询问。
- `src/tools/save-excel-artifact.js`：受控保存 Provider 返回的 Excel 下载结果，覆盖 `mcn_ranking`、`mcn_creator_preview`、`manual_source`、`creator_detail_export` 和 `ranked_submission`。
- `src/tools/save-csv-artifact.js`：受控保存 Provider 返回的 links CSV，覆盖 `manual_creator_links` 和 `mcn_creator_links`。
- `src/tools/merge-creator-csv.js`：按 links CSV 原顺序合并多批原生达人补全结果，输出 merged CSV。
- `src/tools/upload-creator-csv.js`：对 merged CSV 做空文件/格式/500 行上限校验，并在测试模式下返回 `csv_file_path`。
- `src/hooks/register-flow-directives.js`：注入新 CSV 链路、需求澄清与数值格式锁、回收分叉和交付指令；`validate_requirement` 调用前执行规范化和完整预检。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_save_excel_artifact`
- `ypscan_save_csv_artifact`
- `ypscan_merge_creator_csv`
- `ypscan_upload_creator_csv`

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 5 个，远端 MCP 暴露 `score_manual_source_csv` 且不再暴露旧正式链路工具；字段选择仍由远端 MCP 直接暴露；Hook 集合包含流程指令和 Gateway 生命周期事件；`before_tool_call` 仅做需求落库预检，不包含功能互斥或企微发送确认门禁。
