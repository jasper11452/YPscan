import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstString, isRecord, nonemptyString } from "../util/value.js";
import {
  BUSINESS_MODE_VALUES,
  MANUAL_DEFAULT_DEADLINE_DAYS,
  manualSourcePoolSize,
  normalizeBusinessMode,
  normalizeToolCallParams,
  resolveFlowToolName,
  VALIDATE_REQUIREMENT_RANGE_PARAMS,
  VALIDATE_REQUIREMENT_SCALAR_PARAMS,
  validateRequirementPreflight,
} from "../contract/registry.js";
import {
  browserVerificationQuestionPayload,
  businessModeQuestionPayload,
  flowRetryQuestionPayload,
  ingestJobRecoveryQuestionPayload,
  isPopupQuestionPayload,
  mcnCreatorCompletionQuestionPayload,
  mcnRankingRecipientQuestionPayload,
} from "../tools/popup-questions.js";
import { localFileMarkdownLink, safeNameSegment } from "../tools/save-artifact.js";
import { normalizeLocalFilePath } from "../tools/file-bridge.js";

const BUSINESS_SKILL_PATH = fileURLToPath(
  new URL("../../skills/media-assistant/SKILL.md", import.meta.url),
);

const HOOK_OPTIONS = { priority: 90, timeoutMs: 5000 };
const REQUIREMENT_PREFLIGHT_BLOCKED = "YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED";
const REQUIREMENT_RANGE_FORMAT = '无空格 JSON 区间字符串 "[min,max]"，且 min < max';
const MANUAL_SOURCE_ARGUMENT_RULE =
  "调用 manual_source_creators 传 requirement_id 和 num：num 为用户想要的达人数量（期望交付人数，正整数），直接使用 Hook 注入的 MANUAL_SOURCE_NUM，上下文没有可信目标人数时先用 AskUserQuestion 问清再提交，不得默认，也不得把 MANUAL_SOURCE_TARGET_NUM（状态查询的梯度取数数量）当需求人数；当前环境 live schema 将 num 列为 required 时 num 必传，schema 尚未包含 num 的环境只传 requirement_id（人数仍须确认，需求由 Provider 从后台读取）。不传 demand、解析输出或 rawMessagesJson。首次搜索及放宽重跑均传同一 num（放宽不改变交付目标人数），不通过添加原文字段重试。";
const SINGLE_REQUIREMENT_TYPE_RULE =
  "同平台多个达人类型只创建一个 requirement：保留用户给出的总量，合并全部类型标签与条件，不拆分子需求、不重复落库、不重复搜索；本规则覆盖任何旧的平均分配或批量子需求指令。";
const CLARIFICATION_REUSE_RULE =
  "同一会话内用户已确认的澄清答案（截止时间、粉丝量级、返点、报价等）持续有效：后续轮次和 requirement 重建必须原样带入 rawMessagesJson.clarifications 直接复用，同一字段新答案覆盖旧答案，禁止对同一字段重复询问；用户明确修改该字段且新值唯一时直接采用；只有新值仍有歧义或与新需求冲突时才重新澄清。等价时间表述（今晚8点前/今晚20:00/当天20:00:00）视为同一值，归一后不再重复确认。";
const MANUAL_EFFECTIVE_DEMAND_REPARSE_RULE =
  "手动拓展首次澄清改变当前平台的有效需求时，先把原始需求与全部最新有效答案合成为无冲突的完整需求全文，再用该全文重新调用 ypscan_parse_requirement；本次调用的 demand 与 rawMessagesJson.original 使用同一份全文，rawMessagesJson.parse_outputs 全量替换为本次结果，不拼接旧输出，并保留其他仍有效的 clarifications。若完整有效需求与最近一次成功解析的 demand 相同且解析结果有效，不得重复解析。询价机构放宽仍保留未改写原文，按 Skill 将累计放宽写入 clarifications 与本轮顶层参数，不套用手动拓展全文替换规则。";
const PARSED_METRIC_REUSE_RULE =
  "解析 Workflow 已给出的唯一且合法 followercount、rebate、报价、CPM 或 CPE 属于已解析数值，必须直接采用，禁止再问；原文精确单价与 Provider 检索区间只是表达格式不同，不得因此创建报价区间弹窗。粉丝技术上限溢出由本地截断到 999999999，不弹窗。用户未明确粉丝数或解析为“不限”时默认落库全量区间 [0,999999999]，不省略、不弹窗；历史坏值 [1,999999999] 归一为 [0,999999999]。解析器缺失或 null 不等于用户未提供；先核对当前原文与有效澄清，只有仍缺少必要值、多候选或存在冲突时才调用 AskUserQuestion。";
const REBATE_MINIMUM_QUESTION_RULE =
  '询价机构需要澄清返点时只问最低返点：AskUserQuestion 的问题写“最低返点要求是多少”，选项只给单个最低返点百分比（如 20%、25%、30%），禁止给返点区间、上限或“不限”类选项；上限固定按 100% 处理，落库仍为 "[min,1]"。手动拓展未提供返点按手动例外处理。';
const MANUAL_REBATE_DEFAULT_RULE =
  '手动拓展例外：原文、有效澄清及解析结果均未提供返点时，不询问返点，rebate 默认 "[0,1]"（最低0%，不限制）；不写回 original、demand、parse_outputs 或伪造澄清。已提供的有效返点继续采用，不覆盖明确要求；询价机构仍按原规则澄清。此例外优先于通用必填数值澄清规则。';
const MANUAL_DEFAULT_DEADLINE_RULE = `手动拓展例外：原文、有效澄清及解析结果均未提供截止时间时，不询问截止时间；在调用 validate_requirement 前用可见正文说明“未提供截止时间，将使用系统默认建需后 ${MANUAL_DEFAULT_DEADLINE_DAYS} 天，之后可补充具体时间覆盖”。插件将 submissionDeadlineAt 默认设置为当前建需时间后 ${MANUAL_DEFAULT_DEADLINE_DAYS} 天的未来绝对时间，并在 description 标明“系统默认、建需后 ${MANUAL_DEFAULT_DEADLINE_DAYS} 天、可覆盖”。这只是 Provider 兼容值，不写回 original、demand、parse_outputs 或伪造澄清；用户补充具体截止时间时优先采用并覆盖默认值。已有截止时间仍按原规则校验；询价机构不适用此例外。`;
const MANUAL_REQUIREMENT_INPUT_RULE =
  `手动拓展输入规则优先于通用必填澄清：只把平台、达人方向、目标人数作为业务必填；缺失时一次 AskUserQuestion 问齐。三项齐全后、首次建需前，按 Skill 提供一次“直接开始／补充条件”的可选条件入口，正文列出预算、粉丝范围、合作形式、地域、品牌/产品、CPM/CPE、粉丝画像、参考达人、排除条件和截止时间，未填不限或省略；截止时间未提供时由插件默认设置为建需后 ${MANUAL_DEFAULT_DEADLINE_DAYS} 天，并在 description 标明系统默认、可由具体时间覆盖，不因此追问。已选择直接开始、已完成补充或明确说按当前条件直接开始后不得重复提示，重解析/放宽重建不重问。品牌和报价缺失不追问、不造占位值或最大报价；有值仍按原契约校验，用户已写但含糊的预算/粉丝量级等仍需澄清。没有报价/CPM/CPE 档位条件时，不为抖音植入/定制单独追问。contentTag 由解析产生，缺失先重新解析，不让用户填写系统标签。`;
const NUMERIC_CLARIFICATION_QUESTION_RULE =
  "数值澄清正文须先解释原需求为何不能确定该值，再提示“请选择或自定义输入”：未提及则明确缺失字段；定性描述无法确定数值范围时必须说明。不得只写“确认报价/报价上限是多少”，不得展示“落库/Provider 参数”等内部术语。每题设置 multiSelect=false，提供恰好 3 个互斥且可直接回答该字段的具体值；禁用“1 个数值+返回修改/取消”的二按钮结构及自建“其他”选项，保留宿主自定义输入。需要澄清时用一次 AskUserQuestion 收集全部待确认字段，禁止逐字段分轮弹窗。";
const REQUIREMENT_COMPLETENESS_RULE =
  `进入 validate_requirement 前按业务模式检查完整性：询价机构必须检查 brandName、quantityTotal、submissionDeadlineAt、rebate、followercount 和至少一个当前平台支持且与内容形式匹配的报价档位；抖音仅使用 L2/L3 且必须匹配视频类型，小红书不使用 L3，缺失或有歧义一次性 AskUserQuestion 收集，禁止默认补值。手动拓展只把 platform、达人方向对应的 contentTag、quantityTotal 作为用户业务必填；brandName 和报价缺失时省略，submissionDeadlineAt 缺失按手动默认截止规则，rebate 缺失按手动返点规则，followercount 未明确或“不限”仍落库全量区间 [0,999999999]，不省略、不弹窗。所有已提供字段仍按格式、平台和证据校验；contentTag 必须是解析结果中的非空数组，缺失或无效时重新解析，禁止向用户询问或自行补值；本规则覆盖任何“contentTag 缺失时直接省略”的旧指令。status=ready、projectName 和 rawMessagesJson（当前原文+parse_outputs）由 Agent 构造。`;
const RAW_MESSAGES_JSON_KEY_CONTRACT =
  "rawMessagesJson key 与取值严格按 validate_requirement 工具卡 rawMessagesJson 契约执行，禁止写成 original_demand 或 demand；key 写错会被本地预检当成缺失原文阻断。";
const INQUIRY_RECIPIENT_RESPONSE_RULE =
  "机构选择仅在用户选中弹窗中的一个或多个当前机构、选择“询价全部机构”，或用户输入机构名称时成立。支持弹窗自定义输入和满足续办规则的后续消息。能解析为当前机构唯一编号或完整名称时复用当前机构映射；未命中当前机构或命中对象缺少 supplier_id 的原始名称，保留到 supplier_name 交给 Provider。弹窗换行只用于展示，匹配前移除换行还原机构名；选择“询价全部机构”表示选择全部当前机构；“暂不询价”不得与机构或“询价全部机构”同时成立。空输入、未明确机构、无法解析、冲突或存在歧义时，不得继续询价；重新调用本提示或结束本轮。";
const INQUIRY_RECIPIENT_RESUME_RULE =
  "当前 rank_mcns 列表后，若用户选择“暂不询价”、关闭/取消弹窗或当轮未回答，之后在同一会话明确要求给该列表机构发询价（包括“前 5 家”等可按当前排名唯一确定的表达），且期间未修改业务条件或平台、未开始其他功能、未创建更新的 requirement，属于恢复当前询价分支。继续使用该列表所属 requirement、平台和 rank_mcns 机构映射；不得重新调用 ypscan_parse_requirement、validate_requirement、search_creators 或 rank_mcns。已提交字段配置则复用，否则再调用 select_inquiry_form_fields。“暂不询价”只暂停发送，不算明确停止整个询价功能。";
const REQUIREMENT_CREATION_RULE =
  "每次真正开始新的询价机构或手动拓展都必须先创建独立的新 requirement：即使同一会话、同一平台、业务条件未变，或刚完成/停止另一功能，也必须重新调用 ypscan_parse_requirement、复核并调用 validate_requirement。不得跨功能复用 requirement；新 requirement 必须重新调用 select_inquiry_form_fields，按字段继承规则配置。三种业务模式（询价机构/手动拓展/只扒达人信息）不得并行执行，也不得复用旧机构、达人、batch 或 Excel。只扒达人信息不建 requirement、不碰任何已有 requirement：只用 select_inquiry_form_fields 返回的 field_id 关联本次字段选择，不与询价/手扒的 requirement、达人列表或 CSV 混用；用户明确给出的达人 ID 或链接是新业务输入，可以正常传入，不算复用旧达人。当前 rank_mcns 列表后的暂不发送再续办按询价恢复规则处理，不属于新功能开始。";
const FIELD_SELECTION_REUSE_RULE =
  "字段继承：同一会话新 requirement（含放宽、纠错和跨功能）调用 select_inquiry_form_fields 时，以 SELECT_INQUIRY_FORM_FIELDS_ARGS 为基础，追加 source_requirement_id，来源只取本会话最近一次用户已提交或 Provider 已返回 configured/copied 的真实 requirement；无来源时首次选字段。用户明确要求重新勾选才传 force_reselect=true 并省略来源。来源 ID 不得猜测或跨会话取用，不读取、缓存或传递 columns。继承和重选分别要求 live schema 支持对应新参数；不支持时说明接口未支持并暂停，不盲传、不退回重复勾选。继承失败、平台不兼容或 status=error 时暂停，不自动重选。";
const FIELD_SELECTION_GATE_RULE =
  "手动拓展的新 requirement 在调用 manual_source_creators 前必须先调用 select_inquiry_form_fields。success=true 且 status=configured/copied、requirement_id 与当前调用一致时直接按原分支继续，不等待用户确认；返回 selection_required、opened 或旧版有效 URL 时按该结果的字段状态轮询规则等待提交（见下方字段页指令），提交确认后才继续，禁止在同一轮试调 manual_source_creators、搜索或打分。";
const FIELD_PAGE_WAIT_RULE =
  "字段选择 URL 输出后本轮必须结束，不要求用户回复固定口令（需要用户回应时只说提交完成后告诉我），也不得试调下游工具；提交确认后的动作以下方恢复边界为准。";
// 字段状态工具按需求判定（unavailable / submitted / invalid），没有页面实例标识：
// 预检返回 submitted 时无法区分“本轮页面刚提交”与“需求此前已有配置”，只能按等待处理。
const FIELD_STATUS_POLL_RULE =
  "URL 输出后先做一次即时预检：用同一 requirement_id 调用 get_inquiry_form_fields_status。返回 unavailable 才开始轮询（每 30 秒查一次，累计最多 8 次；用一次 sleep 等待，禁止脚本循环调用该工具）；预检返回 submitted 只说明该需求此前已有字段配置、不能证明本轮已提交；invalid、未知状态或调用失败同样如此：立即停止并等待用户确认已提交（不要求固定口令）。轮询期间 submitted 视为本轮提交完成并按原分支恢复（仅限预检曾返回 unavailable；无法确认时按预检即 submitted 处理）；8 次仍为 unavailable 时停止并如实告知，等用户确认已提交后按原分支恢复。轮询期间不得调用任何下游工具，不得重开字段页、改写 URL、替用户选字段或更换 requirement_id。当前环境没有该工具时改回等待用户确认已提交。";
const FIELD_STATUS_NO_POLL_RULE =
  "本次字段页可能对应已有配置（force_reselect 或继承场景）：禁止调用 get_inquiry_form_fields_status 轮询，该状态按需求判定、会在用户提交前就返回 submitted，导致按旧配置提前继续。";
const FIELD_SELECTION_COLUMNS_RULE =
  "Provider 按 validate_requirement 返回的 requirement_id（缺失时兼容 data.id）持久化 columns；不得使用 demand_id、把 columns 放入上下文或调用已弃用的 get_selected_inquiry_form_fields。";
const FIELD_SELECTION_RESUME_RULE =
  "按原分支恢复：询价只使用用户明确选中的当前 MCN 或用户明确提供的机构名称；命中本轮榜单且有 supplier_id 的机构走 supplierIds，其他原名走 supplier_name，并做发送前警示弹窗确认；正常手动拓展只使用原 requirement_id 和当前环境 live schema 允许的参数；若本次字段选择由打分缺列错误触发，则只用同一 requirement_id 与本轮 file_bridge 返回的原始 csv_file_path 重提一次 score_manual_source_csv，不重搜、不重做原生补全、不重跑 file_bridge。";
const RELAXATION_REVIEW_COMPACT_RULE =
  "先复核各轮需求、解析、validate 和实际搜索参数；跨 requirement 的 keyword 差异仅是线索。优先替换同主题关键词、减少非核心人设限定；其他搜索条件保持原值，不扩大数值区间。用户明确要求放宽即执行；未授权时提出具体方案并等待确认。调整后仍不足且复核正确，再按 Skill 顺序提示其他可放宽条件；等待用户明确确认该项后才重跑，不自动改动。手动拓展放宽后整体替换 rawMessagesJson.original 为放宽后完整需求，同文重新解析，parse_outputs 全量更新；询价机构放宽仍保留未改写原文；已确认放宽值必须通过 validate_requirement 保存，由 Provider 从后台读取，搜索返回后核对实际参数与放宽值一致；fallback 允许字段的差异不算未传导。";
// 只在结果时刻注入（manual_source Excel 交付处）；启动块只保留精简的 SHORTFALL 规则。
const MANUAL_SOURCE_RELAXATION_RULE =
  "解释多轮结果差异时必须核对各轮完整有效需求、解析输出、validate_requirement 参数和 Provider 实际搜索参数；跨 requirement 的 keyword 差异只能作为线索，不能单独断言后台不稳定；Provider 未回传实际搜索参数时明确说无法确认根因，不猜测、不让用户替后台决定不可执行的搜索口径。放宽优先在原有搜索条件上替换同主题关键词、减少非核心人设限定（kolPersonaLabel）；这一阶段其他搜索条件保持原值，不扩大数值区间。用户明确要求放宽即执行；未授权时提出具体方案并等待确认。调整后仍不足且复核正确，再按 Skill 顺序提示其他可放宽条件，说明当前值、建议值和人数缺口；等待用户明确确认该项后才重跑，不自动改动。手动拓展确认放宽后，先应用本轮全部已确认放宽值，生成调整后的完整需求全文；整体替换 rawMessagesJson.original，并将同一全文传给 ypscan_parse_requirement.demand，复核后通过 validate_requirement 保存，由 Provider 从后台读取，禁止只追加调整说明或保留冲突的旧条件。rawMessagesJson.parse_outputs 全量替换为本次重解析结果，不拼接旧输出；累计放宽写入 rawMessagesJson.clarifications 对应字段并同步本轮 validate_requirement 顶层参数，其他有效澄清保留。重跑搜索时 manual_source_creators 传 requirement_id，live schema required num 时附同一 num（交付目标人数不变，仍取 MANUAL_SOURCE_NUM），由 Provider 从后台读取已保存的完整有效需求，搜索返回后核对实际搜索参数与放宽值一致，不一致时如实报告放宽未传导、不得宣称放宽成功。差异仅限 fallback 允许的内容召回字段（keyword/author_id、contentTag、personalTags、tag、tag_level_two）时属于 Provider 自动召回，不算未传导；提出人工放宽建议前先对照 parse_outputs.fallback，已覆盖动作不再重复建议。";

const SEARCH_PARAMETER_REVIEW_RULE =
  "先对照当前有效需求、解析输出、validate_requirement 参数和 Provider 实际搜索参数。恢复用户已确认条件不是放宽，不再请求确认；Agent 输入有误且能按原意纠正时，告知后按 Skill 纠正重建，仍遵守新 requirement 字段选择规则。提交参数正确但后台执行不一致时，如实报告参数未传导及当前工具能力限制，不承诺盲目重跑能修复、不让用户接受错误参数或代为排错。用户已明确修改并要求重搜时直接执行，沿用未修改的有效澄清，不再次确认同一值。搜索执行侧可能按需求已保存的 fallback 计划自动调整内容召回字段（keyword/author_id、contentTag、personalTags、tag、tag_level_two）；这类差异属于 Provider 自动召回，不算放宽未传导，不据此重建。";

