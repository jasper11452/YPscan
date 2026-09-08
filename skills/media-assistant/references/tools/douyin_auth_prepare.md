# douyin_auth_prepare

Risk tier: automatic host operation.

抖音星图登录准备工具，由宿主 YP Action 提供，不在 ypscan 插件白名单内。只用于在调用 `get_douyin_author_business_card` 前检查并准备登录态；本身不获取任何达人数据。

宿主未开放该工具时如实报告工具未开放并停止补全链路，提示用户升级或重启 YP Action；不得自行打开登录页、读取 Cookie、调用宿主本地回调地址或改用 Browser / 其他手扒工具。

## Arguments

```json
{ "action": "ensure" }
```

- `ensure`：已有有效登录时复用，否则引导登录。每批原生达人补全前固定使用该值。
- `relogin`：强制重新登录。只在用户明确要求重新登录或明确表示 Cookie 已失效时使用。

## Result

工具只负责登录态，不返回达人数据。未登录或登录失效时由该工具打开星图登录窗口；等待用户完成登录后窗口自动关闭，立即继续本次原生补全调用，不重复调用、不设置很短的调用超时。

## Flow

调用顺序固定为 `douyin_auth_prepare({"action":"ensure"}) → get_douyin_author_business_card`。不要因为查询达人而跳过登录准备，也不要在登录准备后改用其他工具获取达人数据。
