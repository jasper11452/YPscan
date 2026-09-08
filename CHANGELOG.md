# 更新日志

## 1.0.16 — 2026-09-08

- 原生达人补全前强制登录检查：每批调用 `get_xhs_author_business_card`/`get_douyin_author_business_card` 前，先调用对应平台的 `pgy_auth_prepare`/`douyin_auth_prepare`（参数固定 `{"action":"ensure"}`）；已登录直接复用，未登录由该工具打开专用登录窗口，只有用户明确要求重新登录或 Cookie 失效才用 `relogin`。宿主未开放登录准备工具时如实报告并停止补全链路，不自行打开登录页、不读 Cookie、不改用 Browser。
- Hook 在手动拓展 `manual_source_creators`/`manual_source_creators_status` 返回 links、`ypscan_save_creator_links` 归一化、`ypscan_summarize_manual_scores` 的 `complete_next_batch`、机构回填预览与发送成功等节点注入 `AUTH_PREPARE_TOOL`/`AUTH_PREPARE_ARGS`，并在启动指令声明该规则；SKILL 流程、两张新工具卡（`douyin_auth_prepare.md`/`pgy_auth_prepare.md`）与 Spec、验收清单同步。
- `validate_requirement` 本地预检修正：`rawMessagesJson` 结构不可读时，不再连带误报依赖它取证的 brandName/quantityTotal/rebate 等证据缺失，只报告可独立判断的缺失与格式问题。
- 验证：`lint`/`typecheck`/`test`/`smoke` 全绿。真实桌面 E2E 两轮（抖音、小红书手动拓展）：补全前均调用登录准备工具，抖音参数 `{"action":"ensure"}`、返回“已完成抖音星图登录，共获取 5 个接口 Cookie”，小红书返回“已复用现有小红书蒲公英登录态，共获取 14 个 Cookie”；交付表均通过 ypscan 真实消费方校验。
- 已知边界：小红书一轮 `pgy_auth_prepare` 省略了 `action`（宿主默认 ensure，行为一致）；宿主内置补全工具描述仍写着“Do not call pgy_auth_prepare first”，与插件规则相反，属宿主侧待同步项；Provider 报价上限未传导（确认 5000、实际检索 6000）为 Provider 侧问题，本轮未修。

## 1.0.15 — 2026-09-08

- 用户可见产物收敛：只展示评分表、汇总表、MCN 排名表和机构回填预览表；links CSV、补全 CSV、merged CSV 均为内部中间产物，不主动展示表格、下载链接或本地文件路径，也不作为交付物，用户明确索取或要求诊断时除外。
- 工具层同步：`ypscan_save_artifact` 的 `manual_creator_links`/`mcn_creator_links`、`ypscan_save_creator_links` 和 `file_bridge`（除遗留 `mcn_complete_only` 分支）返回 `display_required=false`，本地路径仍保留供下游使用；Hook 不再注入 CSV 展示链接令牌，改用 `CREATOR_LINKS_LOCAL_PATH` 等路径令牌，并保留评分表、汇总表、排名表和预览表的展示指令。
- 合并失败、超过 500 行或打分全失败时不再把内部 CSV 当降级交付物，只报告真实原因与行数；`mcn_complete_only` 因当前流程不可达且本地 merged CSV 是其唯一产物，保留展示。
- 验证：lint/typecheck/test/smoke 全绿，新增展示开关与 Hook 指令回归断言；模型行为与真实宿主展示（含宿主是否自行渲染原生补全附件）尚未验收。

## 1.0.14 — 2026-09-08

