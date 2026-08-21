# validate_requirement

Risk tier: automatic internal business write. A complete, unambiguous requirement does not need a creation confirmation. Use `AskUserQuestion` only to clarify required information that is missing, ambiguous, or conflicting.

## Call flow

- This is the second fixed call, immediately after the first successful Dify-backed `ypscan_parse_requirement`. `data.outputs` is the complete raw Workflow output. Structurally expand only the current platform's Provider fragments under the parsing card, preserve every internal value, then let the Agent add all remaining fields from the current requirement. Do not open Browser before `search_creators` and `rank_mcns` finish.
- The parser no longer returns `projections`, `facts`, `search_jobs`, or `VALIDATE_REQUIREMENT_ARGS`. Build one complete top-level Provider object before calling. If the current requirement has multiple independent groups, each group needs an explicit quantity and a separate `validate_requirement` call.
- Do not display a confirmation-only summary and do not offer `确认创建` / `返回修改`. If clarification is genuinely required, call `AskUserQuestion` with only the unresolved items; denial/cancel/close/timeout/missing answer/callback error stops that turn and no answer/default may be inferred.
- Every missing user-required field must be asked; never fabricate one. Omit optional fields the user did not volunteer.
- Each new call creates an independent requirement attempt. Existing sessions, project names, descriptions, `originalBrief`, and historical manifests never identify the new order or block this tool.
- After success, bind the current requirement ID from `data.requirement_id`, falling back to `data.id` only when `data.requirement_id` is absent. `data.demand_id` is a different identifier and must never be used as the requirement ID. For the normal new-requirement flow, do not stop or ask another question: immediately call `search_creators({id: requirement_id})`, ignore its workbook link, then call `rank_mcns` with the same requirement ID and current platform. The MCN list and branch question come only after ranking.

## Argument contract

Pass published production fields directly at the tool's top level. Never wrap in `payload`, use snake_case aliases, or pass legacy fields.

| Class                      | Fields                                                                                                                   | Contract                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-required              | `platform`, `brandName`, `projectName`, `quantityTotal`, `submissionDeadlineAt`, `rebate`, `followercount`, `contentTag` | Supply all; `contentTag` is the non-empty content direction required by creator search; ask only for the minimum rebate and encode it as `[min,1]`; `quantityTotal` is a positive decimal integer string; `followercount` is a non-negative range string |
| User-required price        | At least one valid `kolOfficialPriceL1/L2/L3`                                                                            | Range string; platform rules below                                                                                                                                                                                                                       |
| Agent-generated            | `status`, `createdAt`, `updatedAt`                                                                                       | Set `status="ready"`; timestamps use the same current local second                                                                                                                                                                                       |
| Requirement context        | `description`                                                                                                            | Extract a short Chinese description from stated and clarified requirements                                                                                                                                                                               |
| Optional identity          | `product`                                                                                                                | Product name is optional; do not ask or pass when absent                                                                                                                                                                                                 |
| Optional reference creator | `originalBrief`, `description`                                                                                           | Never pass `refNickname`/`refUrl`. Keep the original wording in `originalBrief`; when a later WeCom exact-match check is needed, also use labeled `参考达人：...` / `参考达人链接：...` text in `description`                                            |

The Agent fills `status`, `createdAt`, and `updatedAt`; never ask the user for them. Do not pass `id`, `demandId`, or `demandVersion` for a new requirement.

`platform` accepts exactly `xiaohongshu` or `douyin`. Never pass `小红书`, `抖音`, `xhs`, or `dy` to this tool.

MCP error `-32062` is a Provider server error, not JSON-RPC `-32602 Invalid params`. Read and report its exact message/details. Do not change already-valid fields unless the error explicitly names a field, and never blindly retry this write.

### Minimum valid call

```text
validate_requirement({
  status: "ready",
  platform: "douyin",
  brandName: "客户品牌",
  projectName: "2026秋季新品推广",
  createdAt: "2026-07-24 19:30:00",
  updatedAt: "2026-07-24 19:30:00",
  quantityTotal: "50",
  submissionDeadlineAt: "2026-07-31 18:00:00",
  rebate: "[0.25,1]",
  followercount: "[10000,50000]",
  contentTag: "护肤,通勤",
  kolOfficialPriceL1: "[70000,120000]"
})
```

Every field is at the top level of the `validate_requirement` argument object. Build and validate the entire object before the first call. If local preflight reports more than one violation, correct all reported fields together and retry at most once; never probe this tool one field at a time.

## Field rules

### Prices, ranges, and rebate

普通小红书达人检索不把内容形式当需求解析门禁。原文未说明图文/视频时不得询问，把未限定的单账号预算作为 Provider 通用检索价格条件写入 L1，但不把它描述或推断为图文合作；原文明示图文时使用 L1，明示视频时使用 L2，明示两者时价格字段同时提供 L1/L2。一个未限定内容形式的单价不能自行复制到两个档位。人工 Browser 阶段再按平台页面实际合作形式核对报价。

