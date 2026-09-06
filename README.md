# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 Streamable HTTP 连接 Provider MCP，并在本地用 Hook 把正式链路固定到新的 CSV 中心流程。用户明确表达当前功能时直接采用，未明确或语义冲突时再询问；确定后解析、复核并落库。

- 询价机构：`选择模式 → 解析落库 → search_creators → rank_mcns → 选择机构和字段 → 企微询价 → 回收 → get_ingest_job → 保存预览 Excel → 保存 links CSV → 选择“精排并生成提报表 / 只补全达人信息” → （当前测试 Provider）rank_creators(requirement_id, inquiry_ids) → 最终提报 Excel`
- 手动拓展：`选择模式 → 解析落库 → 选择字段 → manual_source_creators → manual_source_creators_status → 保存 links CSV → 原生补全 → file_bridge 合并并上传 OSS → score_manual_source_csv → 最终手动拓展 Excel`

当前实现把 `links CSV` 作为达人补全与排序的正式中间产物：机构回填分支先保存预览 Excel 和 links CSV，再决定是否继续精排；手动拓展分支保存 links CSV 后，按 20 个一批调用平台原生达人补全工具，再由 `file_bridge` 一次完成合并和 OSS 上传。当前测试 Provider 的 `rank_creators` 仍直接消费 `{requirement_id, inquiry_ids}`；插件同时为后续 schema 升级预留了 `原生补全 → file_bridge(flow=mcn_rank) → rank_creators({requirement_id, csv_file_path})` 的兼容接入。正式链路不再调用 `create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`。每次开始询价或手动拓展都必须重新解析、复核并创建独立的新 requirement；即使同一会话、同一平台、需求条件未变且前一功能刚完成或停止，也不得跨功能复用 requirement 或已提交字段配置。

`file_bridge` 的 OSS 凭据按“插件配置 `fileBridgeOss` → 打包内置凭据”读取，不隐式读取宿主进程环境变量；内部测试或集成仍可显式注入环境变量。`region`/`bucket`/`objectPrefix` 未配置时回落到内置非敏感默认值；官方发布包由 prepack 脚本（`scripts/prepare-oss-bundle.mjs`）把本机 `.env` 的 `AccessKeyId`/`AccessKeySecret` 等注入包内（凭据文件被 gitignore，不进入仓库），因此安装后无需任何配置即可上传。上传前强制校验：links 与补全文件必须都是 `.csv`，merged CSV 必须为合法 CSV 内容；links CSV 必须是当前 requirement 受控保存的产物，补全 CSV 必须来自当前 requirement 的 YP Action 原生补全工具，否则返回 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED` 且不上传。上传对象键固定为 `<Object 前缀>/<flow>/<requirement_id>/<sha256>.csv`，返回未签名 OSS 公网地址，并在交给下游前做匿名可读校验。

如需覆盖打包内置凭据，可在插件配置中填写：`fileBridgeOss.accessKeyId`、`fileBridgeOss.accessKeySecret`、`fileBridgeOss.region`、`fileBridgeOss.bucket`、`fileBridgeOss.objectPrefix`（官方发布包通常无需配置）。

## 当前组成

- `index.js`：注册 3 个本地工具、远端 MCP 白名单和 Hook。
- `src/tools/parse-requirement.js`：调用固定需求解析 Workflow，`data.outputs` 只返回当前 Provider 契约消费的字段；解析标签合法时直接采用，缺失或 `null` 时省略。当前平台唯一且非占位的品牌候选直接采用；数值字段只有仍缺失、模糊或冲突时才询问。
- `src/tools/save-artifact.js`：单一入口受控保存 Provider 返回的 Excel 或 links CSV；`artifact_kind` 唯一决定格式，共用下载限制、重试、原子发布与幂等逻辑。
- `src/tools/merge-creator-csv.js`：`file_bridge` 的内部合并实现，按 links CSV 原顺序合并多批原生达人补全结果；不是公开工具。
- `src/tools/file-bridge.js`：合并 links CSV 与补全 CSV；`mcn_complete_only` 或超过 500 行时仅本地交付，其余先做 CSV 格式与 YP Action 来源校验，再上传 OSS 并返回匿名可读的 `csv_file_path`。
- `src/hooks/register-flow-directives.js`：注入新 CSV 链路、需求澄清与数值格式锁、回收分叉和交付指令；`validate_requirement` 调用前执行规范化和完整预检。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_save_artifact`
- `file_bridge`

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 3 个，远端 MCP 暴露 `score_manual_source_csv` 且不再暴露旧正式链路工具；字段选择仍由远端 MCP 直接暴露；Hook 集合包含流程指令和 Gateway 生命周期事件；`before_tool_call` 仅做需求落库预检，不包含功能互斥或企微发送确认门禁。
