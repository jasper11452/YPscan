# ypscan_parse_requirement

## 定位

这是固定链路的第一步。插件把当前单个平台的完整最新需求直接提交给固定 Dify Workflow；插件不再做本地 facts 校验、Provider 参数编译、搜索分组或语义补全。

首次处理一个平台需求时必须调用。成功后，`data.outputs` 是 Dify 的完整原始 `outputs` 对象；插件不挑选、不重命名、不解包、不删除未知字段。Agent 使用其中 Dify 负责的内容，并按本卡补齐其余 `validate_requirement` 参数。

## 输入

只传：

```json
{ "demand": "当前单个平台的完整最新需求文本" }
```

- 单平台需求直接传完整原文。
- 多平台需求按平台分别调用：保留明确共享条件和当前平台条件，删除另一平台专属条件，并明确写出当前平台；每个平台保留自己的最近一次成功结果。
- 不得为了让 Dify 命中而添加用户没说过的条件。
- 为每个平台维护“当前用户原始条件”：只由用户最初原文和后续改口更新。`demand` 必须从这份原始条件重建，不得从 Dify 输出、`validate_requirement` 参数或其他 Provider 归一化结果反向生成。

## Dify 候选解析字段

Dify 首次为以下字段提供候选解析；最终值仍必须有当前原文或用户弹窗答案支持：

| 类别           | 字段                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标签           | `growBloggerTypeLabel`、`contentFeatureLabel`、`contentThemeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`industryTagLabel`、`growTalentTypeLabel` |
| 文本和基础条件 | `contentTag`、`brandName`、`followercount`、`rebate`                                                                                                                         |
| 商业指标       | `kolOfficialPrice`、`cpm`、`cpe`                                                                                                                                             |

使用规则：

1. Dify 返回值只是带原文证据约束的候选解析。只有原文存在唯一明确含义且 Dify 与其一致时才能使用；禁止 Agent 猜测、补全、改标签、排序或从其他语义字段替代。Dify 默认值、原文未支持的时长档或多候选都不是用户确认。
2. 当前 Workflow 的部分输出是 Provider 参数片段对象。允许按字段名做结构性解包或展开，例如从 `{ "rebate": "[0.3,1]" }` 取同名 `rebate`。数组或单值到 Provider 标准区间字符串的确定性边界规范化由插件一次完成；Agent 不得自行尝试不同类型。
3. 标签保持 Dify 返回的数组元素和顺序；不得把 `null` 或缺失值传给 Provider，按第 7 条回查原文处理。
4. 品牌当前按平台输出为 `xhsbrandName` / `dybrandName`；只读取当前平台候选。只有一个且与原文一致时才可无损映射为标量 `brandName`；空、多候选或与原文冲突时必须调用 `AskUserQuestion`，不得自行选择。
5. `contentTag`、`followercount`、`rebate` 可能返回带同名字段的对象，也可能直接返回值；只做同名结构展开。其中 `contentTag` 必须是非空字符串数组，数值筛选值在 Provider 边界统一为下述标准区间字符串。
6. 报价、CPM、CPE 按平台返回 `xhs_kolOfficialPrice` / `dy_kolOfficialPrice`、`xhs_cpm` / `dy_cpm`、`xhs_cpe` / `dy_cpe` 参数片段。只展开当前平台对象。对应内容形式或抖音 L1/L2/L3 时长档必须有当前原文或用户弹窗答案支持；Dify 自行给出的未获支持档位属于冲突，必须澄清，禁止接受默认路由。
7. Dify 字段缺失、为 `null`、为空、模糊、与当前原文冲突、包含多个候选或需要选择合法映射时，必须调用 `AskUserQuestion`。Agent 不再拥有“回查后自主决定”权限；只能提取原文中已经唯一明确的字面值并执行无损结构映射。

## `validate_requirement` 数值格式锁

第一次调用 `validate_requirement` 前必须一次性构造完成全部字段，禁止让 Provider 报错后逐字段或逐类型试探。

- `rebate`、`followercount`、`kolOfficialPriceL1/L2/L3`、`cpmL1/L2/L3`、`cpeL1/L2/L3`，以及 `interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`photoInteract`、`userlikecount`、`likeIncrement`、`avgview`、`avglike`、`avgcomment`、`avgcollect`、`avginteract`、`femaleRate`、`age1Rate` 至 `age6Rate`，全部使用无空格 JSON 区间字符串 `"[min,max]"`。
- 禁止把这些字段作为 JSON 数组、对象、单个数字、百分号文本或“以上/以下”等自然语言传给 Provider。
- 返点表示最低要求，固定为 `"[min,1]"`；比例字段范围为 0–1；其他数值满足 `0 ≤ min ≤ max`。
- 本地 `before_tool_call` 只做一次确定性格式规范化与完整预检；仍有缺失、非法或需要语义选择的字段时会阻断写入，Agent 必须弹窗，不得换一种表达继续试。

## 后续修改与重解析

按用户每一次修改涉及的不同业务条件计数；同一条件的多处措辞调整只算一个变化。

- 没有条件变化：复用最近成功结果。
- 本次只变化一个条件：不再调用 Dify，由 Agent 按用户最新原文直接更新该条件；即使该条件原本属于 Dify 字段也适用。
- 本次变化两个及以上不同条件：把用户原始表述和后续改口中的所有最新条件合并成新的完整单平台 `demand`，重新调用一次 Dify，并用新响应刷新全部 Dify 字段。
- Dify 重跑后不得把旧 Dify 字段与新响应拼接。
- 重跑输入禁止回填任何已归一化值。比如用户原始单价 `10000` 经 Dify 输出 `"[7000,12000]"` 后，后续重跑仍传用户的 `10000`，绝不能把 `"[7000,12000]"` 写入 `demand`，否则会造成二次拓展。返点、粉丝、CPM、CPE 同理。

