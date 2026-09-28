# ypscan Spec 总览

> 本目录是 ypscan（悦普识星）的项目 Spec：描述系统当前形态、边界、契约与关键设计取舍。与代码同仓库、同提交维护，是评审与变更的参照，不是运行时指令或用户文档。
>
> 撰写基准：`feat/rank_creators` 分支工作区（v1.0.21，另含未提交的评分来源持久化改动），即 5 个本地工具 + 5 个 Hook 的 CSV 中心链路形态。此后代码变更应同步更新对应章节（见「维护约定」）。

## 一句话结论

ypscan 是 OpenClaw 客户端集成层插件：通过 Streamable HTTP 连接远端 Provider MCP（`https://mcp.eshypdata.com/mcp`），在本地注册 5 个工具与 5 个 Hook，把「询价机构」「手动拓展」和「只扒达人信息」三条业务链路固定为确定的步骤序列，并在 `validate_requirement` 写入前做本地完整性预检，通过单一 artifact 工具把 Excel/CSV 交付物受控保存到当前项目。

## 文档地图

工程资料导航、最小修复与文档同步流程见 [项目开发 Wiki](../wiki/README.md)；修改后按 [同步矩阵](../wiki/sync-and-release.md) 核对受影响章节。

| 文档                                 | 内容                                                     | 对应代码                                                    |
| ------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| [architecture.md](./architecture.md) | 组件地图、边界、数据流、设计取舍与风险                   | `index.js`、`openclaw.plugin.json`、`src/**`                |
| [tools.md](./tools.md)               | 5 个本地工具的接口契约（参数、返回、错误码、安全约束）   | `src/tools/*.js`                                            |
| [hooks.md](./hooks.md)               | 5 个 Hook 的行为契约与瞬态状态语义                       | `src/hooks/register-flow-directives.js`                     |
| [contracts.md](./contracts.md)       | 参数归一化、预检规则、平台/模式常量、Provider 工具白名单 | `src/contract/registry.js`、manifest `toolFilter`           |
| [flows.md](./flows.md)               | 三条固定业务链路、放宽、续办、回收与降级规则             | Hook 指令 + `skills/media-assistant/SKILL.md`               |
| [get_creator_detail_run.md](./get_creator_detail_run.md) | 「只扒达人信息」需求规格：数据库表、后端工具改动、插件侧改动 | 后端契约 + 工具卡/Hook                                       |
| [config.md](./config.md)             | 配置项、测试 adapter、运行与发布约束                     | `configSchema`、`src/tools/test-adapter.js`、`package.json` |

## 1. 背景与问题定义

### 当前现状

- Provider MCP 提供达人搜索、机构排名、询价发送、手动拓展、异步入库等后端能力，插件侧只做白名单接入（manifest `toolFilter` 暴露 15 个 Provider 工具）。
- 需求解析由固定 Dify Workflow 完成（`ypscan_parse_requirement` 直连代理，不落本地库）。
- 交付物（Excel、CSV）由 Provider 返回下载 URL，插件负责受控下载与本地保存。

### 痛点

直接让 Agent 自由编排上述工具不稳定，历史问题集中在：

1. **链路不固定**：跳步、重复调用、把中间产物当最终交付、跨功能复用 requirement。
2. **参数契约不表达**：Provider 的 `validate_requirement` schema 未写清类型与格式（历史审计结论），Agent 容易用错误类型来回试。
3. **证据缺失**：品牌、数量、截止时间、粉丝、返点、报价等业务值缺乏按业务模式区分的「来自用户原文或弹窗」硬门禁，容易编造或默认补值；当前代码已补充询价机构的严格证据校验，以及手动拓展缺少截止时间时明确标注、可覆盖的 30 天系统兼容默认，同时继续拒绝 `暂无品牌` / `无品牌` 等占位值。
4. **交付物不受控**：下载 URL 任意、覆盖已有文件、只给裸路径不给可点击链接。
5. **老链路残留**：`create_submission_batch`、`get_creator_detail`、`get_creator_detail_export` 等旧正式链路工具与新 CSV 链路并存，Agent 误用。

### 为什么是现在

