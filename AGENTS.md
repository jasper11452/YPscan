# AGENTS.md — 悦普识星（ypscan）项目级工作指南

> 本文件只写本项目特有、agent 在此仓库工作必须知道的事实与约束。通用执行/修改/验证原则见全局 `~/.codex/AGENTS.md`。业务行为权威是 `skills/media-assistant/SKILL.md`；本文件与它冲突时，以 SKILL.md 和用户最新要求为准。

## 开发必读与完成标准

工程资料入口是 [项目开发 Wiki](docs/wiki/README.md)。修改前按任务读取 [开发与验证](docs/wiki/development.md) 和 [同步矩阵](docs/wiki/sync-and-release.md) 的相关部分；业务规则仍以 Skill 为准，Wiki 不复制另一套业务规范。

- **先定位层次**：取得“用户有效需求 → 工具参数 → 真实返回 → 模型下一步”的证据链，分清解析、参数、模型、宿主或 Provider 问题，不能把所有问题都修成提示词问题。
- **最小且有证据**：加规则前先找已有规则与冲突；不因 Hook 行数多就重构，不为假想需求增加状态机、缓存或门禁。一次验证一个可证伪因素，无效试探只撤销本次可分离改动。
- **行为验收不等于文本断言**：Hook 单元测试只证明指令生成。交互修复优先保留可重复样本，检查调用顺序、参数、停止位置与可见结论；分别报告代码、模型和真实宿主验证，不把未执行写成通过。
- **消融后再删减**：隔离环境对照基线、单项消融和最小候选修复；记录样本数与失败轨迹。无明显变化不等于可安全删除，须核对相邻路径；不得在真实业务中关闭安全控制做实验。
- **同步是完成条件**：每次按 Wiki 同步矩阵检查 Skill/工具卡、Hook/契约、Spec、README、AGENTS、验收清单和测试的受影响部分，同任务交付；未受影响的说明原因，不只改一份文档，也不机械改所有文档。
- **版本不能靠记忆**：发版必须同步三个文件的四个版本位置并更新 CHANGELOG，smoke 必须通过；不全局替换依赖版本、不自动升版或提交。
- **凭据分发需核查**：安装包接收者可提取内置 OSS 凭据，gitignore 不解决分发风险。核查权限、有效期和分发范围，未经授权不读取/打印密钥、不自行吊销或轮换。

## 这是什么

- `ypscan`（悦普识星）是 OpenClaw 插件（`id: ypscan`，`private: true`）：客户端集成层，注册 5 个本地工具，通过 Streamable HTTP 连接远端 Provider MCP（`https://mcp.eshypdata.com/mcp`）。
- 当前主线支持**三种业务模式**：`询价机构`、`手动拓展`（由 Provider 后端 `manual_source_creators` 完成）和 `只扒达人信息`（不建需求：`select_inquiry_form_fields` 无需求时传 `platform`+`creator_ids`/`creator_links` 返回 `field_id`，补全后 `excel_export` 导出达人表）。手动拓展固定链路为 `links CSV → 归一化 → ypscan_summarize_manual_scores → 当前批原生补全 → file_bridge 只上传当前批 → score_manual_source_csv → 保存 manual_score_batch → 再汇总`（梯度候选池 10 人→30、20 人→50、50 人→100、20/批，去重推荐人数达标或候选耗尽后交付最终汇总表）；机构回填固定 `sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job → 保存预览 → ypscan_save_creator_links → 原生补全 → file_bridge → score_manual_source_csv`；`mcn_rank` 仅保留兼容接入。每次真正开始任一新功能都重新解析、复核并创建独立的新 requirement；即使同会话需求未变、前一功能刚完成或明确停止，也不跨功能复用 requirement。当前机构列表后的“暂不询价”再续办仍属于原询价分支，不重建 requirement。
- 技术栈：Node.js `>=22.22.2`、ESM（`"type": "module"`）。**没有 TypeScript 源文件**，类型安全靠 JSDoc + `tsc --checkJs`。运行时依赖为 `ali-oss`、`read-excel-file`、`write-excel-file`、`fflate`、`xml2js`。

## 常用命令（仓库根执行）

- `npm test` — `node --test tests/*.test.mjs`，必须全绿。
- `npm run lint` — ESLint（flat config）。
- `npm run typecheck` — `tsc -p tsconfig.json`（checkJs），必须 0 错。
- `npm run smoke` — 加载插件断言注册形态：`tools=5, hooks=5`，遗留 browser 工具未注册，并校验 package、manifest、lock 顶层与 lock 根包四处版本一致。
- `npm run format:check` / `npm run format` — Prettier；`format` 会全量重排，只在明确要求时用。
- Provider 契约审计：`YPSCAN_PROVIDER_URL=<MCP 地址> node scripts/audit-provider-tools.mjs`（测试环境 `https://test-mcp.eshypdata.com/mcp` 是当前契约对齐基准，改链路前先对一遍 live schema）。

