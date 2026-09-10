# 2026-09-10 候选池上限与评分口径复核

状态：只读复核，未改动插件代码、Provider 模板或已发布工作流。结论分三类——「已证实的机制」、「已定位的成因」与「待用户决定的契约/潜在健壮性问题」。所有数字来自对 `.ypscan-e2e/20260910/` 本机证据、`ypaction.sqlite` 运行记录与 `/Users/jasper/ypaction/project/` 产物文件的直接读取或离线复算，不是端到端 Agent 运行的替代。

## 一、候选池 30 → 15 的收缩：已定位

### 直接测量

| 文件 | 数据行 | 不同 `creator_id` | 重复 |
| --- | --- | --- | --- |
| `mcn-links-7fdd24f1cfd94c33b1b59bb5e87ce6e1-6d822ae2.csv`（小红书 R2） | 30 | 30 | 0 |
| `mcn-links-4e7e5cb73be64b9591d365045a96ef4f-1530c4a4.csv`（抖音 R2） | 30 | 30 | 0 |

两份文件表头均为 `source_record_id,creator_id,url`。

### 收缩机制

`src/tools/manual-score-summary.js` 中：

```js
const candidateIds = [...new Set(links.rows.map((row) => row[1].trim()))].slice(
  0,
  manualSourcePoolSize(target),
);
```

- `[...new Set(...)]` 在真实数据上是空操作（0 重复）。
- 收缩全部来自 `.slice(0, manualSourcePoolSize(target))`；本轮 `target = sourceContext.quantityTotal = 5`，`manualSourcePoolSize(5) = 15`。
- 丢弃的是 links CSV 行序的第 16–30 名。切片发生在评分之前（`src/tools/manual-score-summary.js:443-446`），而 `save-creator-links.js` 与 `merge-creator-csv.js` 全文没有排序逻辑（对 sort/order 大小写不敏感检索，两文件 0 命中），即插件侧不重排 links CSV 行序；这只能证明插件按 links CSV 行序在评分前位置切，不能证明 Provider 的完整返回顺序。因此截断是**位置切**，不是**按质量取前 N**——下文「损耗量化」里被丢弃的 15 人只是 links CSV 行序靠后的 15 人，不能读成「最差的 15 人」。四个批次（两平台 × 两轮）都验证过：links CSV 前 15 与评分表 15 人双向一致，差集为空。

### 这不是缺陷

梯度池上限是三处文档记录的契约，并有测试覆盖：

- `docs/spec/tools.md:167`、`docs/spec/flows.md:68`、`docs/review-checklist.md:77`（「10 人→30、20 人→50、50 人→100」）。
- `tests/registry.test.mjs:1939-1952`（`manualSourcePoolSize` 阶梯与单调性）。
- `tests/manual-score-summary.test.mjs:359-374`（`candidate_count===30` / `===60` 与 `next_author_ids` 切片）。

可议的是「N=5 时用 3 倍」这个倍数是否合理，不是有没有 bug。改倍数属于改契约，需用户确认；本轮未改。

### 损耗量化

- 被丢弃的 30 人中，只有 4 人存在历史评分记录，全部来自小红书 R1，结论全部为「不推荐」：哟哟很爱吃😋（100/资格待核实）、Xibaziiiiii（49/硬约束失败）、番茄鸡蛋（77/资格待核实）、梦老九小号（100/资格待核实）。其余 26 人没有任何评分证据。
- 「不截断会多出多少推荐」的真实数据点只有这 4 个，答案是 **0 个新增推荐**。按 Wilson 区间外推的上界估计为小红书 8–14、抖音 7–14，属于上界，不作为结论。
- 前 15 人推荐率：小红书 R2 12/15、抖音 R2 11/15、抖音 R1 9/15、**小红书 R1 0/15**（该轮 0 推荐的真实根因是报价别名缺失，已在同日发布修复，与截断无关）。
- 批次代价上界：候选 15 → 2 批（5+10）；候选 30 → 3 批（5+20+5），即 +1 批 / +15 人。
- 抖音 R1 与 R2 的 links CSV 字节相同（sha8 `1530c4a4`），两轮丢弃的是同一批 15 人。

### 记录更正

`docs/verification/2026-09-10-manual-search-score-e2e.md` 原第 132 行「受控归一化后为 15 个不同候选」与验收清单「状态查询取 30，去重 15」把收缩归因于归一化去重，与上述测量矛盾，已就地更正并保留更正说明。

### 上游复核：搜索条件没有把已知合格候选挡在外面

「搜不到人」最后一个未量化的环节是「发给 Provider 的筛选条件本身是否过窄」。子代理复核（2026-09-10，只读）结论：**已测到的搜索条件与用户需求逐项一致或更宽，看不到条件把已知好候选挡在门外的直接证据**；收缩点仍是插件侧截断。

已证实的部分：

