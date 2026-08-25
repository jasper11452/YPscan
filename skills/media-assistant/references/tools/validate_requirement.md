# validate_requirement

Risk tier: automatic internal business write. A complete, unambiguous requirement does not need a creation confirmation. Use `AskUserQuestion` only to clarify required information that is missing, ambiguous, or conflicting.

## Call flow

- This is the second fixed call, immediately after the first successful `ypscan_parse_requirement`. `data.outputs` is the complete raw Workflow output. Structurally expand only the current platform's Provider fragments under the parsing card, preserve every internal value, then let the Agent add all remaining fields from the current requirement. Do not open Browser before `search_creators` and `rank_mcns` finish.
- The parser no longer returns `projections`, `facts`, `search_jobs`, or `VALIDATE_REQUIREMENT_ARGS`. Build one complete top-level Provider object before calling. If one platform requirement names multiple creator types but only one total quantity, split it deterministically under the allocation rule below and call `validate_requirement` separately for each type.
- Do not display a confirmation-only summary and do not offer `确认创建` / `返回修改`. If clarification is genuinely required, call `AskUserQuestion` with only the unresolved items; denial/cancel/close/timeout/missing answer/callback error stops that turn and no answer/default may be inferred.
- Every missing, ambiguous, conflicting, multi-candidate, or mapping-dependent user field must be asked; never fabricate or autonomously choose one. The only quantity exception is the authorized same-platform multi-type allocation rule below. Omit optional fields the user did not volunteer.
- Each new call creates an independent requirement attempt. Existing sessions, project names, descriptions, `originalBrief`, and historical manifests never identify the new order or block this tool.
- After success, bind the current requirement ID from `data.requirement_id`, falling back to `data.id` only when `data.requirement_id` is absent. `data.demand_id` is a different identifier and must never be used as the requirement ID. For the normal new-requirement flow, do not stop or ask another question: immediately call `search_creators({id: requirement_id})`, ignore its workbook link, then call `rank_mcns` with the same requirement ID and current platform. The MCN list and branch question come only after ranking.

## Argument contract

Pass published production fields directly at the tool's top level. Never wrap in `payload`, use snake_case aliases, or pass legacy fields.

| Class                      | Fields                                                                                                                                                                                    | Contract                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-required              | `platform`, `brandName`, `projectName`, `quantityTotal`, `submissionDeadlineAt`, `rebate`, `followercount`, `contentTag`, `rawMessagesJson`                                               | Supply all; `brandName` is one non-empty scalar string, `contentTag` is a non-empty string array, `quantityTotal` is a positive decimal integer string, and Agent input `rawMessagesJson` is a JSON object containing `original`, complete `parse_outputs`, and popup answers under `clarifications` |
| User-required price        | At least one valid platform-supported `kolOfficialPriceL1/L2/L3`                                                                                                                          | Range string; platform rules below                                                                                                                                                                                                                                                       |
| Parsed platform labels     | XHS: `contentFeatureLabel`, `growBloggerTypeLabel`, `kolPersonaLabel`, `pgyBloggerTypeLabel`; Douyin: `contentThemeLabel`, `growTalentTypeLabel`, `industryTagLabel`, `xtTalentTypeLabel` | Pass every non-`null` parsed array unchanged without confirmation; omit an optional label that was not returned. If XHS `pgyBloggerTypeLabel` or Douyin `xtTalentTypeLabel` is explicitly `null`, ask the user and write the answer to the corresponding top-level array before calling this tool. |
| Fixed                      | `status`                                                                                                                                                                                  | Set `status="ready"`; the local boundary may add this fixed value when absent                                                                                                                                                                                                            |
| Requirement context        | `description`                                                                                                                                                                             | Extract a short Chinese description from stated and clarified requirements                                                                                                                                                                                                               |
| Optional identity          | `product`                                                                                                                                                                                 | Product name is optional; do not ask or pass when absent                                                                                                                                                                                                                                 |
| Optional reference creator | `originalBrief`, `description`                                                                                                                                                            | Never pass `refNickname`/`refUrl`. Keep the original wording in `originalBrief`; when a later WeCom exact-match check is needed, also use labeled `参考达人：...` / `参考达人链接：...` text in `description`                                                                            |

