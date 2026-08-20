# 蒲公英插件内人工拓展

默认 `manual_source_creators` Excel 已保存，且用户明确选择“浏览器详细手扒”后，调用：

`ypscan_manual_research(operation=start, requirement_id, platform=pgy, facts, keywords, quote_type?)`

插件内 Runner 连接宿主 Browser CDP 并复用其 Profile、Cookie 和登录态，打开固定蒲公英达人广场。报价类型为“图文笔记”或“视频笔记”，与“笔记类型”的内容形式筛选相互独立；例如“视频笔记为主”可以同时按图文报价筛选。列表“全部报价/¥xx起”只作起始价展示，只有结构化列表字段或详情页一口价可验证目标报价。随后依次尝试完整筛选、仅关键词、无筛选达人广场和通用可见 DOM 召回。Agent 不直接操作页面，不传快照，不触发平台原生导出。

返回可控终态时立即展示真实 Excel、候选数量、质量等级和缺口。登录或全局验证时先展示当前 Excel并调用返回的 AskUserQuestion；继续后原样调用 `resume_args`。未验证候选只进入“候选达人”。
