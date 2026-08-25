# ypscan_parse_requirement

## 定位

这是固定链路的第一步。插件把当前单个平台的完整最新需求直接提交给固定解析 Workflow；插件不再做本地 facts 校验、Provider 参数编译、搜索分组或语义补全。

首次处理一个平台需求时必须调用。成功后，`data.outputs` 是完整原始 `outputs` 对象；插件不挑选、不重命名、不解包、不删除未知字段。Agent 使用解析结果，并按本卡补齐其余 `validate_requirement` 参数。

## 输入

只传：

```json
{ "demand": "当前单个平台的完整最新需求文本" }
```

- 单平台需求直接传完整原文。
- 多平台需求按平台分别调用：保留明确共享条件和当前平台条件，删除另一平台专属条件，并明确写出当前平台；每个平台保留自己的最近一次成功结果。
- 不得为了让解析命中而添加用户没说过的条件。
- 为每个平台维护“当前用户原始条件”：只由用户最初原文和后续改口更新。`demand` 必须从这份原始条件重建，不得从解析输出、`validate_requirement` 参数或其他 Provider 归一化结果反向生成。

## 解析字段

解析 Workflow 首次为以下字段提供结果。八个 Label 数组和 `contentTag` 合法非 `null` 时直接采用，不要求用户再次确认；数值字段仍是需要用户证据约束的候选。用户明确品牌优先，否则当前平台唯一合法、非占位品牌候选可直接采用：

| 类别           | 字段                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标签           | `growBloggerTypeLabel`、`contentFeatureLabel`、`contentThemeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`industryTagLabel`、`growTalentTypeLabel` |
| 文本和基础条件 | `contentTag`、`brandName`、`followercount`、`rebate`                                                                                                                         |
| 商业指标       | `kolOfficialPrice`、`cpm`、`cpe`                                                                                                                                             |

使用规则：

1. 八个 Label 数组和 `contentTag` 是可直接采用的解析结果；数值返回值是带用户证据约束的候选。数值字段先合并当前原文与最新非空 `clarification`；同一字段的新答案覆盖旧答案，其他已经确认且未修改的数值直接复用。用户明确品牌优先；否则当前平台品牌候选只有一个合法非空值时直接采用。
2. 当前 Workflow 的部分输出是 Provider 参数片段对象。允许按字段名做结构性解包或展开，例如从 `{ "rebate": "[0.3,1]" }` 取同名 `rebate`。数组或单值到 Provider 标准区间字符串的确定性边界规范化由插件一次完成；Agent 不得自行尝试不同类型。
3. 标签保持解析返回的数组元素和顺序，不需要原文逐项举证，不调用 `AskUserQuestion` 确认。可选 Label 为 `null` 或缺失时直接省略，不生成补充值。兼容历史拼写 `xtTalentTypeLable`：当正确字段缺失时确定性映射到 Provider 的 `xtTalentTypeLabel`，同时保持 `parse_outputs` 原样不变。
4. 品牌当前按平台输出为 `xhsbrandName` / `dybrandName`；只读取当前平台候选。用户明确品牌或该字段最新弹窗答案优先；没有明确值时，只有一个非空且不是 `null`、`undefined`、`未知`、`未明确`、`未提及`、`未提供`、`暂无`、`无`、`不详`、`待确认`、`待定` 等占位值的候选才映射为 `brandName`。多候选、占位值或明确冲突必须弹窗。
5. `contentTag`、`followercount`、`rebate` 可能返回带同名字段的对象，也可能直接返回值；只做同名结构展开。其中 `contentTag` 必须是非空字符串数组，数值筛选值在 Provider 边界统一为下述标准区间字符串。
6. 报价、CPM、CPE 按平台返回 `xhs_kolOfficialPrice` / `dy_kolOfficialPrice`、`xhs_cpm` / `dy_cpm`、`xhs_cpe` / `dy_cpe` 参数片段。只展开当前平台对象。抖音三类指标统一按视频类型映射：`kolOfficialPriceL2` / `cpmL2` / `cpeL2` 表示植入视频，`kolOfficialPriceL3` / `cpmL3` / `cpeL3` 表示定制视频，不使用 `kolOfficialPriceL1` / `cpmL1` / `cpeL1`；对应视频类型必须有当前原文或用户弹窗答案支持。解析片段中的旧档位名不作为类型证据；用户证据已唯一明确植入/定制且只有一个合法数值候选时，保持区间不变并路由到当前 L2/L3，不询问用户；多个候选仍需澄清。只有视频类型仍缺失或模糊时才澄清。
7. 解析标签不得触发 `AskUserQuestion`。解析数值在合并 `original` 与字段最新有效 `clarification` 后仍缺失、为空、模糊、冲突或需要选择合法数值映射时，才调用 `AskUserQuestion`。已有有效数值必须复用，禁止重复询问；同一字段历史旧答案不得覆盖最新答案。

解析 Workflow 已给出的唯一且合法报价、CPM 或 CPE 候选直接复用；原文精确单价与 Provider 检索区间只是表达格式不同，不得因此再次弹出报价区间选择。

## `validate_requirement` 数值格式锁

第一次调用 `validate_requirement` 前必须一次性构造完成全部字段，禁止让 Provider 报错后逐字段或逐类型试探。

- `rebate`、`followercount`、`kolOfficialPriceL1/L2/L3`、`cpmL1/L2/L3`、`cpeL1/L2/L3`，以及 `interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`photoInteract`、`userlikecount`、`likeIncrement`、`avgview`、`avglike`、`avgcomment`、`avgcollect`、`avginteract`、`femaleRate`、`age1Rate` 至 `age6Rate`，全部使用无空格 JSON 区间字符串 `"[min,max]"`。
- 禁止把这些字段作为 JSON 数组、对象、单个数字、百分号文本或“以上/以下”等自然语言传给 Provider。
- 返点表示最低要求，固定为 `"[min,1]"`；比例字段范围为 0–1；所有数值区间必须满足 `0 ≤ min < max`，禁止 `[v,v]`。
- 本地 `before_tool_call` 只做一次确定性格式规范化与完整预检；仍有缺失、非法或需要语义选择的字段时会阻断写入，Agent 必须弹窗，不得换一种表达继续试。

