# 达人详情输出链路需求文档（get_creator_detail_run / excel_export）

> 状态：需求规格（已确认，待后端实现）。插件侧契约已按本文落地；后端实现前以本文为准。
> 读者：后端同学（Provider MCP 实现 + 建表）、插件侧维护者。
> 数据库：本机只读，建表由后端执行。

## 1. 需求背景与目标

### 1.1 业务场景

用户手里有一批达人 ID 或主页链接，只想导出这些达人的指定字段成一张 Excel 表。不需要建需求、不需要机构询价、不需要评分排序，就是「给达人，选字段，出表」。

这是第三种业务模式「只扒达人信息」，与现有两种模式并列：

| 模式         | 建需求 | 字段选择存哪                             | 出表工具                                       |
| ------------ | ------ | ---------------------------------------- | ---------------------------------------------- |
| 询价机构     | 是     | `customer_demands.columns`               | `ypscan_summarize_manual_scores`（本地，不动） |
| 手动拓展     | 是     | `customer_demands.columns`               | `ypscan_summarize_manual_scores`（本地，不动） |
| 只扒达人信息 | **否** | `get_creator_detail_run.columns`（新表） | `excel_export`（后端新增）                     |

老两种模式本次完全不动。

### 1.2 用户故事

> 作为媒介同学，我有一批小红书/抖音达人 ID 或链接，想在系统里勾选要导出的字段（昵称、粉丝、报价、主页链接等），补全这批达人后直接导出一张按我选字段排列的 Excel。我不想走询价流程，也不想做评分排序，更不想为了这个去建一个需求。

### 1.3 目标

1. `select_inquiry_form_fields` 支持「无 requirement_id」的调用：传平台 + 达人 ID/链接，返回一个字段选择会话主键 `field_id` 和字段选择页 URL。
2. 新增 `excel_export` 工具：按 `field_id` 关联的用户选中字段，把补全后的达人数据导出成 Excel。
3. 字段提交确认不再靠 agent 轮询或等口头确认，而是 `excel_export` 后端查表校验：columns 没生成就返回「未选择字段」+ URL。

### 1.4 非目标

- 不改动询价机构、手动拓展两条现有链路。
- 不做评分排序（不接 `score_manual_source_csv`）。
- 不做达人数据持久化（补全结果只用于本次导出）。
- 不把 `get_creator_detail`、`get_creator_detail_export` 两个已弃用工具重新激活。

## 2. 名词与概念

| 词                   | 含义                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| requirement / 需求   | 现有两种模式里绑定字段选择与业务链路的实体（`customer_demands`）                                             |
| field_id             | 第三种模式的字段选择会话主键，即 `get_creator_detail_run.run_id`                                             |
| columns              | 用户选中的字段集合，JSON 数组，结构与 `customer_demands.columns` 一致                                        |
| 字段选择页           | 用户勾选字段的前端页面，提交后把 columns 写回后端                                                            |
| source_csv_file_link | 补全后的达人数据 CSV 经 `file_bridge(flow=creator_detail, field_id)` 上传 OSS 后的链接                       |
| custom_table_oss_url | 用户上传的自定义表格模板经 `file_bridge` 上传 OSS 后的链接（可选）                                           |
| 补全 CSV             | YP Action 原生工具（`get_xhs_author_business_card` / `get_douyin_author_business_card`）补全出的达人明细 CSV |

## 3. 总体设计

### 3.1 端到端时序