const MANUAL_SOURCE_POLL_RULE =
  "这是异步轮询，不调用 AskUserQuestion、不重新提交 manual_source_creators，也不得猜测或更换 requirement_id 或 batch_id。任务提交成功后等待 30 秒再进行第 1 次查询，之后每隔 30 秒查询一次，单轮累计最多 10 次；第 10 次仍未完成时如实报告并停止，不得自动查询第 11 次";
const MANUAL_SOURCE_STATUS_NUM_RULE =
  "manual_source_creators_status 的 num 只在当前环境 live schema required 时才传，且取 Hook 给出的 MANUAL_SOURCE_TARGET_NUM 原值：按目标人数梯度取数（如 5 人→15、10 人→30、20 人→50、30 人→60、50 人→100，正整数）。括号内只是示例，不是档位表也不是穷举，表外人数同样由 Hook 按同一梯度算好并写入 MANUAL_SOURCE_TARGET_NUM，直接使用该值，不得再次乘倍数；最终交付目标和不足判断仍使用用户需求人数。schema 不接受 num 时不得附带，避免无效重试。";
const SCORE_MANUAL_SOURCE_POLL_RULE =
  "这是异步轮询，不调用 AskUserQuestion、不重新提交 score_manual_source_csv，也不得猜测或更换 job_id。任务提交成功后等待 30 秒再进行第 1 次查询，之后每隔 30 秒查询一次，单轮累计最多 10 次；第 10 次仍未完成时如实报告并停止，不得自动查询第 11 次";
const MANUAL_SOURCE_SHORTFALL_RULE = `本条数量策略仅用于旧链路直接返回的 manual_source Excel；分批评分必须通过 ypscan_summarize_manual_scores 统计推荐人数并决定下一步，不用处理成功数判断足量。只在当前 Provider 响应明确给出可信实际数量时与用户需求人数 quantityTotal 比较（梯度取数 num 不是交付目标），不得猜测数量，也不得通过 Bash、Python、Node、PowerShell 或其他临时脚本解析 Excel / xlsx 来补链路。数量未知时交付当前 Excel 并结束；达到目标数量时结束；实际数量为 0 或少于目标数量时，先交付当前 Excel 并说明实际数量、目标数量和缺口，再向用户建议可按 media-assistant Skill 的“结果不足：先复核，再放宽”顺序放宽的项，由用户决定是否放宽；不自动放宽、不自动重跑、不自动创建新 requirement。用户明确要求放宽后优先调整同主题关键词、减少非核心人设限定；调整后仍不足再按 Skill 提示其他条件并等待该项确认，随后重新解析、复核并创建独立的新 requirement，不得复用或合并不同轮次 requirement、batch 或 Excel。`;
const CREATOR_CSV_LIMIT = 500;
const MANUAL_SOURCE_FLOW = "manual_source";
// 可信来源登记按项目持久化：Gateway 重启后按需恢复，恢复后仍逐文件重校验 SHA-256。
const MANUAL_SCORE_SOURCES_FILE = "manual-score-sources.json";
const MANUAL_SCORE_SOURCES_VERSION = 1;
const MCN_COMPLETE_ONLY_FLOW = "mcn_complete_only";
const MCN_RANK_FLOW = "mcn_rank";
const CREATOR_DETAIL_FLOW = "creator_detail";

const [BUSINESS_MODE_INQUIRY, BUSINESS_MODE_MANUAL] = BUSINESS_MODE_VALUES;
const FAILED_ASYNC_STATUSES = new Set(["failed", "cancelled", "canceled", "error"]);
// Provider 继承成功实际返回 copied；configured 为旧契约状态名，两者都表示当前需求字段已配置。
const FIELD_SELECTION_CONFIGURED_STATUSES = new Set(["configured", "copied"]);
const REQUIREMENT_COLUMNS_ERROR_CODES = new Set([
  "REQUIREMENT_COLUMNS_NOT_CONFIGURED",
  "REQUIREMENT_COLUMNS_UNAVAILABLE",
]);
const PLATFORM_ALIASES = Object.freeze({
  xiaohongshu: "xiaohongshu",
  xhs: "xiaohongshu",
  小红书: "xiaohongshu",
  douyin: "douyin",
  dy: "douyin",
  抖音: "douyin",
});

function canonicalPlatformName(value) {
  if (!nonemptyString(value)) return null;
  return PLATFORM_ALIASES[value.trim().toLowerCase()] ?? null;
}

function firstCanonicalPlatform(...values) {
  for (const value of values) {
    const platform = canonicalPlatformName(value);
    if (platform) return platform;
  }
  return null;
}

function selectInquiryFormFieldsArgs(requirementId, platform) {
  return requirementId && platform ? { requirement_id: String(requirementId), platform } : null;
}

function rankMcnsArgs(requirementId, platform) {
  return requirementId && platform ? { id: String(requirementId), platform } : null;
}

function businessModeFromRawMessages(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return normalizeBusinessMode(isRecord(value) ? value.business_mode : undefined);
}

function businessModeFromParams(params) {
  return (
    normalizeBusinessMode(params?.business_mode) ??
    businessModeFromRawMessages(params?.rawMessagesJson)
  );
}

function paramsFromEvent(event) {
  if (isRecord(event?.params)) return event.params;
  if (isRecord(event?.arguments)) return event.arguments;
  if (isRecord(event?.input)) return event.input;
  return {};
}

function serializeProviderRawMessages(params) {
  if (!isRecord(params.rawMessagesJson)) return params;
  return { ...params, rawMessagesJson: JSON.stringify(params.rawMessagesJson) };
}

function messageText(message) {
  return messageTextParts(message).join("\n");
}

function messageTextParts(message) {
  if (typeof message === "string") return [message];
  if (!isRecord(message)) return [];
  if (typeof message.text === "string") return [message.text];
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text))
      .filter(nonemptyString);
  }
  return typeof message.content === "string" ? [message.content] : [];
}

function leadingJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function parsedToolResult(message) {
  const parts = messageTextParts(message)
    .map((part) => part.trim())
    .filter(Boolean);
  const texts = [...parts, parts.join("\n")];
  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch {
      // Prefer a complete JSON text block before extracting embedded JSON.
    }
  }
  for (const text of texts) {
    const json = leadingJson(text);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      // Continue to the next text block.
    }
  }
  return null;
}