Do not ask the user for `status`. Do not pass `id`, `demandId`, `demandVersion`, `createdAt`, or `updatedAt` for a new requirement.

`platform` accepts exactly `xiaohongshu` or `douyin`. Never pass `小红书`, `抖音`, `xhs`, or `dy` to this tool.

MCP error `-32062` is a Provider server error, not JSON-RPC `-32602 Invalid params`. Read and report its exact message/details. The local boundary must finish canonical formatting and complete preflight before the first Provider write. Do not change already-valid fields unless the error explicitly names a field, and never probe this write with multiple types or field-by-field retries.

### Minimum valid call

```text
validate_requirement({
  status: "ready",
  platform: "douyin",
  brandName: "客户品牌",
  projectName: "2026秋季新品推广",
  quantityTotal: "50",
  submissionDeadlineAt: "2099-07-31 18:00:00",
  rebate: "[0.25,1]",
  followercount: "[10000,50000]",
  contentTag: ["护肤", "通勤"],
  contentThemeLabel: ["产品测评"],
  growTalentTypeLabel: ["成熟达人"],
  industryTagLabel: ["3C及电器-消费类电子产品"],
  xtTalentTypeLabel: ["科技数码-3C数码"],
  kolOfficialPriceL3: "[70000,120000]",
  rawMessagesJson: {
    original: "抖音项目：2026秋季新品推广；品牌：客户品牌；定制视频；数量50位；单价10万元；返点25%以上；粉丝1万至5万；提报截止2099-07-31 18:00:00。",
    parse_outputs: {},
  }
})
```

Every field is at the top level of the `validate_requirement` argument object. Build and validate the entire object before the first call. The local `before_tool_call` boundary deterministically canonicalizes harmless shape differences, checks all fields together, and serializes `rawMessagesJson` exactly once for the Provider. The Agent always supplies the object form and must never switch between object and string forms. If preflight blocks, the Provider was not called: collect every unresolved business value through `AskUserQuestion`, fix all reported items together, and submit one complete object. Never probe this tool one field or one type at a time.

## Field rules

### Prices, ranges, and rebate

All numeric creator-search filters use one canonical representation before the first call: a no-space JSON **string** `"[min,max]"`. This includes `rebate`, `followercount`, `kolOfficialPriceL1/L2/L3`, `cpmL1/L2/L3`, `cpeL1/L2/L3`, and every other numeric metric listed below. JSON arrays, objects, single numbers, percent text, and natural-language bounds are forbidden Provider inputs. The boundary may serialize or deterministically normalize an already unambiguous value once; it never makes a semantic choice.

普通小红书达人检索不把内容形式当需求解析门禁。原文未说明图文/视频时不得询问，把未限定的单账号预算作为 Provider 通用检索价格条件写入 L1，但不把它描述或推断为图文合作；原文明示图文时使用 L1，明示视频时使用 L2，明示两者时价格字段同时提供 L1/L2。一个未限定内容形式的单价不能自行复制到两个档位。人工 Browser 阶段再按平台页面实际合作形式核对报价。

| Situation                                                     | Tier                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Explicit Xiaohongshu picture content                          | L1                                                                         |
| Explicit Xiaohongshu video content                            | L2                                                                         |
| Xiaohongshu picture and video                                 | Both L1 and L2, with separately confirmed or explicitly shared values      |
| Xiaohongshu content format not stated, normal database search | L1 as generic retrieval price compatibility field; do not label it picture |
| Douyin placement-video price / CPM / CPE                     | `kolOfficialPriceL2` / `cpmL2` / `cpeL2`                                  |
| Douyin custom-video price / CPM / CPE                        | `kolOfficialPriceL3` / `cpmL3` / `cpeL3`                                  |