改完代码至少跑 `npm run lint && npm run typecheck && npm test && npm run smoke`。

## 架构地图（当前形态）

- `index.js` — 入口：注册 5 个本地工具 `ypscan_parse_requirement`、`ypscan_save_artifact`、`ypscan_save_creator_links`、`file_bridge`、`ypscan_summarize_manual_scores`；注册 5 个 Hook：`before_prompt_build`、`before_tool_call`、`tool_result_persist`、`gateway_start`、`gateway_stop`（后两个只重置瞬态状态）。
- `openclaw.plugin.json` — 清单：Provider MCP 白名单 15 个（含 `manual_source_creators`/`manual_source_creators_status`、`rank_mcns`、`select_inquiry_form_fields`/`get_inquiry_form_fields_status`、`score_manual_source_csv`/`score_manual_source_csv_status`、`excel_export`、`rank_creators`；不再暴露 `get_workflow_state`）、测试 adapter、`contracts.tools`、`skills`。`configSchema` 包含 `testMode`/`testAdapterBaseUrl` 与 `fileBridgeOss`；后者是 `file_bridge` 的安装级 OSS 上传配置，`testAdapterBaseUrl` 仅 `testMode=true` 时使用且必须是无凭据 loopback origin。
- `src/tools/` — 本地工具与辅助：
  - `parse-requirement.js` — 直连 Dify 的需求解析代理；`data.outputs` 只返回当前 Provider 契约消费的字段，缺失字段省略；八个 Dify Label 解析契约保持不变，`talentTypeLabel` 不是 Dify 字段。
  - `manual-score-summary.js` — 读取受控评分表，精确累计推荐人数，返回下一批或最终汇总 Excel；仅手动拓展使用。
  - `save-artifact.js` — 以单一工具受控保存 Provider 返回的 Excel 或 links CSV；`artifact_kind` 唯一决定格式，并产出可点击的本地文件链接。
  - `merge-creator-csv.js`、`file-bridge.js` — CSV 解析与 `file_bridge` 内部合并实现；`file_bridge` 按 flow 仅本地交付或读取 OSS 凭据（插件配置 → 打包内置；内部测试/集成可显式注入环境变量）上传到 `Object/<flow>/<requirement_id>/<sha256>.csv`，上传前校验 `.csv` 格式与 links/补全文件来源，并校验返回的未签名 OSS URL 可匿名读取。
  - `test-adapter.js`、`tool-result.js`、`popup-questions.js` — 测试下载、结果适配与统一弹窗载荷。
- `src/contract/registry.js` — 参数归一化、平台别名、`business_mode` 常量与 `validate_requirement` 预检。
- `src/hooks/register-flow-directives.js` — 注入三种业务模式链路（询价机构/手动拓展/只扒达人信息）、独立建需与交付指令；`before_tool_call` 只做 `validate_requirement` 预检，不做功能互斥或企微发送确认门禁。
- `skills/media-assistant/` — **业务行为权威**：`SKILL.md`（固定链路、复核、放宽顺序、Provider 幂等规则）+ `references/`（工具卡）。涉及达人/询价/手扒/提报的任务，首次相关操作前必须完整读一遍。宿主 YP Action 提供原生达人补全（`get_xhs_author_business_card`/`get_douyin_author_business_card`），不在插件白名单；登录窗口与 Cookie 由宿主工具内部处理。
- `docs/review-checklist.md` — 用户维护的验收清单；改业务链路后核对相关条目。
- `docs/wiki/` — 工程资料入口、开发验证方法、文档同步矩阵与发布流程；不重复业务 Skill。
- `tests/requirement-parser.test.mjs` — 当前仓库的解析器回归测试；历史评测记录只有实际存在时才可引用。

## 关键不变量