function flowPauseDirective(stage, message) {
  const result = parsedToolResult(message);
  const code = nonemptyString(result?.error?.code) ? result.error.code : "结果未能继续";
  return [
    `YPSCAN_FLOW_DIRECTIVE=${stage} 已暂停（${code}）。使用下方 AskUserQuestion 选择重试或结束。`,
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(flowRetryQuestionPayload(stage))}`,
  ].join("\n");
}

function isUsableDifyValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const text = value.trim();
    return text !== "" && text.toLowerCase() !== "null";
  }
  if (Array.isArray(value)) return value.some((item) => isUsableDifyValue(item));
  if (typeof value === "object") {
    return Object.values(value).some((item) => isUsableDifyValue(item));
  }
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "boolean";
}

function classifyDifyOutputs(outputs) {
  /** @type {string[]} */
  const resolved = [];
  /** @type {string[]} */
  const missing = [];
  if (!isRecord(outputs)) {
    return {
      resolved,
      missing: ["brandName", "followercount", "rebate", "kolOfficialPrice", "cpm", "cpe"],
    };
  }
  const brandCandidates = [
    ...new Set(
      [outputs.brandName, outputs.dybrandName, outputs.xhsbrandName]
        .flatMap((source) => (Array.isArray(source) ? source : [source]))
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(
          (item) =>
            item &&
            !/^(?:null|undefined|未知|未明确|未提及|未提供|暂无|无|不详|待确认|待定)$/iu.test(item),
        ),
    ),
  ];
  if (brandCandidates.length === 1) resolved.push("brandName");
  else missing.push("brandName");
  for (const field of ["followercount", "rebate"]) {
    if (isUsableDifyValue(outputs[field])) resolved.push(field);
    else missing.push(field);
  }
  if (
    [
      outputs.kolOfficialPrice,
      outputs.kolOfficialPriceL1,
      outputs.kolOfficialPriceL2,
      outputs.kolOfficialPriceL3,
      outputs.dy_kolOfficialPrice,
      outputs.xhs_kolOfficialPrice,
    ].some(isUsableDifyValue)
  ) {
    resolved.push("kolOfficialPrice");
  } else missing.push("kolOfficialPrice");
  if (
    [
      outputs.cpm,
      outputs.cpmL1,
      outputs.cpmL2,
      outputs.cpmL3,
      outputs.dy_cpm,
      outputs.xhs_cpm,
    ].some(isUsableDifyValue)
  ) {
    resolved.push("cpm");
  } else missing.push("cpm");
  if (
    [
      outputs.cpe,
      outputs.cpeL1,
      outputs.cpeL2,
      outputs.cpeL3,
      outputs.dy_cpe,
      outputs.xhs_cpe,
    ].some(isUsableDifyValue)
  ) {
    resolved.push("cpe");
  } else missing.push("cpe");
  for (const field of [
    "growBloggerTypeLabel",
    "contentFeatureLabel",
    "contentThemeLabel",
    "kolPersonaLabel",
    "pgyBloggerTypeLabel",
    "xtTalentTypeLabel",
    "industryTagLabel",
    "growTalentTypeLabel",
    "contentTag",
  ]) {
    if (Array.isArray(outputs[field]) && outputs[field].length > 0) resolved.push(field);
  }
  return { resolved, missing };
}

function parseOutputsFromMessage(message) {
  const result = parsedToolResult(message);
  if (isRecord(result?.data?.outputs)) return result.data.outputs;
  if (isRecord(result?.outputs)) return result.outputs;
  return null;
}

function requirementParseSuccessDirective(message, params = {}, recordedMode = null) {
  const { resolved, missing } = classifyDifyOutputs(parseOutputsFromMessage(message));
  const mode = businessModeFromParams(params) ?? recordedMode;
  return [
    "YPSCAN_FLOW_DIRECTIVE=data.outputs 仅包含当前 Provider 契约消费的 Workflow 字段；先复核，不得直接调用 Browser。",
    "YPSCAN_NEXT_ACTION=REVIEW_REQUIREMENT",
    `DIFY_RESOLVED_FIELDS=${resolved.join(",")}`,
    `DIFY_MISSING_FIELDS=${missing.join(",")}`,
    "DIFY_MISSING_FIELDS 只表示解析器未输出，原文/澄清明确则不重问：25%以上→[0.25,1]；粉丝未明确→[0,999999999]。",
    ...(mode
      ? [
          `BUSINESS_MODE=${mode}`,
          "后续 validate_requirement 的 rawMessagesJson.business_mode 必须使用该值；整个流程保持该模式，不得再次询问。",
        ]
      : []),
    "唯一值直接采用；八个可选 Label 有则原样保留、无则省略；禁止整体传解析输出。",
    "YPSCAN_POLICY=按 media-assistant Skill 的“解析后、落库前必须复核”执行。",
    mode === BUSINESS_MODE_MANUAL
      ? MANUAL_REQUIREMENT_INPUT_RULE
      : "复核 brandName、quantityTotal、submissionDeadlineAt、rebate、followercount 和至少一个当前平台支持且与内容形式匹配的报价档位；抖音仅使用 L2/L3，小红书不使用 L3。缺失或有歧义按 Skill 一次性询问；contentTag 必须来自解析结果，contentTag 缺失时重新解析。",
    mode === BUSINESS_MODE_MANUAL
      ? MANUAL_DEFAULT_DEADLINE_RULE
      : "首次澄清前一次检查缺项和过期日期。截止时间由 Agent 对照当前完整有效需求和最新澄清复核；两者均无截止证据须询问，禁止用旧 requirement、默认值或推测。只有日期没有具体时刻必须澄清；不得默认 18:00、23:59:59 或其他时刻，不得宣称“无需补充澄清”。已有明确小时和分钟且未来时，秒省略时可补 00，不重复询问。两位年按20xx。只解析仍须指出缺失时刻，不得创建需求。",
    ...(mode === BUSINESS_MODE_MANUAL ? [MANUAL_EFFECTIVE_DEMAND_REPARSE_RULE] : []),
    mode === BUSINESS_MODE_MANUAL
      ? MANUAL_REBATE_DEFAULT_RULE
      : "确需澄清才问“最低返点要求是多少”；选项只给单个最低返点百分比，禁止给返点区间、上限或“不限”类选项。",
    RAW_MESSAGES_JSON_KEY_CONTRACT,
  ].join("\n");
}

function requirementPreflightBlockReason(issues) {
  const details = issues.map((issue) => `${issue.field}: ${issue.reason}`).join("；");
  const structureBlocked = issues.some((issue) => issue.field === "rawMessagesJson");
  return [
    REQUIREMENT_PREFLIGHT_BLOCKED,
    "validate_requirement 未执行，Provider 没有收到本次写入。",
    `一次性修正项：${details}`,
    ...(structureBlocked
      ? [
          "rawMessagesJson 是结构错误，只能靠修结构解决：用对象形式重发 original、parse_outputs 和 business_mode，保留全部已有业务值；不得仅因该结构错误弹窗或新增、改写 clarifications。一次性修正项另列其他字段时，仍按对应原因处理。",
        ]
      : []),
    `格式契约：数值区间字段（含 rebate、followercount、报价、CPM/CPE 等）使用${REQUIREMENT_RANGE_FORMAT}；返点固定为 "[min,1]"。以下字段在 Provider 侧是单值而非区间，只能传单个非负数值字符串，不能传区间、数组或百分号文本：${VALIDATE_REQUIREMENT_SCALAR_PARAMS.join("、")}；无法用单值表达时省略该字段，不得自行把区间折算成单值。`,
    "只允许对当前有效用户证据中的唯一明确值做确定性格式归一化。先检查当前对话是否已有该字段的有效弹窗答案：数值字段答案写回 rawMessagesJson.clarifications；同一字段新答案覆盖旧答案，不得再次询问。只有仍缺失、模糊、冲突、多候选或需要选择的业务值才调用 AskUserQuestion。八个可选 Label 有什么原样落库，null 或缺失就省略；contentTag 必须来自本次解析的非空数组，缺失时重新解析。所有标签都不做映射、不推断、不询问。不得自主补值或改变一种类型后继续盲试。",
    NUMERIC_CLARIFICATION_QUESTION_RULE,
  ].join("\n");
}

function requirementPreflightBlockedDirective(message) {
  const structureBlocked = messageText(message).includes("rawMessagesJson:");
  return [
    "YPSCAN_FLOW_DIRECTIVE=validate_requirement 已被本地预检阻断，Provider 未执行写入。一次处理工具错误列出的全部字段，不得把阻断说成 Provider 报错。",
    `REQUIREMENT_RANGE_FORMAT=${REQUIREMENT_RANGE_FORMAT}。禁止数组、对象、百分号文本或自然语言进入数值筛选字段；单值字段（${VALIDATE_REQUIREMENT_SCALAR_PARAMS.join("、")}）只接受单个非负数值字符串，传区间会被 Provider 拒绝。`,
    ...(structureBlocked
      ? [
          "rawMessagesJson 结构错误只靠重发对象形式修正：原样保留已有业务值，不得仅因该结构错误弹窗或新增、改写 clarifications；工具另列的其他字段仍按对应原因处理。",
        ]
      : []),
    "对工具明确列出的业务字段：先把当前对话中已经回答但漏传的值补回 rawMessagesJson.clarifications；同一字段已确认答案直接复用，不得重复询问；只对仍未回答、无效、冲突或需选择的字段在同一次 AskUserQuestion 中成组收集（最多四题）。八个可选 Label 缺失时省略；contentTag 缺失时重新解析，不向用户询问或自行补值。projectName 由 Agent 根据当前需求自行总结生成。禁止自主选择、默认补值或重试探测。",
    NUMERIC_CLARIFICATION_QUESTION_RULE,
  ].join("\n");
}

const MCN_MARKDOWN_TABLE_HEADER = [
  "| 排名 | 机构 | 覆盖达人 | 返点 | 综合分 |",
  "| --- | --- | --- | --- | --- |",
].join("\n");
const MCN_MARKDOWN_EMPTY_ROW = "| — | 暂无匹配机构 | — | — | — |";

const FIELD_SELECTION_AUTO_OPEN_FAILED = "浏览器打开请求未成功";

// 字段页链接是否已进入模型正文，Hook 无法观测：生成可轮询字段页时登记待展示链接，
// before_tool_call 对首次状态查询做一次性阻断，轮询指令再回带一次 URL。
const FIELD_PAGE_LINK_GATE_CODE = "YPSCAN_FIELD_PAGE_LINK_NOT_SHOWN";

function directiveFieldSelectionUrl(text) {
  const match = /(?:^|\n)FIELD_SELECTION_URL=(\S+)/u.exec(String(text ?? ""));
  return match ? match[1] : null;
}

function fieldPageLinkGateReason(url) {
  return [
    FIELD_PAGE_LINK_GATE_CODE,
    "get_inquiry_form_fields_status 未执行：字段页链接还没有出现在面向用户的正文里，用户无法选择字段。",
    `先在正文单独一行原样输出该链接并说明提交后继续，再重新调用本工具：${url}`,
    "不得改用 Browser 打开、不得包装成 Markdown 链接或省略该 URL。",
  ].join("\n");
}

function fieldPageLinkReminder(url) {
  return `字段页链接待展示：若面向用户的正文还没有单独输出过它，先单独一行原样输出 ${url} 再执行本指令其余部分；已输出过则不要重复。`;
}

function inquiryRecipientNames(mcns) {
  const seen = new Set();
  return mcns.flatMap((mcn) => {
    const name = firstString(
      mcn?.agency_name,
      mcn?.supplier_name,
      mcn?.mcn_name,
      mcn?.name,
    )?.trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [name];
  });
}

// field_id 来自 get_creator_detail_run.run_id（bigint），后端可能返回数字或字符串。
function idString(value) {
  if (nonemptyString(value)) return value.trim();
  return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

function fieldSelectionDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const status = firstString(result?.status, result?.data?.status);
  const requirementId = firstString(result?.requirement_id, result?.data?.requirement_id);
  const fieldId = idString(result?.field_id ?? result?.data?.field_id);
  const noRequirementCall =
    !nonemptyString(params?.requirement_id) &&
    (params?.creator_ids || params?.creator_links || fieldId);
  if (noRequirementCall) {
    return fieldSelectionWithoutRequirementDirective(message, result, status, fieldId);
  }
  if (status === "error") {
    return "YPSCAN_FLOW_DIRECTIVE=字段配置失败。说明 Provider 返回的错误原因并暂停，不自动重试、生成字段页或继续下游。";
  }
  if (FIELD_SELECTION_CONFIGURED_STATUSES.has(status)) {
    if (
      result?.success !== true ||
      !requirementId ||
      requirementId !== params?.requirement_id ||
      params?.force_reselect === true
    ) {
      return "YPSCAN_FLOW_DIRECTIVE=字段配置结果缺少成功证据、requirement_id 与当前调用不一致或强制重选未返回字段页。暂停，不把历史配置当作当前需求已配置，不继续下游。";
    }
    return [
      "YPSCAN_FLOW_DIRECTIVE=当前 requirement 字段已配置（existing 或 inherited；Provider 返回 copied 同样按已配置处理）。不展示字段页、不等待用户确认，直接按原分支恢复：手动拓展只用当前 requirement_id 调 manual_source_creators；询价仍先确认收件机构并执行发送前警示弹窗确认；若由打分缺列错误触发，只用此前 SCORE_MANUAL_SOURCE_CSV_ARGS 或同一 requirement 与本轮 file_bridge 原始可信 csv_file_path 重提一次打分，不重搜、不补全、不重跑 file_bridge。缺少可信路径时暂停。不得读取、缓存或传递 columns。",
      `FIELD_CONFIGURATION_REQUIREMENT_ID=${requirementId}`,
    ].join("\n");
  }
  const fieldPageStatus = status === "selection_required" || status === "opened";
  if (status && !fieldPageStatus) {
    return flowPauseDirective("字段选择返回未知状态", message);
  }
  if (params?.source_requirement_id && params?.force_reselect !== true) {
    return "YPSCAN_FLOW_DIRECTIVE=字段继承未返回 configured/copied，不能确认复制成功。说明接口结果并暂停，不展示字段页、不自动重新勾选、不继续下游。";
  }
  if (
    (fieldPageStatus && !requirementId) ||
    (requirementId && requirementId !== params?.requirement_id)
  ) {
    return "YPSCAN_FLOW_DIRECTIVE=字段页缺少目标需求 ID 或与当前调用不一致。暂停，不展示字段页、不继续下游。";
  }
  const autoOpenFailed =
    String(firstString(result?.message, result?.error?.message)).trim() ===
    FIELD_SELECTION_AUTO_OPEN_FAILED;
  const url = firstString(result?.url, result?.data?.url);
  const linkReady = result?.success === true || (result?.success === false && autoOpenFailed);
  if (!linkReady || !url) return flowPauseDirective("字段选择", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=字段选择链接已生成。正文必须单独一行原样输出该 URL；自动打开失败时页面没打开，要让用户自己打开，不得说“页面已打开”。不得改写、包装、用 Browser 替代打开或替用户选择字段；不要求用户回复固定口令，需要用户回应时只说提交完成后告诉我。",
    `FIELD_SELECTION_URL=${url}`,
    ...(params?.force_reselect === true
      ? [
          FIELD_PAGE_WAIT_RULE,
          FIELD_STATUS_NO_POLL_RULE,
          "重选提交后的恢复边界：单独重选只更新字段配置；已完成或明确停止的业务不得重启，不重新搜索、打分或发起询价确认。只有当前对话明确存在等待字段配置的未完成步骤，才按下述原分支规则恢复该步骤；无法确定时仅确认字段已更新，不调用下游。",
        ]
      : [FIELD_STATUS_POLL_RULE]),
    FIELD_SELECTION_COLUMNS_RULE,
    params?.force_reselect === true
      ? `用户确认已提交后只确认字段配置已更新，不调用任何下游工具；仅当本轮对话明确存在等待字段配置的未完成步骤时才${FIELD_SELECTION_RESUME_RULE}无法确定时到此结束。`
      : `用户确认已提交后${FIELD_SELECTION_RESUME_RULE}`,
  ].join("\n");
}

function fieldSelectionWithoutRequirementDirective(message, result, status, fieldId) {
  if (status === "error") {
    return "YPSCAN_FLOW_DIRECTIVE=只扒达人信息的字段选择失败。说明 Provider 返回的错误原因并暂停，不自动重试、生成字段页或继续下游。";
  }
  if (status !== "selection_required" && status !== "opened") {
    return flowPauseDirective("字段选择", message);
  }
  const url = firstString(result?.url, result?.data?.url);
  if (result?.success !== true || !fieldId || !url) {
    return "YPSCAN_FLOW_DIRECTIVE=只扒达人信息的字段选择缺少 field_id 或 URL。暂停，不展示字段页、不继续下游。";
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=只扒达人信息的字段选择链接已生成。正文必须单独一行原样输出该 URL 并说明这是字段选择页；不得改写、包装、用 Browser 替代打开或替用户选择字段。与需求维度不同：输出 URL 后本轮不结束，继续用平台原生工具补全这批达人，再 file_bridge(flow=creator_detail, field_id) 上传补全 CSV 得到 source_csv_file_link，然后调 excel_export(field_id, source_csv_file_link)；后端会查表校验字段是否已提交，未提交会返回「未选择字段」+URL，届时再展示 URL 等用户提交后重试。",
    `FIELD_SELECTION_FIELD_ID=${fieldId}`,
    `FIELD_SELECTION_URL=${url}`,
  ].join("\n");
}

function fieldStatusDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const status = firstString(result?.status, result?.data?.status);
  const requirementId = firstString(params?.requirement_id);
  if (status === "submitted") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=get_inquiry_form_fields_status 返回 submitted。若这是字段页 URL 输出后的首次预检，只说明该需求此前已有字段配置，不代表本轮页面已提交：不得恢复下游，停止轮询并等待用户确认已提交。只有预检曾返回 unavailable、之后轮询才返回 submitted 时，才视为本轮字段页提交完成，按原分支恢复；无法确认是否见过 unavailable 时，按首次预检处理（等用户确认已提交）。",
      FIELD_SELECTION_COLUMNS_RULE,
      `字段页提交完成时${FIELD_SELECTION_RESUME_RULE}`,
      "不得再次轮询该 requirement。",
    ].join("\n");
  }
  if (status === "unavailable") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=get_inquiry_form_fields_status 仍为 unavailable：本轮字段页尚未提交。先等待约 30 秒，再用同一 requirement_id 轮询；之后每 30 秒一次，累计最多 8 次；到上限仍未 submitted 时停止并如实告知，等用户确认已提交后继续。",
      ...(requirementId
        ? [`GET_INQUIRY_FORM_FIELDS_STATUS_ARGS=${JSON.stringify({ requirement_id: requirementId })}`]
        : []),
      "轮询期间不得调用 manual_source_creators、search_creators、rank_mcns、create_with_distributions、score_manual_source_csv 或 file_bridge，不得重开字段页、改写 URL 或更换 requirement_id。",
    ].join("\n");
  }
  return "YPSCAN_FLOW_DIRECTIVE=get_inquiry_form_fields_status 未返回可识别的终态。停止自动轮询，如实说明尚未确认提交并等待用户确认已提交；不得按已提交继续、不得重开字段页或更换 requirement_id。";
}

function excelExportDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const fieldId = idString(params?.field_id);
  if (result?.success === true) {
    const url = providerArtifactUrl(result, [
      "file_url",
      "excel_file_url",
      "excel_export_url",
      "download_url",
      "export_path",
      "excel_export_path",
      "url",
    ]);
    if (!url) return flowPauseDirective("excel_export", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=excel_export 成功，达人表已生成。把下载链接作为最终交付单独展示给用户；不展示 field_id，不把补全 CSV 或字段页 URL 当成交付物。",
      `EXCEL_EXPORT_FILE_URL=${url}`,
    ].join("\n");
  }
  const text = messageText(message);
  const code = firstString(result?.error?.code, result?.data?.error?.code);
  const columnsMissing =
    code === "EXCEL_EXPORT_COLUMNS_NOT_CONFIGURED" ||
    /未选择字段|尚未选择|没有选择字段/.test(text);
  if (columnsMissing) {
    const url = firstString(
      result?.url,
      result?.data?.url,
      result?.field_selection_url,
      result?.data?.field_selection_url,
      result?.error?.details?.url,
      result?.error?.url,
    );
    return [
      "YPSCAN_FLOW_DIRECTIVE=excel_export 因未选择字段失败（后端查表 columns 仍为空）。单独一行原样展示字段选择 URL，等用户提交字段后用同一 field_id 重试 excel_export；不得替用户选字段、不得跳过达人补全、不得重开字段选择。",
      ...(fieldId ? [`FIELD_SELECTION_FIELD_ID=${fieldId}`] : []),
      ...(url ? [`FIELD_SELECTION_URL=${url}`] : []),
    ].join("\n");
  }
  if (
    code === "EXCEL_EXPORT_SOURCE_CSV_INVALID" ||
    /source_csv_file_link.*(?:无效|invalid)|source_csv.*(?:无法|解析失败)/iu.test(text)
  ) {
    return "YPSCAN_FLOW_DIRECTIVE=excel_export 的 source_csv_file_link 无效。用 file_bridge 重新上传补全后的达人 CSV 得到新链接，再用同一 field_id 重试；不得复用旧链接、不得跳过补全或重新勾选字段。";
  }
  return flowPauseDirective("excel_export", message);
}

function providerArtifactUrl(result, nestedFields, rootFields = nestedFields) {
  return firstString(
    ...nestedFields.map((field) => result?.data?.[field]),
    ...nestedFields.map((field) => result?.data?.result?.[field]),
    ...rootFields.map((field) => result?.[field]),
  );
}

function rankMcnsExcelUrl(result) {
  return providerArtifactUrl(result, [
    "mcns_download_url",
    "mcns_export_path",
    "mcn_export_path",
    "rank_mcns_export_path",
    "excel_file_url",
    "excel_url",
  ]);
}

function rankMcnsDirective(
  message,
  params = {},
  recordedPlatform = null,
  requirementPlatform = null,
) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("rank_mcns", message);
  const mcns = result?.data?.mcns;
  if (!Array.isArray(mcns)) return flowPauseDirective("rank_mcns", message);
  const excelFileUrl = rankMcnsExcelUrl(result);
  const artifactId = firstString(params?.id, result?.data?.requirement_id, result?.requirement_id);
  const platform = firstCanonicalPlatform(
    params?.platform,
    result?.data?.platform,
    result?.platform,
    requirementPlatform,
    recordedPlatform,
  );
  const empty = mcns.length === 0;
  const recipientNames = inquiryRecipientNames(mcns);
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=rank_mcns 成功。当前已处于询价机构分支；先按原顺序输出完整 MCN Markdown 表格，作为用户可见正文文本块，再保存排名表并选择询价收件机构。",
    "MCN_OUTPUT_FORMAT_LOCK=只能是五列：排名、机构、覆盖达人、返点、综合分；字段映射固定：排名=rank_no（缺省按响应顺序）、机构=agency_name、覆盖达人=candidate_count、返点=rebate_rate、综合分=rank_score。禁止展示 supplier_id、其他字段、汇总或历史数据。",
    MCN_MARKDOWN_TABLE_HEADER,
    "机构名转 supplier ID 只允许使用本轮同一 requirement_id、同一平台的唯一精确匹配；命中非空 ID 只传 supplierIds，否则传原始名称 supplier_name。不得模糊匹配、跨轮复用。",
  ];
  if (empty) {
    return [
      ...lines,
      MCN_MARKDOWN_EMPTY_ROW,
      "YPSCAN_NEXT_ACTION=REVIEW_BEFORE_RELAXATION",
      "YPSCAN_POLICY=按 media-assistant Skill 的“结果不足：先复核，再放宽”执行。",
      "当前没有可选机构；不得保存空排名表、猜测机构、自动切换功能或未经复核就放宽。",
      RELAXATION_REVIEW_COMPACT_RULE,
    ].join("\n");
  }
  if (excelFileUrl && artifactId) {
    lines.push(
      "完整表格输出后立即使用下面参数保存；保存成功前不得展示本地路径、调用 AskUserQuestion 或展示 Provider 下载 URL。保存结果指令中的 ASK_USER_QUESTION_ARGS 就是收件机构选择弹窗，保存成功后逐字调用，不得重复弹窗。",
      `SAVE_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "mcn_ranking",
        artifact_id: String(artifactId),
        file_url: excelFileUrl,
        mcn_names: recipientNames,
      })}`,
    );
  } else if (artifactId && recipientNames.length > 0) {
    const selectArgs = selectInquiryFormFieldsArgs(artifactId, platform);
    if (!selectArgs) {
      lines.push(
        "当前结果缺少已确认的平台，无法安全生成 select_inquiry_form_fields 必填参数；如实说明并暂停，不得猜测 platform。",
      );
      return lines.join("\n");
    }
    lines.push(
      INQUIRY_RECIPIENT_RESUME_RULE,
      "无法保存 MCN 排名表；再调用 ASK_USER_QUESTION_ARGS 选择收件机构。收到机构选择答案后，同一 requirement_id 已提交字段配置则复用，否则调用 select_inquiry_form_fields（见下方 SELECT_INQUIRY_FORM_FIELDS_ARGS）；不得查询、缓存或重建 columns，不得按排名或指标自行选择。",
      `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify(selectArgs)}`,
      INQUIRY_RECIPIENT_RESPONSE_RULE,
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(mcnRankingRecipientQuestionPayload(recipientNames))}`,
    );
  } else {
    lines.push(
      "当前结果无法保存 MCN 排名表，也缺少进入收件机构选择的条件；表格后如实说明并结束本轮询价，不得猜测 requirement ID 或自动切换功能。",
    );
  }
  return lines.join("\n");
}

function searchCreatorsDirective(
  message,
  params = {},
  recordedPlatform = null,
  requirementPlatform = null,
) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    params?.id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  if (!requirementId) return flowPauseDirective("search_creators", message);
  const platform = firstCanonicalPlatform(
    result?.data?.platform,
    result?.platform,
    requirementPlatform,
    recordedPlatform,
  );
  const nextArgs = rankMcnsArgs(requirementId, platform);
  if (!nextArgs) return flowPauseDirective("search_creators 缺少 platform", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=search_creators 成功（包括 0 命中）。忽略 creators_export_path 等表格链接，不保存或展示，不得用 Browser、脚本或其他方式下载，也不调用保存工具；下一步使用同一 requirement ID 调用 rank_mcns。",
    `RANK_MCNS_ARGS=${JSON.stringify(nextArgs)}`,
  ].join("\n");
}

function providerExcelUrl(result) {
  return providerArtifactUrl(
    result,
    ["excel_file_url", "excel_url", "creators_export_path"],
    ["excel_file_url", "excel_url"],
  );
}

function providerCsvUrl(result) {
  return providerArtifactUrl(result, ["creator_links_csv_url", "csv_file_url"]);
}

function providerCsvFilePath(result) {
  return firstString(result?.data?.csv_file_path, result?.csv_file_path);
}

function providerScoredCount(result) {
  const value = result?.data?.scored_count ?? result?.scored_count;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function providerJobId(result) {
  const value = result?.data?.job_id ?? result?.job_id;
  if (nonemptyString(value)) return value.trim();
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requirementColumnsError(result) {
  // 逐字段检查全部嵌套位置，而不是取第一个非空值：外层通用任务错误可能包裹内层缺列原因。
  const candidates = [result?.error, result?.data?.error, result, result?.data].flatMap(
    (source) => [
      firstString(source?.code),
      firstString(source?.message),
      firstString(source?.error_code),
    ],
  );
  return candidates.some(
    (text) =>
      text != null &&
      (REQUIREMENT_COLUMNS_ERROR_CODES.has(text.toUpperCase()) ||
        /customer demand has no selected inquiry columns/iu.test(text)),
  );
}

function manualSourceBatchId(result) {
  for (const raw of [
    result?.batch_id,
    result?.data?.batch_id,
    result?.data?.manual_source_result?.data?.batch_id,
  ]) {
    const parsed = positiveInteger(raw);
    if (parsed != null) return parsed;
  }
  return undefined;
}

function positiveInteger(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (!nonemptyString(value) || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function manualSourceTargetNumLine(value) {
  const num = positiveInteger(value);
  return num == null ? null : `MANUAL_SOURCE_TARGET_NUM=${num}`;
}

function manualSourceNumDirectiveLine(value) {
  const num = positiveInteger(value);
  return num == null ? null : `MANUAL_SOURCE_NUM=${num}`;
}

function manualSourceCreatorsDirective(
  message,
  params = {},
  recordedPlatform = null,
  requirementPlatform = null,
  quantityTotalLookup = (_requirementId) => null,
) {
  const result = parsedToolResult(message);
  if (result?.success !== true) {
    if (requirementColumnsError(result)) {
      const requirementId = firstString(
        params?.requirement_id,
        result?.error?.details?.requirement_id,
        result?.data?.error?.details?.requirement_id,
      );
      const platform = firstCanonicalPlatform(requirementPlatform, recordedPlatform);
      const selectArgs = selectInquiryFormFieldsArgs(requirementId, platform);
      if (!requirementId) return flowPauseDirective("手动拓展字段选择", message);
      if (!selectArgs) return flowPauseDirective("手动拓展字段选择缺少 platform", message);
      const manualNumLine = manualSourceNumDirectiveLine(quantityTotalLookup(requirementId));
      return [
        "YPSCAN_FLOW_DIRECTIVE=manual_source_creators 缺少字段配置。用同一 requirement_id 调用 select_inquiry_form_fields，不得原参数重试。",
        `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify(selectArgs)}`,
        FIELD_SELECTION_REUSE_RULE,
        FIELD_SELECTION_GATE_RULE,
        "configured/copied 后直接继续；只有 URL 才展示并按字段状态轮询规则等待提交，随后用原 requirement_id 调用 manual_source_creators，live schema required num 时附同一 num（用户想要的达人数量，取 MANUAL_SOURCE_NUM）；不传 demand。",
        ...(manualNumLine ? [manualNumLine] : []),
      ].join("\n");
    }
    return flowPauseDirective("手动拓展", message);
  }
  const requirementId = firstString(
    result?.requirement_id,
    result?.data?.requirement_id,
    params?.requirement_id,
  );
  const creatorLinksCsvUrl = providerCsvUrl(result);
  if (creatorLinksCsvUrl && requirementId) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=manual_source_creators 已返回本轮手动拓展 links CSV。立即保存 links CSV（内部产物，不主动向用户展示）；保存成功后按保存结果指令调用 ypscan_save_creator_links 归一化为受控三列 links CSV，再按 20 个一批做原生达人补全，然后调用 file_bridge 合并并上传 OSS，最后调用 score_manual_source_csv。",
      `SAVE_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "manual_creator_links",
        artifact_id: requirementId,
        file_url: creatorLinksCsvUrl,
      })}`,
    ].join("\n");
  }
  const excelFileUrl = providerExcelUrl(result);
  if (excelFileUrl && requirementId) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=manual_source_creators 仅同步返回旧链路 Excel。立即保存且不展示 Provider 下载 URL；保存后按手动拓展结果策略决定结束或逐项建议放宽，不调用 manual_source_creators_status、rank_creators 或 create_submission_batch。",
      "YPSCAN_NEXT_ACTION=APPLY_MANUAL_SOURCE_RESULT_POLICY",
      MANUAL_SOURCE_SHORTFALL_RULE,
      MANUAL_SOURCE_RELAXATION_RULE,
      `SAVE_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "manual_source",
        artifact_id: requirementId,
        file_url: excelFileUrl,
      })}`,
    ].join("\n");
  }
  const batchId = manualSourceBatchId(result);
  if (batchId == null || !requirementId) return flowPauseDirective("手动拓展", message);
  const statusArgs = { requirement_id: requirementId, batch_id: batchId };
  const quantityTotal = quantityTotalLookup(requirementId);
  const targetNumLine = manualSourceTargetNumLine(
    quantityTotal == null ? null : manualSourcePoolSize(quantityTotal),
  );
  return [
    `YPSCAN_FLOW_DIRECTIVE=manual_source_creators 已提交后台任务（仅返回 batch_id）。先告知用户“后台手动拓展耗时较长，您可以先不用管，我会继续轮询。”，再按当前环境 live schema 使用 MANUAL_SOURCE_CREATORS_STATUS_ARGS 轮询；${MANUAL_SOURCE_STATUS_NUM_RULE}。${MANUAL_SOURCE_POLL_RULE}。`,
    ...(targetNumLine ? [targetNumLine] : []),
    `MANUAL_SOURCE_CREATORS_STATUS_ARGS=${JSON.stringify(statusArgs)}`,
  ].join("\n");
}

