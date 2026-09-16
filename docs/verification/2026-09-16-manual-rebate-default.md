# 手动拓展返点默认值与下游参数核查

本记录核查手动拓展中“未提供返点”时的默认值；同日后续已在[手动拓展需求收集与截止时间兼容记录](./2026-09-16-manual-intake.md)中采用 30 天截止时间策略。两轮均未升版、打包或安装到宿主。

## 真实 Provider 试验

2026-09-16 经运行中的 YP Action 本地 MCP 委托代理（本轮端口 57308）调用 `validate_requirement`，未读取或打印委托凭据。代理上游部署版本未核实，不把本轮结果推广为所有环境的契约。

- 省略返点和截止时间：工具参数校验失败，两项均报 missing required。
- 两项传 null：`INVALID_PAYLOAD`，missing_fields 包含 rebate、submissionDeadlineAt。
- 仅传 8 个 required 字段：成功，`requirement_id=8493a50b54d1414593f44796c405b2b3`。省略品牌、粉丝、报价、CPM/CPE、可选标签并未阻止这次建需，不代表搜索、打分、导出均已验收。
- 使用本轮修改后的 `normalizeToolCallParams` 与 `validateRequirementPreflight`：原文没有返点，自动得到 `[0,1]`，预检返回 `[]`；随后真实调用成功，`requirement_id=ee50e300b2334864a701ead7e415826c`、`status=ready`，stored_fields 包含 rebate。原文没有补“返点不限”，解析输出和澄清也没有伪造默认值。
- `[0,1]` 表示最低 0%、最高 100%；不是最大值 0，也不是 `[0,0]`。未试传退化区间，因为它违反本地现有 min < max 契约。
- 两条成功需求均为明确标注的接口诊断记录，未搜索、选字段、补全、上传、打分或发送询价，也未删除测试记录。

原始本机记录：`/tmp/ypscan-live-proxy-probes-20260916.json`、`/tmp/ypscan-manual-default-rebate-20260916.json`。前一轮直接访问测试 Provider 的缺身份失败，不作为本轮成功证据。

## 下游用途及证据边界

必须区分“validate 顶层字段省略”与“完整需求文本没有该条件”。`manual_source_creators`、`score_manual_source_csv` 只接收需求 ID（评分另接收 CSV 地址），Provider 内部如何从存储字段构造工作流输入，当前仓库没有实现，不能凭客户端证明所有顶层字段均无用。

下表的工作流证据来自本仓库 2026-09-10 脱敏快照，未重新读取远端当前已发布版本；本地插件用途来自本轮源码。快照不是本轮端到端实跑。

