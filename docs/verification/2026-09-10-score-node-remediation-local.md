# 2026-09-10 评分节点级修复本地候选实施记录

状态：**M0–M3 已执行：候选已发布，解析与评分两个 Dify 工作流均已用线上 service API 直连验收通过**。本地冻结来源、基线反例、候选节点改动与版本化回放全部通过（176 项）。草稿模型层筛查发现并修复了缺口校验回归（无依据 `evidence_gaps` 改为丢弃并记诊断）；修复后草稿 10/10 运行成功。评分 published 直连 run `4f7ca693` 行为符合 D1（净价口径 UNKNOWN + `unverified_price_basis`），解析 published 直连 run `2bd67571` 输出正常。真实业务端到端（App 内手动拓展交付、Provider 编排）仍未执行；搜索侧（S1）与 D4 别名补丁未实施。

计划与验收用例见 [Dify 手扒搜索与达人评分节点级修复方案](../plans/dify-search-and-scoring-remediation.md)。

## 1. 冻结源与指纹

- 基线导出：`dify工作流/达人评分（手动拓展验收修复-20260910-脱敏）.json`，SHA-256 `e7ee2acbc4f187399d49d59699b15f037230b20fb3716ef6873688db04d0d480`，与计划 2.2 一致。该导出带 `environment_variables_redacted: true`，不含真实环境变量；发布时仍按远端 GET 结果原样保留。
- 候选导出：`dify工作流/达人评分（节点级修复候选-20260910-脱敏）.json`，SHA-256 `7a8f425424ae5105ae93b9da91379173fb42eed1ffbd1a32b9da997597c04e96`（早前值 `b168ae6c…` 作废）。
- 候选与基线结构对比：28 节点、30 边、features、会话变量、环境变量占位均未变；仅下列 11 个节点的 code / prompt / schema 变化。
- 候选由 `scripts/build-dify-score-candidate.py` 从基线加版本化夹具确定性重建，重复构建 SHA-256 相同；夹具与候选 JSON 的 code/prompt 已逐字节核对一致。
- 回放入口 `scripts/dify_replay_support.py` 每次输出实际加载路径、来源 SHA 与节点指纹；不传参数时加载夹具，传 JSON 时回放该构建，避免混淆。

节点 code 指纹（SHA-256 前 16 位）：

| 节点 | 基线 | 候选 |
| --- | --- | --- |
| `parse_json` | `731934a7b2395d2d` | `4842885a481957b2` |
| `parse_retry_json` | `2dfaf0d15a156b80` | `24ec7de95533647c` |
| `score_json` | `49e1742460d0b948` | `94586a656b1b2a46` |
| `score_retry_json` | `0fa3028da1867678` | `ab3cbc9720b8e64d` |
| `review_json` | `977b94123bdf7d20` | `499569e7cc3b6bd0` |
| `final` | `f535472cb5b4026e` | `164d6ceb447812e2` |

prompt 指纹（system message，SHA-256 前 16 位）：`parse` 从 `9ee1f0c572f9e2f9` 变为 `ac17dd4c2b10e8c5`，`score` 从 `29317ccb3511bd2a` 变为 `7bd6478c5045c57e`，`review` 从 `9648cb07f42f9c80` 变为 `0b4a2b0b04f2175b`。`parse_retry` / `score_retry` 与各自首次节点字节相同。

## 2. 改动范围

| 节点 | 改动 |
| --- | --- |
| `parse` / `parse_retry` | 提示词与结构化 schema 增加 `scope`（`creator_objective` / `creator_commercial` / `project` / `delivery`）与 `price_basis`（`quoted` / `rebate_net` / `unspecified`）；单价/净价条件允许进入达人条件，提报截止、招募数量、总预算与交付门槛仍不进入达人门禁 |
| `parse_json` / `parse_retry_json` | 每个条件必须有合法 `scope`；价格/报价/单价/预算类 `creator_commercial` 条件必须有合法 `price_basis`；`source_quote` 子串校验、id 唯一与合法空条件集合沿用原契约 |
| `score` / `score_retry` | 提示词按 `price_basis` 说明核验口径（净价缺口径必须 UNKNOWN），新增 `evidence_gaps` 说明与 schema |
| `score_json` / `score_retry_json` | `deterministic_checks` 按 scope 路由：project/delivery 不核验；`rebate_net`/`unspecified` 强制 UNKNOWN，普通报价不得代替净价；`quoted` 沿用原确定性比较；`evidence_gaps` 校验受控类别与真实缺失前提 |
| `review` | 提示词与 schema 增加 `condition_reviews`（逐 id verdict）与 `evidence_gaps`；`business.price` 改为由逐 id 结论生成的展示摘要 |
| `review_json` | 删除文本极性 `has_affirmative` 路径，改为同 id verdict 与程序核验逐项比较；偏好不一致只记诊断；`evidence_gaps` 校验；主张守卫与混合句删除逻辑保持不变 |
| `final` | 用 scope 路由替换 `NON_CREATOR_WORDS` 子串过滤；过滤项写入 `model_output_diagnostics.final.filtered_conditions`；受控缺证类别在理由中生成固定说明；`score_contract` 补充 scope 过滤语义 |