function manualSourceCreatorsStatusDirective(
  message,
  params = {},
  quantityTotalLookup = (_requirementId) => null,
) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    result?.requirement_id,
    result?.data?.requirement_id,
    params?.requirement_id,
  );
  const batchId = manualSourceBatchId(result) ?? manualSourceBatchId(params);
  const creatorLinksCsvUrl = providerCsvUrl(result);
  if (result?.success === true && creatorLinksCsvUrl) {
    if (!requirementId) return flowPauseDirective("手动拓展结果查询", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=manual_source_creators_status 已完成。优先消费当前 Provider 响应中的 creator_links_csv_url：立即保存 links CSV（内部产物，不主动向用户展示）；保存成功后按保存结果指令调用 ypscan_save_creator_links 归一化为受控三列 links CSV，再继续原生达人补全、调用 file_bridge 合并并上传 OSS，最后调用 score_manual_source_csv。",
      `SAVE_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "manual_creator_links",
        artifact_id: requirementId,
        file_url: creatorLinksCsvUrl,
      })}`,
    ].join("\n");
  }
  const excelFileUrl = providerExcelUrl(result);
  if (result?.success === true && excelFileUrl) {
    const artifactId = requirementId;
    if (!artifactId) return flowPauseDirective("手动拓展结果查询", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=manual_source_creators_status 已完成。该 Excel 是后台 API 搜索、详情抓取和筛选后的本轮真实手动拓展结果；立即保存且不展示 Provider 下载 URL，保存后按手动拓展结果策略决定结束或逐项建议放宽，不调用 rank_creators 或 create_submission_batch。",
      "YPSCAN_NEXT_ACTION=APPLY_MANUAL_SOURCE_RESULT_POLICY",
      MANUAL_SOURCE_SHORTFALL_RULE,
      MANUAL_SOURCE_RELAXATION_RULE,
      `SAVE_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "manual_source",
        artifact_id: artifactId,
        file_url: excelFileUrl,
      })}`,
    ].join("\n");
  }
  if (
    result?.success === true &&
    result?.data?.completed === true &&
    result?.data?.selected_count === 0 &&
    (result.data.success_count === undefined || result.data.success_count === 0)
  ) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=搜索已完成，实际数量为 0；没有可保存文件，不生成空表、不宣称已交付。停止轮询，不提供原参数重试/结束弹窗。",
      "YPSCAN_NEXT_ACTION=REVIEW_EMPTY_MANUAL_SOURCE_RESULT",
      SEARCH_PARAMETER_REVIEW_RULE,
      "只有参数复核正确后，才按 Skill 提出关键词替换和人设精简方案，说明当前值、建议值、目标数和缺口；首轮优先调整同主题关键词和非核心人设限定，保留其他搜索条件；调整后仍不足再提示其他可放宽条件并等待该项确认。用户已明确要求首轮放宽时直接按优先范围重建。",
      MANUAL_SOURCE_RELAXATION_RULE,
    ].join("\n");
  }
  if (
    result?.error?.code === "BATCH_NOT_READY" ||
    (result?.success === true && result?.data?.completed !== true)
  ) {
    if (batchId == null || !requirementId) return flowPauseDirective("手动拓展结果查询", message);
    const statusArgs = { requirement_id: requirementId, batch_id: batchId };
    // 从需求人数按梯度计算取数数量；缺少需求记录时沿用已发送的取数数量，不能重复计算。
    const quantityTotal = quantityTotalLookup(requirementId);
    const targetNumLine = manualSourceTargetNumLine(
      quantityTotal == null ? positiveInteger(params?.num) : manualSourcePoolSize(quantityTotal),
    );
    return [
      `YPSCAN_FLOW_DIRECTIVE=manual_source_creators_status 仍在处理中（BATCH_NOT_READY/status 0）。由当前对话累计查询次数；未到第 10 次时等待 30 秒后继续使用同一 ID 轮询；${MANUAL_SOURCE_STATUS_NUM_RULE}。${MANUAL_SOURCE_POLL_RULE}。`,
      ...(targetNumLine ? [targetNumLine] : []),
      `MANUAL_SOURCE_CREATORS_STATUS_ARGS=${JSON.stringify(statusArgs)}`,
    ].join("\n");
  }
  return flowPauseDirective("手动拓展结果查询", message);
}

function distributionDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) {
    const errors = [result?.error, ...(Array.isArray(result?.errors) ? result.errors : [])].filter(
      isRecord,
    );
    const hasError = (pattern) =>
      errors.some((error) => pattern.test(String(firstString(error?.message, error?.code) ?? "")));
    const lines = [
      "YPSCAN_FLOW_DIRECTIVE=create_with_distributions 返回失败或部分成功。原样展示 Provider 状态，不把部分成功说成全失败；已成功机构不得重新加入，禁止自动重发。模糊候选使用 AskUserQuestion 让用户选择，重复发送则停止。",
      "模糊候选经用户确认后，只传选中的 supplier ID，supplier_name 传 []。",
    ];
    if (
      hasError(
        /supplier_name and supplierIds cannot both be empty|supplierIds.*supplier_name.*empty/iu,
      )
    ) {
      lines.push("无收件机构：回到本轮真实 MCN 的机构选择，不能按排名自动选或重发空数组。");
    }
    if (hasError(/只有进行中的项目才能创建供应商分发/u))
      lines.push("项目非进行中：原样展示 Provider 错误并停止本轮发送处理，不调用旧状态工具。");
    return lines.join("\n");
  }
  const status = result?.data?.send_status;
  if (
    !isRecord(status) ||
    !Array.isArray(status.sent_suppliers) ||
    !Array.isArray(status.failed_suppliers) ||
    status.sent_suppliers.length + status.failed_suppliers.length === 0
  ) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=create_with_distributions success=true 但缺少逐机构发送状态；原样展示并标为未知，不询问后续或自动重发。",
    ].join("\n");
  }
  const sent = status.sent_suppliers;
  const failed = status.failed_suppliers;
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=create_with_distributions 已返回发送结果。先展示真实逐机构状态，部分成功不得说成全成功。",
    `企微发送摘要：成功 ${sent.length} 家，失败 ${failed.length} 家。`,
  ];
  if (failed.length > 0) {
    lines.push("原样展示失败原因和候选，不自动重发；候选确认后排除本次已成功机构。");
    return lines.join("\n");
  }
  lines.push(
    "全部机构发送成功。告知用户可随时回收在线表格；用户之后说“填好了”“已回收”或“生成表格”时，第一个工具是 sync_mcn_inquiry_status（requirement_id + project_id + supplierIds），再用其返回的 inquiry_ids 调用 ingest_mcn_submissions → get_ingest_job → 保存机构达人预览表 → ypscan_save_creator_links 读取预览并派生 links CSV → 原生补全 → file_bridge → score；不切换到手动拓展分支。",
  );
  return lines.join("\n");
}

// SKILL.md 契约字段是 csv_file；兼容响应里使用 csv_file_path 的形态。directive 与
// 上传来源登记共用同一解析链，保证两者登记的路径一致。
function completionCsvFilePath(result) {
  return firstString(
    result?.data?.csv_file,
    result?.csv_file,
    result?.data?.csv_file_path,
    result?.csv_file_path,
  );
}

// 原地图键：有 csv_file 用路径，全失败批次用失败名单。
function completionResultKey(record) {
  return (
    record?.file_path ??
    `no-csv:${JSON.stringify((record?.failed_author_ids ?? []).map((value) => String(value)))}`
  );
}

function serializableManualScoreSources(sources, platform, quantityTotal) {
  return {
    business_mode: sources.business_mode ?? null,
    platform: platform ?? null,
    quantity_total: quantityTotal ?? null,
    project_name: sources.project_name ?? null,
    source_conflict: sources.source_conflict === true,
    links_file: sources.links_file ?? null,
    completion_results: [...sources.completion_results.values()],
    score_files: [...sources.score_files.values()],
  };
}

function restoredManualScoreSources(record) {
  return {
    business_mode: record.business_mode,
    project_name: safeNameSegment(record.project_name),
    links_file: isRecord(record.links_file) ? record.links_file : null,
    completion_results: new Map(
      (Array.isArray(record.completion_results) ? record.completion_results : [])
        .filter((entry) => isRecord(entry))
        .map((entry) => [completionResultKey(entry), entry]),
    ),
    score_files: new Map(
      (Array.isArray(record.score_files) ? record.score_files : [])
        .filter(
          (entry) =>
            isRecord(entry) && nonemptyString(entry.file_path) && nonemptyString(entry.sha256),
        )
        .map((entry) => [entry.file_path, entry]),
    ),
    source_conflict: record.source_conflict === true,
  };
}

function completionAuthorIds(result, field) {
  return Array.isArray(result?.[field])
    ? result[field]
    : Array.isArray(result?.data?.[field])
      ? result.data[field]
      : undefined;
}

function manualSourceCompletionDirective(message, params = {}, recordedMode = null) {
  const result = parsedToolResult(message);
  // SKILL.md 契约只信任 csv_file、successful_author_ids、failed_author_ids，不要求
  // success 字段；宿主原生补全工具的成功返回没有 success，以 csv_file 是否存在判定。
  // 显式 success=false 仍按失败处理（保留旧错误语义）。
  if (result?.success === false) return flowPauseDirective("达人原生补全", message);
  const csvFilePath = completionCsvFilePath(result);
  const successfulAuthorIds = completionAuthorIds(result, "successful_author_ids") ?? [];
  const failedAuthorIds = completionAuthorIds(result, "failed_author_ids") ?? [];
  if (!csvFilePath) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=本批达人原生补全未生成 csv_file。停止后续合并、上传和打分，原样报告 failed_author_ids。",
      `FAILED_AUTHOR_IDS=${JSON.stringify(failedAuthorIds.map((value) => String(value)))}`,
    ].join("\n");
  }
  if (recordedMode === BUSINESS_MODE_MANUAL) {
    if (!params.requirement_id || !params.links_csv_path || !params.platform)
      return flowPauseDirective("当前批补全缺少可信需求或 links 来源", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=本批达人原生补全成功。立即只合并上传当前批 csv_file 并评分，评分结束前不补全下一批；部分成功保留当前 CSV，不重试整批。补全 CSV 是内部中间产物，不主动向用户展示表格或链接。missing_creator_ids 包含尚未处理者，不能当作补全失败名单。",
      `FILE_BRIDGE_ARGS=${JSON.stringify({ requirement_id: params.requirement_id, platform: params.platform, flow: MANUAL_SOURCE_FLOW, links_csv_path: params.links_csv_path, completion_csv_paths: [csvFilePath] })}`,
      `FAILED_AUTHOR_IDS=${JSON.stringify(failedAuthorIds)}`,
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=本批达人原生补全成功。记录本批 csv_file，汇总全部补全批次后调用一次 file_bridge（flow=manual_source）合并并上传，再调用 score_manual_source_csv 打分。补全 CSV 是内部中间产物，不主动向用户展示表格或链接；部分成功保留成功 CSV，不自动重试整批。",
    `COMPLETION_CSV_FILE=${csvFilePath}`,
    `SUCCESSFUL_AUTHOR_IDS=${JSON.stringify(successfulAuthorIds.map((value) => String(value)))}`,
    `FAILED_AUTHOR_IDS=${JSON.stringify(failedAuthorIds.map((value) => String(value)))}`,
    `FILE_BRIDGE_FLOW=${MANUAL_SOURCE_FLOW}`,
  ].join("\n");
}

function creatorLinksSaveDirective(message, params = {}, recordedMode = null) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("受控 links CSV 生成", message);
  const filePath = firstString(result?.data?.file_path, result?.delivery?.local_path);
  if (!filePath) return flowPauseDirective("受控 links CSV 生成", message);
  if (recordedMode === BUSINESS_MODE_MANUAL) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=手动拓展受控 links CSV 已生成（内部产物，不主动向用户展示）。立即调用 ypscan_summarize_manual_scores，使用其 next_author_ids 决定首批，不自行扩大候选池或提前补全全部达人。",
      `CREATOR_LINKS_LOCAL_PATH=${filePath}`,
      `SUMMARIZE_MANUAL_SCORES_ARGS=${JSON.stringify({ requirement_id: params.requirement_id })}`,
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=受控 links CSV 已生成并登记为当前 requirement 的合法 links 来源（内部产物，不主动向用户展示）。按 20/批把该 CSV 的 author 标识传给当前平台 YP Action 原生达人补全工具，再调用 file_bridge（flow=manual_source）→ score_manual_source_csv。",
    ...(result?.data?.preview?.excluded_row_count > 0
      ? [
          "部分机构回填行填写不正确，已排除错误行；按 preview.problems 提醒用户机构、原表行号及原因（机构名缺失时只报行号，不猜测）。正确行继续补全和生成评分表，不等待错误机构修正，不重跑整批；原始预览表保留。",
          `PREVIEW_ROW_WARNINGS=${JSON.stringify(result.data.preview.problems)}`,
        ]
      : []),
    `CREATOR_LINKS_LOCAL_PATH=${filePath}`,
  ].join("\n");
}

function fileBridgeDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const mergedCsvPath = firstString(
    result?.data?.file_path,
    result?.delivery?.local_file_path,
    result?.delivery?.local_path,
  );
  const localFileLink =
    firstString(result?.delivery?.local_file_link) ?? localFileMarkdownLink(mergedCsvPath);
  if (result?.success !== true) {
    return flowPauseDirective("file_bridge", message);
  }
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  const flow = firstString(params?.flow, result?.data?.flow, result?.flow);
  const dataRowCount = Number(result?.data?.data_row_count);
  const csvFilePath = providerCsvFilePath(result);
  if (!requirementId) return flowPauseDirective("file_bridge 缺少 requirement_id", message);
  if (!localFileLink) return flowPauseDirective("file_bridge 缺少本地 merged CSV", message);
  if (flow === MCN_COMPLETE_ONLY_FLOW) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=机构回填“只补全达人信息”分支已生成 merged CSV。原样展示本地链接并结束，不上传、不调用 rank_creators 或保存 Excel。",
      `MERGED_CSV_LOCAL_PATH=${mergedCsvPath}`,
      `MERGED_CSV_LOCAL_LINK=${localFileLink}`,
      `MERGED_DATA_ROW_COUNT=${Number.isFinite(dataRowCount) ? dataRowCount : "unknown"}`,
    ].join("\n");
  }
  if (flow === CREATOR_DETAIL_FLOW) {
    const fieldId = firstString(params?.field_id, result?.data?.field_id);
    if (!fieldId || !csvFilePath) {
      return flowPauseDirective("file_bridge 缺少 field_id 或 csv_file_path", message);
    }
    return [
      "YPSCAN_FLOW_DIRECTIVE=补全 CSV 已合并上传。不要复述 csv_file_path、OSS 地址、对象路径或下方工具参数；用同一 field_id 原样调 excel_export 导出达人表。",
      `EXCEL_EXPORT_ARGS=${JSON.stringify({
        field_id: fieldId,
        source_csv_file_link: csvFilePath,
      })}`,
    ].join("\n");
  }
  if (Number.isFinite(dataRowCount) && dataRowCount > CREATOR_CSV_LIMIT) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=merged CSV 数据行超过 ${CREATOR_CSV_LIMIT}，file_bridge 已跳过上传。如实报告行数并停止后续打分或精排；merged CSV 是内部中间产物，不主动向用户展示。`,
      `MERGED_CSV_LOCAL_PATH=${mergedCsvPath}`,
      `MERGED_DATA_ROW_COUNT=${dataRowCount}`,
    ].join("\n");
  }
  if (flow !== MANUAL_SOURCE_FLOW && flow !== MCN_RANK_FLOW) {
    return flowPauseDirective("file_bridge 缺少 flow", message);
  }
  if (!csvFilePath) return flowPauseDirective("file_bridge 缺少 csv_file_path", message);
  if (flow === MANUAL_SOURCE_FLOW) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=数据已合并上传。面向用户只说“数据已合并上传，正在启动打分。”，不要复述 csv_file_path、OSS 地址（含省略或截断形式）、对象路径或下方工具参数。SCORE_MANUAL_SOURCE_CSV_ARGS 仅供内部调用，原样传给 score_manual_source_csv；merged CSV 是内部中间产物，不主动向用户展示。成功后按其指令保存评分 Excel，手动拓展的单批表仍须汇总决定下一步。",
      `SCORE_MANUAL_SOURCE_CSV_ARGS=${JSON.stringify({
        requirement_id: requirementId,
        csv_file_path: csvFilePath,
      })}`,
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=数据已合并上传。面向用户不要复述 csv_file_path、OSS 地址（含省略或截断形式）、对象路径或下方工具参数。merged CSV 是内部中间产物，不主动向用户展示；该结果只用于当前环境 live rank_creators schema 已明确支持 csv_file_path 的机构精排兼容分支；当前测试 Provider 仍默认保留 rank_creators(requirement_id,inquiry_ids) 旧链路（inquiry_ids 来自本轮 sync）。",
    `RANK_CREATORS_ARGS=${JSON.stringify({
      requirement_id: requirementId,
      csv_file_path: csvFilePath,
    })}`,
  ].join("\n");
}

function scoreColumnsRecoveryDirective(
  message,
  params = {},
  recordedPlatform = null,
  requirementPlatform = null,
) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
    result?.error?.details?.requirement_id,
    result?.data?.error?.details?.requirement_id,
  );
  const platform = firstCanonicalPlatform(requirementPlatform, recordedPlatform);
  const selectArgs = selectInquiryFormFieldsArgs(requirementId, platform);
  if (!requirementId) return flowPauseDirective("达人打分缺少字段配置", message);
  if (!selectArgs) return flowPauseDirective("达人打分字段选择缺少 platform", message);
  const csvFilePath = firstString(params?.csv_file_path);
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=达人打分因当前 requirement 缺少已提交字段配置而停止。立即用同一 requirement_id 调用 select_inquiry_form_fields，不得把失败 job 的 success_count 当成最终成功，也不得重新搜索、补全或调用 file_bridge。",
    `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify(selectArgs)}`,
    FIELD_SELECTION_REUSE_RULE,
  ];
  if (csvFilePath) {
    lines.push(
      `SCORE_MANUAL_SOURCE_CSV_ARGS=${JSON.stringify({ requirement_id: requirementId, csv_file_path: csvFilePath })}`,
      "字段工具返回 configured/copied 后立即恢复；只有返回 URL 时才原样展示字段选择 URL并按字段状态轮询规则等待提交（轮询场景不额外等待用户确认）；恢复后只用上方 SCORE_MANUAL_SOURCE_CSV_ARGS 原样重提一次 score_manual_source_csv，不得重搜、重做原生补全、重跑 file_bridge 或改写该 csv_file_path。",
    );
  } else {
    lines.push(
      "字段工具返回 configured/copied 后立即恢复；只有返回 URL 时才原样展示字段选择 URL并按字段状态轮询规则等待提交（轮询场景不额外等待用户确认）；随后只使用同一 requirement_id 与本轮 file_bridge 返回的原始 csv_file_path 重提一次 score_manual_source_csv。当前对话无法取得该可信 csv_file_path 时如实说明并停止，禁止自行构造 URL 或重跑前序链路。",
    );
  }
  return lines.join("\n");
}

function scoreManualSourceCsvDirective(
  message,
  params = {},
  recordedPlatform = null,
  requirementPlatform = null,
  recordedMode = null,
) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  if (requirementColumnsError(result)) {
    return scoreColumnsRecoveryDirective(message, params, recordedPlatform, requirementPlatform);
  }
  const scoredCount = providerScoredCount(result);
  const excelFileUrl = providerExcelUrl(result);
  const jobId = providerJobId(result);
  if (result?.success !== true) return flowPauseDirective("达人打分", message);
  if (scoredCount !== null && scoredCount <= 0) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=score_manual_source_csv 全部行打分失败。不生成空 Excel；如实报告失败后停止，不把内部 merged CSV 当交付物展示。",
      ...(requirementId ? [`REQUIREMENT_ID=${requirementId}`] : []),
    ].join("\n");
  }
  if (jobId != null) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=score_manual_source_csv 已提交异步打分任务（仅返回 job_id）。先告知用户“后台打分耗时较长，您可以先不用管，我会继续轮询。”，再按 SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS 轮询；${SCORE_MANUAL_SOURCE_POLL_RULE}。`,
      `SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS=${JSON.stringify({ job_id: jobId })}`,
    ].join("\n");
  }
  if (!excelFileUrl || !requirementId) return flowPauseDirective("达人打分缺少最终 Excel", message);
  return [
    recordedMode === BUSINESS_MODE_MANUAL
      ? "YPSCAN_FLOW_DIRECTIVE=score_manual_source_csv 成功。按 SAVE_ARTIFACT_ARGS 保存 manual_score_batch 中间表，不展示 Provider 下载 URL、本地路径或链接，再汇总决定下一步。"
      : "YPSCAN_FLOW_DIRECTIVE=score_manual_source_csv 成功。立即保存最终打分排序 Excel，不展示 Provider 下载 URL。",
    `SAVE_ARTIFACT_ARGS=${JSON.stringify({
      artifact_kind: recordedMode === BUSINESS_MODE_MANUAL ? "manual_score_batch" : "manual_source",
      artifact_id: requirementId,
      file_url: excelFileUrl,
    })}`,
  ].join("\n");
}

