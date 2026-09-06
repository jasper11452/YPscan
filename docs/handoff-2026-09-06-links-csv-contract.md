# Handoff：links CSV 契约漂移与工具职责复盘（2026-09-06）

> 状态：**仅分析与方案建议，未改任何代码、SKILL 或测试**。本文档记录 2026-09-06 一次会话的完整分析结论，供后续改动立项时使用。
>
> 证据级别约定：标注「已核实」的来自仓库代码/文档；标注「trace」的来自用户提供的 2026-09-06 实况运行记录（test 环境）；标注「推断」的为基于以上证据的推理，落地前需再核实。

## 0. 结论摘要

1. `file_bridge` 要求 `creator_id` 不是冗余约束：它是 links CSV 与补全 CSV 合并的 join key、原生补全分批的入参来源、`score_manual_source_csv` 消费的 CSV 契约列。真正的问题不在 file_bridge，而在 Provider 的 links CSV 只产出 `url` 一列，与插件假设的三列结构（`source_record_id,creator_id,url`）冲突。
2. `ypscan_save_artifact` 与 `ypscan_save_creator_links` 的分工本身有理由（受控下载 vs 本地派生），但 links CSV 存在两个生产者、下载器对 CSV 内容零校验、命名撞车，是"调用混乱、责任不分"的真实来源。
3. 2026-09-06 的实况运行完整复现了上述隐患：url-only CSV 一路通过保存和两轮补全，在 `file_bridge` 才炸出 `YPSCAN_CREATOR_LINKS_CSV_INVALID`；Agent 靠询价回收链的 `ypscan_save_creator_links` 遗留 `rows` 模式手工救火，最后成功依赖 URL 格式恰好可机械提取 ID 的巧合，不是机制兜底。
4. 同一条 trace 里还有第二个独立缺陷：`manual_source_creators.demand` 传了未放宽的原文（预算 3000-20000），Agent 却把搜索参数未放宽归因给后台——按 SKILL，demand 本身必须携带已确认放宽值。
5. 改进方向已排序（见 §4）：保存时做 CSV 内容校验、让受控三列 links CSV 只有一个生产者、删除 `rows` 遗留输入、补行为回归用例、写死补全工具入参契约、放宽传导加 Hook 预检。最小方案待用户确认后实施。

## 1. 设计问题分析结论

### 1.1 为什么 file_bridge 需要 creator_id

creator_id 在链路中承担三个职责（已核实，见 `src/tools/merge-creator-csv.js`、`src/tools/file-bridge.js`）：

- **合并的 join key**：merge 用 links CSV 的 `creator_id` 去补全 CSV 中匹配详情。补全 CSV 的 ID 列候选为 `creator_id`/`请求kw_uid`/`kw_uid`/`xt_id`/`author_id`/`authorid`/`id`（`COMPLETION_ID_HEADER_CANDIDATES`）。links 侧没有该标识，补全详情（昵称、粉丝等）无处挂接。未匹配的行会被静默丢弃并记入 `missing_creator_ids`；全部未匹配时 `data_row_count=0` → `YPSCAN_FILE_BRIDGE_EMPTY`。
- **原生补全分批的入参**：file_bridge 之前，Agent 需按 20 个一批把 links CSV 中的 author 标识传给 `get_xhs_author_business_card`/`get_douyin_author_business_card`（两张工具卡均如此规定）。只有 url 列时该入参无法可靠提取。
- **打分契约列**：上传前 `mergedCsvContentProblems` 强制合并结果以 `source_record_id,creator_id,url` 开头，否则 `YPSCAN_FILE_BRIDGE_INVALID_CSV`；该格式是 `score_manual_source_csv` 的消费契约。

结论：如果 Provider 的 `creator_links_csv_url` 只有 url 列，冲突的是整条链路的假设，不是 file_bridge 单点。仓库内没有任何"从 url 反推 creator_id"的实现：预览 xlsx 路径的 `matchesHomepage`（`src/tools/read-creator-preview.js`）只做 URL↔ID 匹配校验，不推导。

### 1.2 为什么同时存在 save_artifact 和 save_creator_links

分工不同（已核实）：

