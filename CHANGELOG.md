# 更新日志

## 0.1.24-beta88 — 2026-08-27

- 修复需求解析结果中的字符串化 JSON 被错误保留到落库边界的问题，统一兼容标签数组、品牌数组和 `dy_`/`xhs_` 数值对象。
- 新增回归测试，覆盖 `contentTag`、`*Label`、`dybrandName`、`dy_kolOfficialPrice`、`dy_cpm`、`dy_cpe` 的字符串化解析输入。
- 发布包版本更新为 `0.1.24-beta88`。

## 0.1.24-beta85 — 2026-08-25

- 统一抖音达人类型字段为 `xtTalentTypeLabel`，清理错误拼写。
- 小红书、抖音主达人类型解析为 `null` 时，先询问用户再进入需求校验。