- 插件链路不传任何筛选值——`manual_source_creators` 入参只有 `{requirement_id}`，`search_by_dict` 由 Provider 从后端保存的需求组装，所以「条件从哪来」只能追到「保存的需求 + Dify 手扒工作流输出」。
- 抖音 R2 的筛选值可从 `.ypscan-e2e/20260910/published-provider-runs.json` → `hand.outputs` 逐值读出：`tag=["美食"]`、`tag_level_two=["美食教程"]`、`author_id="家常菜制作,菜谱教学"`、`search_by="内容找人"`、`follower__ge/__le="10000"/"1000000"`、`price_by_video_type="植入视频"`、`price_by_video_type__ge/__le="0"/"120000"`，地区/人群/CPM/CPE/互动率/完播率全空。粉丝区间与内容形式直接来自用户需求；价格上界 120000 是插件按规则推导（抖音 code 节点 ×1.2，属既定契约、用户确认不计缺陷）；`search_by` 在提示词与 code 节点两处硬编码为「内容找人」。
- 两平台 R2 的搜索都稳定返回 30 行、30 个不同 ID、0 重复；已逐人核验的 10 位抖音 R2 达人报价 0–100000、粉丝 1万–100万，全部落在条件之内。条件与返回的池子自洽。

三处需要盯的点（均无对照数据，不主张量级）：

| # | 条件 | 方向 | 证据强度 |
| --- | --- | --- | --- |
| 1 | `tag_level_two` 实测只输出 1 个值 `["美食教程"]`，用户要的是「家常菜制作、菜谱教学」两类（提示词允许最多 5 个） | 收窄 | 有实测值，无对照 |
| 2 | `author_id = "家常菜制作,菜谱教学"` 用中文逗号并列两个关键词；插件提示词明写「不添加 AND、OR 等未经约定的查询语法」，说明插件自身也不确定 Provider 语义 | 若 Provider 按 AND 处理则显著收窄 | 值实测，合取语义无证据 |
| 3 | 抖音 R1 的 `tag_level_two = ["乡村野食","美食其他"]`（错误值） | 搜错池子，不是收窄，2026-09-10 已补枚举 | 已记录并修复 |

无证据的部分：小红书的搜索 run 实际筛选值全部未落盘（只有字段名清单，R2 比 R1 少 `noteType`）；Provider 对同字段多值是 AND 还是 OR、筛选是硬过滤还是排序加权，均无证据。

取证建议（未执行）：优先验证 `author_id` 的合取语义——同一需求跑两次，一次单关键词、一次双关键词，比对 `selected_count`。这比继续在插件侧挖更可能改变结论。

## 二、候选池上限 15 与实返 30 行：已定位

`manualSourcePoolSize(5) = 15`，但两轮搜索与候选池实际都是 30 行。本节此前记为「证据不足，不主张原因」；现已由运行记录判定：**不是 Provider 超发，是 Agent 主动按 `num=30` 取数，Hook 注入的 15 未被采用。**

此前判不出来的原因很简单：`.ypscan-e2e/20260910/*.json` 里没有任何 `num` 键，`published-provider-runs.json` 的手扒工作流 `outputs` 只记录解析后的筛选条件。`num` 的实际取值只存在于运行态记录 `~/Library/Application Support/YP Action/ypaction.sqlite` 的 `cowork_messages` 表里（工具入参在 `metadata.$.toolInput`，Provider 回执在 `content`）。

### 判定一：Provider 从不超发（46/46 观测）

状态查询回执同时带 `requested_num` 与 `selected_count`。全部 46 条观测：

| 关系 | 条数 | 说明 |
| --- | --- | --- |
| `selected_count > requested_num` | **0** | 一次都没有 |
| `selected_count = requested_num` | 16 | 供给充足时精确取满（9→9、30→30、90→90） |
| `selected_count < requested_num` | 30 | 全部带 `partial: true`、或 `no_more_creators: true`、或 `selected_count = 0` |

即 `num` 是取数上限，Provider 要么取满、要么取到供给耗尽。**「Provider 不按 `num` 精确取数（超发）」这一假设被排除。**

顺带澄清 `num` 语义（`docs/plans/creator-search-and-scoring-remediation.md` 曾列为未验证项）：`no_more_creators` / `missing_count` 字段与精确取满的行为，与「`num` 控制新增取数、取不到时标记供给耗尽」一致。但回执字段本身无法区分「按 num 取数」与「取全量再截断到 num」，此处不作断言——对本节结论也无影响。

### 判定二：Agent 实发 30，Hook 注入 15

四个手动拓展批次（batch 632/633/634/635，2026-09-10 01:57:16 / 02:13:20 / 02:17:49 / 02:25:47）的回执全部是：

```json
{"requested_num": 30, "selected_count": 30, "success_count": 30, "partial": false, ...}
```

请求量、取数量、成功量三者一致，无超发。同一时段 `manual_source_creators_status` 的工具入参（`metadata.$.toolInput.num`）就是 30；而四个批次前 32–39 秒注入的 `MANUAL_SOURCE_TARGET_NUM=` 值均为 **15**。**Hook 说 15，Agent 发 30。**

### 判定三：30 不是 Provider 的供给上限

「总是只能拿到 30 人」容易被读成 Provider 侧封顶。子代理把全部 49 次状态查询（46 条回执、43 次 completed）按 `requested_num` 分组后，该假设被排除：

| `requested_num` | 9 | 15 | 30 | 50 | 60 | 90 |
| --- | --- | --- | --- | --- | --- | --- |
| 次数 | 6 | 1 | 19 | 2 | 2 | **16** |