`score_json` / `score_retry_json` 仍要求 `constraint_results` 精确覆盖全部条件 id（含 project/delivery），项目/交付条件由 final 过滤，不进入硬门禁、pending 与用户文案。

## 3. 验证

### 3.1 基线复现（改动前，2026-09-10 09:05）

| 入口 | 结果 |
| --- | --- |
| `scripts/replay-dify-review-negation.py`（旧夹具 32 项） | 32/32 |
| `scripts/replay-dify-price-alias.py`（旧夹具 12 项 / 基线候选 JSON 24 项） | 12/12、24/24 |
| `scripts/replay-dify-status-gates.py`（旧夹具 / 基线候选 JSON） | 7/7、7/7 |
| `scripts/replay-dify-hand-douyin.py` | 10/10 |
| `scripts/replay-dify-score-workflow.py`（旧 YAML 指纹绑定） | 14 确定性 + 4 final-status + 4 证据链通过 |
| `/tmp/dify-audit/falsify-audit-gaps.py`（远端 dump 合成输入） | 22 项 11 失败：D1 六个触发词 + secondary 丢弃、D2 三条否定漏判与 1 条端到端误报 |

`/tmp` 审计脚本中的 D1/D2/D3 用例已迁移进版本化回放（`replay-dify-score-chain.py` 的基线对照段与 `replay-dify-review-negation.py`），不再依赖临时路径。

### 3.2 候选回放（夹具与候选 JSON 各跑一遍，结果相同）

| 入口 | 项数 | 覆盖 |
| --- | --- | --- |
| `scripts/replay-dify-price-alias.py` | 44/44（22 用例 × 首次/重试） | 原 12 项价格别名迁移 + T2/T3 净价 UNKNOWN、`unspecified`、`must_not`/偏好净价、project/delivery 不核验、错标 scope 的净价仍不比较报价 |
| `scripts/replay-dify-status-gates.py` | 13/13 | 原 7 项状态门禁迁移 + T1/T1b 保留净价 FAIL、project/delivery 过滤与诊断、偏好 advisory、缺 scope 不默认达人、T5 缺证说明 |
| `scripts/replay-dify-review-negation.py` | 64/64 | 同 id verdict 矩阵、否定文案不再驱动冲突（含 T4“不能确认满足预算”与双重否定）、偏好不一致仅诊断、不同 id 不互比、覆盖/枚举错误、T9 缺证类别与注入校验、P4/P5 主张守卫、无价格关键词的净价缺口 |
| `scripts/replay-dify-score-chain.py` | 55/55 | T8 全链路（parse → score/retry → review → final）、首次/重试一致与失败回退、价格别名一致性、P13/P14 错误路径、复核失败降级、硬 FAIL 不被复核清除、review/final 守卫计数一致、无价格关键词的净价缺口 |

`replay-dify-score-chain.py` 同时输出基线对照并断言旧行为确实有缺陷：旧 `final` 丢弃含“返点”的 FAIL、旧 `score_json` 把报价 12000/8000 判为净价 FAIL/PASS、旧 `review_json` 因否定文案误报冲突并删除缺证句子；候选对应行为分别为保留 FAIL、UNKNOWN、不冲突、由受控类别在最终理由中重生成说明。