This mapping applies when the Agent must route a later sole-condition update. Parser outputs may provide platform-specific `xhs_/dy_kolOfficialPrice`, `xhs_/dy_cpe`, and `xhs_/dy_cpm` objects; expand only the current platform object, and only when the original or a clarification answer uniquely supports the field. A legacy tier key inside a parsed Douyin fragment is not video-type evidence: when current user evidence uniquely says placement or custom video and there is one valid numeric candidate, preserve its range and deterministically route it to current L2 or L3 without asking. Multiple candidates remain ambiguous and require clarification. A Douyin brief that says only “视频” does not identify placement versus custom video and must trigger `AskUserQuestion`. Douyin does not use any L1 price, CPM, or CPE field. Never infer a Xiaohongshu content form from price magnitude, reference creator, or a field default. Xiaohongshu rejects L3.

The local preflight verifies every supplied Douyin price, CPM, and CPE field against the explicit video type: L2 requires placement-video evidence and L3 requires custom-video evidence. A mismatched field or any Douyin `kolOfficialPriceL1`, `cpmL1`, or `cpeL1` blocks the write. Xiaohongshu `kolOfficialPriceL3`, `cpmL3`, and `cpeL3` are always rejected locally.

- Serialize range fields as no-space `"[min,max]"` strings with `0 ≤ min < max`; degenerate `[v,v]` ranges are always invalid.
- The current `xhs_/dy_kolOfficialPrice` output is a candidate Provider parameter fragment. Check it locally against current user evidence, field mapping, and the strict non-degenerate range contract. When it passes, structurally expand the current-platform object without narrowing, widening, or otherwise changing its valid price range; when it fails, block instead of silently rewriting it. Only when the user later changes price as the sole changed condition may the Agent parse that new wording and apply the 70%–120% retrieval expansion exactly once, as documented in the parsing card.
- `followercount` is structurally required. Expand `outputs.followercount.followercount` only when the original or a clarification answer uniquely supports it. Explicit `粉丝量无要求` / `粉丝数不限` maps deterministically to `"[0,999999999]"`; missing, defaulted, ambiguous, or conflicting values require `AskUserQuestion`.
- `rebate` means the minimum accepted rebate and is a hard `search_creators` filter. Its only Provider form is `"[min,1]"`; for example, 25% or “25%以上” becomes `"[0.25,1]"`. Missing, defaulted, ambiguous, or conflicting values require `AskUserQuestion`; Agent must not try arrays, objects, raw percentages, or natural-language variants against Provider.
- Numeric creator-search filters are no-space range strings. They include `followercount`, `interactionRate`, `clickMedium`, `viewMedium`, `photoView`, `videoInteract`, `photoInteract`, `userlikecount`, `likeIncrement`, `avgview`, `avglike`, `avgcomment`, `avgcollect`, `avginteract`, `femaleRate`, `age1Rate` through `age6Rate`, `cpeL1/L2/L3`, `cpmL1/L2/L3`, and `kolOfficialPriceL1/L2/L3`; `rebate` uses its minimum-specific range rule above.
- Expand only the current-platform `xhs_/dy_cpm` and `xhs_/dy_cpe` objects. Their internal values are candidates: validate them locally, preserve a valid non-conflicting range, and block an invalid or conflicting range instead of recomputing it. For Douyin, L2 means placement video, L3 means custom video, and L1 is unsupported. For a later sole-condition Agent update, CPM/CPE are maximum filters whose lower bound is `0` (`500` → `"[0,500]"`).
- `L1/L2/L3` are never the lower and upper endpoints of one range. For Xiaohongshu, put picture price/CPE/CPM in L1 and video price/CPE/CPM in L2. For Douyin price/CPM/CPE, L2 means placement video and L3 means custom video; L1 is unsupported. Never put a Xiaohongshu video price in L1.
- `interactionRate`, `femaleRate`, and `age1Rate` through `age6Rate` are 0–1 share ranges. Count, view, interaction, CPE, and CPM ranges are non-negative. Never put a platform or content form into `clickMedium`/`viewMedium`; those fields are numeric median ranges.
- For ordinary numeric search filters, encode upper bounds as `[0,v]`, lower bounds as `[v,max]`, explicit non-degenerate ranges unchanged, and unrestricted values as `[0,max]`. Never encode an exact value as `[v,v]`; when no field-specific lossless non-degenerate mapping exists, clarify the acceptable bounds. Share fields use `max=1`; count-like fields use the existing technical maximum. A direct female-rate condition follows this rule. When only a male-rate condition exists, convert its normalized interval `[a,b]` to `femaleRate="[1-b,1-a]"` under the documented binary-share assumption.