- `requested_num=90` 的批次里有 572/573/574 三次**取满 90/90**，`partial=false`、`missing_count=0`；batch 589 的构建回执自报 `num:30, max_num:150`。**上限至少到 150。**
- `no_more_creators: true` 出现 10 次，**全部**是 `requested_num=90` 且 `selected_count=0`，**从未在 `requested_num=30` 上出现**。
- 供给耗尽确实存在，但按需求分档不同：`requested_num=30` 的 16 次里有 9 次 `partial`，最低掉到 4–5 人；`requested_num=90` 的 16 次里有 10 次直接 0。

所以 30 行这个数来自**请求量**（Agent 实发 30，见判定二），不是供给天花板。**「搜不到人」在 Provider 侧的真实形态是「按需求分档、部分批次供不上」，不是「一律封顶 30」。**

证据边界：回执里没有候选池规模字段，也没有「同一需求换不同 `num`」的对照实验，因此无法区分「Provider 真的没有更多」与「Provider 按 `num` 取数后再截断」。

### 不是偶发：39/46 遵守，7 次偏离全部集中在换版后的调用上

`.ypscan-loop/num-vs-inject.mjs` 把每次 `manual_source_creators_status` 调用与它之前最近一次 `MANUAL_SOURCE_TARGET_NUM=` 注入配对（46 次注入、49 次调用，其中 3 次调用不带 `num`）：

| 结果 | 次数 |
| --- | --- |
| 注入值与实发 `num` 一致 | **39**（84.8%） |
| 不一致 | 7 |

7 次不一致只有两种取值对：`6 → 30` ×3、`15 → 30` ×4，偏离时一律回落到 30。本文件上一版把成因写成「注入值小于 30 时不被遵守」，该表述**已被下面的分层推翻**：同一个注入值 15，换版前被原样遵守（1/1），换版后被回落到 30（0/4），单看大小解释不了。

### 偏离的真实变量：指令换版 + 梯度表吸附

Hook 指令文本在 **2026-09-09 13:54:09** 前后换过一版，数据库里两版并存（旧版 36 条注入、新版 10 条）：

| 版本 | 判据（`content` 子串） | 注入值集合 | 配对调用 | 偏离 |
| --- | --- | --- | --- | --- |
| 旧版（3 倍） | `quantityTotal 的 3 倍` | 9, 15, 30, 60, 90 | 36 | **0** |
| 新版（梯度） | `按目标人数梯度取数` | 6, 15, 30, 50 | 10 | **7** |

`.ypscan-loop/num-version-crosstab.mjs` 先做版本 × 注入值交叉表，`.ypscan-loop/num-table-snap.mjs` 再做关键分层——新版指令原文带一张显式表 {10 人→30、20 人→50、50 人→100}，检验偏离是否只落在「新版 × 注入值不在表内」这一格：

| 分层 | 配对调用 | 可比（带 `num`） | 偏离 |
| --- | --- | --- | --- |
| 新版 × 注入值**不在**表内 | 7 | 7 | **7（100%）** |
| 新版 × 注入值**在**表内 | 3 | 3 | 0 |
| 旧版 × 表外值 | 25 | 25 | 0 |
| 旧版 × 表内值 | 11 | 11 | 0 |

表外的 7 次就是 `6×3`（qT=2）与 `15×4`（qT=5）。旧版同样出现过表外的 9/15/60/90 共 25 次，一次都没被改。单尾 Fisher 精确检验 p ≈ **2.97e-7**（7 次偏离恰好全落在新版一侧）。

**天然对照是注入 15**：大小相同、结果相反，所以变量只能是「新版指令把梯度表当成穷举规则，表外值被吸附到表内最小档 30」。30 恰好等于 `manualSourcePoolSize(10)`，但旧版数据里 15 被原样发出，说明 30 不是模型的无条件默认值。

完整映射（`.ypscan-loop/num-3x-detail.mjs`，qT 取注入前最近一次 `validate_requirement` 的 `quantityTotal`）：

| 批次 | qT | Hook 注入 | Agent 实发 |
| --- | --- | --- | --- |
| 626 / 627 | 20 | 50 | 50 |
| 628 / 629 / 630 | 2 | 6 | **30** |
| 631 | 10 | 30 | 30 |
| 632 / 633 / 634 / 635 | 5 | 15 | **30** |

旧版对照：qT=30→90→90、qT=5→15→15、qT=10→30→30、qT=3→9→9、qT=20→60→60。

### 新版指令原文（`MANUAL_SOURCE_STATUS_NUM_RULE`，`src/hooks/register-flow-directives.js:71`）

> manual_source_creators_status 的 num 只在当前环境 live schema required 时才传：按目标人数梯度取数（10 人→30、20 人→50、50 人→100，正整数）。Hook 的 MANUAL_SOURCE_TARGET_NUM 已是该梯度取数数量，直接使用，不得再次乘倍数；最终交付目标和不足判断仍使用用户需求人数。schema 不接受 num 时不得附带，避免无效重试。

旧版原文为「取用户需求人数 quantityTotal 的 3 倍（正整数），例如需求 30 人则 num=90」，仍留在 36 条历史注入里。两版都含 `num 只在当前环境 live schema required` 子句（46/46）。3 次不带 `num` 的调用全部发生在 **2026-09-02**（session `d815306f`，batch 589/591/592），早于两版指令的配对记录，无法归因到换版。

### 文档不一致：梯度表在指令里被截短

