# 参数契约与预检

`src/contract/registry.js` 是 Provider 面向流程共用的参数边界：确定性、无损归一化 + 无状态预检，不保留 workflow 状态。

## 1. 常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `BUSINESS_MODE_VALUES` | `["询价机构", "手动拓展"]` | 用户侧业务模式 |
| `PROVIDER_MANUAL_BUSINESS_MODE` | `直接手扒` | 手动拓展的 Provider 兼容线值，仅出站边界映射，Agent 不得使用或展示 |
| `HOST_PREFIXES` | `mcp__ypscan__`、`ypscan__`、`mcp__ypmcn__`、`ypmcn__`、`test__` | 工具名前缀（命名空间），按最后一个 `__` 后段匹配实际工具名 |
| 平台别名 | `xhs`/`小红书`→`xiaohongshu`；`dy`/`抖音`→`douyin` | 归一化规则 |
| `MAX_FOLLOWER_COUNT` | `999_999_999` | 粉丝技术上限 |
| `UNRESTRICTED_FOLLOWERCOUNT_RANGE` | `"[0,999999999]"` | 粉丝无要求时的落库值 |
| `TOOL_REGISTRY` | 18 个业务工具名 | 含已弃用工具名，供 `stripHostPrefix` 做宿主工具名匹配；不代表白名单 |

## 2. Provider MCP 白名单（manifest `toolFilter.include`）

`validate_requirement`、`search_creators`、`rank_mcns`、`select_inquiry_form_fields`、`create_with_distributions`、`sync_mcn_inquiry_status`、`ingest_mcn_submissions`、`get_ingest_job`、`manual_source_creators`、`manual_source_creators_status`、`score_manual_source_csv`、`rank_creators`、`get_workflow_state`（共 13 个）。

明确不暴露：`create_submission_batch`、`get_creator_detail`、`get_creator_detail_export`、`get_selected_inquiry_form_fields`（已弃用）。

## 3. validate_requirement 参数契约

`VALIDATE_REQUIREMENT_PARAMS` 共 64 个已声明字段；未声明字段在预检中被拒。

### 必填（10 个）

`status`、`platform`、`brandName`、`projectName`、`quantityTotal`、`submissionDeadlineAt`、`rebate`、`followercount`、`contentTag`、`rawMessagesJson`。

- `status` 固定 `"ready"`；`projectName` 由 Agent 根据需求自行总结生成，不弹窗询问。
- `platform` 只允许 `xiaohongshu` / `douyin`。
- `contentTag` 必须来自本次解析结果、非空字符串数组；缺失或无效时重新解析，禁止询问或自补。
- `rawMessagesJson` 必须含非空 `original`（原文）、`parse_outputs`（本次契约输出对象）、以及用户侧 `business_mode`（`询价机构` 或 `手动拓展`）；弹窗答案写回 `rawMessagesJson.clarifications`，同字段新答案覆盖旧答案。

### 数值区间字段（31 个，`VALIDATE_REQUIREMENT_RANGE_PARAMS`）