### Dates

- `submissionDeadlineAt` is required and precise to the second, and must be later than the current local time. There is no minimum lead time: a same-day deadline minutes or hours later is valid and urgency alone must never block the call. When the user gives a clock time that is still ahead on the current local day (for example, at 10:30 says `12点前` or `今天18:00`), it resolves uniquely to today. Store the latest answer under `clarifications.submissionDeadlineAt`; an expired absolute time blocks the summary and requires one future-time question. `下周三前` does not imply `18:00` or another clock time.
- A deadline clarification must offer 2–4 concrete future absolute datetimes (for example, move the user's expired clock time to the next day and provide one later alternative). `确认并补充截止时间` / `返回补充` is not an answer and is forbidden.
- `projectStartStart` and `projectStartEnd` are optional and may use ISO datetime or `YYYY-MM-DD`. Pass them only when the same explicit dates exist in `original` or `clarifications`; do not turn `月底`, `下月`, or another vague schedule into concrete dates. When both exist, start must not be later than end.

### Text, tags, and Boolean values

- Pass `rawMessagesJson` as a JSON object containing the current original requirement in `original`, complete current parser outputs in `parse_outputs`, and the latest effective popup answer for each numeric field under `clarifications`. A new answer replaces the old answer for that field while other fields remain intact. Same-platform multiple creator types remain in one requirement with the original total and merged labels; do not create child requirements. Parsed Label arrays and `contentTag` need no confirmation evidence, except an explicitly `null` XHS `pgyBloggerTypeLabel` or Douyin `xtTalentTypeLabel`, which requires user confirmation and a corresponding top-level tag array before submission. An explicit user brand wins; otherwise exactly one non-empty, non-placeholder current-platform `xhsbrandName`/`dybrandName` may prove `brandName`. Other non-label `parse_outputs` defaults do not prove confirmation. Submitted project name, creator quantity, deadline, and optional project dates must match current effective evidence.
- Never pass `refNickname` or `refUrl`; the live Provider rejects them. Preserve an explicit reference creator in the unchanged `originalBrief` or `description`. If the later WeCom body must include it, encode the known values as separate labeled text (`参考达人：...` and `参考达人链接：...`) so the Hook can verify the exact preview; never derive one from the other.
- Pass every real non-`null` parsed tag array directly and preserve its elements and order: `growBloggerTypeLabel`, `contentFeatureLabel`, `contentThemeLabel`, `kolPersonaLabel`, `pgyBloggerTypeLabel`, `xtTalentTypeLabel`, `industryTagLabel`, and `growTalentTypeLabel`. For current-platform array-only fields, also keep parsed `contentTag` as an array. These parsed arrays are authoritative and never require `AskUserQuestion`, except an explicitly `null` current-platform primary tag: XHS `pgyBloggerTypeLabel` or Douyin `xtTalentTypeLabel` must be confirmed first. Never generate, rewrite, join, fill, reorder, or intentionally JSON-stringify them; omit optional Label fields that are `null` or absent. See `platform_tag_enums.md` for the full value lists.
- Pass `hasOrganization`, `hasOrder30day`, and `hasSocial30day` as strings `"true"` or `"false"`.
- Institution affiliation maps only to `hasOrganization`: only institution-affiliated creators is `"true"`; only independent creators is `"false"`. If both are accepted (`机构达人和个人达人都可以`, `不限`, `均可`), omit both `hasOrganization` and `organization` because there is no filter. `organization` is only for one specific institution name explicitly supplied by the user; never pass category or no-preference text such as `"机构达人"`, `"个人达人"`, or `"都可以"`.

Other published optional fields are `kwGender`, `kwIpDependency`, `kwUserUrl`, `organization`, `clickMedium`, `viewMedium`, `photoView`, `videoInteract`, `photoInteract`, `avgcomment`, `avgcollect`, and `avginteract`. Pass one only when volunteered and uniquely mapped. Never pass `null`; omit an optional field whose value or exact semantics are unknown.

The production schema has no project-total-budget field. Never construct `budget_min_cents`, `budget_max_cents`, or `budget_raw`. Never construct legacy deadline fields such as `supplier_response_deadline_at`, `client_submission_deadline_at`, or `content_publish_deadline_at`. Preserve user wording only in `description` or `originalBrief`.

## Clarify when necessary

1. Merge the current original with the latest non-empty clarification for each field first; a later answer replaces an earlier answer for that same field. Prefer an explicit current brand. Otherwise select the current platform's `xhsbrandName` or `dybrandName`; exactly one non-placeholder candidate maps to `brandName`, while zero, multiple, placeholder, or explicitly conflicting candidates require a popup. Never ask an unchanged confirmed field again.
2. `quantityTotal` must come from an explicit creator count in the user's wording or the current [AskUserQuestion](askuserquestion.md) answer. Same-platform multiple creator types keep that original total in one requirement; do not split it. If the overall creator count is absent, you must collect it via `AskUserQuestion`; never ask in plain chat text, never default to `1`, and never derive it from singular wording, institution coverage, recommended manual-sourcing size, another field, or a historical demand. Ask only missing or ambiguous items; skip generic `确认创建` / `返回修改` confirmation.
3. Pass parsed tags without confirmation. Record other optional filters, audience data, project dates, and special requirements only when volunteered.
4. When no required numeric item remains missing, ambiguous, or conflicting, call `validate_requirement` directly without another question. A local preflight evidence error for a numeric answer already present in the conversation means the answer must be restored under `clarifications`, not recollected from the user.
5. A unique, legal price/CPM/CPE candidate already returned by the parser is reusable evidence; do not ask again merely because the original exact amount is represented as a Provider range.
6. If the Agent identifies multiple creator-type groups on one platform and the user gave only a shared total, keep one requirement with the original total and merge all applicable labels and conditions. Do not split, duplicate, or ask for per-type counts.

Top-level arguments must remain semantically equivalent to the user's stated requirements and any clarification answers. A substantive unresolved change requires clarification, not a generic creation confirmation. If a historical requirement has the same `originalBrief` but a different quantity, deadline, rebate, price, or other business field, it is not the same order and its `requirement_id` must not be recovered.

## Multi-platform use

- Call separately per supported platform in first-appearance order, with a separate workflow; clarify only platform-specific uncertainty.
- Give every child the exact same complete, unchanged `originalBrief`. Parser input is current-platform-only and retains only explicit shared conditions plus that platform's conditions; never leak another platform's values into the Provider call.
- Copy quantity, price, rebate, and other values only when explicitly shared; platform-section values stay with that child.
- Put platform budget wording only in that child's `description`.
- Continue other supported platforms after a failure or unknown result; report unsupported platforms.

## Result and stop conditions

Success requires envelope `success === true` and a real requirement identifier: prefer `data.requirement_id`, or use the compatible `data.id` only when that field is absent. Never substitute `data.demand_id`. Preserve that exact requirement ID downstream. Record real `data.status` (`draft`, `ready`, `split_required`, or `clarification_required`) without inferring a state. A verified success is not a turn-ending result in the normal new-requirement flow; continue through search and MCN ranking without an intervening final reply or `AskUserQuestion`.

Stop on unresolved required information, arguments that differ from the user's stated or clarified requirements, unsupported fields, envelope failure, missing success evidence, or conflicting Provider business fields. Do not explain a 10-versus-5 conflict as system-selected actual data, calculate from the conflicting value, or continue downstream. After a successful requirement ID is returned, do not create another requirement for the same request except the remaining child calls in the already-determined same-platform type allocation.