`manualSourcePoolSize` 的真实映射由代码与测试定义：`n<=10 → 3n`、`n<=20 → 2n+10`、否则 `max(2n, n+30)`，锚点 10→30、20→50、50→100（`src/contract/registry.js:19-25`，`tests/registry.test.mjs:1939-1952`）。按此 **qT=30 应取 60**：`tests/hard-controls.test.mjs:618-650` 用 `quantityTotal: 30` 断言 `MANUAL_SOURCE_TARGET_NUM=60`，`skills/media-assistant/SKILL.md:90` 与 `skills/media-assistant/references/tools/manual_source_creators_status.md:15` 也写明「需求 30 人则取 60」。

但 Hook 指令文本（上面那条原文）只列 10/20/50 三个锚点，既没有 30→60，也没有「中间档按 `manualSourcePoolSize` 计算」。模型看到的是一张三个点的表，于是把 6 和 15 判为「不在表内」并吸附到 30。梯度表文本在仓库里出现 14 处（`CHANGELOG.md:13`、`AGENTS.md:20`、`README.md:24`、`docs/review-checklist.md:29,77`、`docs/spec/flows.md:64,68`、`docs/spec/contracts.md:105,124`、`docs/spec/tools.md:167`、`docs/plans/creator-search-and-scoring-remediation.md:9,21`、`SKILL.md:90,92`、`references/tools/manual_source_creators_status.md:15`、`register-flow-directives.js:71,1732`），其中只有 `SKILL.md:90` 与 `manual_source_creators_status.md:15` 两处带 30→60——**指令文本是唯一缺它的地方**，也正是模型实际读到的那个地方。

### 影响

- 30 行是 Agent 要来的，随后被 `src/tools/manual-score-summary.js:443-446` 按 `manualSourcePoolSize(target) = 15` 截断到 15。**每批多取 15 人、取来即丢**：多付一次取数与归一化，评分仍只有 15 人。
- 代价分档：把 Agent 的 `num` 拉回注入值能消掉这份浪费，但**不改变最终候选池 15 人**；只有同时放宽 `manualSourcePoolSize` 才会真正扩大候选集。前者是行为对齐，后者是契约变更。

### 修法（均未实施，需用户批准）

| 方向 | 做法 | 前置条件 |
| --- | --- | --- |
| 补齐梯度表 | 在 `register-flow-directives.js:71` 的指令文本里补「需求 30 人则取 60」并说明「三个锚点不是穷举，中间档按 `manualSourcePoolSize` 计算」 | 只改 hook 指令文案，不碰契约；命中率最高的方向，但仍属指令变更，需用户批准 |
| 强制对齐 | `before_tool_call` 钩子直接覆写 `params.num` | 宿主是否允许 hook 改写入参，未验证 |
| 事后纠正 | 回执的 `requested_num` 与注入值比对，不一致时下发纠正指令 | 需确认纠正指令在流程中的插入点 |
| 收紧表述 | 工具卡与文档写明「`num` 必须取注入值」 | 只降低概率，不保证 |

四种方向的取舍：前两种修的是「表外值被吸附」这个已定位的成因，后两种修的是「模型不听话」这个笼统假设。数据支持先做第一种——7 次偏离全部发生在带表的新版、且全部是表外值，补齐表把成因直接消掉，不需要宿主能力支持。

### 待查点（保留）

`src/hooks/register-flow-directives.js:634`（`MANUAL_SOURCE_TARGET_NUM=${num}`）、`:699-701` 与 `:771-773`（`manualSourcePoolSize(quantityTotal)`）、`:71`（hook 指令文本）。

## 三、评分口径复核

### 已证实的机制

1. Provider 相关度只有 9 个可达值：`score = 100.0 * (content_level + type_level) / 8.0`，两维各取 0–4 整数（`tests/fixtures/dify-final.py:86-93`）。一档 = 12.5 分；(77.0, 85.5) 区间不可达。
2. 档位阈值 85/72/60（`dify-final.py:96-105`）在这套取值下等价于「两维档和 ≥7/≥6/≥5」，阈值本身不额外提供分辨率。把 `coverage` 项算进去后，可达分是 **9 段区间**而非 9 个点：`[0,2] [10.5,14.5] [23,27] [35.5,39.5] [48,52] [60.5,64.5] [73,77] [85.5,89.5] [98,100]`；三个阈值**全部落在空隙内**（85 ∈ (77,85.5)、72 ∈ (64.5,73)、60 ∈ (52,60.5)），所以档位与 `coverage` 无关，只由 `content+type` 决定（25 个组合逐一带内验证，档位全部稳定）。余量很小：85 距 85.5 差 0.5 分、60 距 60.5 差 0.5 分、72 距 73 差 1.0 分。因此这条冗余**依赖 coverage 系数**：设偏移上界为 `c/2`，只要 `c ≤ 5.0` 就成立，当前 `c = 4.0`（偏移 ±2.0），余量 0.5 分。e2e 记录里的 14 个真实分（100×4、77、89.5×2、76.2×2、76.5、64.5、63、88.4、52）全部落在可达区间内，无一在空隙中。
3. 综合分中 30% 来自同批同平台排名：性价比分是批内百分位（`percentileScores`），n=15 时每名次约 2.143 分。小红书 R2 有 6 人相关度同为 100，排序完全由性价比决定。
4. 同一达人 52 → 77 的差异来自复核覆盖：`review_levels` 四个维度齐备时替换初评 `levels` 与 `coverage`（`dify-final.py:197-204`），本例内容与类型各 +1 档。