真实搜索图相邻保护：`scripts/replay-dify-hand-douyin.py` 10/10 通过；旧 `replay-dify-score-workflow.py` 仍对旧 YAML 通过。其旧 final-status 断言（`qualification_pending`、`review_conflict` 作为 evaluation_status）描述的是旧 YAML 版本，与当前候选不一致属过时断言；迁移后的等价覆盖在 `replay-dify-status-gates.py`（UNKNOWN 标注不阻断）与 `replay-dify-score-chain.py`（复核失败降级）中，未改旧脚本本身。

仓库检查：`npm run lint`、`npm run typecheck`、`npm test`（fail 0）、`npm run smoke`（`tools=5, hooks=5`）全部通过；本次未改插件运行时代码。

### 3.3 草稿模型层筛查（2026-09-10 09:30–09:48，draft）

首轮 5 场景 × 5 次整图草稿运行暴露系统性回归：模型在 `content` 已存在时仍上报 `missing_content`（真实意图是“缺简介/口播样本”），`score_json`/`score_retry_json`/`review_json` 的严格前提校验拒绝整个输出，重试同样失败 → `system_error`（S3 5/5、S4 5/5、S2-r2）。

修复：无依据的缺口不再使输出失败，改为丢弃并写入 `diagnostics.dropped_gaps`（原因 `unknown_condition`/`content_present`/`comments_present`/`price_condition_not_unverified`）；仅结构非法（额外字段、未知 kind、重复 kind、id 类型错误、自由文本注入）仍报错。这保留了 D3 的“真实缺证不丢失”和 T9 的“非法通道拒绝”，不再让无依据缺口拖垮整单评分。

修复后（同步到远端草稿 hash `5f0abfb4…`）S3/S5 重跑 10/10 `succeeded`，无节点错误：

| 场景 | 结果 |
| --- | --- |
| S3 报价 12000 > 上限 10000（quoted） | 4/5 `hard_constraint_fail` + H1 FAIL；1/5 模型把价格标为净价口径 → H1/H2 UNKNOWN + `unverified_price_basis`（从不误判 PASS） |
| S5 仅标题、无正文 | 1/5 `ok` + `missing_content` 缺证说明；4/5 将口播要求判为 FAIL（模型对“缺证 vs 不满足”的归类仍有波动） |

S5 的 FAIL 归类波动与 `rebate_net` 无真实证据时稳定 UNKNOWN 一样，属模型层残余风险，代码层不能消除。

### 3.4 发布与 published 直连验收（2026-09-10 09:48–10:00）

- 发布：`POST /console/api/apps/057896e7-3162-4363-aaf4-933657b21c87/workflows/publish`（body `{}`），HTTP 200。
- 发布后 published：`1cffac91-4473-42f8-b220-6b73b1896695`，hash `5f0abfb43753f26d04550c318b786cbc5979fee1723fef66d3426e72d8347ebf`，与草稿完全一致；28 节点、30 边、6 个环境变量未变。
- 发布前备份：`~/.local/state/yp-dify-backups/score-draft-prepublish-20260910.json`（sha `7cd8ab0f…`）与 `score-published-prepublish-20260910.json`（sha `8e5766b9…`，published id `912d3cdb-aaed-42f8-969e-faf526e0cf3f`）。

两个工作流均用线上 `/v1/workflows/run`（blocking）直连实跑，不依赖 Console UI：

| 工作流 | 凭据来源 | run_id | 结果 |
| --- | --- | --- | --- |
| 解析 `61300237…`（published） | 仓库常量 `DIFY_PUBLIC_WORKFLOW_KEY` | `2bd67571-4f80-4af6-92b4-93b4b43bddd9` | `succeeded`；`contentTag=["手机数码测评"]`、`rebate=[0.25,1]`、`followercount=[0,999999999]`、L1 报价区间正常 |
| 评分 `057896e7…`（published） | Console `/api-keys` 中 Provider 正在使用的 key | `4f7ca693-a8bb-4a90-846c-3e7509956c64` | `succeeded`（19s）；净价 + 返点条件 → H1/H2 UNKNOWN、`unverified_price_basis`、decision 不推荐，无 FAIL/PASS 误判 |

评分请求与 Provider 调用同一端点、同一 key、同一 `inputs` 形状（`demand`/`creator_json`/`platform`），因此可作为 Provider 打分链路的可用性证据；Provider 自身的批次编排、文件上传和交付不属于本节范围。