| Situation                                                     | Tier                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Explicit Xiaohongshu picture content                          | L1                                                                              |
| Explicit Xiaohongshu video content                            | L2                                                                              |
| Xiaohongshu picture and video                                 | Both L1 and L2, with separately confirmed or explicitly shared values           |
| Xiaohongshu content format not stated, normal database search | L1 as generic retrieval price compatibility field; do not label it picture      |
| Douyin price, CPE, or CPM                                     | L1=1–20秒, L2=21–60秒, L3=60秒以上; match the tier to the stated video duration |

This mapping applies when the Agent must route a later sole-condition update. Current Dify outputs already provide platform-specific `xhs_/dy_kolOfficialPrice`, `xhs_/dy_cpe`, and `xhs_/dy_cpm` objects with L1/L2/L3 Provider fields; expand only the current platform object and never route or change those internal values again. Never infer a Xiaohongshu content form from price magnitude, reference creator, or a field default. Xiaohongshu rejects L3.

- Serialize range fields as no-space `"[min,max]"` strings with lower ≤ upper. Price bounds are non-negative.
- Dify's current `xhs_/dy_kolOfficialPrice` output is already a Provider parameter fragment. Expand its current-platform object without changing any `kolOfficialPriceL1/L2/L3` value. Only when the user later changes price as the sole changed condition may the Agent parse that new wording and apply the 70%–120% retrieval expansion exactly once, as documented in the parsing card.
- `followercount` is structurally required. Expand `outputs.followercount.followercount` without changing it. If the object or inner field is missing, `null`, or empty, recheck the original wording; explicit `粉丝量无要求` / `粉丝数不限` maps to `"[0,999999999]"`, otherwise clarify only when the original still has no unique answer.
- `rebate` means the minimum accepted rebate and is a hard `search_creators` filter. Expand `outputs.rebate.rebate` without changing it. If the object or inner field is missing, `null`, empty, or conflicts with the original, recheck the original and only then resolve or clarify. For a later sole-condition Agent update, 26% maps to `"[0.26,1]"` and the maximum remains `1`.
- Numeric creator-search filters are no-space range strings. They include `followercount`, `interactionRate`, `clickMedium`, `viewMedium`, `photoView`, `videoInteract`, `photoInteract`, `userlikecount`, `likeIncrement`, `avgview`, `avglike`, `avgcomment`, `avgcollect`, `avginteract`, `femaleRate`, `age1Rate` through `age6Rate`, `cpeL1/L2/L3`, `cpmL1/L2/L3`, and `kolOfficialPriceL1/L2/L3`; `rebate` uses its minimum-specific range rule above.
- Expand only the current-platform `xhs_/dy_cpm` and `xhs_/dy_cpe` objects; their internal L1/L2/L3 values are final and must not be recomputed. For a later sole-condition Agent update, CPM/CPE are maximum filters whose lower bound is `0` (`500` → `"[0,500]"`).
- `L1/L2/L3` are never the lower and upper endpoints of one range. For Xiaohongshu, put picture price/CPE/CPM in L1 and video price/CPE/CPM in L2. For Douyin, use the duration tiers L1=1–20秒, L2=21–60秒, L3=60秒以上. Never put a Xiaohongshu video price in L1.
- `interactionRate`, `femaleRate`, and `age1Rate` through `age6Rate` are 0–1 share ranges. Count, view, interaction, CPE, and CPM ranges are non-negative. Never put a platform or content form into `clickMedium`/`viewMedium`; those fields are numeric median ranges.
- For ordinary numeric search filters, encode exact as `[v,v]`, upper bounds as `[0,v]`, lower bounds as `[v,max]`, explicit ranges unchanged, and unrestricted values as `[0,max]`. Share fields use `max=1`; count-like fields use the existing technical maximum. A direct female-rate condition follows this rule. When only a male-rate condition exists, convert its normalized interval `[a,b]` to `femaleRate="[1-b,1-a]"` under the documented binary-share assumption.

### Dates