### 本轮降级：单一指标独占权重

这一节把「0 当缺失」和「单指标独占权重」分开定级，两者性质不同。

**「0 当缺失」是已记录的业务标准，不是缺陷。** `positiveNumber`（`src/tools/manual-score-summary.js:197-200`）对 0 返回 `null`，与实测记录里用户的口径一致：`docs/verification/2026-09-10-manual-search-score-e2e.md:167` 写明「糖糖和城妈的合作阅读、CPM/CPE 均为 0，按商业效果缺失处理，不当成免费或最佳性价比」。源表里的 0 表示未填写，不是免费；若改成把 0 当最便宜，会把缺数据的人推到性价比第一名，与业务标准相反。因此**不应修改**。

**剩下的才是潜在健壮性问题**：`costEffectivenessScores` 中

```js
const score =
  cpmScore == null
    ? cpeScore
    : cpeScore == null
      ? cpmScore
      : CPM_WEIGHT * cpmScore + CPE_WEIGHT * cpeScore;
```

只有一个指标可用时，该指标按 100% 权重计入（偏离 0.6/0.4），且不走「缺失按同批中位数代入」的回落。百分位分数本身在同一批内可比，所以这不构成系统性抬高，只是少了平滑、方差更大；按真实数据判定影响为零（见下表）。

用 `costEffectivenessScores` 的忠实复刻跑四份 R2 批次评分表：

| 平台 | 行数 | 两项都有 | 只有 CPM | 只有 CPE | 都没有 |
| --- | --- | --- | --- | --- | --- |
| 小红书 | 15 | 15 | 0 | 0 | 0 |
| 抖音 | 15 | 15 | 0 | 0 | 0 |

两条分支在真实 R2 数据上一次都没命中——小红书的「合作 → 日常」回落把所有合作阅读/互动为 0 的行都救回来了。结论：这是潜在健壮性问题，不是现行算错。修它属于稳健性改进，不是修 bug。

### 重分类为已记录契约：档位与综合分不一致

最终表按综合分降序，但「匹配等级」仍取 Provider 相关度档位，因此会出现高分「不推荐」排在低分「推荐」之前。`docs/spec/tools.md:169` 与 `docs/review-checklist.md:82` 都写明「匹配等级仍取 Provider 相关度档位」，`grep -rn 匹配等级 src/ tests/` 除该文档行外无命中——插件从不读写该列。改档位需用户明确批准，本轮未改。

结构原因已读码确认：`saveSummaryWorkbook`（`src/tools/manual-score-summary.js:346-358`）只改写「综合得分」单元格并按 `display_score` 降序重排（`:529`），「匹配等级」与「推荐结论」两列原样搬自 Provider 批次评分表；`recommendedCount` 也取自 Provider 的「推荐结论」（`:167-175`、`:538`）。因此只要 0.3 权重的性价比分改变了排序，最终表就会出现高分不推荐。

分歧已量化（`.ypscan-loop/tier-vs-blend.mjs` 复刻性价比 + 0.7/0.3 混合，跑 R2 四份批次评分表）：

| 平台 | 行数 | Spearman(相关度, 综合分) | 推荐结论分布 |
| --- | --- | --- | --- |
| 小红书 | 15 | 0.863 | 推荐 12 / 不推荐 3 |
| 抖音 | 15 | **0.479** | 推荐 11 / 不推荐 4 |

抖音综合分第一名（谈家二姑娘 83.7）的「推荐结论」是**不推荐**、「匹配等级」是资格待核实，且 11 个推荐行的综合分全部低于最高的不推荐行；小红书有 2 个不推荐行（60、79.2）高于 7 个推荐行。可解释的成因：抖音相关度只用了 2 个可达档带，而性价比是 15 个名次 × 7.143 分 × 0.3（每名次 2.14 分），0.3 的权重足以在窄相关度带内重排；小红书相关度铺开 4 个档带，ρ 就高。

顺带发现：真实数据里「匹配等级」出现第五种取值 `资格待核实`（两平台各 2 行），不在 `dify-final.py:96-105` 的 首选/次选/备选/不推荐 四档阶梯内，说明该列承载的是 Provider 侧的资格状态，与四档阶梯不是同一套枚举。

### 「高分不推荐」的 7 行全部是 Provider 侧判断，插件侧 0 行

R2 两平台共 30 行，7 行「推荐结论 = 不推荐」，子代理逐行回溯到源头：

| 成因 | 行数 | 证据 |
| --- | --- | --- |
| Provider 硬条件未核实（`资格待核实`） | 4 | Provider 批次表里该行硬条件为 UNKNOWN；抖音 4 行的「植入视频报价」在**全部 6 份上游文件里都是空**，缺失点在插件之上 |
| Provider 内容相关度判定 | 3 | 懂日常 50、骏弟 48.6、大头 23.8，均为 Provider 相关度分本身偏低 |

