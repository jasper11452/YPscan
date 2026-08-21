# 星图浏览器详细手扒

默认 `manual_source_creators` Excel 已保存，且用户明确提出使用“浏览器手扒”“浏览器详细手扒”或选择同名选项后，调用：

`ypscan_manual_research(operation=start, requirement_id, platform=xingtu, facts, keywords, quote_type?)`

Runner 打开 `https://www.xingtu.cn/ad/creator/market`。若进入 `/redirect_to/ad/creator/market`，先判断登录状态：未登录则让用户登录后 resume；已登录则在同一浏览器新标签重新打开达人广场。普通资质验证弹窗直接关闭。

先通过 Playwright 应用全部级联筛选和精确范围最小值/最大值，关键词最后提交。切换关键词时保留其他筛选条件，只替换关键词。每个关键词持续翻页到没有下一页，保存所有达人及主页链接并按稳定 ID 去重。

硬筛后逐个新标签打开达人详情，滚动加载并把完整 HTML 分块返回 Agent 提取和判断。验证码与资质弹窗叠加时先关闭普通资质弹窗并重新抓取 HTML；仍不可用则新标签重开该详情一次，不求解验证码。

Agent 对纳入达人给出 `recommendation_score` 和理由。合格详情达到用户需求数 2 倍后停止；按分数排序后，前需求数进入“达人推荐List”，其余合格达人进入“候选达人”。

返回可控终态时立即展示真实 Excel、候选数量、质量等级和缺口。登录或全局验证时先展示当前 Excel并调用返回的 AskUserQuestion；继续后原样调用 `resume_args`。未验证候选只进入“候选达人”。