| 字段/条件 | 后续使用位置 | 不填的影响判断 |
| --- | --- | --- |
| `rawMessagesJson.original`、有效澄清 | 手扒工作流以 demand 文本解析搜索条件；评分工作流以 demand 提取目标类型、内容、硬条件及偏好 | 核心需求来源，不能因省略顶层条件而删除原文中的有效要求；默认返点不写入原文 |
| `rawMessagesJson.business_mode` | Hook 分支与持久来源登记，汇总拒绝询价模式 | 不能省略或借用其他需求模式 |
| `parse_outputs` | 本地复核、标签展开、唯一数值与品牌取证 | 本地建需仍需要有效解析输出；不是独立手扒搜索工具入参 |
| `platform` | 字段配置、搜索平台、原生补全工具、CSV 身份校验、性价比指标选择 | 全链路必需 |
| `quantityTotal` | 候选池梯度、状态查询数量、首批人数、汇总推荐达标停止 | 全链路需要真实目标人数，不能默认成 1 |
| `brandName`、`product` | 本地品牌预检、需求语境；手扒快照明确禁止仅从品牌推断达人身份/行业/地域；评分读取需求文本与达人商业品牌证据 | 顶层 brandName 已实测可省略建需；不能保证 Provider 表头或输入拼接无依赖。原文也无品牌/产品背景时，相关性与竞品要求可能少了判断依据。本轮保留要求 |
| `kolOfficialPriceL1/L2/L3`、原文单价与合作形式 | 手扒快照提取图文/视频或植入/定制报价上下界；评分对原文明确硬价格条件做程序核验 | 原文没预算通常不产生预算筛选，可能搜到超出实际预算的达人；原文有预算而只省略顶层字段，仍可能从原文提取。不能把“可建需”当“报价无用” |
| `cpmL*`、`cpeL*`、粉丝及其他数值条件 | 手扒快照按明确指标映射平台搜索参数；评分按原文判断达人侧可核验条件 | 缺失一般意味着对应筛选缺少依据；不应编造。当前粉丝默认全量区间仍保留 |
| `rebate` | Provider 建需必填；手扒两平台快照 schema 没有返点筛选字段；评分快照明确将返点排除于达人硬条件和相关度档位 | 缺值阻止建需，默认 `[0,1]` 已实测可建需。快照支持“不以返点限制手扒”的判断；远端当前搜索/打分未实跑，不宣称全链路验证 |
| `submissionDeadlineAt`、项目起止日期 | 本地日期证据/未来时间校验，Provider 需求存储；评分快照将提报截止排除于达人条件 | Provider 仍强制出站截止字段；手动拓展完全没有截止语境时由插件默认建需后 30 天并标明可覆盖，用户已有日期/模糊/过期/冲突时仍澄清；不是手扒筛选字段不等于可删除。项目起止可选 |
| `contentTag`、八个解析 Label | 本地契约展开与存储；手扒 workflow 从 demand 重新提取关键词、类目、人设；评分从 demand 提取 target_tracks | 不能证明顶层标签直达手扒；原文主题/类型仍是搜索与评分核心。contentTag 当前仍必填，其余缺失可省略 |
| 地域、性别、互动/播放、粉丝画像等可选条件 | 手扒快照只对支持字段作平台映射，未提及/冲突字段省略；评分对原文明示的可核验条件取证 | 只传用户明确要求且映射唯一的条件；Provider 对所有扩展字段的实际消费未逐个实跑 |
| `hasOrganization`、`organization`、参考达人等可选字段 | 共用建需契约存储；手扒快照没有与所有共用字段一一对应的筛选项 | 当前无法证明所有共用字段在手扒链中均生效，不因 schema 有字段就承诺支持；本轮不改 |
| `projectName`、`status`、描述/Brief | 项目元信息；projectName 用于本地文件名，status 固定 ready；描述/Brief 保留语境 | 自动构造项无需用户重复确认；未知 Provider 导出依赖不猜测 |
| 达人实际报价、实际 CPM/CPE | `manual-score-summary.js:costEffectivenessScores` 从评分表达人数据计算性价比，再与相关度加权 | 与“用户给的预算字段”不同。省略需求预算不会让实际达人报价失去排序用途；本地性价比不读取需求 rebate |

证据文件：`src/contract/registry.js`、`src/hooks/register-flow-directives.js`、`src/tools/manual-score-summary.js`；`dify工作流/手扒达人（家常菜枚举修复-20260910）.json` 的 start、两平台提取 schema/提示词；`dify工作流/达人评分（远端草稿候选-20260910-脱敏）.json` 的 start、parse、score_json、review 节点。

## 修改与验证

- 共用归一化只在当前需求为手动拓展、原文/澄清无返点证据且解析无返点候选时，为空返点补 `[0,1]`。预检只豁免这个默认值的来源证据；询价与其他字段不放宽。
- 新回归先失败：预期 `[0,1]`，旧实现实际 undefined；修改后通过。覆盖两种手动模式名称、空值、显式/解析返点保留、歧义不覆盖、无依据非默认返点仍拦截、询价仍拦截，以及 Hook 真正出站序列化。
- lint、typecheck、smoke 通过；全量测试 632/632 通过，无跳过，smoke 为 tools=5、hooks=5；diff 空白检查通过。
- 额外检查 Prettier 时，registry 源码、Hook 源码和 flow-directives 测试在 HEAD 基线已有格式问题，未全量重排；本轮新增测试格式已修正。
- 已同步 Skill、解析/建需工具卡、Hook、contracts/flows/hooks Spec、AGENTS 与用户验收清单。README 注册/安装/流程骨架未变；manifest 出站字段/schema 未变；版本/CHANGELOG/发布物不涉及，不更新。
- 未进行模型多轮行为回归或桌面弹窗验收，未把源码安装至运行中 YP Action，不能声称现有应用已生效。验收清单新增条目保留未勾选。