- 插件**从不读写**「匹配等级」与「推荐结论」：`grep` 全仓库对 `匹配等级` 零命中（仅文档提及），代码里只有 `verdict === "推荐"` 的一处计数（`src/tools/manual-score-summary.js:175`），`saveSummaryWorkbook`（`:346-358`）只改写「综合得分」单元格。
- 因此 7 行不推荐没有一行是插件造成的；排序反转（不推荐行排在推荐行之前）是 `display_score` 降序排列（`:529-533`）的可见性效应，不是结论被改。
- 这 7 行**都没有**命中「0 当缺失」的中位数回落分支。
- 4 行缺失报价的估算（仅供理解量级，不作数据）：按 `预期CPM × 预期播放量 / 1000` 反推，谈家二姑娘约 600 元、咸淡超人约 2000 元。缺失报价的根因在 Provider 上游数据，修它不在插件侧。

### 产物溯源：混合层目前没有端到端证据

本节所有混合分数（98.7 / 83.7 等）都来自**离线复算**。真实运行产出的两份 summary 工作簿（02:24:55 / 02:32:25）逐人比对与 Provider「综合得分」**完全一致、零差异**，即混合层在真实运行中未生效；03:13:34 那两份带混合的产物由 `.ypscan-e2e/20260910/summary-blend-replay.json`（自述 `not an Agent E2E run`）按名指认为其输出。成因与判定见第四节。

### 其余观察

- 33% 的评分行落在 85/72/60 阈值 ±3 以内，结论对单档变化敏感。
- `similarity` 仅用于展示，与结论不相关。
- 性价比「无排名」的触发条件比文档宽：`percentileScores`（`src/tools/manual-score-summary.js:214-222`）在批内不同取值不足 2 个时对整批返回 `null`，因此整批成本完全相同、或只有 1 个候选带数据时也会退回「保留原相关度分」，而不只是「整批无商业数据」。批内无可排序信息时回落是合理的；`docs/verification/2026-09-10-manual-search-score-e2e.md:117` 与 `docs/review-checklist.md:82` 的措辞窄于实现，属表述问题而非行为缺陷，R2 未触发（两平台 `both=15`；`.ypscan-loop/ties.mjs` 复算四份 R2 批次表，CPM/CPE 两侧各 15 个取值全互异、并列组 0）。并列路径在测试里也是零覆盖（`tests/manual-score-summary.test.mjs:224-292` 的两组混合分取值全互异），因此并列口径既无真实数据触发，也无回归保护。

### 离线复算对账

复刻 `costEffectivenessScores` + 0.7/0.3 混合，跑四份 R2 批次评分表，两平台前五与 `docs/verification/2026-09-10-manual-search-score-e2e.md` 记录完全一致：小红书 98.7 / 93.1 / 92.3 / 86.7 / 86.3；抖音 83.7 / 82.8 / 79.9 / 78.9 / 77.0。单人代理口径也对上：樱子的厨房日记 cpm 76.289 / cpe 1.376；小鹿鹿子 cpm 43.385 / cpe 1.745。零分分支：R2 共 30 行，最低综合分 23.8，未在真实运行中命中。

**证据分层**：本节全部为离线复算与本机产物读取，不等于 Agent 端到端验收，也不等于发布版 Provider 调用；端到端结论仍以 2026-09-10 双平台实测记录为准。

## 四、运行态加载路径：已定位，且修复未生效

这个问题决定 2026-09-10 的修复（报价别名、状态机、综合分混合）对真实消费方是否生效。本节此前记为「证据不足，无法判定」；现已由宿主配置 + 运行记录 + 产物逐人比对三路证据判定：**加载点是 `~/Library/Application Support/YP Action/third-party-extensions/ypscan` 的 1.0.20 副本，其 `src/tools/manual-score-summary.js` 停留在 2026-09-09 23:08:35，不含混合层——所以 0.7/0.3 混合在真实运行中未生效。**

### 加载点：配置直接写明

`~/Library/Application Support/openclaw/state/openclaw.json` 的 `plugins.load.paths` 只列两项：应用包内路径（不含 ypscan）与 `~/Library/Application Support/YP Action/third-party-extensions`；`entries.ypscan.enabled = true`。ypscan 只可能从第二项加载，即上述副本。

### 该副本整体冻结在 2026-09-09 23:21:17

副本内**没有任何文件比 2026-09-09 23:21:17 更新**；最新的几个是 `validate_requirement.md` 23:21:17、`registry.js` 23:19:57、`ypscan_summarize_manual_scores.md` 与 `SKILL.md` 23:13:44、`manual-score-summary.js` 23:08:35。**唯一缺新代码的就是 `manual-score-summary.js`**：21,718 B，sha16 `bf83e4d651fd1d40`，`grep -c` 混合层常量（`CPM_WEIGHT`/`costEffectivenessScores`）为 **0**；仓库同文件 26,831 B、带 227+/4− 未提交改动、常量在 15–18 / 254 / 527 行。

### 运行记录：宿主最后一次工具调用是 02:32:25，之后没有运行

`~/Library/Application Support/YP Action/ypaction.sqlite` 的 `cowork_messages` 里 tool_use 行覆盖 2026-09-02 17:59:05 → **2026-09-10 02:32:25**（1661 行）。02:00–02:40 有 147 行（阳性对照），02:50–03:40 **0 行**。即 03:13 前后宿主没有跑过任何工具。

### 产物逐人比对：宿主产出是 Provider 原值，混合只出现在离线复算产物里

