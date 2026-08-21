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

## Dify 负责字段

Dify 独占首次解析以下字段：

| 类别           | 字段                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标签           | `growBloggerTypeLabel`、`contentFeatureLabel`、`contentThemeLabel`、`kolPersonaLabel`、`pgyBloggerTypeLabel`、`xtTalentTypeLabel`、`industryTagLabel`、`growTalentTypeLabel` |
| 文本和基础条件 | `contentTag`、`brandName`、`followercount`、`rebate`                                                                                                                         |
| 商业指标       | `kolOfficialPrice`、`cpm`、`cpe`                                                                                                                                             |

使用规则：

1. Dify 返回了明确值时直接使用；禁止 Agent 猜测、补全、重写、排序、换算、扩区间或从其他语义字段替代。
2. 当前 Workflow 的部分输出是 Provider 参数片段对象。允许按字段名做结构性解包或展开，例如从 `{ "rebate": "[0.3,1]" }` 取同名 `rebate`；禁止改变内部值。
3. 标签保持 Dify 返回的数组元素和顺序；不得把 `null` 或缺失值传给 Provider，按第 7 条回查原文处理。
4. 品牌当前按平台输出为 `xhsbrandName` / `dybrandName`；只读取当前平台候选。单一候选结构性映射为 `brandName`，空、多候选或与原文冲突时按第 7 条处理。
5. `contentTag`、`followercount`、`rebate` 当前分别返回带同名字段的对象；展开后使用内部同名值，不做二次解析。
6. 报价、CPM、CPE 当前按平台返回 `xhs_kolOfficialPrice` / `dy_kolOfficialPrice`、`xhs_cpm` / `dy_cpm`、`xhs_cpe` / `dy_cpe` 参数片段，内部已是 L1/L2/L3 Provider 字段；只展开当前平台对象，不得再次路由、扩区间或重算。若 Workflow 以后返回未分档的逻辑值，才根据明确的小红书图文/视频或抖音时长档做字段路由，值仍不得改变。
7. Dify 字段缺失、为 `null`、为空或与当前原文冲突时，Agent 先回查当前完整需求和用户后续修改，自主选择原文中唯一明确的值；原文仍缺失、模糊或冲突时才调用 `AskUserQuestion`，不得盲猜。

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

| 字段                     | 解析规则                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `platform`               | 只传 `xiaohongshu` 或 `douyin`；多平台分别创建需求。                                                 |
| `projectName`            | 使用明确项目名；品牌名、产品名不能自动充当项目名。没有明确项目名时澄清。                             |
| `quantityTotal`          | 明确的提报达人数量，转成正整数字符串；不能用合作数量、机构覆盖数、推荐补量或默认 `1` 代替。          |
| `submissionDeadlineAt`   | 解析为未来绝对时间并精确到秒；只有日期没有时刻时澄清，不能默认 18:00；已过期时给出未来绝对时间选项。 |
| `status`                 | Agent 固定传 `"ready"`。                                                                             |
| `createdAt`、`updatedAt` | Agent 生成同一个当前本地时间，精确到秒。                                                             |
| `description`            | 用当前明确需求写简短中文说明，保留无法映射成 Provider 筛选字段但后续需要人工核验的条件。             |
| `originalBrief`          | 保留用户最初完整原文，不因平台拆分或后续归一化改写。                                                 |

`product`、`rawMessagesJson`、`projectStartStart`、`projectStartEnd` 是可选上下文字段；只在原文明确时传。新需求不传 `id`、`demandId`、`demandVersion`、`refNickname` 或 `refUrl`。参考达人昵称和链接分别以带标签的原文写入 `description`/`originalBrief`。

### 内容形式、时长和分组

- 小红书内容形式只根据明确的图文/视频表述确定；普通 Provider 检索未说明形式时不追问，价格使用 L1 兼容位，但不能推断为图文合作。
- 抖音时长只映射为 1–20 秒、21–60 秒、60 秒以上三个档；`60s+` 同时表示视频和 L3。
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
- 其他文本：`talentTypeLabel`。不得拿它覆盖任何 Dify 标签字段。

`hasOrganization`、`hasOrder30day`、`hasSocial30day` 使用字符串 `"true"`/`"false"`。同时接受机构达人和个人达人时省略 `hasOrganization` 和 `organization`；`organization` 只放明确机构名称。

项目总预算、软偏好、平台不可见条件和无法安全映射的要求只保留在 `description`/`originalBrief`，不得伪造 Provider 字段。生产 schema 不接收 `budget_min_cents`、`budget_max_cents`、`budget_raw` 或旧截止时间字段。

## 进入 validate_requirement 前

1. 对 Dify 字段执行“直接使用”检查，并确认没有对值做二次转换。
2. 从原文补齐 Agent 字段，检查必填、平台、数量、日期、价档和区间格式。
3. 对 Dify 缺失/冲突先回查原文；只有仍无法确定的业务问题才一次性用 `AskUserQuestion` 收集。
4. 完整参数准备好后直接调用 `validate_requirement`；不展示额外的“确认创建”弹窗，不提前调用 Browser、`search_creators` 或 `rank_mcns`。