```text
用户：给平台 + 一批达人 ID 或链接
  │
  ▼
agent 调 select_inquiry_form_fields(platform, creator_ids / creator_links)
  │  （不传 requirement_id）
  ▼
后端：创建 get_creator_detail_run 记录（status=pending）
      返回 { success, status:"selection_required", field_id, url }
  │
  ▼
agent：正文单独一行原样展示 url，让用户去选字段
  │
  ▼
agent：平台原生工具补全这批达人 → file_bridge(flow=creator_detail, field_id) 上传补全 CSV → source_csv_file_link
       （用户上传了自定义表格时，file_bridge 上传得到 custom_table_oss_url，可选）
  │
  ▼
agent 调 excel_export(field_id, source_csv_file_link[, custom_table_oss_url])
  │
  ▼
后端：查 get_creator_detail_run
  ├─ columns 已生成 → 导出 Excel，status=exported，返回下载链接
  └─ columns 为空     → 返回「未选择字段」错误 + 字段选择 URL，status 保持 pending
                          agent 重新展示 URL，等用户提交后用同一 field_id 重试 excel_export
```

### 3.2 职责划分

| 角色           | 职责                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| agent          | 识别模式、调工具、展示 URL、补全达人、上传 CSV、交付下载链接；不轮询字段状态、不主动停下等口头确认 |
| 插件（ypscan） | 工具卡、SKILL、Hook 指令、registry、toolFilter（已落地）                                           |
| Provider 后端  | `select_inquiry_form_fields` 改 schema、新增 `excel_export`、字段页落库、查表校验                  |
| 数据库         | 新建 `get_creator_detail_run` 表                                                                   |

## 4. 数据库设计

### 4.1 建表 DDL（建议）

```sql
CREATE TABLE get_creator_detail_run (
  run_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键，即 select_inquiry_form_fields 无需求时返回的 field_id',
  user_id       INT             NOT NULL                COMMENT '创建用户，关联 auth_user.id',
  platform      VARCHAR(32)     NOT NULL                COMMENT 'xiaohongshu / douyin',
  columns       TEXT            NULL                    COMMENT '字段选择 json 数组，结构与 customer_demands.columns 一致；用户提交字段页后写入，先建行为空',
  creator_ids   JSON            NULL                    COMMENT '达人 ID 列表，请求时传入',
  creator_links JSON            NULL                    COMMENT '达人主页链接列表，请求时传入',
  status        VARCHAR(32)     NOT NULL DEFAULT 'pending' COMMENT 'pending / columns_selected / exported / failed',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id),
  KEY idx_get_creator_detail_run_user (user_id),
  KEY idx_get_creator_detail_run_status (status),
  KEY idx_get_creator_detail_run_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='只扒达人信息的字段选择与导出会话';
```

说明：

- `status` 用 `VARCHAR(32)` 与现有表风格一致；如需更严格可用 `ENUM('pending','columns_selected','exported','failed')`，二者等效。
- `columns` 结构与 `customer_demands.columns` **完全一致**，见 4.3 示例。
- `user_id` 建议加外键指向 `auth_user.id`（与 `core_formtemplate.created_by_id` 同款），是否加由后端按现有规范决定。
- `creator_ids` / `creator_links` 存请求原文（数组），用于追溯，不参与导出逻辑。

### 4.2 状态机

```text
                select_inquiry_form_fields（无 requirement_id）
                              │
                              ▼
                        [ pending ]  ←──────────────┐
                              │                      │
              字段页提交，columns 写入                │ 字段页重新提交（覆盖 columns）
                              ▼                      │
                    [ columns_selected ] ────────────┘
                              │
               excel_export 成功 / 失败
                    ┌─────────┴─────────┐
                    ▼                   ▼
              [ exported ]         [ failed ]
```

- `pending`：`select_inquiry_form_fields` 创建，等用户选字段。
- `columns_selected`：字段页提交，columns 写入。
- `exported`：`excel_export` 成功生成表格。
- `failed`：`excel_export` 失败。

补充规则：

- 字段页可重复提交：重新提交用新 columns 覆盖旧值，status 回到/保持 `columns_selected`。
- 同一 `field_id` 重复调 `excel_export` 且 columns 已生成：应可重复导出（幂等），status 保持 `exported`。
- `excel_export` 因「未选择字段」失败**不**置 `failed`（保持 `pending`，等用户提交）；因 source_csv 无效或其他失败置 `failed`。