`.ypscan-loop/loadpath-blend-check-022x.mjs` 把 summary 工作簿的「综合得分」与对应 Provider 批次评分表逐人比对（按昵称 join）：

| summary 工作簿 | 产出时间 | 与 Provider「综合得分」相同 / 不同 | 综合得分列 |
| --- | --- | --- | --- |
| DY `-408d9aa54d925e8f` | 02:32:25 | **10 / 0** | 89.5, 89.5, 89.5, 88.4, 77, 76.7, … 48.6, 23.8 |
| XHS `-e7d09dc6a6320557` | 02:24:55 | **10 / 0** | 100×7, 77, 77, 75.5×3, 64.5, 63, 50 |
| DY `-71fac6562c41c2c0` | 03:13:34 | **0 / 10** | 83.7, 82.8, 79.9, 78.9, 77, 76.6, … 42.2, 20.1 |
| XHS `-b7b013782cc3888e` | 03:13:34 | **0 / 10** | 98.7, 93.1, 92.3, 86.7, 86.3, 79.2, … 55, 35 |

两平台宿主运行产出与 Provider 原值**逐人一致、零差异**，与「副本无混合层」互相印证。

### 03:13:34 那两份混合产物是离线复算，不是 Agent 运行

- `.ypscan-e2e/20260910/summary-blend-replay.json`（mtime **03:14:02**）自述 `"offline replay of summarizeManualScores against real R2 batch workbooks; not an Agent E2E run"`，并把上表 03:13:34 的两份工作簿**按文件名**列为 `summary_file`，其 `rows[].blended_score` 与工作簿「综合得分」列逐行相同。**03:13:34 的产物就是这个复算脚本自己的输出。**
- 宿主工具调用在 02:32:25 截止，03:13 前后无任何运行。
- 更正一条上一版的外推：曾用「仓库文件 mtime 03:14:25 晚于 03:13:34」推断它不可能由仓库代码产出。该论证**不成立**——`/private/tmp/pretty-mss.js`（03:14:22）与仓库文件 sha256 完全相同（`924e03796235657c7b1fbfdf…`），说明 03:14:22–25 只是 prettier 格式化往返，mtime 被刷新而内容未变。结论不依赖这条，改由「复算记录按名指认 + 宿主无运行 + 副本无混合层」三路支撑。

### 判定

**混合层在真实运行中未生效**：宿主加载的副本缺混合代码，最近一次真实运行（02:2x）产出的是 Provider 原值。**离线复算产物不能当作端到端证据**——它证明的是仓库代码在真实输入上的行为，不证明宿主跑的是仓库代码。

下一步（本轮未执行，需用户批准）：把副本更新到仓库版本，或改 `plugins.load.paths` 指向仓库目录，然后重跑一次双平台手动拓展，产出一份综合分降序且带混合层的工作簿。属环境变更，需用户确认。

## 五、本轮未改动

- 插件代码、测试、Provider/Dify 模板与已发布工作流均未修改；只更正了实测记录中两处与测量矛盾的归因表述。
- 梯度池倍数、85/72/60 阈值、「匹配等级」口径、单一指标权重分支都涉及契约或业务决定，留待用户确认后再动。
- 第二节新增的「Agent 实发 `num` 与 Hook 注入值不一致」（46 次里 7 次）同样未修：成因现已定位到新版指令的梯度表被当成穷举，但四条修法的首选要改 `register-flow-directives.js:71` 的指令文案，属 hook 行为变更，留待用户确认；其余三条还依赖尚未验证的宿主能力或流程插入点。**2026-09-10 用户批准后已实施首选修法**：`register-flow-directives.js:71` 与 `:1732` 改为「`num` 取 Hook 的 `MANUAL_SOURCE_TARGET_NUM` 原值，括号内只是示例、不是档位表也不是穷举」，并补 5 人→15、30 人→60；工具卡、`skills/media-assistant/SKILL.md`、`docs/spec/flows.md`、`docs/spec/contracts.md`、`docs/review-checklist.md` 同步；`tests/flow-directives.test.mjs`、`tests/hard-controls.test.mjs` 补指令文本与表外人数回归，`tests/registry.test.mjs` 补 `manualSourcePoolSize(5)=15`、`(6)=18`、`(30)=60`。这些只是指令生成测试，模型是否不再传错仍待真实运行验收。
- 第四节没有代码改动：旧快照目录未清理、未移动、未改动（它是既有环境的一部分，清理属环境变更，需用户确认）。

### 待决事项与批准后的第一步

六项全部需要用户决定或授权，本文件只给方向与落点，不预设结论。证据位置指向本文对应小节。