- 修复桌面 E2E 实测暴露的两个 Hook 缺陷：`manual_source_creators_status` 的 live 中间态（success + completed=false）不再误注入暂停弹窗指令，改按 BATCH_NOT_READY 继续轮询；原生补全全失败批次（csv_file=null）现在同样登记失败名单，汇总不再重排失败达人，同一达人重试成功后以成功记录取代旧失败。
- 手动拓展最终汇总表改为逐字节保留 Provider 单表模板：工作表名、标题、需求信息、分组表头、列宽、颜色、数字格式、冻结行和单元格类型原样保留，只更新“评分数量”、按综合得分重排全部评分行并同步 dimension/autoFilter；不再输出“推荐达人/已评分达人”双表，也不按推荐结论过滤或截断前 N 位。模板含公式、关联对象、数据区合并或多工作表等无法安全移动的内容时以 `YPSCAN_MANUAL_SCORE_TEMPLATE` 停止，不输出损坏表。新增 `xml2js` 依赖。
- 结果不足的放宽顺序调整为先替换同主题关键词、减少非核心人设限定（`kolPersonaLabel`），该阶段报价、CPM、CPE、粉丝范围、返点及其他条件保持原值；用户明确要求放宽时直接执行，未授权时先给方案等确认。仍不足且复核正确后，再按刊例价 → CPM → CPE → 粉丝范围 → 最低返点 → `contentFeatureLabel` → `contentThemeLabel` → `industryTagLabel` 逐项建议并等待该项确认。
- 已用两份真实 Provider 评分表离线合并并逐像素对比：模板样式、表头、列宽、冻结行、评分值与工作表名一致；未重新调用 Provider 评分，跨批评分尺度与一次性评分是否等价未验证。

## 1.0.13 — 2026-09-08

- 手动拓展增加本地评分汇总：最多三倍候选、20人/批，逐批补全/上传/评分，去重“推荐”人数达标或候选耗尽后交付汇总表；机构回收仍全量处理。新增 `ypscan_summarize_manual_scores` 和 `manual_score_batch`，本地注册改为5工具、5 Hook；未知结论或来源缺失时停止。
- 评分表同名不同内容按需求与内容哈希保留各批文件；新增 write-excel-file 生成最终两表 Excel。真实测试已验证同一测试需求两批独立任务与四条“不推荐”结果；足量早停由本地回归覆盖，模型与桌面行为尚未验收。

- 新增项目开发 Wiki，固化分层定位、最小修复、消融实验、模型行为验证、文档同步矩阵与发布步骤；AGENTS、README、Spec 和验收清单接入同一工程资料入口，并修正相关过时描述。
- smoke 增加 `package-lock.json` 顶层与根包版本校验，连同 package、manifest 共校验四处版本；新增隔离回归测试，覆盖版本漂移与 lock 根包记录缺失。
- 模型行为基线与 OSS 凭据权限核查仍为待执行事项，不代表已通过真实宿主或上传验收。

## 1.0.0 — 2026-09-01

- 首个正式版：双业务功能（询价机构 + 手动拓展）链路与 Provider 契约稳定收敛。相对 0.1.27 仅升版本号，无行为变更。

## 0.1.27 — 2026-09-01

- 询价收件机构恢复自定义机构名输入：用户可直接输入机构名称（含弹窗自定义输入）；命中本轮榜单且带非空 `supplier_id` 的走 `supplierIds`，未命中或无 ID 的原始名称保留到 `supplier_name` 交给 Provider；匹配仍只限本轮同一 requirement、同一平台，不模糊匹配、不跨轮复用。
- 收件机构选择弹窗统一 `multiSelect=true`，避免两选项场景被宿主当成确认弹窗而隐藏自定义输入入口；新增冲突拦截：`暂不询价` 不得与机构或 `询价全部机构` 同时成立，空输入、未明确机构、无法解析、冲突或歧义时不得继续询价。
- 手动拓展可信数量为 0 或不足时，交付当前 Excel 后进入与询价机构共享的“先复核、再逐项自动放宽”流程：每轮提前告知唯一修改项，重新解析、复核、创建新 requirement 并重新选择字段；全部允许项用完仍不足时询问“手动修改需求 / 改用询价机构 / 结束”。数量未知时不猜测、不解析 Excel、不自动放宽，当前 Excel 即最终结果；足量时在最终结果前汇总累计放宽条件。
- `create_submission_batch.submission_batche_page` 首次生成提报表固定传页码 `1`；明确不得用 `rank_creators.run_id`（即使为正整数）、达人数量、缺口、batch ID 等业务数字充当页码，只有用户之后明确要求第 N 页才传对应 N。
- 新增 Provider 侧 MCP 稳定性审计与 `get_workflow_state` 重构方案文档、Provider 工具契约审计脚本，并同步扩展流程与契约回归测试。

