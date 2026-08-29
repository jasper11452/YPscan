# ypscan_parse_requirement

## 定位

这是固定链路的第一步。插件把当前单个平台的完整最新需求直接提交给固定解析 Workflow；插件不再做本地 facts 校验、Provider 参数编译、搜索分组或语义补全。

首次处理一个平台需求时必须调用。成功后，`data.outputs` 只保留当前 Provider 契约消费的 Workflow 字段，字段值不改写、不解包。Workflow 内部字段以及运行 ID、需求指纹不对 Agent 暴露。Agent 使用解析结果，并按本卡补齐其余 `validate_requirement` 参数。

## 输入

只传：

```json
{ "demand": "当前单个平台的完整最新需求文本", "business_mode": "询价机构 或 直接手扒" }
```

- `business_mode` 必填：使用用户明确说出的模式，或在语义未明确/冲突时通过 `AskUserQuestion` 选定的模式（`询价机构` / `直接手扒`）；整个 requirement 保持该模式，缺失或不合法时本工具直接失败。
- 单平台需求直接传完整原文。
- 多平台需求按平台分别调用：保留明确共享条件和当前平台条件，删除另一平台专属条件，并明确写出当前平台；每个平台保留自己的最近一次成功结果。
- 不得为了让解析命中而添加用户没说过的条件。
- 为每个平台维护“当前用户原始条件”：只由用户最初原文和后续改口更新。`demand` 必须从这份原始条件重建，不得从解析输出、`validate_requirement` 参数或其他 Provider 归一化结果反向生成。

## 解析字段

解析 Workflow 首次为以下字段提供结果。八个可选 Label 数组和 `contentTag` 合法非 `null` 时直接采用，不要求用户再次确认；`contentTag` 是 Provider 必填解析结果，缺失或无效时必须重新解析，不得询问用户或自行补值。Dify 已给出的唯一 `followercount`、`rebate`、报价、CPM、CPE 同样直接采用，不要求原文关键词，不得再问。当前平台唯一合法、非占位的 Dify 品牌候选直接作为权威品牌采用：

| 类别           | 字段                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标签           | `growBloggerTypeLabel`、`contentFeatureLabel`、`contentThemeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`industryTagLabel`、`growTalentTypeLabel` |
| 文本和基础条件 | `contentTag`、`brandName`、`followercount`、`rebate`                                                                                                                         |
| 商业指标       | `kolOfficialPrice`、`cpm`、`cpe`                                                                                                                                             |

使用规则：

1. 八个可选 Label 数组和 `contentTag` 是可直接采用的解析结果。`contentTag` 必须是非空字符串数组；缺失或无效时必须重新解析，不得询问用户或自行补值。Dify 已给出的唯一 `followercount`、`rebate`、报价、CPM、CPE 也直接采用，不要求原文再出现「粉丝」等关键词，不得再问。数值字段先采用该唯一解析值，再与最新非空 `clarification` 合并；同一字段的新答案覆盖旧答案，其他已经确认且未修改的数值直接复用。当前平台 Dify 品牌候选只有一个合法非空值时直接原样采用，不得询问或改写。
2. 当前 Workflow 的部分输出是 Provider 参数片段对象。允许按字段名做结构性解包或展开，例如从 `{ "rebate": "[0.3,1]" }` 取同名 `rebate`。数组或单值到 Provider 标准区间字符串的确定性边界规范化由插件一次完成；Agent 不得自行尝试不同类型。
3. 标签保持解析返回的数组元素和顺序，不需要原文逐项举证，不调用 `AskUserQuestion` 确认。可选 Label 为 `null` 或缺失时直接省略，不生成补充值——包括主达人类型 `pgyBloggerTypeLabel`/`xtTalentTypeLabel`；任何标签内容都不询问、不映射、不推断。
4. 品牌当前按平台输出为 `xhsbrandName` / `dybrandName`；只读取当前平台候选。只有一个非空且不是 `null`、`undefined`、`未知`、`未明确`、`未提及`、`未提供`、`暂无`、`无`、`不详`、`待确认`、`待定` 等占位值的候选时，该 Dify 值必须原样映射为 `brandName`，不得被 Agent、原文或历史 `clarification` 修改，也不得再次询问。解析品牌缺失、多候选或为占位值时才弹窗，并使用最新答案。
5. `contentTag`、`followercount`、`rebate` 可能返回带同名字段的对象，也可能直接返回值；只做同名结构展开。其中 `contentTag` 必须是非空字符串数组，数值筛选值在 Provider 边界统一为下述标准区间字符串。
6. 报价、CPM、CPE 按平台返回 `xhs_kolOfficialPrice` / `dy_kolOfficialPrice`、`xhs_cpm` / `dy_cpm`、`xhs_cpe` / `dy_cpe` 参数片段。只展开当前平台对象。抖音三类指标统一按视频类型映射：`kolOfficialPriceL2` / `cpmL2` / `cpeL2` 表示植入视频，`kolOfficialPriceL3` / `cpmL3` / `cpeL3` 表示定制视频，不使用 `kolOfficialPriceL1` / `cpmL1` / `cpeL1`；对应视频类型必须有当前原文或用户弹窗答案支持。解析片段中的旧档位名不作为类型证据；用户证据已唯一明确植入/定制且只有一个合法数值候选时，保持区间不变并路由到当前 L2/L3，不询问用户；多个候选仍需澄清。只有视频类型仍缺失或模糊时才澄清。
7. 八个可选 Label 不触发 `AskUserQuestion`：有什么原样落库，`null` 或缺失直接省略。`contentTag` 同样不触发弹窗，但必须来自本次解析结果中的非空字符串数组；缺失或无效时重新解析，禁止询问用户或自行补值。Dify 已给出的唯一数值必须复用，禁止再问；只有这些字段缺失、`null`、多候选或与用户明确改口冲突时，才调用 `AskUserQuestion`。同一字段历史旧答案不得覆盖最新答案。

解析 Workflow 已给出的唯一且合法 `followercount`、`rebate`、报价、CPM 或 CPE 候选直接复用；原文精确单价与 Provider 检索区间只是表达格式不同，不得因此再次弹出报价区间选择。粉丝技术上限溢出由本地截断，不弹窗。

## `validate_requirement` 数值格式锁

第一次调用 `validate_requirement` 前必须一次性构造完成全部字段，禁止让 Provider 报错后逐字段或逐类型试探。

- `rebate`、`followercount`、`kolOfficialPriceL1/L2/L3`、`cpmL1/L2/L3`、`cpeL1/L2/L3`，以及 `interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`photoInteract`、`userlikecount`、`likeIncrement`、`avgview`、`avglike`、`avgcomment`、`avgcollect`、`avginteract`、`femaleRate`、`age1Rate` 至 `age6Rate`，全部使用无空格 JSON 区间字符串 `"[min,max]"`。
- 禁止把这些字段作为 JSON 数组、对象、单个数字、百分号文本或“以上/以下”等自然语言传给 Provider。
- 返点表示最低要求，固定为 `"[min,1]"`；比例字段范围为 0–1；所有数值区间必须满足 `0 ≤ min < max`，禁止 `[v,v]`。
- 本地 `before_tool_call` 只做一次确定性格式规范化与完整预检；仍有缺失、非法或需要语义选择的字段时会阻断写入，Agent 必须弹窗，不得换一种表达继续试。