`rebate`、`followercount`、`interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`photoInteract`、`userlikecount`、`likeIncrement`、`avgview`、`avglike`、`avgcomment`、`avgcollect`、`avginteract`、`femaleRate`、`age1Rate`–`age6Rate`、`cpeL1/L2/L3`、`cpmL1/L2/L3`、`kolOfficialPriceL1/L2/L3`。

格式锁：无空格 JSON 区间字符串 `"[min,max]"` 且 `0 ≤ min < max`；禁止数组、对象、单值、百分号文本或自然语言。特例：

- `rebate` 表示最低返点，固定 `"[min,1]"`。
- CPM/CPE（`cpmL*`、`cpeL*`）表示最大可接受值，固定 `"[0,max]"`。
- 比例字段（`interactionRate`、`femaleRate`、`age*Rate`）区间必须位于 0–1。
- `followercount` 上限不得超过 `999999999`；原文表达“无粉丝要求”时落库 `"[0,999999999]"`。

### 平台标签数组

- 小红书：`contentFeatureLabel`、`growBloggerTypeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel` + `contentTag`。
- 抖音：`contentThemeLabel`、`growTalentTypeLabel`、`industryTagLabel`、`xtTalentTypeLabel` + `contentTag`。
- 8 个可选 Label 有则原样落库（保留元素与顺序），null/缺失则省略；不做映射、不推断、不询问。

### 平台档位约束

- 抖音：报价/CPM/CPE 只用 L2=植入视频、L3=定制视频；出现 L1 字段即预检失败；提交的 L2/L3 字段必须与需求中的明确视频类型一致。
- 小红书：不传任何 L3 字段（`kolOfficialPriceL3`、`cpmL3`、`cpeL3`）。

## 4. 归一化行为（`normalizeToolCallParams`，仅 validate_requirement）

| 字段 | 规则 |
| --- | --- |
| `platform` | 别名归一化到 `xiaohongshu`/`douyin` |
| `status` | 缺失/空时补 `"ready"` |
| `brandName` | 单元素字符串数组解包；优先采用当前平台 Dify 唯一合法品牌 |
| `quantityTotal` | 归一化为正整数字符串；非法则删除该字段（交预检报错） |
| 区间字段 | 标量→`[v,v]` 起步；百分号字符串（如 `"20%"`、`"10%-30%"`）解析并换算比例；中文区间 `-~～至到` 解析；`rebate`→`"[min,1]"`；粉丝“无/不限”→`"[0,999999999]"`；粉丝超上限截断到 `999999999`；CPM/CPE 标量→`"[0,v]"`；报价标量→`[floor(v×0.7), ceil(v×1.2)]`（Provider 检索单价只按原价下 30%/上 20% 扩展一次，不回写需求参数） |
| `submissionDeadlineAt` | 归一化为 `YYYY-MM-DD HH:mm:ss`，仅当晚于当前时间 |
| 标签数组 | 字符串化 JSON 数组解包；Dify `parse_outputs` 中的标签/品牌/数值唯一值时自动补入缺失字段（抖音按视频类型对齐 L2/L3） |
| `rawMessagesJson` | `business_mode` 出站映射为 Provider 兼容线值（序列化为字符串在 `before_tool_call` 完成） |
| 空值清洗 | 非必填字段的 `null`/`"null"` 删除 |

## 5. 预检规则（`validateRequirementPreflight`）

返回 `{ field, reason }[]`；`before_tool_call` 据此阻断。除上述必填与格式外：

- 未知字段：`不是 validate_requirement 的已声明参数`。
- 证据门禁（来自 `rawMessagesJson.original` 与 `clarifications` 拼合的文本证据）：
  - `brandName` 必须原样使用当前平台唯一 Dify 解析品牌；仅解析缺失/多候选时使用最新弹窗答案。
  - `quantityTotal`、`submissionDeadlineAt` 必须有与提交值一致的原文/澄清证据。
  - `followercount`、`rebate`、报价：要么 Dify 给出唯一合法区间且提交值与其等价，要么原文/澄清中有对应证据。
  - `projectStartStart`/`projectStartEnd`（可选）：只能传明确日期，需原文证据，且开始不晚于结束。
- 布尔字符串字段（`hasOrganization`、`hasOrder30day`、`hasSocial30day`）必须是 `"true"`/`"false"`。
- 字符串字段类型校验；`rawMessagesJson` 结构校验。

预检是「完整性 + 规范格式」硬门禁；语义选择（放宽等）由 Agent 按 SKILL.md 在预检通过前完成，预检不代做业务决策。

## 6. 宿主工具名匹配

`stripHostPrefix` 先做全名精确匹配，再按 `前缀__业务名` 后缀匹配；不匹配返回 null（Hook 不处理）。这使 Provider 工具与本地工具在不同宿主命名空间下都能被 Hook 识别。
