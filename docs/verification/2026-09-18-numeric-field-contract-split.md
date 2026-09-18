# Provider 数值字段区间/单值契约拆分

本记录核查 2026-09-18 手动拓展“点淘小红书活人感女性达人提报”连续两次失败的原因，并记录本次修复依据。未升版、未打包、未提交，也未在真实 Provider 新建任何诊断需求。

## 现场证据（用户会话，未在本机复跑）

1. 第一次调用被本地预检阻断，`blockReason` 含 `YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED` 与两条一次性修正项：`submissionDeadlineAt`（原始需求/澄清没有与提交值一致的证据）、`refNickname`/`refUrl`（必须是字符串）。模型自己算了 30 天后的时间并手写“系统默认”说明；`isManualDefaultDeadline` 只认 `description` 里的规范标记 `提报截止时间由系统默认设置为 <时间>（建需后30天，可覆盖）`，自填值不会补标记。参考达人字段只接受单个字符串，两处参考账号被传成数组。
2. 第二次省略截止时间与参考字段后通过本地预检，Provider 返回：
   `INVALID_PAYLOAD / invalid value for viewMedium: could not convert string to float: '[10000,999999999]'`。即后端把 `viewMedium` 按单值 `float` 读取，而本地把 31 个数值字段统一要求为 `"[min,max]"`。
3. 本地实测 `normalizeToolCallParams` + `validateRequirementPreflight`：给 `viewMedium` 传 `"10000"` 会被归一成 `"[10000,10000]"` 并因 `min < max` 被预检拒绝，传区间才通过预检。插件在该字段上无法产出 Provider 能接受的任何形式，属硬死锁。

## 区间白名单探测（test Provider，无写入）

对 `https://test-mcp.eshypdata.com/mcp` 的 `validate_requirement` 直接发 JSON-RPC，两次都只触发参数校验、未进入建需：

- 把 31 个本地区间字段全部传数字：返回 `INVALID_PAYLOAD / validate_requirement range fields must use [min,max] format`，`invalid_range_fields` =
  `avgcollect, avgcomment, avginteract, avglike, avgview, cpeL1-3, cpmL1-3, followercount, kolOfficialPriceL1-3, likeIncrement, photoInteract, userlikecount`；`rebate` 另报 `empty_fields`（数字不合法，仍按 `"[min,1]"`）。
- 只把 `interactionRate/clickMedium/viewMedium/photoView/videoInteract/femaleRate/age1Rate-age6Rate` 传区间：通过该后端校验，随后因缺少 YPAction 委托身份失败（`YP_ACTION_DELEGATION_REQUIRED`），未写入。

结论：Provider 后端只对白名单内 19 个字段做区间校验；其余数值字段不接受区间，`viewMedium` 的线上报错与之吻合。

## 线上（本地代理）单次探测，无写入

经 YP Action 本地 MCP 代理（`127.0.0.1`，未读取或打印委托凭据）发一次 `validate_requirement`：单值字段全部传区间、截止时间故意传过去时间。返回 `INVALID_PAYLOAD / validate_requirement contains an invalid submission deadline`。这次没有报任何 float 转换错误，说明截止时间业务校验先于字段类型转换，不能用来判断单值字段，故没有继续试写。本轮未产生需求记录。

## 本次修改

- `src/contract/registry.js`：`VALIDATE_REQUIREMENT_RANGE_PARAMS` 收敛为 Provider 白名单 19 项；新增 `VALIDATE_REQUIREMENT_SCALAR_PARAMS`（12 项）只接受单个非负数值字符串，`interactionRate/femaleRate/age*Rate` 额外要求 0–1；新增 `normalizedNumericScalar`（`"60%"`→`"0.6"`，比例字段 >1 且 ≤100 的数字按百分数换算，无法归一成单个非负数值时原样返回交预检）；预检对单值字段收到区间/数组/百分号文本给出明确原因；`STRING_VALIDATE_PARAMS` 不再重复报单值字段的类型错误。区间字段的归一化、证据与平台规则未改。
- `src/hooks/register-flow-directives.js`：预检阻断说明与“数值字段格式锁”指令分别列出区间字段与单值字段的格式要求。
- 工具卡、`docs/spec/contracts.md`、`docs/review-checklist.md`、AGENTS 不变量 6 同步；`validate_requirement` 卡补上“手动拓展无截止时间语境时省略该字段”的明确要求，以及 `refNickname`/`refUrl` 只能传单个字符串、多个参考达人写入 `description` 的说明。

## 验证与边界

- `npm run lint`、`npm run typecheck`、`npm test`（642 项）、`npm run smoke`（tools=5, hooks=5）通过。
- 未验证：这 12 个单值字段中只有 `viewMedium` 有线上报错证据，其余按同一白名单推断；单值代表下限、精确值还是其他语义没有 Provider 文档或回读证据，插件只做格式守卫、不解释语义，也没有在真实 Provider 重跑建需或搜索。
- 未验证：模型是否会稳定按新契约改传单值/省略字段，未做模型行为验收与 YP Action 桌面验收。
- 未处理：`avgview` 等区间字段的上限写法（`999999999` 还是 `-1` 表示无穷）本轮未在真实 Provider 验证；字段语义与上限需要后台确认时再单独跟进。