- `createdAt` and `updatedAt` must match exactly at the current local second.
- `submissionDeadlineAt` is required and precise to the second, and must be later than `createdAt`. There is no minimum lead time: a same-day deadline minutes or hours later is valid and urgency alone must never block the call. When the user gives a clock time that is still ahead on the current local day (for example, at 10:30 says `12点前`), resolve it to today without clarification. An expired absolute time blocks the summary; ask once for a future time. `下周三前` does not imply `18:00` or another clock time; use one valid `AskUserQuestion` call.
- A deadline clarification must offer 2–4 concrete future absolute datetimes (for example, move the user's expired clock time to the next day and provide one later alternative). `确认并补充截止时间` / `返回补充` is not an answer and is forbidden.
- `projectStartStart` and `projectStartEnd` are optional and may use ISO datetime or `YYYY-MM-DD`.

### Text, tags, and Boolean values

- Pass `rawMessagesJson`, `talentTypeLabel`, and `originalBrief` as strings. `contentTag` must be non-empty because `search_creators` loads it from the stored demand; structurally extract it from `outputs.contentTag.contentTag` without changing the Dify semantic values. If its returned shape conflicts with the Provider's current published type, treat that as a shape conflict: recheck the original and choose the unambiguous Provider-compatible representation rather than silently coercing it.
- Never pass `refNickname` or `refUrl`; the live Provider rejects them. Preserve an explicit reference creator in the unchanged `originalBrief` or `description`. If the later WeCom body must include it, encode the known values as separate labeled text (`参考达人：...` and `参考达人链接：...`) so the Hook can verify the exact preview; never derive one from the other.
- Pass every real non-`null` Dify tag array directly and preserve its elements and order: `growBloggerTypeLabel`, `contentFeatureLabel`, `contentThemeLabel`, `kolPersonaLabel`, `pgyBloggerTypeLabel`, `xtTalentTypeLabel`, `industryTagLabel`, and `growTalentTypeLabel`. Never generate, rewrite, join, fill, reorder, or intentionally JSON-stringify them. Missing or conflicting fields follow the original-text review rule in the parsing card.
- Pass `hasOrganization`, `hasOrder30day`, and `hasSocial30day` as strings `"true"` or `"false"`.
- Institution affiliation maps only to `hasOrganization`: only institution-affiliated creators is `"true"`; only independent creators is `"false"`. If both are accepted (`机构达人和个人达人都可以`, `不限`, `均可`), omit both `hasOrganization` and `organization` because there is no filter. `organization` is only for one specific institution name explicitly supplied by the user; never pass category or no-preference text such as `"机构达人"`, `"个人达人"`, or `"都可以"`.

Other published optional fields are `kwGender`, `kwIpDependency`, `kwUserUrl`, `organization`, `clickMedium`, `viewMedium`, `photoView`, `videoInteract`, `photoInteract`, `avgcomment`, `avgcollect`, and `avginteract`. Pass one only when volunteered and uniquely mapped. Never pass `null`; omit an optional field whose value or exact semantics are unknown.

The production schema has no project-total-budget field. Never construct `budget_min_cents`, `budget_max_cents`, or `budget_raw`. Never construct legacy deadline fields such as `supplier_response_deadline_at`, `client_submission_deadline_at`, or `content_publish_deadline_at`. Preserve user wording only in `description` or `originalBrief`.

## Clarify when necessary

1. Structurally expand populated Dify Provider fragments without changing internal values. Select `xhsbrandName` or `dybrandName` for the current platform. When an owned field is missing, `null`, empty, or conflicts with the original or Provider shape, recheck the current original and decide from explicit wording before asking. Preserve a project phrase such as `秋季新品种草`; `某护肤品牌` is a placeholder. Brand name, minimum rebate, follower-count range, and a non-empty `contentTag` are required; product name and reference creator fields are optional.
2. `quantityTotal` must come from an explicit creator count in the user's wording or the current [AskUserQuestion](askuserquestion.md) answer. If the creator count is absent, ask for it; never default to `1` or derive it from singular wording, institution coverage, recommended manual-sourcing size, another field, or a historical demand. Ask only missing or ambiguous items; skip generic `确认创建` / `返回修改` confirmation.
3. Record optional filters, audience data, project dates, tags, and special requirements only when volunteered.
4. When no required item remains missing, ambiguous, or conflicting, call `validate_requirement` directly without another question.
5. If the Agent identifies multiple independent search groups, each needs its own exact submission count and separate requirement call. A shared total must be clarified into per-group counts; never duplicate it across requirements. A cooperation count is context, not `quantityTotal`.

Top-level arguments must remain semantically equivalent to the user's stated requirements and any clarification answers. A substantive unresolved change requires clarification, not a generic creation confirmation. If a historical requirement has the same `originalBrief` but a different quantity, deadline, rebate, price, or other business field, it is not the same order and its `requirement_id` must not be recovered.

## Multi-platform use

- Call separately per supported platform in first-appearance order, with a separate workflow; clarify only platform-specific uncertainty.
- Give every child the exact same complete, unchanged `originalBrief`. Dify input is current-platform-only and retains only explicit shared conditions plus that platform's conditions; never leak another platform's values into the Provider call.
- Copy quantity, price, rebate, and other values only when explicitly shared; platform-section values stay with that child.
- Put platform budget wording only in that child's `description`.
- Continue other supported platforms after a failure or unknown result; report unsupported platforms.

## Result and stop conditions

Success requires envelope `success === true` and a real requirement identifier: prefer `data.requirement_id`, or use the compatible `data.id` only when that field is absent. Never substitute `data.demand_id`. Preserve that exact requirement ID downstream. Record real `data.status` (`draft`, `ready`, `split_required`, or `clarification_required`) without inferring a state. A verified success is not a turn-ending result in the normal new-requirement flow; continue through search and MCN ranking without an intervening final reply or `AskUserQuestion`.

Stop on unresolved required information, arguments that differ from the user's stated or clarified requirements, unsupported fields, envelope failure, missing success evidence, or conflicting Provider business fields. Do not explain a 10-versus-5 conflict as system-selected actual data, calculate from the conflicting value, or continue downstream. After a successful requirement ID is returned, do not create another requirement for the same request unless the user explicitly starts a new one.