### 4.3 columns 结构（复用 customer_demands.columns，实测样例）

columns 是**字段对象数组**，每个元素：

```json
{ "key": "...", "name": "...", "type": "...", "required": true, "group": "..." }
```

- `key`：字段标识，导出时用它从达人数据取值。
- `name`：展示名，导出表头用它。
- `type`：字段类型（`VARCHAR(32)` / `BIGINT` / `json` / `text` 等）。
- `required`：是否必选。
- `group`：分组名（小红书用「必选标签」，抖音用「基础信息」等）。
- `sourceKey`（可选）：派生字段标记，表示该字段值由另一字段生成（见 4.5）。

小红书（xiaohongshu）实测样例：

```json
[
  {
    "key": "platform",
    "name": "平台",
    "type": "VARCHAR(32)",
    "required": true,
    "group": "必选标签"
  },
  {
    "key": "nickname",
    "name": "博主昵称",
    "type": "varchar(255)",
    "required": true,
    "group": "必选标签"
  },
  {
    "key": "bloggerLabel",
    "name": "达人标签",
    "type": "json",
    "required": true,
    "group": "必选标签"
  },
  {
    "key": "xiaohongshuId",
    "name": "小红书ID",
    "type": "varchar(64)",
    "required": true,
    "group": "必选标签"
  },
  {
    "key": "homepage_url",
    "name": "主页链接",
    "type": "text",
    "required": true,
    "group": "必选标签"
  },
  {
    "key": "pugongying_url",
    "name": "蒲公英链接",
    "type": "text",
    "required": true,
    "group": "必选标签"
  },
  { "key": "rebate", "name": "返点", "type": "VARCHAR(255)", "required": true, "group": "必选标签" }
]
```

抖音（douyin）实测样例：

```json
[
  {
    "key": "platform",
    "name": "平台",
    "type": "VARCHAR(32)",
    "required": true,
    "group": "基础信息"
  },
  {
    "key": "star_id",
    "name": "星图ID",
    "type": "VARCHAR(64)",
    "required": true,
    "group": "基础信息"
  },
  {
    "key": "nick_name",
    "name": "昵称",
    "type": "VARCHAR(255)",
    "required": true,
    "group": "基础信息"
  },
  {
    "key": "follower",
    "name": "粉丝数（万）",
    "type": "BIGINT",
    "required": true,
    "group": "基础信息"
  },
  {
    "key": "rebate",
    "name": "返点",
    "type": "VARCHAR(255)",
    "required": true,
    "group": "基础信息"
  },
  {
    "key": "star_homepage",
    "name": "星图主页",
    "type": "VARCHAR(255)",
    "required": true,
    "group": "基础信息",
    "sourceKey": "star_id"
  }
]
```

### 4.4 字段选项来源（字段选择页）

字段选择页的候选字段来自 `core_formtemplatecolumn`（模板字段表），按平台的默认模板过滤：

- `core_formtemplate`：模板本体（`template_type` 如「达人提报」，`platform` 如「小红书」/「抖音」，`is_default` 默认模板）。
- `core_formtemplatesheet`：模板内的 sheet。
- `core_formtemplatecolumn`：字段定义（`field_key`、`field_name`、`field_type`、`required`、`options`、`sort_order`、`sheet_id`）。

字段选择页复用现有需求维度的字段页逻辑，只把「提交后写回哪个实体」从 `customer_demands.columns` 换成 `get_creator_detail_run.columns`。

### 4.5 sourceKey 派生字段

columns 里带 `sourceKey` 的字段（如抖音 `star_homepage` 的 `sourceKey: "star_id"`）表示其值由源字段派生（主页链接由达人 ID 构造）。`excel_export` 生成表格时：

- 达人数据里已有该列值 → 直接用。
- 达人数据里没有 → 按既有派生规则从 `sourceKey` 字段生成；生成规则复用现有链路，不在本文新定义。