1. **SKILL.md 优先**：业务行为（模式判定、复核、放宽、交付）一律以 `skills/media-assistant/SKILL.md` 及其 references 为准，本文件只补充工程约束。
2. **双功能独立建需**：询价机构与手动拓展不得并行或在功能处理中切换；每次真正开始任一新功能都必须重新解析、复核并创建 requirement。即使同会话、同平台、业务条件未变且前一功能完成或明确停止，也不得跨功能复用 requirement；不得复用旧机构、达人、batch 或 Excel。例外仅限当前 `rank_mcns` 列表后的“暂不询价”续办：需求、平台未变且没有更新的功能或 requirement 时，继续原 requirement 和当前机构映射，不重新解析、落库、搜索或排名。只扒达人信息不建 requirement、不适用本不变量，其字段选择会话用 field_id（`get_creator_detail_run.run_id`）关联，不与 requirement 混用。
3. **复核先于放宽**：不足结果的触发条件、复核、逐项建议与确认、重新建需及禁止放宽项，统一按 SKILL 的“结果不足：先复核，再放宽”执行。手动拓展可信数量不足时可在交付当前真实 Excel 后提出放宽建议，须等待用户确认；机构回收不足只交付真实结果，不自动再询价。
4. **Provider 边界**：企微发送确认、机构名匹配、合并去重、同 requirement/机构幂等全部由 Provider 负责；插件不预检发送、不缓存发送状态、不暴露已弃用的查询工具。
5. **结果归属**：所有结果、链接、文件只用当前 requirement、当前平台、本轮真实 Provider 证据；不跨需求/平台/账号/历史 run 混用或补齐。
6. **数值与字段契约**：区间字段（`VALIDATE_REQUIREMENT_RANGE_PARAMS`）一律无空格字符串 `"[min,max]"` 且 `min < max`；单值字段（`VALIDATE_REQUIREMENT_SCALAR_PARAMS`：`interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`femaleRate`、`age1Rate`–`age6Rate`）在 Provider 侧按单值 float 读取，只传单个非负数值字符串，无法用单值表达时省略并保留原文，不把区间自行折算成单值；返点 `"[min,1]"`；抖音报价/CPM/CPE 只用 L2=植入、L3=定制；未知字段省略。粉丝数未明确或明确“不限/无要求”时，`followercount` 落库全量区间 `"[0,999999999]"`（零到最大值），不省略字段、不为此弹窗（原文出现“头部/肩部/腰部/尾部/行业头部”等量级描述时必须先询问具体区间）；历史坏值 `"[1,999999999]"` 同样归一为 `"[0,999999999]"`。已确认放宽值必须通过 `validate_requirement` 保存，由 Provider 从后台读取（`manual_source_creators` 传 `requirement_id`，live schema 将 `num` 列为 required 时附——`num` 为用户想要的达人数量、取 Hook 注入的 `MANUAL_SOURCE_NUM`，缺可信人数时先问清，任何环境人数都必填；不传 `demand`）并在搜索返回后核对实际搜索参数，不一致时如实报告未传导（差异仅限 Provider fallback 允许自动调整的内容召回字段时属于执行侧自动召回，不算未传导）；手动拓展确认放宽后，`ypscan_parse_requirement.demand` 与 `rawMessagesJson.original` 使用同一份应用全部已确认放宽的完整需求全文，`parse_outputs` 全量替换为本次重解析结果。
7. **上传边界**：`file_bridge` 只上传合法 CSV；links CSV 必须是当前 requirement 受控保存的产物（`manual_creator_links`/`mcn_creator_links`）、补全 CSV 必须来自当前 requirement 的 YP Action 原生补全工具返回的 `csv_file`，否则 `YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED` 且不上传。OSS 凭据按插件配置 → 打包内置读取，不隐式读取宿主环境变量；内部测试/集成可显式注入环境变量。真实 AK/SK 只由 prepack（`scripts/prepare-oss-bundle.mjs`）注入 gitignored bundle，不进入仓库、补丁或日志。
8. **分析 vs 修改**：默认只做分析评审，用户明确要求才改代码；改动最小化，不顺手重构或重排无关文件。
9. **不增多余机制**：不新增无必要的状态、缓存、账本、校验实体或权限门禁；共同逻辑保持共享。

手动拓展以平台、达人方向、人数为业务必填；三项齐全后首次建需前提供一次可选补充入口，具体交互及 Provider 必填兼容策略以 Skill 为准。品牌、报价未提供可省略；返点未提供默认 `rebate="[0,1]"`（最低 0%，不限制），截止时间未提供默认当前建需后 30 天并在 `description` 标明系统默认、可覆盖（`submissionDeadlineAt` 由插件独占：原文无截止语境时模型自填的时间与说明一律被覆盖）；两个默认值都不伪造用户条件，不写回原文或解析输出。已有有效条件保留，有值仍校验。询价机构规则不变。

## 迭代方向偏好（修改/评审时的建议导向）

本项目的价值在业务规矩的编码质量，不在代码量；做修改或 review 时，建议与结论优先往以下方向引导。这些只是建议偏好：不改变上面的最小改动、不增多余机制、默认只分析等约束，落地前仍需用户明确认可。

1. **行为回归评测（最高优先）**：SKILL.md 是 prompt 契约，模型或 Provider 变化可能让规矩静默失效。涉及业务链路的改动，优先建议在 `benchmarks/` 或 `tests/` 补行为回归用例（该问才问、复核先于放宽、放宽顺序、双功能独立建需），而不是只补单元断言。
2. **契约对齐自动化**：工具卡、Hook 预检、Provider MCP schema 三处手工对齐是反复出 bug 的根源（字符串化 JSON、未知字段、类型不符）。遇到契约漂移类问题，优先建议 schema 校验/对齐方向，而不是叠加手工修补。
3. **上下文按需注入**：Hook directive 持续瘦身；新增指令优先按流程阶段注入片段，避免整条链路每轮全量注入。
4. **数据回流**：涉及 rank/询价回收链路时，可提示"回收结果反哺排序"的数据回流机会（Provider 侧实现，仅作建议，不在插件内自建账本）。
5. **遗留清理**：发现遗留代码、worktree、`*.tgz` 被误用时，建议归档/清理方向，不重新启用。

## 常见坑

- **Provider MCP 可本地直连做快速实验**：YP Action 主进程在本机起 MCP 代理（streamable-http JSON-RPC，无需额外鉴权头），地址在 `~/Library/Application Support/YP Action/openclaw/state/openclaw.json` 的 `mcp.servers.test.url`（`http://127.0.0.1:<port>/mcp/<token>`，端口每次启动变化）。可直接调 `validate_requirement` → `manual_source_creators` → `manual_source_creators_status` 跑真实搜索，不必走 App Agent。注意：`manual_source_creators` 用需求的 `rawMessagesJson.original` 调 Dify 解析，搜索参数由该 demand 文本决定，不是需求的 `contentTag` 等字段。
- **npm `EPERM`（cache root-owned）**：本机 `~/.npm` 有 root 属主残留，用 `--cache /tmp/ypscan-npm-cache` 绕过，不要 `sudo chown`。
- **`*.tgz` 是发布产物**：已被 `.gitignore` 忽略，不要提交；发布用 `npm pack`（`files` 已裁剪），产物命名沿用 `ypscan-<version>.tgz`。
- **版本同步**：三个文件、四个位置必须一致：`package.json.version`、`openclaw.plugin.json.version`、`package-lock.json.version` 与 `package-lock.json.packages[""].version`；smoke 自动校验，任一漂移都会失败。
- **typecheck 靠 JSDoc**：新增解构参数/对象字面量时若 tsc 报 Property/excess property，先补 `@param` 类型，不要关 `checkJs`。
- **工程资料**：`docs/review-checklist.md` 是用户验收清单，勿擅自删除；文档入口只引用当前实际存在的路径，历史或待建评测不得写成现有能力。
- **`src/tools/file-bridge-oss-defaults.json` 是密钥载体**：由 `npm pack` 自动触发的 prepack 脚本生成、被 `.gitignore` 忽略，只随安装包发布，勿提交、勿在日志/补丁中打印其内容；本机没有凭据时 prepack 跳过注入并警告，打包仍继续。