function scoreManualSourceCsvStatusDirective(
  message,
  params = {},
  recordedPlatform = null,
  requirementPlatform = null,
  recordedMode = null,
) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  if (requirementColumnsError(result)) {
    return scoreColumnsRecoveryDirective(message, params, recordedPlatform, requirementPlatform);
  }
  const excelFileUrl = providerExcelUrl(result);
  const jobId = providerJobId(result) ?? providerJobId({ data: params });
  if (result?.success !== true) return flowPauseDirective("达人打分结果查询", message);
  if (
    FAILED_ASYNC_STATUSES.has(String(result?.data?.status ?? result?.status ?? "").toLowerCase())
  ) {
    return flowPauseDirective("达人打分结果查询任务已失败", message);
  }
  if (excelFileUrl && requirementId) {
    return [
      recordedMode === BUSINESS_MODE_MANUAL
        ? "YPSCAN_FLOW_DIRECTIVE=score_manual_source_csv_status 已完成。按 SAVE_ARTIFACT_ARGS 保存 manual_score_batch 中间表，不展示 Provider 下载 URL、本地路径或链接，再汇总决定下一步。"
        : "YPSCAN_FLOW_DIRECTIVE=score_manual_source_csv_status 已完成。立即保存最终打分排序 Excel，不展示 Provider 下载 URL。",
      `SAVE_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind:
          recordedMode === BUSINESS_MODE_MANUAL ? "manual_score_batch" : "manual_source",
        artifact_id: requirementId,
        file_url: excelFileUrl,
      })}`,
    ].join("\n");
  }
  if (result?.success === true && excelFileUrl) {
    return flowPauseDirective("达人打分结果查询 完成但缺少 requirement_id", message);
  }
  if (jobId != null) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=score_manual_source_csv_status 尚未完成。继续使用同一 job_id 轮询，不重新打分、不更换 job_id、不询问用户；由当前对话累计查询次数，单轮最多 10 次，第 10 次仍未完成时如实报告并停止，不得自动开始第 11 次。`,
      `SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS=${JSON.stringify({ job_id: jobId })}`,
    ].join("\n");
  }
  return flowPauseDirective("达人打分结果查询", message);
}

function syncInquiryIds(result) {
  if (Array.isArray(result?.data?.inquiry_ids)) return result.data.inquiry_ids;
  if (Array.isArray(result?.data?.inquiries)) {
    return result.data.inquiries.map((item) => item?.inquiry_id).filter((value) => value != null);
  }
  if (Array.isArray(result?.inquiry_ids)) return result.inquiry_ids;
  return null;
}

function normalizeInquiryIds(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function requirementIdForInquiryIds(inquiryIds, inquiryIdsByRequirement) {
  if (!Array.isArray(inquiryIds) || inquiryIds.length === 0) return null;
  const key = normalizeInquiryIds(inquiryIds).sort().join(",");
  let matched = null;
  for (const [requirementId, recordedIds] of inquiryIdsByRequirement) {
    if (normalizeInquiryIds(recordedIds).sort().join(",") !== key) continue;
    if (matched !== null) return null;
    matched = String(requirementId);
  }
  return matched;
}

function syncInquiryDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("询价状态同步", message);
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  const rawIds = syncInquiryIds(result);
  if (!requirementId) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=询价状态同步成功但缺少 requirement_id；如实说明缺失，不得跨轮拼接或使用 trace_id。",
    ].join("\n");
  }
  if (Array.isArray(rawIds) && rawIds.length > 0) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=询价状态同步成功，已返回非空 inquiry_ids。只把本次响应的 inquiry_ids 传给 ingest_mcn_submissions，不得跨轮拼接或使用 trace_id。",
      `INGEST_MCN_SUBMISSIONS_ARGS=${JSON.stringify({ inquiry_ids: normalizeInquiryIds(rawIds) })}`,
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=询价状态同步成功但未返回 inquiry_ids；如实说明缺 inquiry_ids，不得直接 ingest。",
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(flowRetryQuestionPayload("询价状态同步"))}`,
  ].join("\n");
}

function ingestSubmissionsDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("机构提报入库", message);
  const jobId = providerJobId(result);
  if (jobId == null) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=ingest_mcn_submissions 成功但缺少可信 job_id，无法查询异步入库结果。不得把本次响应当成最终 Excel、编造任务 ID 或跳过预览表直接精排。",
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(ingestJobRecoveryQuestionPayload())}`,
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=ingest_mcn_submissions 仅创建异步任务，尚未返回预览表。立即用 GET_INGEST_JOB_ARGS 调用 get_ingest_job，不得保存或精排本响应。",
    `GET_INGEST_JOB_ARGS=${JSON.stringify({ job_id: jobId })}`,
  ].join("\n");
}

function getIngestJobDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true && result?.error?.code !== "JOB_PENDING")
    return flowPauseDirective("异步入库结果查询", message);
  const jobId = providerJobId(result) ?? providerJobId({ data: params });
  if (
    result?.success === true &&
    FAILED_ASYNC_STATUSES.has(String(result?.data?.status ?? result?.status ?? "").toLowerCase())
  ) {
    return flowPauseDirective("异步入库结果查询任务已失败", message);
  }
  const excelFileUrl = providerExcelUrl(result);
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.data?.result?.requirement_id,
    result?.requirement_id,
  );
  if (result?.success === true && excelFileUrl && requirementId) {
    const lines = [
      "YPSCAN_FLOW_DIRECTIVE=get_ingest_job 已完成（succeeded 或 partially_succeeded），返回机构回填预览 Excel。先保存机构达人预览表，再按后续分叉执行：ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV → 原生达人补全（20/批）→ file_bridge（flow=manual_source）→ score_manual_source_csv → score_status → 保存打分排序 Excel。",
      `MCN_CREATOR_PREVIEW_URL=${excelFileUrl}`,
      `SAVE_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "mcn_creator_preview",
        artifact_id: requirementId,
        file_url: excelFileUrl,
      })}`,
    ];
    const partial = ingestPartialSummary(result);
    if (partial) lines.push(partial);
    return lines.join("\n");
  }
  if (result?.success === true && excelFileUrl) {
    return flowPauseDirective("异步入库结果查询 完成但缺少 requirement_id", message);
  }
  if (jobId != null) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=get_ingest_job 尚未完成。继续使用同一 job_id 轮询，不重新入库、不更换 job_id、不询问用户；由当前对话累计查询次数，单轮最多 10 次，第 10 次仍未完成时如实报告并停止，不得自动开始第 11 次。",
      `GET_INGEST_JOB_ARGS=${JSON.stringify({ job_id: jobId })}`,
    ].join("\n");
  }
  return flowPauseDirective("异步入库结果查询", message);
}

function ingestPartialSummary(result) {
  const status = String(result?.data?.status ?? result?.status ?? "");
  const results = Array.isArray(result?.data?.results) ? result.data.results : [];
  if (status !== "partially_succeeded") return null;
  if (results.length === 0)
    return "INGEST_PARTIAL_SUMMARY=部分成功，但缺少逐机构明细；只能引用接口汇总，不能推断失败原因或哪些机构待回填。回填行数不能当作唯一达人数或合格人数，不自动重跑或重发。";
  const pending = [];
  const succeeded = [];
  const failed = [];
  let unknown = 0;
  for (const item of results) {
    const inquiryId = [item?.inquiry_id, item?.error?.details?.inquiry_id].find(
      (value) => nonemptyString(value) || Number.isSafeInteger(value),
    );
    if (item?.success === true) succeeded.push(inquiryId);
    else if (item?.error?.code === "DISTRIBUTION_NOT_SUBMITTED") pending.push(inquiryId);
    else if (item?.success === false)
      failed.push({
        inquiry_id: inquiryId,
        code: item?.error?.code ?? "UNKNOWN",
        message: item?.error?.message,
      });
    else unknown += 1;
  }
  return [
    `INGEST_PARTIAL_SUMMARY=已回填 ${succeeded.length} 家，pending ${pending.length} 家${pending.length > 0 ? `（inquiry_id: ${pending.join(", ")}）` : ""}。`,
    `处理失败 ${failed.length} 家，状态未知 ${unknown} 家；失败明细=${JSON.stringify(failed)}。不能把 pending 当故障，也不能把回填行数当合格人数。`,
    "如实报告哪些机构 pending、哪些已回填；保存预览表后让用户选择「补全并打分排序 / 暂不补全」，不得把 partially_succeeded 当全部完成。",
    "部分机构失败不阻止保存成功机构的预览表及后续生成评分表；按真实错误说明原因，不等待失败机构修正，不重跑成功机构。只有明确的填写错误才说填写不正确，其他错误原样说明。",
  ].join("\n");
}

function rankCreatorsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  const scoredCount = providerScoredCount(result);
  const excelFileUrl = providerExcelUrl(result);
  if (result?.success !== true) return flowPauseDirective("rank_creators", message);
  if (scoredCount !== null && scoredCount <= 0) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=rank_creators 全部行精排失败。不生成空提报表；如实报告失败后停止，不把内部 merged CSV 当交付物展示。",
      ...(requirementId ? [`RANK_REQUIREMENT_ID=${requirementId}`] : []),
    ].join("\n");
  }
  if (!requirementId || !excelFileUrl)
    return flowPauseDirective("rank_creators 缺少最终 Excel", message);
  const inputSummary = nonemptyString(params?.csv_file_path)
    ? "当前 requirement_id 与 file_bridge 返回的 csv_file_path"
    : "当前 requirement_id 与本轮 sync 的 inquiry_ids";
  return [
    `YPSCAN_FLOW_DIRECTIVE=rank_creators 成功。该调用的精排输入为${inputSummary}。直接保存最终提报 Excel 为 ranked_submission，不调用 create_submission_batch。`,
    `SAVE_ARTIFACT_ARGS=${JSON.stringify({
      artifact_kind: "ranked_submission",
      artifact_id: requirementId,
      file_url: excelFileUrl,
    })}`,
  ].join("\n");
}

const ARTIFACT_SAVE_STAGES = Object.freeze({
  mcn_ranking: "MCN 排名表保存",
  mcn_creator_preview: "机构达人预览表保存",
  manual_source: "手动拓展表保存",
  manual_score_batch: "手动拓展单批评分表保存",
  ranked_submission: "最终提报表保存",
  manual_creator_links: "links CSV 保存",
  mcn_creator_links: "links CSV 保存",
});

function artifactSaveDirective(
  message,
  params = {},
  recordedPlatform = null,
  requirementPlatformLookup = (_requirementId) => null,
  recordedMode = null,
) {
  const artifactKind = params?.artifact_kind;
  const stage = ARTIFACT_SAVE_STAGES[artifactKind];
  if (!stage) return null;
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective(stage, message);
  const filePath = firstString(result?.data?.file_path, result?.delivery?.local_path);
  if (!filePath) return flowPauseDirective(stage, message);
  const localFileLink =
    firstString(result?.delivery?.local_file_link) ?? localFileMarkdownLink(filePath);
  if (!localFileLink) return flowPauseDirective(stage, message);
  if (artifactKind === "manual_creator_links") {
    const platform = requirementPlatformLookup(params.artifact_id) ?? recordedPlatform;
    return [
      "YPSCAN_FLOW_DIRECTIVE=手动拓展 links CSV 已保存（原始 Provider 下载物，尚未归一化；内部产物，不主动向用户展示）。立即使用 SAVE_CREATOR_LINKS_ARGS 调用 ypscan_save_creator_links 归一化为受控三列 links CSV；归一化成功后先调用 ypscan_summarize_manual_scores，按其 next_author_ids 逐批补全、上传和评分。不得把该原始 CSV 直接传给 file_bridge。",
      `MANUAL_CREATOR_LINKS_LOCAL_PATH=${filePath}`,
      ...(platform
        ? [
            `SAVE_CREATOR_LINKS_ARGS=${JSON.stringify({ requirement_id: params.artifact_id, platform, links_csv_path: filePath })}`,
          ]
        : [
            "当前缺少已确认的平台，无法生成 ypscan_save_creator_links 必填参数；暂停，不猜测 platform。",
          ]),
    ].join("\n");
  }
  if (artifactKind === "manual_score_batch") {
    if (recordedMode === BUSINESS_MODE_MANUAL) {
      return [
        "YPSCAN_FLOW_DIRECTIVE=当前批评分表已保存，仅为内部中间结果。不要向用户展示表格、文件路径或本地链接；立即调用 ypscan_summarize_manual_scores 累计推荐人数；不把本批评分成功数当推荐人数，不直接结束或放宽。",
        `SUMMARIZE_MANUAL_SCORES_ARGS=${JSON.stringify({ requirement_id: params.artifact_id })}`,
      ].join("\n");
    }
    if (recordedMode !== BUSINESS_MODE_INQUIRY) {
      return "YPSCAN_FLOW_DIRECTIVE=manual_score_batch 保存缺少当前 requirement 的已登记业务模式，无法判断是手动拓展中间表还是询价误存；停止，不展示为最终交付，不调用汇总、不重存或重评。";
    }
  }
  if (artifactKind === "manual_source" || artifactKind === "manual_score_batch") {
    const isInquiry = recordedMode === BUSINESS_MODE_INQUIRY;
    return [
      "YPSCAN_FLOW_DIRECTIVE=最终打分排序 Excel 已保存。原样展示本地链接作为最终交付物。不得调用 rank_creators 或 create_submission_batch。",
      ...(isInquiry
        ? [
            "当前为询价机构，即使误存为 manual_score_batch 也按本次评分表交付，不调用 ypscan_summarize_manual_scores、不重存或重评。询价回收结果不足时交付当前真实结果并说明缺口后结束，不进入放宽流程，不自动发起新一轮询价。",
          ]
        : [
            "YPSCAN_NEXT_ACTION=APPLY_MANUAL_SOURCE_RESULT_POLICY",
            "以下放宽建议仅适用于手动拓展；若当前业务来源未确认，先确认来源。询价回收结果只交付真实结果并说明缺口后结束。",
            MANUAL_SOURCE_SHORTFALL_RULE,
            MANUAL_SOURCE_RELAXATION_RULE,
          ]),
      `MANUAL_SOURCE_LOCAL_PATH=${filePath}`,
      `MANUAL_SOURCE_LOCAL_LINK=${localFileLink}`,
      "将 MANUAL_SOURCE_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径。",
      REQUIREMENT_CREATION_RULE,
    ].join("\n");
  }
  if (artifactKind === "mcn_creator_preview") {
    const platform = requirementPlatformLookup(params.artifact_id) ?? recordedPlatform;
    return [
      "YPSCAN_FLOW_DIRECTIVE=机构达人预览表已保存，属于未核验原始回填，不是合格名单。原样展示本地链接后让用户选择是否补全；选“补全并打分排序”时调用 ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV → 按 20/批调用当前平台 YP Action 原生达人补全工具 → file_bridge（flow=manual_source）→ score_manual_source_csv → score_status → 保存打分排序 Excel。不要用普通 read 读取 xlsx，也不要求用户转换 CSV。",
      `MCN_CREATOR_PREVIEW_LOCAL_PATH=${filePath}`,
      `MCN_CREATOR_PREVIEW_LOCAL_LINK=${localFileLink}`,
      "将 MCN_CREATOR_PREVIEW_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径。",
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(mcnCreatorCompletionQuestionPayload())}`,
      ...(platform
        ? [
            `SAVE_CREATOR_LINKS_ARGS=${JSON.stringify({ requirement_id: params.artifact_id, platform, preview_file_path: filePath })}`,
          ]
        : ["缺少本轮已确认平台时暂停，不猜测 platform。"]),
    ].join("\n");
  }
  if (artifactKind === "mcn_ranking") {
    const nextArgs = result?.delivery?.next_args;
    const platform = requirementPlatformLookup(params.artifact_id) ?? recordedPlatform;
    const selectArgs = selectInquiryFormFieldsArgs(params.artifact_id, platform);
    return [
      "YPSCAN_FLOW_DIRECTIVE=MCN 排名表已保存。表格已先输出；原样展示本地链接后选择询价收件机构。",
      `MCN_RANKING_LOCAL_PATH=${filePath}`,
      `MCN_RANKING_LOCAL_LINK=${localFileLink}`,
      "将 MCN_RANKING_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径或把路径/链接放入弹窗；随后执行 ASK_USER_QUESTION_ARGS 选择询价收件机构，不得按排名或指标自行选择，也不得重复下载或重新 rank_mcns。",
      ...(isPopupQuestionPayload(nextArgs)
        ? [
            `ASK_USER_QUESTION_ARGS=${JSON.stringify(nextArgs)}`,
            INQUIRY_RECIPIENT_RESPONSE_RULE,
            ...(selectArgs
              ? [
                  INQUIRY_RECIPIENT_RESUME_RULE,
                  "收到机构选择答案后，先检查当前对话中同一 requirement_id 是否已经提交过字段配置：已提交则复用并继续发送预览，未提交才调用 select_inquiry_form_fields（参数见下方 SELECT_INQUIRY_FORM_FIELDS_ARGS）；不得查询、缓存或重建 columns。",
                  `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify(selectArgs)}`,
                ]
              : [
                  "当前缺少已确认的平台，无法安全生成 select_inquiry_form_fields 必填参数；暂停在机构选择之后，不得猜测 platform。",
                ]),
          ]
        : ["当前没有可选机构；如实说明询价功能无法继续，不得自动切换功能或猜测收件机构。"]),
    ].join("\n");
  }
  if (artifactKind === "ranked_submission") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=最终提报表已保存。原样展示本地链接并结束本轮机构回填精排链路。",
      `RANKED_SUBMISSION_LOCAL_PATH=${filePath}`,
      `RANKED_SUBMISSION_LOCAL_LINK=${localFileLink}`,
      "将 RANKED_SUBMISSION_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径。",
    ].join("\n");
  }
  return null;
}

