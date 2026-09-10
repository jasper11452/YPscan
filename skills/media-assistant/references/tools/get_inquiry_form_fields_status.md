# get_inquiry_form_fields_status

字段页提交状态的唯一查询入口。字段选择 URL 输出后用它自动确认用户是否已提交，替代人工回复“好了”；“好了”仍是全程有效的兜底恢复信号。

## When to call

- 仅当 `select_inquiry_form_fields` 刚返回字段页 URL（`selection_required`/`opened`/旧版有效链接），且本轮是**首次选择**（没有 `force_reselect`，也没有 `source_requirement_id`）时使用。
- `force_reselect=true` 或继承场景禁止调用：该需求可能已有历史配置，本工具按需求判定，会在用户提交前就返回 `submitted`，导致按旧配置提前继续。
- 不用于查询历史配置、核对字段内容或替代 `select_inquiry_form_fields`；不读取、缓存或传递 `columns`。本工具响应不回显 `requirement_id`，只使用当前字段页已确认的那个 ID，不得凭成功状态推断其他需求。

## Remote arguments

| Argument         | Constraint                                            |
| ---------------- | ----------------------------------------------------- |
| `requirement_id` | Provider-required string；当前字段页对应的真实需求 ID |

## Result

- `unavailable`：该需求当前没有已提交的字段配置（字段页可能已打开但尚未提交）。只有预检返回它，才说明这是首次选择，可以开始轮询。
- `submitted`：该需求已有字段配置。它按需求判定，不区分“本次打开的页面刚提交”还是“此前提交/继承的旧配置”。只有预检曾返回 `unavailable`、之后轮询才返回 `submitted` 时，才能当作本轮提交完成；预检本身就是 `submitted` 时不得据此恢复，改为等待用户回复“好了”。无法确认预检结果时，一律按预检即 `submitted` 处理：不恢复下游，等待“好了”。
- `invalid`：`requirement_id` 无效（如空字符串）。停止轮询，等待“好了”。
- 其他状态或调用失败：停止轮询，如实说明尚未确认提交并等待“好了”；不得按已提交继续、不得重开字段页或更换 `requirement_id`。

## Polling

- URL 输出后先立即预检一次。预检为 `unavailable` 后开始轮询：每 30 秒查询一次，累计最多 8 次轮询（含预检共 9 次查询）。用一次 sleep 等待即可；禁止的是用脚本循环调用该工具（宿主看不到进度，无法恢复业务指令）。
- 上限是硬约束，不得放宽：宿主对“同一工具、同一参数、连续 16 次完全相同结果”会触发全局无进展断路器，之后同参数调用会被直接拦截。9 次查询离该阈值有 7 次余量，不要重试、追加查询或放宽节奏。
- 轮询期间不调用 `AskUserQuestion`，不调用 `manual_source_creators`、`search_creators`、`rank_mcns`、`create_with_distributions`、`score_manual_source_csv` 或 `file_bridge`；不重开字段页、不改写 URL、不替用户选择字段、不更换 `requirement_id`。
- 到上限仍是 `unavailable`：停止轮询，如实告知用户“还没检测到提交”，请其提交后回复“好了”；之后按原分支恢复。
- 当前环境没有暴露本工具（工具列表/live schema 不存在）时不要调用，直接按原规则等待“好了”。