## 后续修改与重解析

- 没有条件变化：复用最近成功结果。
- 用户主动修改任何业务条件时，无论是否已经生成提报表，都回到用户原始需求，合并用户亲自提出的最新修改，撤销此前全部自动放宽，形成新的完整单平台 `demand`。
- 重新调用本工具，复核新输出和待提交参数，创建新的 requirement，并从原业务模式起点重新执行；不得复用旧 requirement、机构、询价、达人、batch 或 Excel。
- 重新解析后不得把旧解析字段与新响应拼接。
- 重跑输入禁止回填任何已归一化值。比如用户原始单价 `10000` 经解析输出 `"[7000,12000]"` 后，后续重跑仍传用户的 `10000`，绝不能把 `"[7000,12000]"` 写入 `demand`，否则会造成二次拓展。返点、粉丝、CPM、CPE 同理。

## Agent 负责字段

除上述解析字段外，所有 Provider 参数由 Agent 从当前需求原文和用户后续修改解析。只使用明确证据；缺失、模糊或冲突时澄清。

### 必填和生成字段

| 字段                   | 解析规则                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`             | 只传 `xiaohongshu` 或 `douyin`；多平台分别创建需求。                                                                                                                                                                                                 |
| `projectName`          | 由 Agent 根据当前需求自行总结生成（可用品牌/产品、平台、达人类型等概括），不向用户确认、不弹窗；调用 validate_requirement 前用一句可见正文告知用户取的项目名。                                                                                                                                                   |
| `quantityTotal`        | 明确的提报达人数量，转成正整数字符串；不能用合作数量、机构覆盖数、推荐补量或默认 `1` 代替。                                                                                                                                                          |
| `submissionDeadlineAt` | 解析为未来绝对时间并精确到秒；只有日期没有时刻时澄清，不能默认 18:00；已过期时给出未来绝对时间选项。                                                                                                                                                 |
| `status`               | 固定传 `"ready"`，本地边界可在缺失时确定性补入；不得询问用户。                                                                                                                                                                                       |
| `rawMessagesJson`      | 必填 JSON 对象：`original` 保留当前原始需求，`parse_outputs` 保留本次返回的契约字段，`business_mode` 固定为解析时使用的业务模式，`clarifications` 按字段保存最新有效答案；同一字段新答案覆盖旧答案，重建参数时保留其他字段答案。同平台多个类型只保留一个需求和原始总量，合并全部类型标签与条件。当前平台唯一合法 Dify 品牌候选必须直接采用；解析品牌缺失或不唯一时才读取最新弹窗答案。 |
| `description`          | 用当前明确需求写简短中文说明，保留无法映射成 Provider 筛选字段但后续需要人工核验的条件。                                                                                                                                                             |
| `originalBrief`        | 保留用户最初完整原文，不因平台拆分或后续归一化改写。                                                                                                                                                                                                 |

`product`、`projectStartStart`、`projectStartEnd` 是可选上下文字段；只在原文明确时传。新需求不传 `id`、`demandId`、`demandVersion`、`createdAt`、`updatedAt`、`refNickname` 或 `refUrl`。参考达人昵称和链接分别以带标签的原文写入 `description`/`originalBrief`。

### 内容形式和分组

- 小红书内容形式只根据明确的图文/视频表述确定；普通 Provider 检索未说明形式时不追问，价格使用 L1 兼容位，但不能推断为图文合作。
- 抖音报价、CPM、CPE 只按视频类型映射：植入视频使用 L2，定制视频使用 L3，不使用任何 L1。原文只说“视频”而没有明确类型时必须弹窗确认。
- 同一平台明确要求多个达人类型但只给总量时，保留一个 requirement，传入原始总量并合并所有类型标签和条件；不得拆分子需求、重复落库或重复搜索，也不得询问每类人数。

### 数值参数构造规则

以下规则用于根据当前完整需求构造本轮 `validate_requirement` 数值参数。用户主动修改任何业务条件后仍须先按上文重新解析，不得绕过重解析直接更新旧 requirement，也不得再次处理未修改的解析值。

- 达人单价：先换算成人民币元，再执行一次 Provider 检索浮动。精确值或单边值 `v` → `[floor(0.7v),ceil(1.2v)]`；明确区间 `[a,b]` → `[floor(0.7a),ceil(1.2b)]`。同一值不得重复扩展。
- CPM/CPE：表示最大可接受值，`v` → `[0,v]`；不能把“至少/以上”的下限反转成上限。
- 粉丝量：上限 `[0,v]`，下限 `[v,999999999]`，明确非退化区间原样；明确“不限”使用 `[0,999999999]`。精确值不得写成 `[v,v]`，需要用户确认可接受的上下界。
- 返点：表示最低返点，百分比换算到 0–1 后使用 `[min,1]`；不要询问或保留用户给出的上限。
- 其他数量指标：上限 `[0,v]`、下限 `[v,技术最大值]`、明确非退化区间 `[a,b]`。精确值不得写成 `[v,v]`；没有字段专属的无损非退化映射时，必须澄清上下界。
- 比例字段：统一使用 0–1 区间；只有男性占比时，可在明确二元占比假设下换算女性占比 `[1-b,1-a]`。

所有 Provider 区间最终使用无空格 JSON 字符串 `"[min,max]"`。数值不能为负，且下界必须严格小于上界。

### 可选筛选字段

仅在原文明确、主体和含义唯一时解析：

- 达人：`kwGender`、`kwIpDependency`、`kwUserUrl`、`organization`、`hasOrganization`。
- 商业表现：`hasOrder30day`、`hasSocial30day`、`interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`photoInteract`、`userlikecount`、`likeIncrement`、`avgview`、`avglike`、`avgcomment`、`avgcollect`、`avginteract`。
- 受众：`femaleRate`、`age1Rate` 至 `age6Rate`。粉丝性别/地域不能误写成达人本人性别/所在地。