function cascadeSelectionDirective(message) {
  const result = parsedToolResult(message);
  if (result?.status === "needs_user_action") {
    return [
      `YPSCAN_FLOW_DIRECTIVE=级联菜单操作被${result?.error?.code ?? "登录或全局验证"}阻止。`,
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(browserVerificationQuestionPayload())}`,
    ].join("\n");
  }
  if (result?.applied === true && result?.verified === true) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=级联菜单已验证：${result?.field_label ?? "未知筛选"} → ${(result?.selected_path ?? []).join(" / ")}。`,
      "立即回到 Playwright CLI 同一 session 观察完整筛选区并继续剩余条件；不要重复点击已选路径。",
    ].join("\n");
  }
  return [
    `YPSCAN_FLOW_DIRECTIVE=级联菜单未提交（${result?.error?.code ?? result?.status ?? "未知"}），但整个手扒任务不得停止。`,
    result?.recovery_hint ??
      "重新观察页面实际筛选名、入口文字和菜单层级后最多调整参数再试一次；仍失败则将该条件转入详情硬复核并继续其他筛选。",
  ].join("\n");
}

function filterRangeDirective(message) {
  const result = parsedToolResult(message);
  if (result?.status === "needs_user_action") {
    return [
      `YPSCAN_FLOW_DIRECTIVE=范围筛选操作被${result?.error?.code ?? "登录或全局验证"}阻止。`,
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(browserVerificationQuestionPayload())}`,
    ].join("\n");
  }
  if (result?.applied === true && result?.verified === true) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=范围筛选已验证：${result?.field_label ?? "未知筛选"}。`,
      "立即回到 Playwright CLI 同一 session 重新 snapshot 并继续剩余条件；不要复用输入前的 ref，也不要重复提交已选范围。",
    ].join("\n");
  }
  return [
    `YPSCAN_FLOW_DIRECTIVE=范围筛选未提交（${result?.error?.code ?? result?.status ?? "未知"}），但整个手扒任务不得停止。`,
    result?.recovery_hint ??
      "重新观察页面实际筛选名、入口文字和单位后最多调整参数再试一次；仍失败则将该条件转入详情硬复核并继续其他筛选。",
  ].join("\n");
}

function manualScoreSummaryDirective(message) {
  const result = parsedToolResult(message);
  if (
    result?.success === false &&
    result?.error?.code === "YPSCAN_MANUAL_SCORE_MODE_NOT_APPLICABLE"
  ) {
    return "YPSCAN_FLOW_DIRECTIVE=当前为询价机构，误调用了仅用于手动拓展的汇总工具；这不表示评分或保存失败。不重试汇总、不重评、不重新建需、不弹重试窗口。仅交付当前需求已成功保存的评分 Excel 真实本地链接；没有可信保存结果时如实说明并停止，不猜测文件或宣称已交付。";
  }
  const batchFiles = Array.isArray(result?.data?.partial_delivery?.batch_files)
    ? result.data.partial_delivery.batch_files
    : [];
  if (result?.success === false && batchFiles.length > 0) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=评分汇总未完成，但当前需求已有按持久来源记录校验通过的评分表。先如实说明汇总未完成和具体原因，再展示下列本地链接，并明确标注“本批评分结果，汇总未完成”，不得当作最终汇总。",
      `MANUAL_SCORE_BATCH_LINKS=${JSON.stringify(batchFiles.map((file) => file?.local_file_link))}`,
      "不重新搜索、不重新补全、不重新打分，不新建 requirement；校验失败被排除的批次不猜测、不补文件，不要求用户整轮重做。",
    ].join("\n");
  }
  if (
    result?.success === false &&
    result?.error?.code === "YPSCAN_MANUAL_SCORE_CONTEXT_UNAVAILABLE"
  ) {
    return "YPSCAN_FLOW_DIRECTIVE=持久来源记录中缺少当前需求的可信上下文，且没有可交付的已核验评分表。停止并保留已有文件，不据此推断为询价机构，不重试汇总、不重新建需或重评，不猜测人数、来源或完成状态。";
  }
  if (result?.success !== true) return flowPauseDirective("手动拓展评分汇总", message);
  const data = result.data;
  if (data?.next_action === "complete_next_batch") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=累计推荐尚未达标。只用 NEXT_AUTHOR_IDS 调用当前平台原生达人补全工具（小红书 page_count=1），本批完成后只上传本批 CSV 再评分，禁止提前补全下一批。",
      `NATIVE_COMPLETION_TOOL=${data.platform === "xiaohongshu" ? "get_xhs_author_business_card" : "get_douyin_author_business_card"}`,
      `NEXT_AUTHOR_IDS=${JSON.stringify(data.next_author_ids)}`,
    ].join("\n");
  }
  if (data?.next_action === "await_scores") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=当前批仍有已补全达人缺评分行，不得当作最终交付。先向用户展示 progress.user_visible_message（明确标注仅为阶段性结果，不代表最终汇总；已保存的单批评分表也不是最终表）。",
      `MANUAL_SCORE_PENDING_AUTHOR_IDS=${JSON.stringify(data.pending_score_author_ids ?? [])}`,
      "评分任务仍在运行：只等待当前已提交任务（沿用 30 秒轮询、单轮最多 10 次），不开始下一批。任务已终态仍缺行：原样报告上述缺失达人并停止，不重复提交、不自动重评、不猜测结论。",
    ].join("\n");
  }
  if (data?.next_action === "deliver") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=手动拓展分批评分结束。展示最终汇总 delivery.local_file_link（若有），说明真实已评分、推荐、目标、失败和未处理人数。没有文件不得声称已交付；禁止继续补全或评分剩余候选。",
      `MANUAL_SCORE_COUNTS=${JSON.stringify({ scored_count: data.scored_count, excluded_zero_score_count: data.excluded_zero_score_count, recommended_count: data.recommended_count, target_count: data.target_count, unprocessed_count: data.unprocessed_count, completion_failed_count: data.completion_failed_count, shortfall: data.shortfall, stop_reason: data.stop_reason })}`,
      ...(data.excluded_zero_score_count
        ? [
            "综合分为 0 的评分行未写入汇总表，按 excluded_zero_score_count 如实说明；不写成未评分、补全失败或达人被筛掉。",
          ]
        : []),
      ...(data.shortfall > 0
        ? [
            "先交付真实汇总结果并说明推荐人数缺口，再按 Skill 优先建议替换关键词、减少人设限定；该阶段用户已明确要求放宽时直接执行，否则等待确认。调整后仍不足再提示其他条件并等待该项确认。",
            MANUAL_SOURCE_RELAXATION_RULE,
          ]
        : []),
    ].join("\n");
  }
  return flowPauseDirective("手动拓展评分汇总缺少下一步", message);
}

function flowDirective(
  toolName,
  message,
  params = {},
  recordedMode = null,
  recordedPlatform = null,
  requirementPlatformLookup = (_requirementId) => null,
  quantityTotalLookup = (_requirementId) => null,
) {
  const normalizedName = toolName.toLowerCase();
  const bare = resolveFlowToolName(normalizedName);
  const result = parsedToolResult(message);
  const requirementIdFromParams = firstString(
    params?.requirement_id,
    params?.id,
    params?.artifact_id,
  );
  const requirementPlatform = requirementPlatformLookup(requirementIdFromParams) ?? null;
  if (
    bare === "validate_requirement" &&
    messageText(message).includes(REQUIREMENT_PREFLIGHT_BLOCKED)
  ) {
    return requirementPreflightBlockedDirective(message);
  }
  if (bare === "ypscan_summarize_manual_scores") return manualScoreSummaryDirective(message);
  if (bare === "select_inquiry_form_fields") {
    return fieldSelectionDirective(message, params);
  }
  if (bare === "get_inquiry_form_fields_status") {
    return fieldStatusDirective(message, params);
  }
  if (bare === "ypscan_save_artifact") {
    return artifactSaveDirective(
      message,
      params,
      recordedPlatform,
      requirementPlatformLookup,
      recordedMode,
    );
  }
  if (bare === "ypscan_save_creator_links") {
    return creatorLinksSaveDirective(message, params, recordedMode);
  }
  if (bare === "file_bridge") {
    return fileBridgeDirective(message, params);
  }
  if (bare === "score_manual_source_csv") {
    return scoreManualSourceCsvDirective(
      message,
      params,
      recordedPlatform,
      requirementPlatform,
      recordedMode,
    );
  }
  if (bare === "score_manual_source_csv_status") {
    return scoreManualSourceCsvStatusDirective(
      message,
      params,
      recordedPlatform,
      requirementPlatform,
      recordedMode,
    );
  }
  if (bare === "ypscan_select_cascade") {
    return cascadeSelectionDirective(message);
  }
  if (bare === "ypscan_set_filter_range") {
    return filterRangeDirective(message);
  }
  if (bare === "create_with_distributions") return distributionDirective(message);
  if (bare === "sync_mcn_inquiry_status") return syncInquiryDirective(message, params);
  if (bare === "ingest_mcn_submissions") return ingestSubmissionsDirective(message);
  if (bare === "get_ingest_job") return getIngestJobDirective(message, params);
  if (bare === "manual_source_creators") {
    return manualSourceCreatorsDirective(
      message,
      params,
      recordedPlatform,
      requirementPlatform,
      quantityTotalLookup,
    );
  }
  if (bare === "manual_source_creators_status")
    return manualSourceCreatorsStatusDirective(message, params, quantityTotalLookup);
  if (bare === "get_xhs_author_business_card" || bare === "get_douyin_author_business_card") {
    return manualSourceCompletionDirective(message, params, recordedMode);
  }
  if (bare === "rank_creators") return rankCreatorsDirective(message, params);
  if (bare === "excel_export") return excelExportDirective(message, params);
  if (result?.success !== true) {
    if (
      bare === "ypscan_parse_requirement" ||
      bare === "validate_requirement" ||
      bare === "search_creators" ||
      bare === "rank_mcns"
    ) {
      return flowPauseDirective(bare, message);
    }
    return null;
  }
  if (bare === "ypscan_parse_requirement") {
    return requirementParseSuccessDirective(message, params, recordedMode);
  }
  if (bare === "validate_requirement") {
    const requirementId = firstString(result?.data?.requirement_id, result?.data?.id);
    if (!requirementId) return flowPauseDirective("validate_requirement", message);
    const mode = businessModeFromParams(params) ?? recordedMode;
    const platform = firstCanonicalPlatform(
      params?.platform,
      result?.data?.platform,
      result?.platform,
      recordedPlatform,
    );
    if (!mode) {
      return flowPauseDirective("validate_requirement 缺少 business_mode", message);
    }
    if (!platform) {
      return flowPauseDirective("validate_requirement 缺少 platform", message);
    }
    if (mode === BUSINESS_MODE_INQUIRY) {
      return [
        "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。当前需求只保留一个 requirement，业务模式：询价机构。立即使用 SEARCH_CREATORS_ARGS 调用 search_creators，随后 rank_mcns；不得调用手动拓展分支工具、Browser 或直接结束。",
        "只使用本次返回的 data.requirement_id，缺失时兼容 data.id；严禁使用 data.demand_id。",
        `SEARCH_CREATORS_ARGS=${JSON.stringify({ id: requirementId })}`,
      ].join("\n");
    }
    const selectArgs = selectInquiryFormFieldsArgs(requirementId, platform);
    const manualNumLine = manualSourceNumDirectiveLine(quantityTotalLookup(requirementId));
    return [
      "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。当前需求只保留一个 requirement，业务模式：手动拓展。立即使用 SELECT_INQUIRY_FORM_FIELDS_ARGS 调用 select_inquiry_form_fields，按字段继承规则补充参数；configured/copied 后继续，字段页 URL 按字段状态轮询规则等待提交；不得调用 search_creators、rank_mcns 或 Browser。",
      "只使用本次返回的 data.requirement_id，缺失时兼容 data.id；严禁使用 data.demand_id。",
      FIELD_SELECTION_REUSE_RULE,
      FIELD_SELECTION_GATE_RULE,
      `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify(selectArgs)}`,
      ...(manualNumLine ? [manualNumLine] : []),
    ].join("\n");
  }
  if (bare === "search_creators") {
    return searchCreatorsDirective(message, params, recordedPlatform, requirementPlatform);
  }
  if (bare === "rank_mcns") {
    return rankMcnsDirective(message, params, recordedPlatform, requirementPlatform);
  }
  return null;
}

function appendDirective(message, directive) {
  if (!directive || !isRecord(message)) return undefined;
  const content = Array.isArray(message.content)
    ? [...message.content, { type: "text", text: `\n\n${directive}` }]
    : `${messageText(message)}\n\n${directive}`;
  return { message: { ...message, content } };
}

function scopeKey(event, context) {
  return (
    firstString(
      context?.sessionKey,
      context?.sessionId,
      event?.sessionKey,
      event?.sessionId,
      context?.runId,
      context?.run_id,
      event?.runId,
      event?.run_id,
    ) ?? "global"
  );
}

const REQUIREMENT_ID_TOOLS = new Set([
  "select_inquiry_form_fields",
  "manual_source_creators",
  "manual_source_creators_status",
  "sync_mcn_inquiry_status",
  "create_with_distributions",
  "score_manual_source_csv",
  "file_bridge",
  "ypscan_save_creator_links",
  "ypscan_summarize_manual_scores",
  "rank_creators",
]);

function trustedRequirementId(bare, params, result) {
  if (result?.success !== true) return null;
  if (bare === "validate_requirement")
    return firstString(result?.data?.requirement_id, result?.data?.id);
  if (bare === "search_creators" || bare === "rank_mcns")
    return firstString(params?.id, result?.data?.requirement_id);
  if (bare === "ypscan_save_artifact" && params?.artifact_kind !== "creator_detail_export")
    return firstString(params?.artifact_id, result?.data?.artifact_id);
  return REQUIREMENT_ID_TOOLS.has(bare)
    ? firstString(params?.requirement_id, result?.data?.requirement_id)
    : null;
}

// Installed YP Action passes sessionKey + toolCallId to both hooks. Never correlate
// by a "latest call" fallback when either coordinate is absent.
function callKey(event, context) {
  const session = firstString(context?.sessionKey, event?.sessionKey);
  const id = firstString(event?.toolCallId, context?.toolCallId);
  return session && id ? JSON.stringify([session, id]) : null;
}

/**
 * Register fixed-flow prompt and result directives.
 *
 * The preflight gate in before_tool_call records the validated business_mode
 * per scope so tool_result_persist can route the success directive even when
 * its event omits the call params. The mode is always derivable from params
 * whenever the preflight passes, so the record is deterministic and never
 * relies on a Provider response echo.
 */