Provider 侧已落地手动拓展 CSV 打分链路（`score_manual_source_csv` 消费 `file_bridge` 上传后的 `csv_file_path` 并经 `score_manual_source_csv_status` 轮询）；询价回收链同样以 `sync_mcn_inquiry_status → ingest → 预览 Excel → 派生 links CSV → 补全 → 打分` 落地，`get_workflow_state`/`rank_creators` 已废弃，是固化 Spec 的时点。

## 2. 目标与成功标准

### 主要目标

1. **链路固定**：三条业务链路每一步的下一步由 Hook 按真实工具结果动态给出（`*_ARGS` 指令），Agent 不被允许自由发散。
2. **写入前预检**：`validate_requirement` 在本地完成完整性、格式与证据校验，不通过则阻断，Provider 不收到写入。
3. **交付受控**：Excel/CSV 只从 `eshypdata.com` 主域 HTTPS 下载、禁止重定向、限量限时、原子发布、同内容幂等；Excel 结果始终附带可点击的 `local_file_link`，links CSV/补全 CSV/merged CSV 是内部中间产物，不主动向用户展示。
4. **CSV 中心链路**：手动拓展 links CSV → 归一化及汇总取得下一批 → 原生补全 → `file_bridge` 仅合并上传当前批 → 打分（`score_manual_source_csv_status` 轮询 job 终态）→ 保存单批表再汇总，推荐人数达标停止；询价回收链 links CSV 由 `ypscan_save_creator_links` 直接读取已受控保存的预览 Excel 派生，之后同样走原生补全 → `file_bridge(manual_source)` → 打分；超过 500 行时跳过上传并停止打分，merged CSV 不主动向用户展示。
5. **双功能独立建需**：每次真正开始询价机构或手动拓展都重新解析、复核并创建独立 requirement，禁止跨功能复用。

### 成功标准（可验证）

- `npm run smoke` 断言：本地工具 `tools=5`、Hook `hooks=5`、package、manifest 与 lock 两处根包版本一致、白名单含新链路工具且不含已弃用工具（见 `scripts/smoke-test.mjs`）。
- `npm run lint && npm run typecheck && npm test` 全绿（CI 同样执行）。
- 违反预检的 `validate_requirement` 调用被 `before_tool_call` 阻断（`YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED`），测试覆盖。
- `docs/review-checklist.md` 中与本形态相关的条目逐条成立。

## 3. 非目标（Non-goals）

- **不做 Provider 后端业务逻辑**：搜索、排序、打分、入库、企微发送匹配/去重/幂等全部由 Provider 负责；插件不预检发送内容，`before_tool_call` 只做 `validate_requirement` 预检，不含功能互斥或发送确认门禁。
- **不持久化 workflow 状态**：Hook 只保留会话内的瞬态路由映射（模式/平台/CSV URL/inquiry_ids/job_id→requirement_id），gateway 启停即清空，不落盘、不跨 run。
- **不暴露已弃用工具**：`create_submission_batch`、`get_creator_detail`、`get_creator_detail_export`、`get_selected_inquiry_form_fields` 不在 Provider 白名单。
- **不重新引入遗留 native Browser 手扒分支**：`manual-browser-*`、`manual-research*`、`select-cascade.js`、`set-filter-range.js` 等源文件与 `playwright-core` 依赖已在 1.0.31 删除；需要该能力时重新设计，不恢复旧实现、不加回依赖。
- **不替代业务权威文档**：运行时规则以 `skills/media-assistant/SKILL.md` 为准，本 Spec 只描述设计与契约。

## 4. 相关方与使用场景

| 相关方                     | 关注点                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| 最终用户（媒介执行）       | 用自然语言发起询价/手动拓展，看到可点击的本地交付物、被询问必要的业务澄清 |
| Agent（OpenClaw 模型）     | 按 Hook 指令执行固定链路，预检通过后落库，结果不足时先复核再放宽          |
| Provider 后端（eshypdata） | 消费规范化后的参数，负责搜索/排名/发送/入库与异步任务                     |
| 开发者/维护者              | 改动链路后同步工具卡、Hook、Spec 与 `review-checklist`，跑通验证清单      |
| CI/测试                    | 自动执行 lint/typecheck/test/smoke，断言注册形态与白名单                  |

## 5. 范围与边界

### In scope