`hasOrganization`、`hasOrder30day`、`hasSocial30day` 使用字符串 `"true"`/`"false"`。同时接受机构达人和个人达人时省略 `hasOrganization` 和 `organization`；`organization` 只放明确机构名称。

## 进入 validate_requirement 前

1. 八个可选 Label 数组直接采用，任何 Label 都不触发确认或询问：有什么原样落库，`null` 或缺失直接省略（包括主达人类型 `pgyBloggerTypeLabel`/`xtTalentTypeLabel`）。`contentTag` 必须来自本次解析结果中的非空字符串数组；缺失或无效时重新解析，禁止询问用户或自行补值。数值字段先合并 `original` 与最新非空 `clarification`。当前平台唯一合法 Dify 品牌候选必须原样采用；解析品牌缺失或不唯一时才读取最新弹窗答案。
2. 检查必填、平台、数量、日期、价档和全部 `"[min,max]"` 区间格式；达人数量、截止时间和可选项目日期必须与当前有效用户证据一致，同一字段旧答案不得重新生效；项目名由 Agent 自行总结生成，不要求证据。
3. 仍缺失、模糊、冲突或需要选择数值映射的数值字段，一次性调用 `AskUserQuestion`；八个可选 Label 和 `contentTag` 都不得触发弹窗，`contentTag` 缺失或无效时重新解析，已确认数值不得重复询问。
4. 完整参数准备好后直接调用 `validate_requirement`；不展示额外的“确认创建”弹窗，不提前调用 Browser、`search_creators` 或 `rank_mcns`。