| 工具 | 职责 | 网络 | 内容处理 |
| ---- | ---- | ---- | ---- |
| `ypscan_save_artifact` | 从受信 eshypdata.com URL 下载 Provider 产物（Excel/CSV），`artifact_kind` 唯一决定扩展名；20 MiB/20s 预算、sha256 幂等发布 | 是 | **零解析**，原样落盘 |
| `ypscan_save_creator_links` | 从受控预览 xlsx（sha256 注册校验）或遗留 `rows` 派生 `source_record_id,creator_id,url` CSV；ID/主页匹配校验、按 creator_id 去重 | 否 | 解析 xlsx/结构化行 |

实际用法（已核实，SKILL.md）：

- 手动拓展链：只用 `save_artifact(manual_creator_links)` 存 Provider 的 links CSV。
- 询价回收链：`save_artifact(mcn_creator_preview)` 下载预览 xlsx → `save_creator_links(preview_file_path)` 派生 links CSV，两者顺序配合。

真实混淆点（三个，均为边界设计问题）：

1. **links CSV 有两个生产者**：手动拓展链由 save_artifact 产出，询价回收链由 save_creator_links 产出。
2. **save_artifact 的 CSV kind 无内容校验**：非法结构（如 url-only）也能以"合法 links 来源"身份保存并登记。file_bridge 的来源门禁（`blockedUploadSources`）校验的是**路径登记**而非**内容**，内容只到 merge 才校验。
3. **命名撞车**：artifact_kind `manual_creator_links`/`mcn_creator_links` 与工具名 `ypscan_save_creator_links` 语义不同（"存 Provider 已产出的 CSV" vs "从 xlsx 派生 CSV"）。

### 1.3 入参长度与"最简系统"的讨论结论

- **入参过长风险基本不成立**：插件工具的入参模式是"传路径不传内容"。`file_bridge` 一次调用约几 KB；`save_creator_links` 现行主路径只有 3 个字段。历史长入参风险（`read` xlsx 后把全部 `rows` 内联传入）已在 1.0.3 用 `preview_file_path` 直读方案消除，`rows` 仅是遗留兼容。真正长入参在 Provider 侧（`validate_requirement` 需求载荷），属业务固有。
- **"最简系统"不可靠减工具数实现**：链路有四个不可消掉的阶段（下载 → 派生 links → 分批补全（允许部分成功、缺 csv_file 必须停）→ 合并上传（>500 行停、URL 不可读停）→ 打分），工具按阶段拆才有地方挂门禁和停点，Hook 也按工具结果注入阶段指令。合成"整链大工具"会失去观察点，工具少了系统反而不可控。
- **但职责边界确实需要收敛**：受控三列 links CSV 应只有一个生产者，两条链共用归一化；下载器只管 Excel，CSV kind 要么校验要么移交。详见 §4。

## 2. 实况 trace 复盘（2026-09-06，test 环境）

来源：用户提供的本次实况运行记录。requirement_id `fe065d67bebd479581d6cac427d97d79`，batch_id 515，目标 25 位小红书达人。

### 2.1 事件时间线

| 步骤 | 行为 | 结果 |
| ---- | ---- | ---- |
| 1 | `manual_source_creators` 提交（demand 含"预算：3000-20000"） | 返回 batch_id 515 |
| 2 | `manual_source_creators_status` 轮询 | 返回 25 条 links，`creator_links_csv_url` |
| 3 | `ypscan_save_artifact(manual_creator_links)` 保存 Provider CSV | 成功保存；**未发现 CSV 只有 url 列** |
| 4 | Agent 读取 CSV，提取 URL 中的 hex ID，按 20+5 两批调 `get_xhs_author_business_card`（`authors` 传的是**裸 URL**，宿主接受并解析） | 两批全部成功，拿到 2 个补全 CSV |
| 5 | `file_bridge(flow=manual_source)` | **失败：`YPSCAN_CREATOR_LINKS_CSV_INVALID`（links CSV 缺少 source_record_id、creator_id 或 url 列）** |
| 6 | Agent 反复 read/exec 确认 CSV 确实只有 url 列，犹豫"save_creator_links 是否机构回填专用"，最终用其遗留 `rows` 模式内联 25 行（creator_id 手工从 URL 提取） | 生成受控三列 links CSV（`mcn-links-*.csv`） |
| 7 | `file_bridge` 用派生 CSV 重试 | 成功：25/25 匹配，上传 OSS，返回 `csv_file_path` |
| 8 | `score_manual_source_csv` + 5 轮 status 轮询 | 25/25 打分完成 |
| 9 | `ypscan_save_artifact(manual_source)` 保存最终 Excel | 链路完成 |