## Agent 负责字段

除上述 Dify 字段外，所有 Provider 参数由 Agent 从当前需求原文和用户后续修改解析。只使用明确证据；缺失、模糊或冲突时澄清。

### 必填和生成字段

| 字段                   | 解析规则                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`             | 只传 `xiaohongshu` 或 `douyin`；多平台分别创建需求。                                                                                                                          |
| `projectName`          | 使用明确项目名；品牌名、产品名不能自动充当项目名。没有明确项目名时澄清。                                                                                                      |
| `quantityTotal`        | 明确的提报达人数量，转成正整数字符串；不能用合作数量、机构覆盖数、推荐补量或默认 `1` 代替。                                                                                   |
| `submissionDeadlineAt` | 解析为未来绝对时间并精确到秒；只有日期没有时刻时澄清，不能默认 18:00；已过期时给出未来绝对时间选项。                                                                          |
| `status`               | 固定传 `"ready"`，本地边界可在缺失时确定性补入；不得询问用户。                                                                                                                |
| `rawMessagesJson`      | 必填 JSON 对象：`original` 保留当前原始需求，`parse_outputs` 保留本次完整 Dify `outputs`，每轮弹窗答案按字段写入 `clarifications`；不得用历史需求或 Dify 默认值代替用户证据。 |
| `description`          | 用当前明确需求写简短中文说明，保留无法映射成 Provider 筛选字段但后续需要人工核验的条件。                                                                                      |
| `originalBrief`        | 保留用户最初完整原文，不因平台拆分或后续归一化改写。                                                                                                                          |

`product`、`projectStartStart`、`projectStartEnd` 是可选上下文字段；只在原文明确时传。新需求不传 `id`、`demandId`、`demandVersion`、`createdAt`、`updatedAt`、`refNickname` 或 `refUrl`。参考达人昵称和链接分别以带标签的原文写入 `description`/`originalBrief`。

### 内容形式、时长和分组

- 小红书内容形式只根据明确的图文/视频表述确定；普通 Provider 检索未说明形式时不追问，价格使用 L1 兼容位，但不能推断为图文合作。
- 抖音时长只映射为 1–20 秒、21–60 秒、60 秒以上三个档；`60s+` 同时表示视频和 L3。原文只说“视频”而没有时长时必须弹窗确认，禁止由 Dify 或 Agent 默认选择 L1/L2/L3。
- 一个需求存在多个独立达人组、形式或时长档时，每组必须有自己的明确提报数量。共享总量不能复制到多组；无法拆分时澄清，并为每组分别调用 `validate_requirement`。

### 单条件修改时的数值规则

以下规则只用于“用户本次只修改一个条件”的 Agent 直接更新；不得再次处理未修改的 Dify 值。

- 达人单价：先换算成人民币元，再执行一次 Provider 检索浮动。精确值或单边值 `v` → `[floor(0.7v),ceil(1.2v)]`；明确区间 `[a,b]` → `[floor(0.7a),ceil(1.2b)]`。同一值不得重复扩展。
- CPM/CPE：表示最大可接受值，`v` → `[0,v]`；不能把“至少/以上”的下限反转成上限。
- 粉丝量：精确值 `[v,v]`，上限 `[0,v]`，下限 `[v,999999999]`，明确区间原样；明确“不限”使用 `[0,999999999]`。
- 返点：表示最低返点，百分比换算到 0–1 后使用 `[min,1]`；不要询问或保留用户给出的上限。
- 其他数量指标：精确 `[v,v]`、上限 `[0,v]`、下限 `[v,技术最大值]`、区间 `[a,b]`。
- 比例字段：统一使用 0–1 区间；只有男性占比时，可在明确二元占比假设下换算女性占比 `[1-b,1-a]`。

所有 Provider 区间最终使用无空格 JSON 字符串 `"[min,max]"`。下界不能大于上界，数值不能为负。

### 可选筛选字段

仅在原文明确、主体和含义唯一时解析：

- 达人：`kwGender`、`kwIpDependency`、`kwUserUrl`、`organization`、`hasOrganization`。
- 商业表现：`hasOrder30day`、`hasSocial30day`、`interactionRate`、`clickMedium`、`viewMedium`、`photoView`、`videoInteract`、`photoInteract`、`userlikecount`、`likeIncrement`、`avgview`、`avglike`、`avgcomment`、`avgcollect`、`avginteract`。
- 受众：`femaleRate`、`age1Rate` 至 `age6Rate`。粉丝性别/地域不能误写成达人本人性别/所在地。

`hasOrganization`、`hasOrder30day`、`hasSocial30day` 使用字符串 `"true"`/`"false"`。同时接受机构达人和个人达人时省略 `hasOrganization` 和 `organization`；`organization` 只放明确机构名称。

## 进入 validate_requirement 前

1. 检查每个 Dify 候选是否有当前原文证据且不存在歧义；只允许无损结构展开和本地标准格式归一化。
2. 从原文提取 Agent 字段，检查必填、平台、数量、日期、价档和全部 `"[min,max]"` 区间格式；品牌、项目名、达人数量、截止时间和可选项目日期必须与 `original` 或非空 `clarifications` 中的明确值一致。
3. 对任何缺失、模糊、冲突、多候选或需要选择映射的字段，一次性用 `AskUserQuestion` 收集；禁止 Agent 自主决定。
4. 完整参数准备好后直接调用 `validate_requirement`；不展示额外的“确认创建”弹窗，不提前调用 Browser、`search_creators` 或 `rank_mcns`。