## 发布/打包流程（用户要求发版时执行）

完整步骤以 [Wiki：同步与发布](docs/wiki/sync-and-release.md) 为工程流程入口：先同步受影响文档和 CHANGELOG，更新三个文件的四处版本，跑 lint/typecheck/test/smoke，再核对 dry-run、真实包与安装结果。`npm pack --dry-run` 也可能运行 prepack 并写入或删除凭据 bundle；不把它当完全只读检查。没有凭据的包不得宣称免配置可上传；未经用户要求不升版、不提交、不推送。

## 验证清单（改完必做）

1. `npm run lint` → 0 错
2. `npm run typecheck` → 0 错
3. `npm test` → 全绿
4. `npm run smoke` → `tools=5, hooks=5`
5. 涉及打包/发布：`npm pack --dry-run --cache /tmp/ypscan-npm-cache`，确认发布包只含 `files` 白名单内容（不含遗留 browser 工具与测试文件），确认 prepack 注入的 `src/tools/file-bridge-oss-defaults.json` 在 tgz 内且 git 中不含该文件，发布前核对版本同步。
6. 涉及业务链路：逐条核对 `docs/review-checklist.md` 中与本次改动相关的条目，并说明结论。
7. 所有修改：按 Wiki 同步矩阵复核相关资料和最终 diff；报告更新项、不适用项及原因、未验收范围。

字段配置按字段工具卡执行：同一会话新需求传 source_requirement_id 继承最近已提交/已配置的需求；用户主动重选才传 force_reselect=true。configured/copied 后直接继续；首次选择产生字段页 URL 时用 get_inquiry_form_fields_status 自动确认（预检 unavailable 后每 30 秒轮询、最多 8 次，submitted 续接；预检即 submitted、invalid、未知、失败、到上限或无法确认预检结果时等用户确认已提交），重选/继承场景不轮询；继承失败、平台不兼容或 live schema 不支持新参数时暂停。具体字段仅由 Provider 保存和复制。