## 5. 接口设计

### 5.1 select_inquiry_form_fields 改动

#### 5.1.1 入参变化

| 参数                    | 类型     | 必填         | 变化       | 说明                               |
| ----------------------- | -------- | ------------ | ---------- | ---------------------------------- |
| `requirement_id`        | string   | 否（原必填） | **改选填** | 传了走需求维度；不传走只扒达人信息 |
| `platform`              | string   | 是           | 不变       | `xiaohongshu` / `douyin`           |
| `creator_ids`           | string[] | 否           | **新增**   | 达人 ID 列表                       |
| `creator_links`         | string[] | 否           | **新增**   | 达人主页链接列表                   |
| `source_requirement_id` | string   | 否           | 不变       | 同会话继承来源需求；无需求模式不传 |
| `force_reselect`        | boolean  | 否           | 不变       | 默认 false；无需求模式不传         |

#### 5.1.2 入参校验

- 传了 `requirement_id`：沿用现有需求维度逻辑，忽略 `creator_ids` / `creator_links`，不生成 field_id 流程，返回结构不变（不返回 field_id）。
- 没传 `requirement_id`：
  - `creator_ids` 与 `creator_links` 至少一个非空，否则返回参数错误。
  - `platform` 必须是 `xiaohongshu` 或 `douyin`。
  - `source_requirement_id` / `force_reselect` 不适用（无来源需求可继承，每次都是首次选字段），agent 不传；后端收到时建议忽略而非报错。
  - 创建一条 `get_creator_detail_run`（status=`pending`，记录 platform、creator_ids、creator_links、user_id）。

#### 5.1.3 返回结构

无 `requirement_id` 的调用：

```json
{
  "success": true,
  "status": "selection_required",
  "field_id": "<run_id，字符串或数字>",
  "url": "<字段选择页 URL>"
}
```

- `field_id` 与 `url` 缺一不可；缺失时 agent 暂停。
- 传了 `requirement_id` 的调用：返回结构不变，**不返回 field_id**。

#### 5.1.4 错误码

| 错误码                                    | 场景                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `SELECT_INQUIRY_FORM_FIELDS_INVALID_ARGS` | 无 requirement_id 时 creator_ids 与 creator_links 均为空，或 platform 非法 |
| 沿用现有字段选择错误码                    | 传 requirement_id 时的继承失败、平台不兼容等                               |

### 5.2 excel_export 新增

#### 5.2.1 入参

| 参数                   | 类型   | 必填 | 说明                                                                   |
| ---------------------- | ------ | ---- | ---------------------------------------------------------------------- |
| `field_id`             | string | 是   | `get_creator_detail_run.run_id`，定位用户选中字段                      |
| `source_csv_file_link` | string | 是   | 补全后的达人 CSV 经 file_bridge(flow=creator_detail) 上传 OSS 后的链接 |
| `custom_table_oss_url` | string | 否   | 用户自定义表格的 OSS 链接；不传用固定格式，传了按表格字段插值          |

#### 5.2.2 校验与处理流程

1. 参数校验：`field_id`、`source_csv_file_link` 非空且类型正确，否则 `EXCEL_EXPORT_INVALID_ARGS`。
2. 查表：`get_creator_detail_run` 里 `run_id = field_id` 存在，否则 `EXCEL_EXPORT_FIELD_NOT_FOUND`。
3. 校验 columns：`columns` 为空或 status 仍为 `pending` → 返回「未选择字段」错误，**附上该 field_id 的字段选择 URL**（见 5.2.4）。status 保持 `pending`，不置 failed。
4. 校验 source_csv：下载并解析 `source_csv_file_link`，必须有可识别的达人行，否则 `EXCEL_EXPORT_SOURCE_CSV_INVALID`（置 status=`failed`）。
5. 分支：
   - 无 `custom_table_oss_url`：按 columns 生成固定格式表格（见第 7 章）。
   - 有 `custom_table_oss_url`：下载解析自定义模板，按字段名匹配插入达人数据（见第 8 章）。
