# 星图插件内人工拓展

完成固定 Provider 链路并由用户选择“人工拓展并提报”后，调用：

`ypscan_manual_research(operation=start, requirement_id, platform=xingtu, facts, keywords, quote_type?)`

插件内 Runner 使用专用持久 Chrome 打开固定星图达人广场，等待首次重定向后检查登录，并自动关闭普通资质信息弹窗；未登录时必须让用户登录后再 resume。本期报价类型只支持“植入视频”和“定制视频”，不再按视频时长档选择报价。客户有达人报价条件但未指定类型时默认植入视频；同时出现多个类型时，Agent 必须先让用户选择一个。随后依次尝试正确报价类型和完整筛选、仅关键词、无筛选达人广场和通用可见 DOM 召回。Agent 不操作页面，不传快照，不触发平台原生导出。

返回可控终态时立即展示真实 Excel、候选数量、质量等级和缺口。登录或全局验证时先展示当前 Excel并调用返回的 AskUserQuestion；继续后原样调用 `resume_args`。未验证候选只进入“候选达人”。