观察：验收期间 Console 运行列表里另有一串非本任务发起的 draft 运行（输入含“本地样例M3/M5”“测试品牌，仅做流程测试”），全部 `succeeded`。已确认不是本任务启动的循环，未干预、未据其得出结论。

### 3.5 未运行

- `tests/fixtures/dify-score-model-cases.json` 已冻结 6 个模型样例（净价、普通报价、双重否定、缺证混合句），本次**未运行**，输出中标记 `model_layer: not_run`。
- 真实业务端到端：App 内完整手动拓展交付、Provider 批次编排与 Excel 交付未执行；published 的可用性由上述直连运行证明，不代表业务交付链路已验收。
- 新提示词是否被模型稳定遵守，不能由代码层回放证明；3.3 的样本量不足以给出稳定性结论。

## 4. D4 证据普查（E1，未改别名）

本机可读的脱敏原生 payload（小红书，共 14 位达人 / 112 条记录，来源 `/tmp` 会话样本，含 `creators_raw.json` 与 `?-creator-sanitized.json`）：

- 记录字段实测：`标题`（str）、`正文`（str）、`点赞量`/`评论量`/`分享量`/`收藏量`/`阅读量`/`曝光量`（int）等。
- 未观测到 `视频标题`、`note_title`、`note_content`、`transcript`、`asr`、`评论原文`、`评论内容`、`comment_text` 等别名，也未观测到非字符串的标题/正文。
- 未找到抖音原生 payload 样本（检索 `星图ID` / `近15条视频表现` 无真实数据）。

结论：四张别名表不一致（A 级代码证据）仍成立，但无证据表明真实 payload 触发过错误上限或误删；抖音侧与未观测别名的影响仍是未知。按计划不扩表、不删表，`score_json` 新增的评论计数仅用于 `evidence_gaps` 前提校验，不参与证据上限。`score_json`/`review_json` 的 `has_any`（接受数字/列表）与 `final._counts`（只认非空字符串）的值类型差异保留，实测样本未触发。

## 5. 残余风险

- `rebate_net` 真实净价证据当前不存在，上线后该类条件会稳定显示 UNKNOWN/待确认；这是设计选择，不是漏判。
- D2 的双重否定仍依赖模型给出正确 verdict；代码只能在其与程序核验相反时保守判复核失败。
- 新增提示词与 schema 只在本节 3.3/3.4 的少量真实运行中验证；`evidence_gaps` 只能覆盖已声明类别，自由文本中其他表述的误删仍是残余风险。
- 回滚目标为上述 `score-published-prepublish-20260910.json`（published id `912d3cdb…`）；计划 2 节的历史 ID（`e927e7fd…`/`a0e169b7…`）已过时，不得使用。
- 无依据缺口改为丢弃后，模型若把真实缺证写成未知类别，仍会静默丢失（只留 `dropped_gaps` 诊断，不进用户可见理由）；当前 5 场景未观测到该情况。

## 6. 复现命令

```bash
python3 scripts/build-dify-score-candidate.py
CAND="dify工作流/达人评分（节点级修复候选-20260910-脱敏）.json"
python3 scripts/replay-dify-price-alias.py "$CAND"
python3 scripts/replay-dify-status-gates.py "$CAND"
python3 scripts/replay-dify-review-negation.py "$CAND"
python3 scripts/replay-dify-score-chain.py "$CAND"
python3 scripts/replay-dify-hand-douyin.py
python3 scripts/replay-dify-score-workflow.py   # 旧 YAML 基线，未迁移
```

线上可用性闭坏（不依赖 Console UI；key 从仓库常量读取，不写入命令行变量以外的位置）：

```bash
# 解析 published
KEY=$(python3 -c "import re;print(re.search(r'DIFY_PUBLIC_WORKFLOW_KEY = \"([^\"]+)\"', open('src/tools/parse-requirement.js').read()).group(1))")
curl -sS -X POST https://dfi.eshypdata.com/v1/workflows/run -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"inputs":{"demand":"<完整需求原文>"},"response_mode":"blocking","user":"ypscan-smoke"}'
# 评分 published：在 dfi.eshypdata.com 的 Console 会话里取 /console/api/apps/<app>/api-keys 的 token，
# 再 POST 同一端点，inputs = {demand, creator_json, platform}；请求形状与 Provider 一致。
```