6. 成功：置 status=`exported`，返回下载链接。
7. 其他失败：置 status=`failed`，返回错误码。

#### 5.2.3 返回结构

成功：

```json
{
  "success": true,
  "data": { "file_url": "<表格下载链接>" }
}
```

> 下载链接字段名已确认：`data.file_url`。

失败：

```json
{
  "success": false,
  "error": { "code": "EXCEL_EXPORT_COLUMNS_NOT_CONFIGURED", "message": "未选择字段" },
  "url": "<字段选择页 URL>"
}
```

#### 5.2.4 「未选择字段」错误

这是字段是否已提交的**唯一确认机制**：

- agent 不轮询 `get_inquiry_form_fields_status`、不主动停下等用户口头确认「已提交」。
- agent 展示 URL 后继续补全、上传，直接调 `excel_export`。
- 后端查 `get_creator_detail_run.columns`：空就返回「未选择字段」+ URL，agent 重新展示 URL，等用户提交后用同一 `field_id` 重试。

#### 5.2.5 错误码

| 错误码                                | 场景                              | status 变化  |
| ------------------------------------- | --------------------------------- | ------------ |
| `EXCEL_EXPORT_INVALID_ARGS`           | 参数缺失/类型错                   | 不变         |
| `EXCEL_EXPORT_FIELD_NOT_FOUND`        | field_id 不存在                   | 不变         |
| `EXCEL_EXPORT_COLUMNS_NOT_CONFIGURED` | columns 为空 / status=pending     | 保持 pending |
| `EXCEL_EXPORT_SOURCE_CSV_INVALID`     | source_csv 无法下载/解析/无有效行 | failed       |
| `EXCEL_EXPORT_CUSTOM_TABLE_INVALID`   | 自定义表格解析失败/字段匹配失败   | failed       |
| `EXCEL_EXPORT_FAILED`                 | 其他失败                          | failed       |

## 6. 字段选择页（callback）

- **URL 生成**：复用现有字段选择页（现有需求维度 URL 形如 `https://agenta.eshypdata.com/demand-field-selector?token=...`）。无需求模式用**新 token 参数**标识指向 `field_id`，前端据此知道「提交后写回哪条 get_creator_detail_run」。
- **字段选项**：按平台取 `core_formtemplatecolumn`（默认「达人提报」模板）的字段，渲染勾选。
- **提交写入**：前端提交后，后端把选中字段序列化为 columns JSON 数组（结构与 4.3 一致）写入 `get_creator_detail_run.columns`，status 改为 `columns_selected`。
- **重复提交**：覆盖旧 columns，status 回到 `columns_selected`。

## 7. 固定格式表格规范（无 custom_table_oss_url）

### 7.1 样式基线

「固定格式」= 样式照抄现有 `ypscan_summarize_manual_scores` 生成的 manual-score-summary 汇总表，**列按用户选中的 columns 裁剪**。

manual-score-summary 的样式要点（实现参考本地 `src/tools/manual-score-summary.js`）：

- 工作表名、标题、需求信息、分组表头、列宽、颜色、数字格式、冻结行保留 Provider 单表模板原样。
- 数据区隔行底色；数据区任意单元格为合法 HTTP(S) URL 时写成 OOXML 外部超链接。
- 达人身份列：抖音 `星图ID`、小红书 `蒲公英ID`。

### 7.2 列裁剪规则

- 表头 = columns 数组元素的 `name`，顺序 = columns 数组顺序。
- 只输出用户选中的字段，不多加列（身份列如星图ID/蒲公英ID若在 columns 里则自然包含）。
- columns 里带 `sourceKey` 的派生字段按 4.5 规则取值。

### 7.3 达人数据映射

`source_csv_file_link` 的补全 CSV 结构：

