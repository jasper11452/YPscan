# 2026-09-10 解析 Dify 工作流修复与发布

状态：搜索参数传导机制已用真实 batch 证明；重解析规则生效后的行为仍未验证（见下）。`contentTag` 修复已通过离线与真实草稿回归，远端解析工作流已发布。published 版本未从 Console 入口实跑，行为由 published 与已验收 draft 的 hash 完全一致推断。

## 搜索参数传导

根因是手动拓展首次澄清后，已确认值只写入顶层字段或 `clarifications`，没有合并进 Provider 实际用于调用 Dify 的 `rawMessagesJson.original`。因此 Provider 重新解析时仍按旧原文生成搜索参数。

本机数据库 `cowork_messages` 的真实 batch 对照（对应 `sequence=38/215/305`）：

| batch | 已确认/输入                               | 实际 `search_by_dict`                                                |
| ----- | ----------------------------------------- | -------------------------------------------------------------------- |
| 600   | 粉丝 `[50000,200000]`；原文仍为“2.5W10位” | `keyword=衬衫`、粉丝 `0..999999999`、`contentTag=[穿搭]`、无博主性别 |
| 606   | 用完整原文重新解析，粉丝 `[50000,200000]` | `keyword=男装衬衫`、粉丝 `50000..200000`                             |
| 612   | 原文改为“粉丝3万以上”后重新解析           | 粉丝 `30000..999999999`                                              |

batch 600 与 606 的差异证明有效需求全文是否更新会直接改变 Provider 实际搜索参数；batch 612 证明开放上界也能按新原文传导。现有 [手动拓展有效需求重解析规则](../../src/hooks/register-flow-directives.js) 已要求：澄清改变有效需求时，使用应用全部已确认澄清的完整全文重新解析，`demand` 与 `rawMessagesJson.original` 同文，`parse_outputs` 全量替换。本次不需要新增一套状态或参数通道。

需要区分“机制已被真实 batch 证明”和“规则生效后的行为已验证”：该重解析规则由提交 `a37304d`（2026-09-09 16:20 +0800）写入 Hook 与 Skill，而本文引用的 batch 600（02:10）、606（11:52）、612（14:12，均为 Asia/Shanghai）都发生在此之前。因此这些 batch 只能证明“有效需求全文变化会改变 Provider 实际搜索参数”，不能证明规则生效后模型会在真实会话中按规则重解析、把完整全文写回 `rawMessagesJson.original`。搜索侧传导目前仍停在提示契约层，尚无规则生效后的端到端行为证据。

“男博主”没有已证实可执行的 `kwGender` 通道；batch 600/606/612 的实际参数都没有博主性别字段，因此不臆造或声称已修复性别筛选。

## 解析工作流缺陷与修复

- 应用：`61300237-5c9a-4894-bd9c-928d0bf3ccc1`。
- 仅修改节点 `1900000000020`「旧版输出格式适配」的 `data.code`。
- 旧逻辑在 common 缺少平台标签时会丢掉平台解析出的 `contentTag`；新逻辑先合并各已选平台的 `contentTag`，再用 common 补缺，并按首次出现去重保序。
- 节点 code 长度：1696 → 2293；其他节点、43 条边和 0 个环境变量保持不变。
- 修复前 draft hash：`f1a2cb9f82211fb9a5fb792179960ea77153b157105cd4884d5bc35cfe1ae70e`。
- 修复后 draft hash：`c45f89a4e3f4c5100463bd79eed326a247e4d486afd6b1c6052d79e1f9774e10`。

离线固定输入 harness 覆盖 common 缺平台标签、双平台合并去重、common 为空、仅抖音、未选平台、固定验收输入和去重保序，全部通过；其中 bug 场景确认旧 code 丢失平台标签、新 code 保留。

真实草稿重复运行 3 次，均 `succeeded`，最终 `contentTag=["时尚男博主","商务","职场","潮流男博主"]`、`followercount="[50000,200000]"`：

- `b8b106de-4cc7-4623-a2a4-5801da15fd76`
- `e278329c-d800-4844-a575-7a1089ad58db`
- `591f3514-7a5b-4f51-bac8-f75f7700b58c`

这 3 次运行中 common 节点已直接产出四个标签，实跑本身不能隔离合并分支；合并逻辑的隔离证据来自上述离线 harness。

## 发布

- 发布前 draft：`a1a87ce6-8aeb-4626-bc19-4d980d4b7bc3`，hash `c45f89a4e3f4c5100463bd79eed326a247e4d486afd6b1c6052d79e1f9774e10`。
- 发布前 published：`0adccaaf-25ce-45c5-a227-391e044a55da`，hash `0d308b092b9e6856c04112172b6b3c0afbf88963cf77754b5919dc254edc8350`。
- 发布：`POST /console/api/apps/61300237-5c9a-4894-bd9c-928d0bf3ccc1/workflows/publish`，body `{}`，HTTP 200。
- 发布后 published：`90a25bfd-765e-4fcf-9b62-30b32aa9309b`，hash 与 draft 相同。
- 发布后均为 28 节点、43 边、0 个环境变量；draft 的 `updated_at` 未因发布改变。
- UI 佐证：刷新工作流页后顶部由“已发布 2 天前”变为“已发布 几秒前”。

## 文件与边界

- 脱敏 JSON 候选：`dify工作流/悦普识星-parse_requirement（远端草稿候选-20260910-脱敏）.json`，SHA-256 `d55217472948d38812c7a5c6f1d840c88808b84515086b6d2741755fd3e205e6`。
- 脱敏 YAML 验收包装：`dify工作流/悦普识星-parse_requirement（远端草稿候选-20260910-脱敏）.yml`，SHA-256 `2e72d471e70aaa6ca0eb8e28bd885159792c00675b3c0fbbf5514c9b9d2630e8`。
- Console 没有可用的已发布版本运行入口，因此没有 published 实跑；发布有效性由回读 hash、workflow id 和节点/边数量证明。
- 搜索侧传导仍属提示契约层，未做规则生效后的端到端行为验证（时间线与证据见「搜索参数传导」）；不能写成搜索侧已修复。
- 3 次真实 run 的 run_id 未通过 Console workflow-runs API 独立复核，该接口对当前账号返回 401；run 结果依据冻结验收记录。
- 去重顺序语义为“平台标签优先、common 补缺”；当下游依赖 common 优先顺序时需重新评估。
