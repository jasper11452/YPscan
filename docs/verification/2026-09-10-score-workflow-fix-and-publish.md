# 2026-09-10 评分 Dify 工作流修复与发布

状态：修复已通过离线与真实草稿回归，远端工作流已发布。本文只记录已验证事实；真实运行使用草稿入口，发布版本的行为由 published 与 draft hash 一致、节点/边/环境变量数量一致推断，不等同于 published 入口实跑。

## 应用与版本

- 评分应用：`057896e7-3162-4363-aaf4-933657b21c87`。
- 发布前草稿 hash：`26f444cb026b0a79480575790dd134a65bb724450057c52a398a68914e77fa4f`。
- 修复后草稿 hash：`a0e169b75b5065ca8c9e0de52a351754bae5087cd8ddecf817ab7b181cac26b6`。
- 发布前 published workflow：`d8b109ec-10c2-4b44-a7d0-2920fb6302dd`，hash `13ce7ba66aee58f762946d7b13c803ab47ba314e4ae23e7e46ff3d0666a5791b`。
- 发布后 published workflow：`e927e7fd-8c27-4661-bfd9-d53d09a1174e`，hash `a0e169b75b5065ca8c9e0de52a351754bae5087cd8ddecf817ab7b181cac26b6`。
- 发布前后均为 28 节点、30 边、6 个环境变量；发布后 published hash 与 draft hash 完全一致，draft 的 `updated_at` 未因发布改变。

## 根因

`review_json` 用字符串包含判断“正向价格主张”：

- `claims_ok` 使用 `"符合" in text or "满足" in text`。
- `price_state` 使用 `"满足" in price_state`。

这会把“不满足 / 无法满足 / 未满足 / 不符合 / 不能满足 / 没有满足”等否定语境当成正向主张。价格程序核验已经 `FAIL` 时，复核文本却被识别为价格通过，于是误报 `review_conflict`，覆盖原本正确的硬失败结果。

## 修复范围

- 只修改 `review_json` 节点的 `data.code`，新增 `has_affirmative()`，排除否定前缀后再判断正向主张。
- 未改 schema、prompt、`final`、评分逻辑、其他节点、边、features、conversation variables 或环境变量。
- `review_json` code SHA-256：`b9d34ebdabe0669082df41786177e331f00a95153bfab60f4967c77288cc6ef0` → `1bc1fa25aed5256daa8378ab921857f9eb04162b158f71f242d9d675e556fccf`。
- 远端同步使用 `GET /console/api/apps/<app>/workflows/draft` 后 `POST` 同路径；该 Dify 版本对 `PUT` 返回 405。六个环境变量按 GET 结果原样保留，未读取或记录值。

## 验证

离线直接执行新旧 `review_json` code 的 12 个冻结断言全部通过：否定语境不再误报，正向价格主张仍能检出，价格 PASS 不产生冲突。

真实草稿矩阵重复 3 轮，9/9 通过，全部 `workflow_status=succeeded`、`review_status=ok`：

| 场景                 | 次数 | run_id                                                                                                                     | 结果                                        |
| -------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 硬区间、有报价       |    3 | `4de44af2-c278-480c-b7c7-5a32c9726e3c`<br>`ea260654-d955-49f1-80c7-c205f1ff5215`<br>`bafa08e2-bbb9-4cf3-b291-87b9c99d020d` | `hard_constraint_fail` / 不推荐 / 价格 FAIL |
| 硬区间、缺报价       |    3 | `06792d8a-93b9-40f8-8ecc-e7adc414e0b3`<br>`47169bb6-7861-44d9-a7a9-986889e5627a`<br>`e5c042b3-8173-4db1-9368-a36eda0a01a4` | `qualification_pending` / 不推荐            |
| 可协商参考价、有报价 |    3 | `1e5fe0aa-506c-43fd-8bd5-fbfa7318ba94`<br>`499517b0-bd77-4cde-94d8-55d1f4befb94`<br>`3e8b395c-c7e1-41fe-a0d1-41b251f8746f` | `ok` / 推荐                                 |

缺报价样本使用 `/tmp/alan-matrix-3-noprice.json`；旧记录中的 `/tmp/alan-matrix-3-missing.json` 仍含图文报价和最低合作价，不是有效缺报价样本。

## 发布与文件

- 发布：`POST /console/api/apps/057896e7-3162-4363-aaf4-933657b21c87/workflows/publish`，body `{}`，HTTP 200；随后 GET published/draft 回读。
- UI 佐证：刷新工作流页后顶部显示“已发布 几秒前”。
- 脱敏 JSON 候选：`dify工作流/达人评分（远端草稿候选-20260910-脱敏）.json`，SHA-256 `c4027f408db8da4b1530094e7629b6fcc16d314f9cf6600056ff07aee27f1395`。
- 脱敏 YAML 验收包装：`dify工作流/达人评分（远端草稿候选-20260910-脱敏）.yml`，SHA-256 `b58dde6124ca437e2dcc6c131a72ec43d6f57560d99dc74db195d047297d77c2`。
- 候选环境变量值为空占位，不得用于覆盖远端；远端已按 GET 结果保留六个真实环境变量。

## 残余风险

- 9 次真实草稿运行没有直接触发 `review_conflict`，因为草稿 LLM 每次措辞不同；否定语境修复的直接证据来自旧/新 code 的离线对照。
- `price_state` 分支读取 `business.price`，真实输出更多使用 `H1_报价`、`报价`、`S1` 等键，该分支实际命中较少；本次按授权只修判断，不改 schema 或 prompt。
- `has_affirmative` 只检查目标词前 3 个字符是否以否定词结尾，即否定词必须紧邻目标词；否定词与目标词之间只要插入任何字符就会失效。实测 `不很满足`、`未完全符合`、`无法完全满足` 仍被判为正向主张。本次只按此语义修复，未改窗口逻辑。
- published 版本没有从 Console 入口实跑；发布有效性由发布后 hash、workflow id、节点/边/环境变量数量回读证明。