- 达人 ID 列（抖音优先 `creator_id`/`请求星图ID`/`星图ID`/`xt_id`；小红书 `creator_id`/`请求kw_uid`/`kw_uid`/`xt_id`），对应本地 `COMPLETION_ID_HEADER_CANDIDATES`。
- 其余列为达人详情字段。

CSV 列名 → columns `key` 的映射：**复用现有补全/打分链路的字段映射**（补全 CSV 是同一套产物，已确认）。

### 7.4 排序

只扒达人信息**不做评分排序**，达人行顺序 = source_csv 里达人出现顺序（保持用户给达人的顺序）。

## 8. 自定义表格解析（custom_table_oss_url，可选）

- 用户上传自定义表格模板（列名/顺序由用户定），file_bridge 上传 OSS 得到 `custom_table_oss_url`。
- `excel_export` 下载该模板，解析其表头字段，把达人数据按字段名匹配插入对应列。
- 字段匹配规则（列名 ↔ 达人字段 key ↔ columns key）由后端定义；匹配不上或模板无法解析时返回 `EXCEL_EXPORT_CUSTOM_TABLE_INVALID`。
- 该能力是后期功能，本次可先只支持固定格式；自定义表格具体匹配规则待后端细化。

## 9. agent 操作时序（只扒达人信息）

| 步骤 | 动作                   | 输入                                                                   | 输出                   | 异常处理                   |
| ---- | ---------------------- | ---------------------------------------------------------------------- | ---------------------- | -------------------------- |
| 1    | 识别模式               | 用户给平台 + 达人 ID/链接                                              | 业务模式=只扒达人信息  | 模式冲突时 AskUserQuestion |
| 2    | 选字段                 | `select_inquiry_form_fields(platform, creator_ids/creator_links)`      | `field_id` + `url`     | field_id/url 缺失暂停      |
| 3    | 展示 URL               | 单独一行原样输出 url                                                   | 用户去选字段           | 不改写、不包装、不替选     |
| 4    | 补全                   | 平台原生工具补全这批达人                                               | 补全 CSV               | 部分失败保留成功 CSV       |
| 5    | 上传                   | `file_bridge(flow=creator_detail, field_id)` 上传补全 CSV              | `source_csv_file_link` | 失败暂停                   |
| 6    | （可选）上传自定义表格 | `file_bridge` 上传自定义表格                                           | `custom_table_oss_url` | 失败按工具错误处理         |
| 7    | 导出                   | `excel_export(field_id, source_csv_file_link[, custom_table_oss_url])` | 下载链接               | 见 9.1                     |
| 8    | 交付                   | 展示下载链接                                                           | 交付完成               | —                          |

### 9.1 excel_export 异常分支

| 返回                                      | agent 动作                                                          |
| ----------------------------------------- | ------------------------------------------------------------------- |
| 「未选择字段」+ URL                       | 重新单独一行展示 URL，等用户提交后用同一 field_id 重试 excel_export |
| `EXCEL_EXPORT_SOURCE_CSV_INVALID`         | 重新 file_bridge 上传补全 CSV 得到新链接，再重试                    |
| `EXCEL_EXPORT_FIELD_NOT_FOUND` / 其他失败 | 暂停，如实说明，用重试/结束弹窗                                     |

## 10. 插件侧改动清单（已完成）

