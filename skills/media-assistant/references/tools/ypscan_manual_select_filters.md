# ypscan_manual_select_filters

人工拓展的必经筛选阶段。首次调用前，先用宿主 Browser 直接打开当前平台的固定达人广场（星图 `https://www.xingtu.cn/ad/creator/market`；蒲公英 `https://pgy.xiaohongshu.com/solar/pre-trade/note/kol`）。然后传 `requirement_id`、`platform`、精简 `facts`，可选 `keywords` 和用户明确要求时的 `fresh_run=true`。后续关键词只传抓取工具返回的 `run_id` 与 `branch_index`，无需重复打开 Browser。

工具每次只处理一个关键词分支，负责重置、关键词、报价口径、级联项和区间筛选，并逐项真实回读。只有 `ready_for_collection=true` 时，才把返回的 `collection_args` 原样调用 `ypscan_manual_research`。

- `actual_filters`：已有选中证据的页面条件。
- `failed_filters`：尝试但未提交的条件；存在任一项时禁止抓取。
- `unexpressed_filters`：平台无法表达的条件；可继续抓取并在详情/Agent 阶段复核。
- `needs_user_action`：只用于登录失效或真实 CAPTCHA。

不得把菜单消失当作提交成功，不得在迟到提交后再次点击，不得读取候选、翻页、详情或触发平台导出。

多层级联按完整路径逐层选择。每次 hover 后必须证明下一列属于当前父项并等待列内容稳定；同名但位于其他列的选项不算命中。星图“达人报价”必须分别识别报价类型和报价区间：类型靠时长菜单签名确认，区间靠“自定义区间”或可编辑数字输入确认，禁止使用第几个/最后一个下拉框作为依据。
