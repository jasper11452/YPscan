# 2026-09-10 字段状态工具契约探测

状态：只读探测 + 测试环境合成需求；插件实现已按本页结论落地并通过单元回归。真实 App 桌面端到端未执行（未安装到宿主、未重启 App）。

## 目的

确认 Provider 新工具 `get_inquiry_form_fields_status({requirement_id})` 的真实语义，判断“字段页提交后自动续接”能否安全替代人工回复“好了”。

## 方法

- 服务端 1.9.4，经 YP Action 本地 MCP 代理（`~/Library/Application Support/YP Action/openclaw/state/openclaw.json` 的 `mcp.servers.test.url`）直连测试环境；直接对 `test-mcp.eshypdata.com/mcp` 调用会返回 `YP_ACTION_DELEGATION_REQUIRED`，无委托身份。
- 用 `validate_requirement` 创建合成需求（小红书、手动拓展、品牌“探测测试品牌”，项目名含“勿用”），再 `select_inquiry_form_fields({force_reselect:true})` 取字段页 URL。
- 用 ego-browser 打开 `test-agenta.eshypdata.com/demand-field-selector?requirement_id=...&platform=xiaohongshu`，提交默认 8 个必填字段后轮询状态。
- 另建需求 C，用 `source_requirement_id` 继承已提交需求，再 `force_reselect` 重新打开字段页并轮询。

## 实测结果

状态取值（仅这三种，且均为顶层 `{status}`，不回显 `requirement_id`）：

| 输入/时间点                             | 返回                                 |
| --------------------------------------- | ------------------------------------ |
| 全新需求、未打开页面                    | `{"status":"unavailable"}`           |
| 已打开页面、用户尚未提交                | `{"status":"unavailable"}`           |
| 用户点击提交字段后约 3 秒内             | `{"status":"submitted"}`             |
| 需求 C 由继承变已配置（未打开页面）     | `{"status":"submitted"}`             |
| 需求 C 随后 `force_reselect` 打开新页面 | 仍立即返回 `{"status":"submitted"}`  |
| `requirement_id=""`                     | `{"status":"invalid"}`               |
| 不存在的 `requirement_id`               | `{"status":"unavailable"}`（无错误） |

其他关键事实：

1. **pending 响应字节恒定**：连续 3 次轮询均为完全相同的 `{"status":"unavailable"}`，无时间戳、无计数、无 `requirement_id`；MCP 工具结果的 `details` 只含 `mcpServer`/`mcpTool`，因此宿主侧同参数同结果哈希会持续累积。
2. **状态是需求级存量状态，不是页面实例状态**：需求 C 已有配置后重新打开字段页，状态立刻是 `submitted`，无法区分“本轮页面刚提交”与“此前已有配置”。
3. `select_inquiry_form_fields` 对已配置需求再次调用（不带 `force_reselect`、不带 source）实测仍返回 `opened` + URL，而不是 `configured`/`existing`，与本页第 5 条叠加会放大第 2 条的风险。
4. 测试环境字段页提交后页面本身没有可见成功反馈（提交按钮、已选计数均不变），只能靠状态确认。

## 结论与实现约束

- 只在**首次选择**（无 `force_reselect`、无 `source_requirement_id`）且即时预检为 `unavailable` 时轮询；预检即 `submitted`、`invalid`、未知状态、调用失败或到上限时停止并保留“好了”兼容路径。
- `force_reselect` 与继承场景禁止轮询。
- 轮询上限 8 次（含预检共 9 次查询；初版曾定为 12 次，复核后按下方熔断阈值收紧为 8 次）：宿主 App 配置为 `tools.loopDetection.enabled=true`、`globalCircuitBreakerThreshold=16`，对同一工具、同一参数、连续 16 次完全相同结果阻断后续调用（`cfmind/dist/tool-loop-detection-*.js` 的 `getNoProgressStreak` + `runBeforeToolCallHook`；本地 `exec sleep` 不触发是因为其结果 details 每次都变）。只靠文本不同的间隔时间无法规避，因此上限压到 16 以下。
- Provider 若在状态响应里加入页面实例标识（selection token）或每次变化的字段，可重新评估放宽到 30 轮并覆盖重选场景。

## 未验证

- 真实 App 会话里模型是否严格按新指令预检、轮询、续接（需安装插件并重启宿主）。
- 超时 8 次后的用户可见文案与“好了”回退路径。
- Provider 生产环境（`mcp.eshypdata.com`）状态取值与测试环境是否一致；本地代理指向测试环境，生产未探测。