1. `src/contract/registry.js`：`BUSINESS_TOOL_NAMES` 增加 `excel_export`。
2. `openclaw.plugin.json`：`toolFilter.include` 增加 `excel_export`（白名单 14→15）。
3. `src/tools/popup-questions.js`：业务模式弹窗增加「只扒达人信息」选项。
4. `src/hooks/register-flow-directives.js`：无需求字段选择指令、`excel_export` 结果指令、`before_tool_call` 保留新参数、`before_prompt_build` 注入链路；field_id 维度补全路径门禁（`currentFieldIdByScope` + `completionCsvPathsByFieldId`）。
5. `src/tools/file-bridge.js` + `src/tools/merge-creator-csv.js` + `index.js`：新增 `flow=creator_detail`（`field_id` 替代 requirement_id、无 links CSV 纯合并、OSS 路径用 field_id），作为 `source_csv_file_link` 的上传来源。
6. 工具卡：更新 `select_inquiry_form_fields.md`、`file_bridge.md`，新增 `excel_export.md`。
7. `SKILL.md`、spec（contracts/flows/hooks/tools/architecture/README）、`review-checklist`、`README`、`CHANGELOG`、`AGENTS` 同步。
8. 测试：新增 `tests/creator-detail-export.test.mjs`（11 项），更新 registry/select-inquiry-tool/hard-controls/smoke 断言。

## 11. 测试用例（后端）

1. **select_inquiry_form_fields 无需求**：传 platform + creator_ids → 建 run（status=pending），返回 field_id + url。
2. **无需求但 creator 参数为空**：返回参数错误，不建 run。
3. **有 requirement_id**：走原逻辑，不建 run、不返回 field_id。
4. **字段页提交**：提交后 columns 写入对应 field_id，status=columns_selected。
5. **字段页重复提交**：columns 覆盖，status 回 columns_selected。
6. **excel_export 正常**：columns 已生成 + source_csv 有效 → 导出成功，status=exported，返回链接。
7. **excel_export 未选字段**：columns 空 → 返回「未选择字段」+ URL，status 保持 pending。
8. **excel_export field_id 不存在**：返回 FIELD_NOT_FOUND。
9. **excel_export source_csv 无效**：返回 SOURCE_CSV_INVALID，status=failed。
10. **excel_export 幂等**：同一 field_id 二次调用，columns 已生成 → 再次导出成功。
11. **固定格式列裁剪**：导出表头 = columns 的 name，顺序一致，无多余列。
12. **自定义表格**（后期）：传 custom_table_oss_url → 解析模板插值；模板无效 → CUSTOM_TABLE_INVALID。

## 12. 兼容性、边界与风险

- **达人去重**：creator_ids / creator_links 去重由后端决定；重复达人导出行为需明确（建议按请求顺序去重保留首个）。
- **空达人列表**：请求时校验至少其一非空，空列表走参数错误。
- **并发**：同一 field_id 并发调 excel_export 的幂等与锁由后端保证。
- **大 CSV**：source_csv 行数上限建议复用现有 file_bridge/score 链路的 500 行或更大阈值，超出明确报错。
- **安全**：`source_csv_file_link` / `custom_table_oss_url` 必须是可信 OSS 链接（file_bridge 产物），后端校验域名/签名，避免 SSRF。

## 13. 已确认项与待确认点

### 已确认

1. excel_export 成功后的下载链接字段名：`data.file_url`。
2. 参数命名：`creator_ids`、`creator_links`、`custom_table_oss_url`。
3. 达人数据映射：补全 CSV 列名 ↔ columns key 复用现有补全/打分链路的字段映射。
4. 字段选择页 URL 携带 field_id：用新 token 参数。

### 待确认

1. 自定义表格字段匹配规则：后期功能，具体匹配规则待细化。

## 14. 验收标准

1. 用户给一批达人 ID/链接 + 平台，能走完「选字段 → 补全 → 导出」全链路，得到按选中字段排列的 Excel。
2. 未选字段就调 excel_export，返回「未选择字段」+ 字段选择 URL，用户提交后重试成功。
3. 老两种模式（询价机构/手动拓展）行为不变，回归通过。
4. 导出表样式与 manual-score-summary 一致（列按 columns 裁剪），URL 单元格可点击。
5. 状态机正确流转（pending → columns_selected → exported/failed），幂等导出不重复改状态。
6. 插件侧 `npm test` / `lint` / `typecheck` / `smoke` 通过，真实 Provider 端到端验收通过。
