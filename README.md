# YPscan Client Integration Layer

悦普识星是一个 OpenClaw 客户端集成层：通过 Streamable HTTP 连接 Provider MCP，并在本地用 Hook 把正式链路固定到新的 CSV 中心流程。用户明确表达当前功能时直接采用，未明确或语义冲突时再询问；确定后解析、复核并落库。

- 询价机构：`选择模式 → 解析复核落库 → search_creators → rank_mcns → 选择机构和字段 → 发送确认与企微询价 → sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job → 保存预览 Excel → 询问是否补全 → ypscan_save_creator_links 派生 links CSV → 原生补全 → file_bridge 合并上传 → score_manual_source_csv → 保存打分排序 Excel`
- 手动拓展：`选择模式 → 解析复核落库 → 选择字段 → manual_source_creators → 同步 links CSV 或 manual_source_creators_status 轮询 → 保存并归一化 links CSV → ypscan_summarize_manual_scores 取得当前批 → 原生补全 → file_bridge 仅合并上传当前批 → score_manual_source_csv → 同步 Excel 或 score_manual_source_csv_status 轮询 → 保存 manual_score_batch → 再汇总 → 达标交付或下一批`

当前实现把 `links CSV` 作为达人补全与排序的正式中间产物；两分支按 20 个一批调用当前平台原生达人补全工具，再由 `file_bridge(flow=manual_source)` 合并并上传，交给 `score_manual_source_csv` 打分。正式链路不再调用 `get_workflow_state`、`rank_creators`、`create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`；遗留 flow 只保留兼容接入。每次真正开始询价或手动拓展都必须重新解析、复核并创建独立的新 requirement，不跨功能复用结果或字段配置；当前机构列表后的“暂不询价”续办是例外。完整业务规则及例外以 [Skill](skills/media-assistant/SKILL.md) 为准。

`file_bridge` 的 OSS 凭据按“插件配置 `fileBridgeOss` → 打包内置凭据”读取，不隐式读取宿主进程环境变量；内部测试或集成仍可显式注入环境变量。`region`/`bucket`/`objectPrefix` 未配置时回落到内置非敏感默认值；官方发布包由 prepack 脚本（`scripts/prepare-oss-bundle.mjs`）把本机 `.env` 的 `AccessKeyId`/`AccessKeySecret` 等注入包内（凭据文件被 gitignore，不进入仓库），凭据成功注入且权限、网络满足要求时，安装后无需额外配置即可上传；本机缺少凭据时 prepack 会警告并继续打包，此类包需配置上传凭据，不能宣称免配置可用。上传前强制校验：links 与补全文件必须都是 `.csv`，merged CSV 必须为合法 CSV 内容；links CSV 必须是当前 requirement 受控保存的产物，补全 CSV 必须来自当前 requirement 的 YP Action 原生补全工具，否则返回 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED` 且不上传。上传对象键固定为 `<Object 前缀>/<flow>/<requirement_id>/<sha256>.csv`，返回未签名 OSS 公网地址，并在交给下游前做匿名可读校验。

如需覆盖打包内置凭据，可在插件配置中填写：`fileBridgeOss.accessKeyId`、`fileBridgeOss.accessKeySecret`、`fileBridgeOss.region`、`fileBridgeOss.bucket`、`fileBridgeOss.objectPrefix`（官方发布包通常无需配置）。

## 当前组成

- `index.js`：注册 5 个本地工具与 5 个 Hook；远端 MCP 白名单由 `openclaw.plugin.json` 声明。
- `src/tools/parse-requirement.js`：调用固定需求解析 Workflow，`data.outputs` 只返回当前 Provider 契约消费的字段；解析标签合法时直接采用，缺失或 `null` 时省略。当前平台唯一且非占位的品牌候选直接采用；数值字段只有仍缺失、模糊或冲突时才询问。
- `src/tools/save-artifact.js`：单一入口受控保存 Provider 返回的 Excel 或 links CSV；`artifact_kind` 唯一决定格式，共用下载限制、重试、原子发布与幂等逻辑。`manual_source` / `manual_score_batch` 同名异内容采用需求与内容哈希回退名称保留两份文件，不覆盖原文件；推荐计数与早停由本地汇总工具负责。
- `src/tools/save-creator-links.js`：读取受控 links CSV 或机构预览 Excel，归一化为当前 requirement 的三列 links CSV。
- `src/tools/merge-creator-csv.js`：`file_bridge` 的内部合并实现，按 links CSV 原顺序合并多批原生达人补全结果；不是公开工具。
- `src/tools/file-bridge.js`：合并 links CSV 与补全 CSV；`mcn_complete_only` 或超过 500 行时仅本地交付，其余先做 CSV 格式与 YP Action 来源校验，再上传 OSS 并返回匿名可读的 `csv_file_path`。
- `src/hooks/register-flow-directives.js`：注入新 CSV 链路、需求澄清与数值格式锁、回收分叉和交付指令；`validate_requirement` 调用前执行规范化和完整预检。

手动拓展归一化后由本地汇总工具从真实候选中按顺序取最多三倍需求人数，每批最多 20 人；每批补全、上传、评分、保存后累计去重“推荐”人数，达标立即停止，否则继续到候选耗尽。最终表沿用 Provider 原模板，保留工作表名、标题、需求信息、列顺序、样式和全部已评分结果，不截断前 N 人。机构回收仍全量处理。来源登记在 Gateway 重置后失效时停止，不猜测恢复。

## 本地工具

- `ypscan_parse_requirement`
- `ypscan_save_artifact`
- `ypscan_save_creator_links`
- `file_bridge`
- `ypscan_summarize_manual_scores`

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run smoke
npm pack --dry-run --cache /tmp/ypscan-npm-cache
```

Smoke 断言本地工具为 5 个、Hook 为 5 个，并校验 package、manifest 和 lock 两处根包版本一致；远端 MCP 暴露 `score_manual_source_csv` / `score_manual_source_csv_status` 且不再暴露已移除工具（`rank_creators` 仍保留兼容白名单，不用于正式链路）。字段选择由远端 MCP 直接暴露；`before_tool_call` 仅做需求落库预检，不包含功能互斥或企微发送确认门禁。代码检查不等于模型或桌面交互验收。

`npm pack --dry-run` 也会触发 prepack，可能生成或删除凭据 bundle，只在需要打包核对时执行。安装包接收者可提取内置凭据；不入 Git 不等于分发安全，发布前需确认权限、有效期和分发范围。

## 开发资料

仓库维护者从 [项目开发 Wiki](docs/wiki/README.md) 进入，按 [同步矩阵与发布流程](docs/wiki/sync-and-release.md) 完成相关资料更新和四处版本核对；当前实现见 [Spec](docs/spec/README.md)，体验验收见 [Review Checklist](docs/review-checklist.md)。`docs/` 是仓库工程资料，不在插件发布包内。