export function registerFlowDirectiveHooks(api) {
  const pendingCalls = new Map();
  const startupScopes = new Set();
  const businessModeByScope = new Map();
  const platformByScope = new Map();
  const platformByRequirement = new Map();
  const inquiryIdsByRequirement = new Map();
  const quantityTotalByRequirement = new Map();
  // score job → { requirement_id, csv_file_path? }：缺列恢复需要精确重提本轮打分参数。
  const scoreJobRecoveryByScope = new Map();
  const requirementIdByIngestJobId = new Map();
  const currentRequirementIdByScope = new Map();
  const currentFieldIdByScope = new Map();
  const linksCsvPathsByRequirement = new Map();
  const previewFilesByRequirement = new Map();
  const completionCsvPathsByRequirement = new Map();
  const completionCsvPathsByFieldId = new Map();
  // requirement → { url, blockedOnce }：字段页链接生成后直到提交/失效前必须先在正文展示。
  const fieldPageLinkByRequirement = new Map();
  // Source records only; progress is recomputed by the local summarizer.
  const manualScoreSourcesByRequirement = new Map();
  // requirement → 持久化文件路径；hydrated 集合避免同一项目重复读盘。
  const manualScoreSourcesStoreByRequirement = new Map();
  const hydratedManualScoreStores = new Set();

  function manualScoreStorePath(workspaceDir) {
    return nonemptyString(workspaceDir) && isAbsolute(workspaceDir)
      ? join(workspaceDir, ".ypscan", MANUAL_SCORE_SOURCES_FILE)
      : null;
  }

  // 首次需要时按项目读回持久记录；已存在的内存记录优先，不覆盖本进程的新结果。
  function hydrateManualScoreSources(workspaceDir) {
    const storePath = manualScoreStorePath(workspaceDir);
    if (!storePath || hydratedManualScoreStores.has(storePath)) return;
    hydratedManualScoreStores.add(storePath);
    let payload;
    try {
      payload = JSON.parse(readFileSync(storePath, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(payload) || payload.version !== MANUAL_SCORE_SOURCES_VERSION) return;
    const records = isRecord(payload.requirements) ? payload.requirements : {};
    for (const [requirementId, record] of Object.entries(records)) {
      if (!isRecord(record) || manualScoreSourcesByRequirement.has(requirementId)) continue;
      const sources = restoredManualScoreSources(record);
      manualScoreSourcesByRequirement.set(requirementId, sources);
      manualScoreSourcesStoreByRequirement.set(requirementId, storePath);
      const platform = canonicalPlatformName(record.platform);
      if (platform && !platformByRequirement.has(requirementId))
        platformByRequirement.set(requirementId, platform);
      const quantityTotal = positiveInteger(record.quantity_total);
      if (quantityTotal != null && !quantityTotalByRequirement.has(requirementId))
        quantityTotalByRequirement.set(requirementId, quantityTotal);
      // 恢复 links CSV 上传白名单，使重启后仍能仅凭持久来源继续当前需求。
      if (nonemptyString(sources.links_file?.file_path)) {
        const paths = linksCsvPathsByRequirement.get(requirementId) ?? new Set();
        paths.add(sources.links_file.file_path);
        linksCsvPathsByRequirement.set(requirementId, paths);
      }
    }
  }

  function persistManualScoreSources(workspaceDir) {
    const storePath = manualScoreStorePath(workspaceDir);
    if (!storePath) return;
    const requirements = {};
    for (const [requirementId, sources] of manualScoreSourcesByRequirement) {
      if (manualScoreSourcesStoreByRequirement.get(requirementId) !== storePath) continue;
      requirements[requirementId] = serializableManualScoreSources(
        sources,
        platformByRequirement.get(requirementId),
        quantityTotalByRequirement.get(requirementId),
      );
    }
    const tempPath = `${storePath}.${String(process.pid)}.tmp`;
    try {
      mkdirSync(dirname(storePath), { recursive: true });
      writeFileSync(
        tempPath,
        JSON.stringify({ version: MANUAL_SCORE_SOURCES_VERSION, requirements }, null, 2),
        { mode: 0o600 },
      );
      renameSync(tempPath, storePath);
    } catch {
      try {
        unlinkSync(tempPath);
      } catch {
        // 临时文件清理失败不影响本次工具结果。
      }
    }
  }

  function recordManualScoreSourceChange(requirementId, workspaceDir) {
    const storePath = manualScoreStorePath(workspaceDir);
    if (!storePath) return;
    if (!manualScoreSourcesStoreByRequirement.has(requirementId))
      manualScoreSourcesStoreByRequirement.set(requirementId, storePath);
    persistManualScoreSources(workspaceDir);
  }

  api.on(
    "before_prompt_build",
    (event, context) => {
      const scope = scopeKey(event, context);
      const lines = [
        "[YPSCAN 业务模式指令]",
        `业务规则文件：${BUSINESS_SKILL_PATH}。首次相关操作前必须完整读取；本会话已读则不重复。即使宿主技能目录未列出 media-assistant，也使用此实际安装路径读取，不把 Hook 摘要当完整 Skill。`,
        "业务模式识别：用户明确说“询价机构/机构询价/MCN 询价”时直接使用“询价机构”；明确说“手动拓展/人工拓展/直接手扒/手扒/手捞筛选”时统一使用用户侧模式“手动拓展”；明确说“只扒达人信息/只扒达人/导出达人表/达人详情表”等只想按达人 ID 或链接导出指定字段、不要需求解析和询价的，走第三种业务模式“只扒达人信息”，不建 requirement、不调 ypscan_parse_requirement 和 validate_requirement。手动拓展与只扒达人信息的判别：用户给的是搜索筛选条件（达人方向、标签、品类等，需要后台搜索抓取）走手动拓展；用户给的是具体达人 ID 或主页链接（已知达人，直接补全导出）走只扒达人信息。用户说“手扒/扒这几个达人”且给了具体 ID 或链接时按只扒达人信息处理，只给方向或条件时按手动拓展处理。未明确、同时出现多种模式或语义冲突时，必须先逐字调用下方 AskUserQuestion；回答前不得解析或落库。",
        `BUSINESS_MODE_QUESTION_ARGS=${JSON.stringify(businessModeQuestionPayload())}`,
      ];

      if (!startupScopes.has(scope)) {
        startupScopes.add(scope);
        lines.push(
          "[YPscan startup instruction]",
          "用户已明确的需求或修改直接执行；内部解析、保存和轮询持续推进，不以进度通知索取确认。只在必要输入、业务决策或真实阻塞处停下。面向用户说明正在做什么、是否需要操作和下一步；不主动展示 requirement_id、batch_id、工具名称或落库术语，不把阶段完成说成最终交付。",
          "用户可见的表格只有评分表、汇总表、MCN 排名表和机构回填预览表；links CSV、补全 CSV 和 merged CSV 都是内部中间产物，不主动展示表格、下载链接或本地文件路径，也不作为交付物报告；用户明确索取或要求诊断时除外。",
          SEARCH_PARAMETER_REVIEW_RULE,
          "可用工具以当前宿主提供的工具列表为准；插件业务注册表和 Provider 白名单不是宿主全部工具目录。沿用裸工具名或完整名称最后一个 __ 后的实际工具名匹配；额外兼容 mcp-<server>_<工具名>，按所需工具的完整名称后缀匹配。前缀（含 test）只是命名空间。单一匹配直接调用宿主展示的完整名称；多个同名匹配才用 AskUserQuestion 请用户选择；无匹配才报告工具未开放。",
          `选择业务模式后，把同一用户侧 business_mode 传给 ypscan_parse_requirement 和 validate_requirement.rawMessagesJson；插件在 Provider 边界把“手动拓展”兼容映射为旧线值，Agent 不得自行改写。business_mode 决定本次新建 requirement 进入的功能。询价链路：解析→复核→validate_requirement→search_creators→rank_mcns→选择机构和字段→发送确认→create_with_distributions→sync_mcn_inquiry_status→ingest_mcn_submissions→get_ingest_job→保存机构达人预览表→ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV→原生补全（20/批）→file_bridge（flow=manual_source）→score_manual_source_csv→score_status→保存打分排序 Excel。手动拓展：解析→复核→validate_requirement→选择字段→manual_source_creators→manual_source_creators_status→保存并归一化 links CSV→ypscan_summarize_manual_scores 取得当前批→原生补全（最多20人，小红书 get_xhs_author_business_card 且固定 page_count=1；抖音 get_douyin_author_business_card）→file_bridge（仅当前批）→score_manual_source_csv→score_manual_source_csv_status→保存单批表→再次汇总（达标交付，否则下一批）。需求 ID 优先 data.requirement_id，缺失时兼容 data.id，绝不使用 data.demand_id。发送前必须用警示弹窗确认：AskUserQuestion 一次只问一个问题、恰好两个选项“确认发送/返回修改”、不设 multiSelect；最终机构名单与完整企微消息写入问题正文，不得把机构或消息列为选项；正文保留企微消息原有行结构，只在单行将超过 20 字符时断行，禁止把短分句、字段或项目名拆成多行。用户选择“确认发送”或明确无条件回复“可以发/发吧/按这个发/就这样发送”可发送一次；否定、修改或条件表达不算确认。create_with_distributions 的 description 与 wechat_notification_message 内容一致。supplierIds 和 supplier_name 始终为数组。用户明确提供或提名机构名时，先只在本轮同一 requirement ID、同一平台的 rank_mcns.data.mcns 中做唯一精确匹配；命中非空 supplier_id 放 supplierIds，未命中或无 ID 的原名放 supplier_name，不模糊匹配或跨轮复用。`,
          REQUIREMENT_CREATION_RULE,
          FIELD_SELECTION_REUSE_RULE,
          INQUIRY_RECIPIENT_RESUME_RULE,
          "所有 AskUserQuestion 弹窗的 header、question、label 和 description 只在整行将超过 20 个 Unicode 字符时换行，先连续写满接近 20 再断行（确需断行时优先语义边界），禁止把短分句、字段或项目名单独成行，保留消息原有的行结构；长机构名可为展示插入换行，匹配前移除换行还原原名。",
          "机构回填预览链路先保存预览表，再让用户选择是否补全；选“补全并打分排序”时继续 ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV → 原生补全（20/批）→ file_bridge（flow=manual_source）→ score_manual_source_csv → score_status → 保存打分排序 Excel。回收不足时不自动放宽，交付真实结果。",
          "仅询价机构分支调用 search_creators；成功后忽略 creators_export_path 等表格链接，直接用同一 requirement ID 调用 rank_mcns。rank_mcns 成功后先输出完整五列表格，再保存 MCN 排名表；保存成功后展示本地链接并调用收件机构选择弹窗，不得再次询问业务模式。",
          "MCN 用户可见输出格式锁：rank_mcns 成功后不得根据响应 schema、原始字段、旧模板或上一轮结果自行设计表格。只能输出五列 Markdown 表格：排名、机构、覆盖达人、返点、综合分；列名、顺序和数量不得改动。字段映射固定：排名=rank_no（缺省按响应顺序）、机构=agency_name、覆盖达人=candidate_count、返点=rebate_rate、综合分=rank_score。特别禁止 Supplier ID/supplier_id、候选达人、供给占比、手动拓展补量、推荐理由及其他 rank_mcns 字段或汇总。",
          "手动拓展分支先选择字段，再调用 manual_source_creators；该工具由后台 API 完成搜索和落库。manual_source_creators 传 requirement_id，live schema required num 时附 num（用户想要的达人数量，取 Hook 注入的 MANUAL_SOURCE_NUM，没有可信人数时先问清用户），需求由 Provider 从后台读取；manual_source_creators_status 按当前环境 live schema 传入梯度取数 num（这是状态查询的取数数量，不是提交的 num；如 5 人→15、10 人→30、30 人→60，非穷举，实际值取 Hook 的 MANUAL_SOURCE_TARGET_NUM）。返回 batch_id 后先等待 30 秒，再按同一 requirement_id / batch_id 轮询，累计最多 10 次。新链路下成功结果的主产物是 creator_links_csv_url：先保存 manual_creator_links CSV，再用 ypscan_save_creator_links 归一化为受控三列 links CSV，然后调用 ypscan_summarize_manual_scores 取得最多20人的当前批名单；仅按该名单调用当前平台对应的 YP Action 原生达人补全工具。每批只认 csv_file、successful_author_ids、failed_author_ids，部分成功保留同一个 CSV，不自动重试整批；全部失败时 csv_file=null，停止 file_bridge 和打分。每批补全后仅以当前批 CSV 调用 file_bridge（flow=manual_source）并评分；每份评分表保存为 manual_score_batch 后再汇总，推荐人数达标立即交付汇总 Excel，否则继续下一批直到梯度候选池耗尽；score 返回 job_id 时用 score_manual_source_csv_status 每 30 秒查询一次、累计最多 10 次，完成后保存为 manual_score_batch 再汇总；score 仍同步返回 Excel 时也按单批保存并汇总。第 10 次仍未完成时如实报告并停止，不弹窗、不自动查询第 11 次。结果不足且用户确认放宽后重建搜索时，传 requirement_id，live schema required num 时附同一 num（交付目标人数不变），由 Provider 从后台读取已保存的完整有效需求，搜索返回后核对实际搜索参数与放宽值一致，不一致时如实报告放宽未传导。",
          "原生达人补全工具由宿主 YP Action 提供、不在 ypscan 白名单内：小红书 get_xhs_author_business_card 且固定 page_count=1，抖音 get_douyin_author_business_card。宿主未开放对应工具时如实报告工具未开放并停止补全链路，不得改用 Browser 或其他手扒工具代替。",
          MANUAL_SOURCE_SHORTFALL_RULE,
          MANUAL_SOURCE_ARGUMENT_RULE,
          "手动拓展最终汇总 Excel 或旧版兼容 Excel 保存成功后原样展示 delivery.local_file_link；手动拓展的 manual_score_batch 单批中间表不展示表格、路径或链接，不再提供浏览器详细拓展分支，也不追加完成弹窗。",
          "只扒达人信息链路（不建需求）：用户缺平台或达人 ID/链接时先问清（不猜测、不默认平台），拿到后调 select_inquiry_form_fields 传 platform 和 creator_ids/creator_links（不传 requirement_id、source_requirement_id、force_reselect；无来源需求可继承，每次都是首次选字段），拿到 field_id 和字段选择页 URL，单独一行原样展示 URL 让用户选字段；与需求维度不同，展示 URL 后本轮不结束：按当前平台原生达人补全工具补全这批达人（沿用现有批量与参数约束，超上限分批补全；部分成功保留成功达人继续，全部失败停止并如实告知不编造），补全 CSV 用 file_bridge(flow=creator_detail, field_id) 上传得到 source_csv_file_link（用户上传了自定义表格时再用 file_bridge 上传得到 custom_table_oss_url，可选）；然后用同一 field_id 调 excel_export(field_id, source_csv_file_link, custom_table_oss_url?)，后端查 get_creator_detail_run.columns 校验字段是否已提交：已提交则导出达人表并原样展示下载链接，未提交则返回「未选择字段」+URL，重新展示 URL 等用户提交后重试 excel_export。不轮询 get_inquiry_form_fields_status、不主动停下等口头确认、不调用 score_manual_source_csv、不评分排序、不建 requirement。source_csv_file_link 无效时重新上传补全 CSV 再重试。",
          "需求澄清规则：解析返回的八个可选 Label 数组是纯解析结果，有什么就原样落库什么，保留元素与顺序，不要求原文逐项举证，不调用 AskUserQuestion 确认、不询问任何标签内容；可选 Label（包括主达人类型 pgyBloggerTypeLabel/xtTalentTypeLabel）为 null 或缺失时直接省略，不做映射、不推断、不弹窗。contentTag 必须是本次解析结果中的非空数组；缺失或无效时重新解析，禁止询问用户或自行补值。数值字段先采用 Dify 唯一解析值，再与最新非空 clarification 合并；同一字段新答案覆盖旧答案，其他已确认且未修改的数值继续复用。Dify 已给出唯一 followercount、rebate、报价、CPM、CPE 时禁止再问。只有这些必填数值仍缺失、null、多候选或与用户明确改口冲突时才调用 AskUserQuestion。当前平台 Dify 品牌候选唯一、合法且非空时必须原样作为 brandName，不得询问、改写或被原文与 clarification 覆盖；解析品牌缺失、多候选或为 null、未知等占位值时才询问。项目名由 Agent 根据当前需求自行总结生成，不弹窗确认；调用 validate_requirement 前用一句可见正文告知用户取的项目名。禁止编造标签、默认补数值或普通文本追问。解析 Workflow 唯一合法报价、CPM、CPE 候选直接复用，不因原文单值与 Provider 区间格式差异询问；同平台多个达人类型只保留一个 requirement，总量不变并合并条件，不拆分或追问每类人数。正常成功交付不追加完成弹窗。",
          REQUIREMENT_COMPLETENESS_RULE,
          "询价机构这些业务值缺失、无效或需要选择时，必须在调用前一次性通过 AskUserQuestion 收集；手动拓展只对三项业务必填这样处理。",
          REBATE_MINIMUM_QUESTION_RULE,
          MANUAL_REBATE_DEFAULT_RULE,
          MANUAL_REQUIREMENT_INPUT_RULE,
          NUMERIC_CLARIFICATION_QUESTION_RULE,
          INQUIRY_RECIPIENT_RESPONSE_RULE,
          `validate_requirement 数值字段格式锁：${VALIDATE_REQUIREMENT_RANGE_PARAMS.join(",")} 使用${REQUIREMENT_RANGE_FORMAT}，禁止数组、对象、单个数字、百分号文本或自然语言；${VALIDATE_REQUIREMENT_SCALAR_PARAMS.join(",")} 在 Provider 侧是单值 float，只传单个非负数值字符串，禁止区间、数组或百分号文本，无法用单值表达时省略；rebate 固定为 "[min,1]"；followercount 未明确或“不限”时默认落库 [0,999999999]。第一次调用前一次性检查全部必填字段和格式，禁止通过 Provider 报错逐字段、逐类型试探。`,
          "Dify 已给出的唯一数值直接采用，禁止再问；本地只做区间格式与粉丝技术上限截断，粉丝缺失或“不限”默认落库 [0,999999999]、不弹窗。只有解析缺失、null、多候选或与用户明确改口冲突时才阻断。",
          "需求解析复核、结果不足后的二次复核与逐项放宽、用户修改需求后的重建规则，统一按 media-assistant Skill 执行；Hook 只提供当前工具结果和下一步动态参数。",
          "手动拓展启动传 requirement_id，live schema required num 时附 num（用户想要的达人数量，取 MANUAL_SOURCE_NUM；缺人数先问清），不传 demand；状态查询按 live schema 传梯度取数 num。禁止生成或暗示 size、creator_count、page_url、original_brief 等旧字段。",
          PARSED_METRIC_REUSE_RULE,
          SINGLE_REQUIREMENT_TYPE_RULE,
          CLARIFICATION_REUSE_RULE,
          MANUAL_EFFECTIVE_DEMAND_REPARSE_RULE,
        );
      }
      return { prependContext: lines.join("\n") };
    },
    HOOK_OPTIONS,
  );

  api.on(
    "before_tool_call",
    (event, context) => {
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      const bare =
        resolveFlowToolName(toolName.toLowerCase()) ?? toolName.toLowerCase().split("__").at(-1);
      const params = paramsFromEvent(event);
      if (bare === "get_inquiry_form_fields_status") {
        const requirementId = firstString(params?.requirement_id);
        const pendingLink = requirementId
          ? fieldPageLinkByRequirement.get(String(requirementId))
          : null;
        if (pendingLink && !pendingLink.blockedOnce) {
          pendingLink.blockedOnce = true;
          return { block: true, blockReason: fieldPageLinkGateReason(pendingLink.url) };
        }
      }
      const key = callKey(event, context);
      const scope = scopeKey(event, context);
      const remember = (values) => {
        if (!key) return;
        // Retain only directive/correlation fields, never full briefs or download URLs.
        const minimal = {};
        for (const field of [
          "requirement_id",
          // 字段选择的这两个参数决定工具结果指令走重选/继承分支，必须在 pending 记录里保留。
          "source_requirement_id",
          "force_reselect",
          // 只扒达人信息：无需求时传达人，导出时定位字段选择会话。
          "creator_ids",
          "creator_links",
          "field_id",
          "id",
          "artifact_id",
          "artifact_kind",
          "platform",
          "quantityTotal",
          "projectName",
          "inquiry_ids",
          "job_id",
          "flow",
          "batch_id",
          "num",
        ]) {
          if (values[field] !== undefined) minimal[field] = structuredClone(values[field]);
        }
        // 缺列恢复要按本轮可信路径原样重提打分：只对当前 score 调用保留其 csv_file_path。
        if (bare === "score_manual_source_csv") {
          const csvFilePath = firstString(values.csv_file_path);
          if (csvFilePath) minimal.csv_file_path = csvFilePath;
        }
        if (bare === "ingest_mcn_submissions") {
          const requirementId = requirementIdForInquiryIds(
            values.inquiry_ids,
            inquiryIdsByRequirement.get(scope) ?? new Map(),
          );
          if (requirementId) minimal.requirement_id = requirementId;
        }
        if (bare === "score_manual_source_csv_status") {
          const jobId = providerJobId({ data: values });
          const record =
            jobId == null
              ? null
              : scoreJobRecoveryByScope.get(JSON.stringify([scope, String(jobId)]));
          if (record?.requirement_id) minimal.requirement_id = record.requirement_id;
        } else if (bare === "get_ingest_job") {
          const jobId = providerJobId({ data: values });
          const requirementId =
            jobId == null
              ? null
              : requirementIdByIngestJobId.get(JSON.stringify([scope, String(jobId)]));
          if (requirementId) minimal.requirement_id = requirementId;
        }
        pendingCalls.set(key, {
          bare,
          params: minimal,
          requirementId: currentRequirementIdByScope.get(scope),
          fieldId: currentFieldIdByScope.get(scope),
          mode: businessModeFromParams(values),
        });
      };
      if (bare !== "validate_requirement") {
        if (
          REQUIREMENT_ID_TOOLS.has(bare) ||
          [
            "search_creators",
            "rank_mcns",
            "ypscan_save_artifact",
            "ingest_mcn_submissions",
            "get_ingest_job",
            "score_manual_source_csv_status",
            "get_xhs_author_business_card",
            "get_douyin_author_business_card",
            "excel_export",
          ].includes(bare)
        )
          remember(params);
        return undefined;
      }
      const normalized = normalizeToolCallParams(toolName, params);
      const issues = validateRequirementPreflight(normalized);
      if (issues.length > 0) {
        return {
          block: true,
          blockReason: requirementPreflightBlockReason(issues),
        };
      }
      const providerParams = serializeProviderRawMessages(normalized);
      remember(providerParams);
      const mode = businessModeFromParams(providerParams);
      const platform = canonicalPlatformName(providerParams.platform);
      if (mode) businessModeByScope.set(scopeKey(event, context), mode);
      if (platform) platformByScope.set(scopeKey(event, context), platform);
      return providerParams === params ? undefined : { params: providerParams };
    },
    HOOK_OPTIONS,
  );

  api.on(
    "tool_result_persist",
    (event, context) => {
      hydrateManualScoreSources(context?.workspaceDir);
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      const key = callKey(event, context);
      const pending = key ? pendingCalls.get(key) : null;
      if (key) pendingCalls.delete(key);
      const matched =
        pending?.bare ===
        (resolveFlowToolName(toolName.toLowerCase()) ?? toolName.toLowerCase().split("__").at(-1))
          ? pending
          : null;
      const params = { ...(matched?.params ?? paramsFromEvent(event)) };
      const recordedMode = matched?.mode ?? businessModeByScope.get(scopeKey(event, context));
      const recordedPlatform = platformByScope.get(scopeKey(event, context));
      const bare =
        resolveFlowToolName(toolName.toLowerCase()) ?? toolName.toLowerCase().split("__").at(-1);
      const result = parsedToolResult(event?.message);
      const isNativeCompletion =
        bare === "get_xhs_author_business_card" || bare === "get_douyin_author_business_card";
      const scope = scopeKey(event, context);
      if (bare === "ypscan_save_artifact") {
        for (const field of ["artifact_kind", "artifact_id"]) {
          if (params[field] === undefined && result?.data?.[field] !== undefined)
            params[field] = result.data[field];
        }
      }
      const seenRequirementId = trustedRequirementId(bare, params, result);
      if (seenRequirementId) {
        currentRequirementIdByScope.set(scope, String(seenRequirementId));
        currentFieldIdByScope.delete(scope);
      }
      const seenFieldId =
        bare === "select_inquiry_form_fields"
          ? idString(result?.field_id ?? result?.data?.field_id)
          : null;
      if (seenFieldId) currentFieldIdByScope.set(scope, String(seenFieldId));
      if (isNativeCompletion && result?.success !== false && !event?.isSynthetic) {
        // 宿主原生补全返回没有 success 字段；与 directive 共用 csv_file 解析链，
        // 显式 success=false 的结果不登记上传来源。
        const csvFile = completionCsvFilePath(result);
        const fieldId = matched?.fieldId;
        const requirementId = matched?.requirementId;
        const path = normalizeLocalFilePath(csvFile, context?.workspaceDir);
        if (path && fieldId) {
          const set = completionCsvPathsByFieldId.get(fieldId) ?? new Set();
          set.add(path);
          completionCsvPathsByFieldId.set(fieldId, set);
        } else if (path && requirementId) {
          const set = completionCsvPathsByRequirement.get(requirementId) ?? new Set();
          set.add(path);
          completionCsvPathsByRequirement.set(requirementId, set);
        }
        // 全失败批次（csv_file=null）同样登记失败名单，避免汇总把失败达人重新排批。
        // 只扒达人信息（fieldId 维度）不登记需求维度的打分来源。
        if (requirementId && !fieldId) {
          const sources = manualScoreSourcesByRequirement.get(requirementId);
          if (sources) {
            const successfulIds = completionAuthorIds(result, "successful_author_ids") ?? [];
            const failedIds = completionAuthorIds(result, "failed_author_ids") ?? [];
            const successful = new Set(successfulIds.map((value) => String(value)));
            const failed = new Set(failedIds.map((value) => String(value)));
            if ([...successful].some((id) => failed.has(id))) sources.source_conflict = true;
            // 重试成功取代旧失败；同一达人已成功后又出现在失败名单才是冲突。
            const previousSuccessful = new Set();
            for (const [key, previous] of [...sources.completion_results]) {
              for (const id of previous?.successful_author_ids ?? [])
                previousSuccessful.add(String(id));
              const previousFailed = previous?.failed_author_ids ?? [];
              const remaining = previousFailed.filter((id) => !successful.has(String(id)));
              if (remaining.length !== previousFailed.length) {
                const next = { ...previous, failed_author_ids: remaining };
                if (remaining.length === 0 && !next.file_path) {
                  sources.completion_results.delete(key);
                } else {
                  sources.completion_results.set(key, next);
                }
              }
            }
            if ([...failed].some((id) => previousSuccessful.has(id)))
              sources.source_conflict = true;
            if (path || successful.size || failed.size) {
              const record = {
                file_path: path,
                platform: bare === "get_xhs_author_business_card" ? "xiaohongshu" : "douyin",
                successful_author_ids: successfulIds,
                failed_author_ids: failedIds,
              };
              const recordKey = completionResultKey(record);
              const previous = sources.completion_results.get(recordKey);
              if (previous && JSON.stringify(previous) !== JSON.stringify(record))
                sources.source_conflict = true;
              sources.completion_results.set(recordKey, record);
            }
            recordManualScoreSourceChange(requirementId, context?.workspaceDir);
          }
        }
      }
      if (bare === "validate_requirement" && result?.success === true) {
        const requirementId = firstString(result?.data?.requirement_id, result?.data?.id);
        const platform = firstCanonicalPlatform(
          params?.platform,
          result?.data?.platform,
          result?.platform,
          recordedPlatform,
        );
        if (requirementId) {
          if (platform) platformByRequirement.set(String(requirementId), platform);
          // 项目名由 Agent 在 validate 时自行总结；记入需求来源记录，仅用于本地交付文件名。
          const projectName = safeNameSegment(params?.projectName);
          const sources = manualScoreSourcesByRequirement.get(String(requirementId));
          if (sources) {
            if (projectName) sources.project_name = projectName;
          } else if (recordedMode) {
            manualScoreSourcesByRequirement.set(String(requirementId), {
              business_mode: recordedMode,
              project_name: projectName,
              links_file: null,
              completion_results: new Map(),
              score_files: new Map(),
              source_conflict: false,
            });
          }
          // 持久化 validate 调用参数里的目标交付数量，作为 manual_source_creators_status 梯度取数数量的确定性来源。
          const quantityTotal = positiveInteger(params?.quantityTotal);
          if (quantityTotal != null)
            quantityTotalByRequirement.set(String(requirementId), quantityTotal);
          if (manualScoreSourcesByRequirement.has(String(requirementId)))
            recordManualScoreSourceChange(String(requirementId), context?.workspaceDir);
        }
      } else if (result?.success === true) {
        const requirementId = firstString(params?.requirement_id, params?.id, params?.artifact_id);
        const platform = canonicalPlatformName(params?.platform);
        if (requirementId && platform) platformByRequirement.set(String(requirementId), platform);
        if (bare === "sync_mcn_inquiry_status") {
          const rawIds = syncInquiryIds(result);
          const id = firstString(
            result?.data?.requirement_id,
            result?.requirement_id,
            params?.requirement_id,
          );
          if (id && Array.isArray(rawIds)) {
            const inquiries = inquiryIdsByRequirement.get(scope) ?? new Map();
            inquiries.set(String(id), normalizeInquiryIds(rawIds));
            inquiryIdsByRequirement.set(scope, inquiries);
          }
        }
        if (bare === "score_manual_source_csv" || bare === "score_manual_source_csv_status") {
          const jobId = providerJobId(result) ?? providerJobId({ data: params });
          const id = firstString(
            params?.requirement_id,
            result?.data?.requirement_id,
            result?.requirement_id,
          );
          if (jobId != null && id) {
            const key = JSON.stringify([scope, String(jobId)]);
            const previous = scoreJobRecoveryByScope.get(key);
            const csvFilePath = firstString(params?.csv_file_path) ?? previous?.csv_file_path;
            scoreJobRecoveryByScope.set(key, {
              requirement_id: String(id),
              ...(csvFilePath ? { csv_file_path: csvFilePath } : {}),
            });
          }
        } else if (bare === "ingest_mcn_submissions" || bare === "get_ingest_job") {
          const jobId = providerJobId(result) ?? providerJobId({ data: params });
          const id = firstString(
            params?.requirement_id,
            result?.data?.requirement_id,
            result?.requirement_id,
            requirementIdForInquiryIds(
              params?.inquiry_ids,
              inquiryIdsByRequirement.get(scope) ?? new Map(),
            ),
          );
          if (jobId != null && id)
            requirementIdByIngestJobId.set(JSON.stringify([scope, String(jobId)]), String(id));
        }
      }
      const jobId = providerJobId(result) ?? providerJobId({ data: params });
      let directiveParams = params;
      if (jobId != null && !nonemptyString(firstString(params?.requirement_id))) {
        const requirementId =
          bare === "score_manual_source_csv_status"
            ? scoreJobRecoveryByScope.get(JSON.stringify([scope, String(jobId)]))?.requirement_id
            : bare === "get_ingest_job"
              ? requirementIdByIngestJobId.get(JSON.stringify([scope, String(jobId)]))
              : null;
        if (requirementId) directiveParams = { ...params, requirement_id: requirementId };
      }
      if (
        bare === "score_manual_source_csv_status" &&
        jobId != null &&
        !nonemptyString(firstString(directiveParams?.csv_file_path))
      ) {
        const csvFilePath = scoreJobRecoveryByScope.get(
          JSON.stringify([scope, String(jobId)]),
        )?.csv_file_path;
        if (csvFilePath) directiveParams = { ...directiveParams, csv_file_path: csvFilePath };
      }
      if (isNativeCompletion && matched?.requirementId) {
        const sources = manualScoreSourcesByRequirement.get(matched.requirementId);
        directiveParams = {
          ...directiveParams,
          requirement_id: matched.requirementId,
          links_csv_path: sources?.links_file?.file_path,
          platform: platformByRequirement.get(matched.requirementId),
        };
      }
      if (
        jobId != null &&
        (providerExcelUrl(result) ||
          FAILED_ASYNC_STATUSES.has(
            String(result?.data?.status ?? result?.status ?? "").toLowerCase(),
          ))
      ) {
        const jobs =
          bare === "score_manual_source_csv_status"
            ? scoreJobRecoveryByScope
            : bare === "get_ingest_job"
              ? requirementIdByIngestJobId
              : null;
        jobs?.delete(JSON.stringify([scope, String(jobId)]));
      }
      const directiveRequirementId =
        bare === "ypscan_save_artifact"
          ? firstString(
              directiveParams.artifact_id,
              directiveParams.requirement_id,
              matched?.requirementId,
            )
          : firstString(
              directiveParams.requirement_id,
              directiveParams.artifact_id,
              matched?.requirementId,
            );
      const requirementMode = directiveRequirementId
        ? (manualScoreSourcesByRequirement.get(String(directiveRequirementId))?.business_mode ??
          null)
        : null;
      const requiresRequirementMode =
        bare === "ypscan_save_artifact" && directiveParams.artifact_kind === "manual_score_batch";
      const effectiveMode = requirementMode ?? (requiresRequirementMode ? null : recordedMode);
      let directive = flowDirective(
        toolName,
        event?.message,
        directiveParams,
        effectiveMode,
        recordedPlatform,
        (requirementId) =>
          nonemptyString(requirementId)
            ? (platformByRequirement.get(String(requirementId)) ?? null)
            : null,
        (requirementId) =>
          nonemptyString(requirementId)
            ? (quantityTotalByRequirement.get(String(requirementId)) ?? null)
            : null,
      );
      const fieldPageRequirementId = nonemptyString(directiveRequirementId)
        ? String(directiveRequirementId)
        : null;
      if (bare === "select_inquiry_form_fields" && fieldPageRequirementId) {
        const fieldSelectionUrl = directiveFieldSelectionUrl(directive);
        const pollEligible =
          directiveParams?.force_reselect !== true &&
          !nonemptyString(directiveParams?.source_requirement_id);
        if (fieldSelectionUrl && pollEligible) {
          fieldPageLinkByRequirement.set(fieldPageRequirementId, {
            url: fieldSelectionUrl,
            blockedOnce: false,
          });
        } else {
          fieldPageLinkByRequirement.delete(fieldPageRequirementId);
        }
      } else if (bare === "get_inquiry_form_fields_status" && fieldPageRequirementId) {
        const status = String(
          firstString(result?.status, result?.data?.status) ?? "",
        ).toLowerCase();
        if (status === "submitted" || status === "invalid") {
          fieldPageLinkByRequirement.delete(fieldPageRequirementId);
        } else {
          const pendingLink = fieldPageLinkByRequirement.get(fieldPageRequirementId);
          if (pendingLink) directive = `${directive}\n${fieldPageLinkReminder(pendingLink.url)}`;
        }
      }
      return appendDirective(event?.message, directive);
    },
    HOOK_OPTIONS,
  );

  return {
    resetTransientState() {
      pendingCalls.clear();
      startupScopes.clear();
      businessModeByScope.clear();
      platformByScope.clear();
      platformByRequirement.clear();
      inquiryIdsByRequirement.clear();
      quantityTotalByRequirement.clear();
      fieldPageLinkByRequirement.clear();
      scoreJobRecoveryByScope.clear();
      requirementIdByIngestJobId.clear();
      currentRequirementIdByScope.clear();
      currentFieldIdByScope.clear();
      linksCsvPathsByRequirement.clear();
      previewFilesByRequirement.clear();
      completionCsvPathsByRequirement.clear();
      completionCsvPathsByFieldId.clear();
      manualScoreSourcesByRequirement.clear();
      manualScoreSourcesStoreByRequirement.clear();
      hydratedManualScoreStores.clear();
    },
    projectNameFor(requirementId, workspaceDir) {
      if (nonemptyString(requirementId)) hydrateManualScoreSources(workspaceDir);
      return manualScoreSourcesByRequirement.get(String(requirementId))?.project_name ?? null;
    },
    manualScoreContextFor(requirementId, workspaceDir) {
      if (nonemptyString(requirementId)) hydrateManualScoreSources(workspaceDir);
      const sources = manualScoreSourcesByRequirement.get(requirementId);
      if (!sources) return undefined;
      return {
        ...sources,
        platform: platformByRequirement.get(requirementId),
        quantityTotal: quantityTotalByRequirement.get(requirementId),
        completion_results: [...sources.completion_results.values()],
        score_files: [...sources.score_files.values()],
      };
    },
    recordSavedCsvArtifact(artifactKind, artifactId, result, workspaceDir) {
      if (artifactKind === "manual_score_batch") {
        const sources = manualScoreSourcesByRequirement.get(artifactId);
        const { file_path, sha256 } = result?.details ?? {};
        const path = normalizeLocalFilePath(file_path, workspaceDir);
        if (sources && path && nonemptyString(sha256) && !result?.isError) {
          const previous = sources.score_files.get(path);
          if (previous && previous.sha256 !== sha256) sources.source_conflict = true;
          sources.score_files.set(path, { file_path: path, sha256 });
          recordManualScoreSourceChange(String(artifactId), workspaceDir);
        }
        return;
      }
      if (artifactKind === "mcn_creator_preview") {
        const { file_path: filePath, sha256 } = result?.details ?? {};
        if (
          !nonemptyString(artifactId) ||
          !nonemptyString(filePath) ||
          !nonemptyString(sha256) ||
          result?.isError
        )
          return;
        const path = normalizeLocalFilePath(filePath, workspaceDir);
        if (!path) return;
        const files = previewFilesByRequirement.get(artifactId) ?? new Map();
        files.set(path, sha256);
        previewFilesByRequirement.set(artifactId, files);
        return;
      }
      if (artifactKind !== "manual_creator_links" && artifactKind !== "mcn_creator_links") {
        return;
      }
      const id = nonemptyString(artifactId) ? String(artifactId) : null;
      if (!id) return;
      // saveArtifact 返回 hostToolResult（{content, details}），文件路径在 details 上，
      // 不在顶层 data/delivery 上。
      const filePath = firstString(result?.details?.file_path);
      if (!filePath) return;
      const set = linksCsvPathsByRequirement.get(id) ?? new Set();
      set.add(normalizeLocalFilePath(filePath, workspaceDir));
      linksCsvPathsByRequirement.set(id, set);
    },
    recordLinksCsv(requirementId, filePath, workspaceDir, sha256 = null) {
      const id = nonemptyString(requirementId) ? String(requirementId) : null;
      if (!id || !filePath) return;
      const set = linksCsvPathsByRequirement.get(id) ?? new Set();
      set.add(normalizeLocalFilePath(filePath, workspaceDir));
      linksCsvPathsByRequirement.set(id, set);
      const sources = manualScoreSourcesByRequirement.get(id);
      if (sources && nonemptyString(sha256)) {
        const record = { file_path: normalizeLocalFilePath(filePath, workspaceDir), sha256 };
        if (sources.links_file && JSON.stringify(sources.links_file) !== JSON.stringify(record))
          sources.source_conflict = true;
        sources.links_file = record;
        recordManualScoreSourceChange(id, workspaceDir);
      }
    },
    linksCsvPathsFor(requirementId) {
      if (!nonemptyString(requirementId)) return [];
      return [...(linksCsvPathsByRequirement.get(String(requirementId)) ?? [])];
    },
    previewFilesFor(requirementId) {
      return [...(previewFilesByRequirement.get(requirementId) ?? [])].map(
        ([file_path, sha256]) => ({ file_path, sha256 }),
      );
    },
    completionCsvPathsFor(id) {
      const key = id == null ? "" : String(id).trim();
      if (!key) return [];
      return [
        ...(completionCsvPathsByRequirement.get(key) ?? []),
        ...(completionCsvPathsByFieldId.get(key) ?? []),
      ];
    },
  };
}