- 插件注册形态：5 个本地工具、5 个 Hook、Provider MCP 白名单与超时配置。
- 参数归一化与 `validate_requirement` 预检（`src/contract/registry.js`）。
- Excel/CSV 受控保存、CSV 合并与上传校验。
- 固定链路指令注入与瞬态状态管理。
- 宿主 YP Action 原生达人补全工具（`get_xhs_author_business_card`/`get_douyin_author_business_card`）不在插件注册内；登录窗口、Cookie 与内部回调地址均由宿主工具内部处理，插件不干预。
- 配置项 `testMode` / `testAdapterBaseUrl` / `fileBridgeOss`，以及隔离测试 adapter 与 `file_bridge` 的安装级 OSS 上传配置。

### Out of scope

- Provider 侧 MCP 实现、Dify Workflow 内部逻辑、企微发送通道。
- 浏览器自动化手扒（遗留分支）。
- 权限模型、多租户、审计与线上监控告警（插件无独立日志/指标设施，可观测性依赖宿主）。

### 依赖与前提

- OpenClaw 宿主 `>=2026.7.1`（peerDependencies，optional），Node `>=22.22.2`。
- Provider MCP `https://mcp.eshypdata.com/mcp` 可达；Dify Workflow `https://dfi.eshypdata.com/v1/workflows/run` 可达。
- 宿主提供可信的 `workspaceDir`（绝对路径）作为交付物保存目录。

## 6. 验证与验收

- **CI**（`.github/workflows/ci.yml`）：`npm ci` → `lint` → `typecheck` → `test` → `smoke`。
- **Smoke**：版本同步、MCP 端点与 transport、白名单 include/exclude、工具参数枚举、`tools=5, hooks=5`、弃用工具未注册。
- **行为验收**：逐条核对 `docs/review-checklist.md`，按 [开发与验证](../wiki/development.md) 区分代码、模型和真实宿主层；当前 CI 不执行模型跑批或桌面验收。解析器代码回归见 `tests/requirement-parser.test.mjs`。
- **发布**：按 [同步与发布](../wiki/sync-and-release.md) 核对四处版本、CHANGELOG、发布包和安装结果；`npm pack --dry-run` 会触发 prepack，不是完全只读检查。

## 7. 风险与未决问题

| 风险/未决项                                        | 现状与影响                                                                                                                        | 决策归属                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 询价回收 links CSV 需本地派生      | Provider 只回预览 Excel，无 links CSV；`ypscan_save_creator_links` 从已保存预览的结构化达人标识受控派生并登记为合法来源 | 插件内部闭环；`file_bridge` 上传门禁已放行该来源             |
| OSS 对象需匿名可读                                 | OSS 上传成功后，若 Bucket 或账号策略阻断未签名访问，下游会拿不到 `csv_file_path`                                                  | `file_bridge` 先做匿名 `HEAD/GET` 校验；失败即停止下游调用 |
| 契约三处手工对齐                                   | 工具卡（`skills/media-assistant/references/tools/`）、Hook 指令、Provider MCP schema 靠人工保持一致，历史上反复出漂移 bug         | 维护者 + Provider；长期看 schema 校验/对齐自动化           |
| 瞬态状态生命周期                                   | `businessModeByScope` 等映射在 gateway 启停时清空；手动评分来源已按项目持久化并按需恢复                                               | 宿主行为确认                                               |
| 外部依赖可用性                                     | Dify 60s 超时、Provider 请求 330s 超时；两者不可用时链路暂停（`flowPauseDirective` 给重试/结束选项）                              | Provider/Dify 运维                                         |

## 8. 维护约定

- **版本绑定**：Spec 与代码同仓库同提交更新，不单独发版。
- **变更后同步**：按 [同步矩阵](../wiki/sync-and-release.md) 同任务更新受影响的 Skill/工具卡、Hook/契约、Spec、README、AGENTS、验收清单和测试；不适用项说明原因，不机械修改所有文档。只写可被代码或真实证据证实的内容，不确定处标为待确认。
- **不覆盖人工内容**：更新只触及受影响的章节，保留人工补充的背景与说明。
- **业务权威优先**：业务行为冲突时以 `skills/media-assistant/SKILL.md` 和用户最新要求为准，Spec 仅描述工程形态。