### 2.2 根因链

1. **Provider 契约漂移（根因）**：links CSV 只有 `url` 一列，插件假设三列。trace 中 Agent 用 read 和 exec 两次确认过表头，证据充分（trace）。尚未做 live schema 级别的正式核实（见 §5 开放问题 1）。
2. **保存时零校验（放大器）**：save_artifact 的 CSV kind 原样落盘并登记为合法 links 来源，非法 CSV 带着错误身份通过 2 轮补全才在 merge 处爆炸。失败暴露点距问题产生点隔 3 个步骤。
3. **手动拓展链缺归一化步骤（混乱的直接来源）**：SKILL 假设 Provider 给三列，落空后没有正式工具可用。Agent 只能挪用询价回收链的工具（`rows` 模式还是 SKILL 标注的遗留输入），并因工具卡把它定位为"机构回填预览派生"而反复自我怀疑，多轮 read/exec/自问后才敢用。
4. **侥幸成功，非机制兜底**：`pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/<24位hex>` 恰好可机械提取 ID，且补全 CSV 恰好按同一 ID（kw_uid）join，25/25 全匹配。换成 xhslink 短链、其他 ID 体系、或补全 CSV 换键，本次即死锁；且补全已在 links CSV 修复前完成，若需要重跑补全会额外浪费批次。

### 2.3 附带发现（同一 trace 内，独立问题）

1. **放宽未传导（Agent 侧违规，推断待核）**：trace 中 `manual_source_creators.demand` 传的是"预算：3000-20000"（未放宽原文），随后 Agent 发现搜索实际参数 notePriceLower=3000/notePriceUpper=20000，并把原因归给后台。SKILL 明确规定：`manual_source_creators` 的实际搜索参数跟随调用时传入的 demand 文本，重跑搜索时 demand 必须传"应用了本轮全部已确认放宽值的有效搜索文本"，"只传原始文本等于没有放宽"。因此搜索用 3000-20000 与传入文本一致，属 Agent 未按规则改写 demand，而非后台未读落库值。前提（放宽 [2400,24000] 已确认且落库）来自 trace 中 Agent 的自述，落地前需核对放宽确认环节。
2. **OSS objectPrefix 疑似配置异常（推断）**：trace 中上传返回的 URL 为 `https://ypmisc.oss-cn-shanghai.aliyuncs.com/%E5%89%8D%E7%BC%80%20action/manual_source/...`，解码后前缀是"前缀 action"（含中文与空格），而插件内置默认值为 `action`。该值未阻断链路（打分只消费 URL），但说明该环境 `fileBridgeOss.objectPrefix` 配置可能被误填为"前缀 action"。落地前需核对环境配置。
3. **补全工具入参契约未写死（trace）**：`get_xhs_author_business_card` 的 `authors` 传裸 URL 被宿主接受并解析出 ID。工具卡只写"author 标识（按宿主实际 schema 传参）"，URL 还是 ID 未定死；宿主解析能力是隐式依赖，换 URL 形态（短链、带 query）可能静默失败。

## 3. 与既有文档的关系

- 本文档与 `docs/review-checklist.md` 中以下条目相关：`manual_source_creators_status` 终态 links CSV 保存与补全条目、"Agent 调 `ypscan_save_creator_links`（询价回收补全）"条目。若按 §4 改动落地，需同步更新这些条目。
- 与 `docs/spec/tools.md` 中 file_bridge/merge 的三列契约描述相关；改动后需同步 spec。
- 改进方向与项目 `AGENTS.md` 的迭代偏好一致：行为回归评测（#1）、契约对齐自动化（#2）、遗留清理（#5）。

## 4. 改进方向（按优先级，均待用户确认后实施）