| # | 事项 | 证据 | 建议方向 | 批准后的第一步 |
| --- | --- | --- | --- | --- |
| ① | N=5 时梯度池取 3 倍（`manualSourcePoolSize(5)=15`） | 一、二 | 倍数属契约；若「搜不到人」优先，可评估把低档倍数调平。注意截断是按 links CSV 行序在评分前位置切、不是按质量取前 N（一、收缩机制）；本地 0 处 sort/order 只能说明插件不重排，不能证明 Provider 的完整返回顺序。放大池子即使 Provider 顺序与质量无关也可能增加合格数，收益未知，需真实运行实测 | 改 `src/contract/registry.js:19-25`，同步 3 处文档与 `tests/registry.test.mjs:1939-1952` |
| ② | 85/72/60 与 9 段可达区间的冗余只剩 0.5 分（依赖 `c ≤ 5.0`） | 三、已证实机制 2 | 阈值落在空隙中点是巧合，不是设计；可改成显式档位判据 | 改 Provider 评分模板的档位判据（仓库内对应 `tests/fixtures/dify-final.py:96-105`），并重发已发布工作流 |
| ③ | 0.3 权重在抖音几乎打乱排序（ρ=0.479） | 三、重分类为已记录契约 | 二选一：提高相关度权重，或最终排序仍以 Provider 相关度为准 | 改 `src/tools/manual-score-summary.js` 权重常量，同步 `tests/manual-score-summary.test.mjs` 与 `docs/spec/tools.md:169` |
| ④ | `num` 实发与 Hook 注入不一致（46 次里 7 次） | 二、偏离的真实变量 | 首选「补齐梯度表」；另三条依赖未验证的宿主能力 | 改 `src/hooks/register-flow-directives.js:71` 文案补 30→60 并写明锚点非穷举，加一条对指令文本的断言（2026-09-10 已实施，见五） |
| ⑤ | `author_id` 多值合取语义无证据 | 一、上游复核 | 若按 AND 处理则显著收窄，是「搜不到人」最可能的上游变量 | **需授权**：同一需求跑两次（单关键词 / 双关键词），比对 `selected_count` |
| ⑥ | 运行态加载的是冻结副本，混合层未生效 | 四、判定 | 更新副本或改指向仓库，才能真正验证本轮修复 | **需授权（环境变更）**：更新副本或改 `plugins.load.paths`，重跑双平台，产出综合分降序且带混合层的工作簿 |

其中 ⑤ 与 ⑥ 是本文件唯一两条「继续在插件侧挖不会改变结论」的项：⑤ 决定搜索条件是否收窄，⑥ 决定修复对真实消费方是否生效。

## 六、验证

- `npm run lint`、`npm run typecheck`、`npm test`（591/591，0 fail）、`npm run smoke`（tools=5, hooks=5）全绿（本轮复核基线）。
- 复算脚本与原始测量产物在本机 gitignored 目录 `.ypscan-loop/`（`exposure.mjs`、`zeros.mjs`、`blend-check.mjs`、`reachability.mjs`、`coefficient-bound.mjs`、`ties.mjs`、`tier-vs-blend.mjs`、`headers.mjs`、`num-vs-inject.mjs`、`num-by-inject.mjs`、`num-version-crosstab.mjs`、`num-table-snap.mjs`、`num-3x-detail.mjs`、`num-inj-count.mjs`、`directive-shape.mjs`、`directive-text.mjs`、`loadpath-workbook-headers.mjs`、`loadpath-workbook-rows.mjs`、`loadpath-blend-check.mjs`、`loadpath-blend-check-022x.mjs`），未提交。第四节的逐人比对由 `loadpath-blend-check-022x.mjs` 复算（表头识别用精确等值 `=== "综合得分"`，因为 `.includes` 会命中 r1 副标题行）。
- 第二节的判定链可复算：`num-vs-inject.mjs` 直接读 `ypaction.sqlite` 的 `cowork_messages`，输出注入值↔实发 `num` 的配对表与不一致明细；`num-version-crosstab.mjs` 做「指令版本 × 注入值 → 实发」交叉表并给出换版时间点与两版注入值集合；`num-table-snap.mjs` 做「版本 × 注入值是否在梯度表内」分层与单尾 Fisher 精确检验；`num-3x-detail.mjs` 给出每批 qT→注入→实发的完整映射；`num-inj-count.mjs` 统计注入行版本分布与不带 `num` 的调用。版本判定靠 `content` 子串（旧版 `quantityTotal 的 3 倍` / 新版 `按目标人数梯度取数`），梯度表取新版指令原文的 `{30, 50, 100}`。
- 第四节的加载路径判定为直接读取，无脚本：读 `~/Library/Application Support/openclaw/state/openclaw.json` 的 `plugins.load.paths` 与 `entries.ypscan.enabled`，比对快照与仓库的 `src/tools/manual-score-summary.js` 字节数/哈希/`grep -c` 常量命中，统计快照目录内全部文件的 mtime 上界；运行态时间上界读 `ypaction.sqlite` 的 `cowork_messages`（`datetime(created_at/1000,'unixepoch','localtime')` 过滤，02:00–02:40 的 147 行作阳性对照）。产物逐人比对见上一条的 `loadpath-blend-check-022x.mjs`。
- 子代理独立缺陷扫描（只读，覆盖本文件 8 条已记录项之外）：**未发现同时满足「文件:行号 + 具体失败场景 + 契约反证 + 最小修复方向」四项标准的新缺陷**。最接近上报的 `percentileScores` 并列口径（`src/tools/manual-score-summary.js:214-222`）经四份 R2 批次表复算为并列组 0、真实数据零触发（测量已并入第三节）；另两条候选（单一指标独占权重、`distinct < 2` 整批返回 `null`）即第三节已记录的潜在健壮性问题。未覆盖范围：Provider 侧语义（`author_id` 合取、`num` 取数语义、筛选是硬过滤还是排序加权）、宿主运行态、约 11k 行不注册也不进发布包的遗留分支。
