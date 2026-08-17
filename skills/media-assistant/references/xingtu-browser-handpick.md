# 星图 Browser 人工拓展

只有完成 `ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns`、输出完整 MCN Markdown 表格并展示本地路径，再在 `AskUserQuestion` 中选择“人工拓展并提报”后，才进入本流程。不得向用户输出达人预览表下载链接。

## 最小 SOP

1. 先用宿主 Browser 直接打开星图达人广场 `https://www.xingtu.cn/ad/creator/market`，不得先打开首页、工作台或其他中转页；页面打开后调用 `ypscan_manual_select_filters`。仅当返回 `ready_for_collection=true` 时，原样使用 `collection_args` 调用 `ypscan_manual_research`。
2. 首次选择传当前 `requirement_id`、`platform=xingtu`、精简 `facts` 和可选 1–4 个关键词；后续关键词原样使用 `next_selection_args`。选择工具逐轮清空并应用内容关键词、类目/达人类型、人设、本人性别、地域、粉丝量与画像、报价、CPM/CPE、互动率等平台可表达硬筛。
3. 确认报价档位后再读价格（8/14 教训：列表默认列是 21-60s报价，直接读会拿到错误口径）。需求是 60s+ 时，工具切到“60s以上视频”并回读表头；没有确认成功的价格只能当参考。
4. 工具优先读取当前 UI 筛选/分页动作产生的达人列表响应，并逐页唤醒 DOM 表格补充格式化报价等展示值；响应不可识别时自动使用纯 DOM。按星图 ID 或主页链接去重，并按需求数量形成有界候选池。只有两条列表路径仍不足、关键硬筛字段完全缺失或读取异常时，整次运行才最多触发一次原生导出；不得在每个关键词分支重复导出。
5. 先用列表响应 + DOM 候选完成离线初筛，再只打开入围者的详情页补近期内容、商业样本、粉丝与对应时长报价证据。若触发了导出 fallback，再读取 `export_fallback` 中的飞书表格补缺。达人报价以客户值为锚点按 50%–120% 硬筛（如 10 万以内 → 5 万–12 万），不用 Provider 70%–120% 区间；1–20 秒、21–60 秒、60 秒以上报价必须读取对应档位，禁止跨时长替代。
   昵称或星图 ID 搜索只用于定位工具已返回的 `detail_tasks`，不得绕过候选池另建名单。`price_check.status=rejected` 不得推荐；合格人数不足时如实报告缺口。
6. 每页候选都会写入本地 checkpoint，同计划自动续跑。最终必须展示 `artifact.excel_path`；目标超过 20 人时，对话只给摘要和最多 10 条预览，完整目标名单与候选池交付 Excel。该本地 Excel 与平台原生导出无关，不消耗星图额度。

### 星图级联控件（达人类型等，真实鼠标驱动）

1. 工具先定位 `.market-filter-wrapper--line`，读取触发器实时 `aria-controls`，再从全局 DOM 找 Teleport 菜单。
2. 一级分支通过 Playwright 真实 hover 展开二级列，叶子选项用真实鼠标点击；关闭无确认浮层时发送完整 move/down/up 事件。
3. 多层路径必须逐层绑定：父项 hover 后，仅接受位于父项右侧且相对 hover 前新增或内容发生变化的子列；子列需连续三次快照稳定。不得因其他列存在同名文字就继续路径。
4. “达人报价”是复合控件，不按 DOM 顺序猜下拉框。报价类型菜单必须真实包含 `1-20s / 21-60s / 60s以上`；报价区间菜单必须包含“自定义区间”或可编辑数字输入。自定义上下限填入后逐个读取 input value，再提交外层筛选。
5. 每次动作后回读筛选行和结果信号；无法表达的条件写入 `unexpressed_filters`，不得伪报已应用。

### 星图报价档位手动切换（已在真实页面验收）

1. 点击「达人报价」触发器（`div.price-select-group` 内的 `span.refer-label`；已选档位后其文本会变成「达人报价·N」，靠 class 找，不靠文本）。
2. 浮层内点「选择报价类型」下的下拉触发器（`div.xt-dropdown.star-select` 内的 `span.refer-label`，点击即展开，不需要 hover）。
3. 点选项 `60s以上视频`（`span.pack-label`）。
4. 点浮层底部「确定」。
5. 等列表刷新后回读表头，确认 `price_tier` 为 `60s以上`；切回时重复上述动作点 `全部`。

同一达人在不同档位的报价不同（真页实例：吉星高照 21-60s ¥2,200 → 60s以上 ¥2,600），档位未经确认的价格不得进入交付名单。

报价与 CPM 只能使用对应时长档位；搜索词、标签和平台硬筛只负责召回，不能单独证明相关性。详情缺失写“未知”或“待商务确认”。

只有登录失效、真实 CAPTCHA 或确实需要用户做业务选择时才调用宿主 `AskUserQuestion`。页面未打开、普通弹窗、native 浮层异常、筛选复位和参数问题由 Agent/工具直接处理；单分支有限恢复仍失败则记录并继续其他关键词，不要求用户刷新或关弹窗。不得索取或代填密码、验证码、Cookie、Token，也不得绕过风控。