1. **保存时做 CSV 内容校验**：`ypscan_save_artifact` 的 CSV kind 增加最小结构校验——必须含可解析出平台 ID 的 url 列或 creator_id 列，不合格立即报错（新增错误码）。错误暴露点从 file_bridge 提前到保存，补全不再基于非法 links 白白执行。
2. **受控三列 links CSV 唯一生产者**：手动拓展链在下载 Provider CSV 后固定走归一化步骤（从 url 按平台规则推导 creator_id、重写三列表头、去重）。入口建议放进 `ypscan_save_creator_links`（新增"接收 Provider CSV 文件路径/file_url"的输入形态），而不是新工具；工具卡从"机构回填专用"改为"两条链的受控 links CSV 唯一入口"。
3. **删除遗留面**：归一化入口上线后移除 `rows` 遗留输入（trace 中 25 行内联 JSON 恰好也是长入参风险的实证）与 `save_artifact` 的 CSV kind（`manual_creator_links`/`mcn_creator_links`），下载器回到"只管 Excel"；顺带评估遗留 kind `ranked_submission`/`creator_detail_export`。
4. **行为回归用例**：把本 trace 做成 benchmark/测试用例——"Provider links CSV 只有 url 列时，链路必须在保存/归一化步骤停下或自动修复"，并锁定各平台 URL→ID 推导规则；补全工具入参契约（URL vs ID）与宿主 YP Action 对齐后写死进工具卡。
5. **放宽传导加 Hook 预检**：`manual_source_creators.demand` 与已确认放宽值一致性在 `before_tool_call` 做预检，传未放宽原文时拦截，消除本次 trace 中第二类缺陷（当前该规则完全依赖 Agent 自觉）。
6. **改后同步**：SKILL.md、相关工具卡、Hook 路径登记逻辑、`docs/spec/tools.md`、`docs/review-checklist.md`、`openclaw.plugin.json` contracts 一并更新；`npm run lint && npm run typecheck && npm test && npm run smoke` 全绿。

## 5. 开放问题（落地前需核实）

1. Provider links CSV 的真实列结构：本次证据为 2026-09-06 trace 的两次读取（只有 url 列）。正式核实方式：用一次真实 `manual_source_creators_status` 结果检查表头，或用 `scripts/audit-provider-tools.mjs` 对照 live schema；同时确认 Provider 是否计划补 creator_id 列（决定归一化是插件侧推导还是临时兼容）。
2. 归一化入口放哪个工具：`save_creator_links` 新增输入形态（本方案倾向）vs save_artifact 内建 vs file_bridge 兼容。需要按"唯一生产者 + 最小改动"再定。
3. 各平台 URL→ID 推导规则清单：小红书 `pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/<id>`、`xiaohongshu.com/user/profile/<id>` 已见于代码/ trace；抖音星图路径已见于 `matchesHomepage`；xhslink 短链无法本地推导，需要明确策略（拒绝并报告 vs 请求 Provider 给长链）。
4. 补全工具入参契约：宿主 YP Action 的 `get_xhs_author_business_card`/`get_douyin_author_business_card` 接受 URL 还是 ID 需与宿主确认后写死。
5. trace 环境的 `fileBridgeOss.objectPrefix` 配置值"前缀 action"是否误填，需核对该部署的插件配置。

## 6. 相关代码与文档索引

- `src/tools/merge-creator-csv.js`：三列必选表头（`findRequiredHeaders`）、join 键（`detailsByCreatorId`）、补全 ID 列候选（`COMPLETION_ID_HEADER_CANDIDATES`）、未匹配行丢弃逻辑。
- `src/tools/file-bridge.js`：merged CSV 表头前缀校验（`mergedCsvContentProblems`）、来源门禁（`blockedUploadSources`，路径登记制）、>500 行跳过上传、匿名 URL 可读校验。
- `src/tools/save-artifact.js`：7 个 artifact_kind、下载约束（受信域名/20MiB/20s/禁重定向）、幂等发布；无 CSV 内容校验。
- `src/tools/save-creator-links.js`：`preview_file_path` 主路径与 `rows` 遗留路径、三列输出、按 creator_id 去重、`preserveSourceId` 差异。
- `src/tools/read-creator-preview.js`：`PLATFORM_HEADERS`、`matchesHomepage`（仅校验不推导）。
- `skills/media-assistant/SKILL.md`：手动拓展链假设（"拿到 links CSV 后…按 20 个一批…"）、放宽传导规则（demand 必须含放宽值）。
- `skills/media-assistant/references/tools/`：`manual_source_creators_status.md`、`ypscan_save_artifact.md`、`ypscan_save_creator_links.md`、`file_bridge.md`、`get_xhs_author_business_card.md`。
- `docs/review-checklist.md`、`docs/spec/tools.md`：需随改动同步的用户验收清单与契约 spec。