## 0.1.25 — 2026-08-31

- 手动拓展结果为 0 或低于目标数量时，仍交付真实 Excel，并明确数量与缺口、建议用户放宽条件。
- 仅依据 Provider 明确返回的可信数量判断不足，不解析 Excel 或猜测数量，也不自动放宽、重跑或复用旧 requirement。
- 每次开始询价机构或手动拓展都重新解析、复核并创建独立的新 requirement，不再跨功能复用 requirement 或字段配置。
- 收紧手动拓展和提报表 batch ID 的正整数与来源契约，缺失或非法时停止，避免使用其他 ID 顶替。
- 统一异步轮询、参考达人字段和同步手动拓展 Excel 保存规则，并补充契约回归测试。

## 0.1.24 — 2026-08-31

- 正式发布 0.1.24：询价机构与手动拓展双业务链路，业务条件不变时顺序复用同一需求。
- 企微发送前改用警示弹窗确认，`create_with_distributions` 的 `description` 与 `wechat_notification_message` 内容一致。
- Provider MCP 切换到 HTTP；小红书与抖音提报表均支持达人信息补全，导出轮询持续携带当前平台。

## 0.1.24-beta93 — 2026-08-31

- 支持询价机构与手动拓展双业务链路，并允许条件不变时顺序复用同一需求。
- 结果不足时先复核再按固定顺序放宽；完善手动拓展状态轮询与工具契约。
- 修复抖音提报表误触发小红书达人补全，补充弹窗载荷校验和相关回归测试。

## 0.1.24-beta90 — 2026-08-27

- 修复需求必填项缺失时未统一询问的问题，并将 `contentTag` 缺失明确为重新解析。
- 修复询价机构选择后未调用 `select_inquiry_form_fields` 的流程指令，补充确定的 requirement 参数。
- 候选机构超过 4 家时改用提示型弹窗，支持询价全部机构或按表格编号/完整名称自定义选择。
- 在 `validate_requirement` Provider 调用前增加未知字段和入参类型预检，并同步工具卡契约。
- 新增上述流程、类型和工具卡契约回归测试，发布包版本更新为 `0.1.24-beta90`。

## 0.1.24-beta89 — 2026-08-27

- 精简工具结果 Hook 中重复的流程说明，降低模型上下文占用；保留需求 ID、动态调用参数、保存顺序、轮询、发送确认和安全阻断规则。
- `get_workflow_state` 成功结果不再追加重复 directive；搜索结果中的表格链接仍禁止通过 Browser、脚本或其他方式下载，模糊机构候选仍必须使用 `AskUserQuestion`。
- 新增 Hook 精简与安全边界回归测试，发布包版本更新为 `0.1.24-beta89`。

## 0.1.24-beta88 — 2026-08-27

- 修复需求解析结果中的字符串化 JSON 被错误保留到落库边界的问题，统一兼容标签数组、品牌数组和 `dy_`/`xhs_` 数值对象。
- 新增回归测试，覆盖 `contentTag`、`*Label`、`dybrandName`、`dy_kolOfficialPrice`、`dy_cpm`、`dy_cpe` 的字符串化解析输入。
- 发布包版本更新为 `0.1.24-beta88`。

## 0.1.24-beta85 — 2026-08-25

- 统一抖音达人类型字段为 `xtTalentTypeLabel`，清理错误拼写。
- 小红书、抖音主达人类型解析为 `null` 时，先询问用户再进入需求校验。