## 后续修改与重解析

按用户每一次修改涉及的不同业务条件计数；同一条件的多处措辞调整只算一个变化。

- 没有条件变化：复用最近成功结果。
- 本次只变化一个条件：不再重新解析，由 Agent 按用户最新原文直接更新该条件；即使该条件原本属于解析字段也适用。
- 本次变化两个及以上不同条件：把用户原始表述和后续改口中的所有最新条件合并成新的完整单平台 `demand`，重新调用一次解析工具，并用新响应刷新全部解析字段。
- 重新解析后不得把旧解析字段与新响应拼接。
- 重跑输入禁止回填任何已归一化值。比如用户原始单价 `10000` 经解析输出 `"[7000,12000]"` 后，后续重跑仍传用户的 `10000`，绝不能把 `"[7000,12000]"` 写入 `demand`，否则会造成二次拓展。返点、粉丝、CPM、CPE 同理。

## Agent 负责字段

除上述解析字段外，所有 Provider 参数由 Agent 从当前需求原文和用户后续修改解析。只使用明确证据；缺失、模糊或冲突时澄清。

### 必填和生成字段

| 字段                   | 解析规则                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`             | 只传 `xiaohongshu` 或 `douyin`；多平台分别创建需求。                                                                                                                                                                                                 |
| `projectName`          | 使用明确项目名；品牌名、产品名不能自动充当项目名。没有明确项目名时澄清。                                                                                                                                                                             |
| `quantityTotal`        | 明确的提报达人数量，转成正整数字符串；不能用合作数量、机构覆盖数、推荐补量或默认 `1` 代替。                                                                                                                                                          |
| `submissionDeadlineAt` | 解析为未来绝对时间并精确到秒；只有日期没有时刻时澄清，不能默认 18:00；已过期时给出未来绝对时间选项。                                                                                                                                                 |
| `status`               | 固定传 `"ready"`，本地边界可在缺失时确定性补入；不得询问用户。                                                                                                                                                                                       |
| `rawMessagesJson`      | 必填 JSON 对象：`original` 保留当前原始需求，`parse_outputs` 保留本次完整原始 `outputs`，`clarifications` 按字段保存最新有效答案；同一字段新答案覆盖旧答案，重建参数时保留其他字段答案。同平台多个类型只保留一个需求和原始总量，合并全部类型标签与条件。除当前平台唯一合法品牌候选外，不得用解析默认值代替用户证据。 |
| `description`          | 用当前明确需求写简短中文说明，保留无法映射成 Provider 筛选字段但后续需要人工核验的条件。                                                                                                                                                             |
| `originalBrief`        | 保留用户最初完整原文，不因平台拆分或后续归一化改写。                                                                                                                                                                                                 |

`product`、`projectStartStart`、`projectStartEnd` 是可选上下文字段；只在原文明确时传。新需求不传 `id`、`demandId`、`demandVersion`、`createdAt`、`updatedAt`、`refNickname` 或 `refUrl`。参考达人昵称和链接分别以带标签的原文写入 `description`/`originalBrief`。

### 内容形式和分组

- 小红书内容形式只根据明确的图文/视频表述确定；普通 Provider 检索未说明形式时不追问，价格使用 L1 兼容位，但不能推断为图文合作。
- 抖音报价、CPM、CPE 只按视频类型映射：植入视频使用 L2，定制视频使用 L3，不使用任何 L1。原文只说“视频”而没有明确类型时必须弹窗确认。
- 同一平台明确要求多个达人类型但只给总量时，保留一个 requirement，传入原始总量并合并所有类型标签和条件；不得拆分子需求、重复落库或重复搜索，也不得询问每类人数。
- 用户只明确一个达人类型时，Agent 必须判断其最匹配的主达人类型标签；小红书默认优先映射到 `pgyBloggerTypeLabel`，抖音默认优先映射到 `xtTalentTypeLabel`，其他标签字段只补充主题、内容和成长阶段，不得反客为主。

### 单条件修改时的数值规则

以下规则只用于“用户本次只修改一个条件”的 Agent 直接更新；不得再次处理未修改的解析值。

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

1. 解析标签数组直接采用，不读取对应 `clarification`，不向用户确认；数值字段先合并 `original` 与最新非空 `clarification`。用户明确品牌优先，否则采用当前平台唯一合法品牌候选。
2. 检查必填、平台、数量、日期、价档和全部 `"[min,max]"` 区间格式；项目名、达人数量、截止时间和可选项目日期必须与当前有效用户证据一致，同一字段旧答案不得重新生效。
3. 解析结果中只对仍缺失、模糊、冲突或需要选择数值映射的数值字段一次性调用 `AskUserQuestion`；标签不得触发弹窗，已确认数值不得重复询问。
4. 完整参数准备好后直接调用 `validate_requirement`；不展示额外的“确认创建”弹窗，不提前调用 Browser、`search_creators` 或 `rank_mcns`。
