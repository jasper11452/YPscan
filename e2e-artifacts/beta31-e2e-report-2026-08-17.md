# ypscan 0.1.24-beta31 端到端测试报告

测试时间：2026-08-17（Asia/Shanghai）  
发布包：`ypscan-0.1.24-beta31.tgz`  
包 SHA-256：`53e348dcbdf53ca70975815049bb8fc9e49fbfc59e3ad56fb832db9c22d3e194`

## 结论

**不通过发布验收。** 已在真实、已登录的星图和蒲公英页面复现 P0 筛选问题，且星图的真实手扒运行回读到了错误的报价时长档位。P0 不满足 100% 通过，不能交付候选名单或 Excel 作为验收结果。

## 环境与基础校验

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| E2E-01 发布包安装与注册 | 通过 | 独立临时工作目录安装包后，版本为 `0.1.24-beta31`；注册 `tools=3`、`hooks=6`。 |
| 本地回归 | 通过 | `npm run lint`、`npm run typecheck`、`npm test`（137/137）、`npm run smoke` 全部通过。 |

## 真实平台结果

| 用例 | 结果 | 观察到的事实 |
| --- | --- | --- |
| XT-01 星图二级级联选择 | **失败（P0）** | 使用真实路径 `美妆 → 美妆教程` 连续 3 次。一级真实触发器文本为“美妆”，二级叶子为“美妆教程”；适配器将完整叶子路径用于匹配一级触发器，3 次均返回 `applied=false`、`reason=filter_row_not_found`，叶子没有选中。 |
| XT-03 未提交不得假成功 | 通过（负向断言） | 上述 3 次失败没有被报告为已应用；没有出现“菜单关闭即成功”的假阳性。 |
| XT-05 星图 60s+ 报价档位 | **失败（P0）** | 真实 runner 的计划要求 `60s以上视频`，而增量 checkpoint 的页面回读仍是 `21-60s`。因此候选价格口径错误，运行被主动停止。 |
| PGY-01 蒲公英类目回读 | **失败（P0）** | 在真实“博主类目”行选择“职场”连续 3 次。第一次后 UI 真实出现 `--active`，但工具仍返回 `applied=false`；第二次再次点击把已选项取消，第三次再点回。适配器未识别当前页面使用的 `--active` 选中态，存在重试反向取消风险。 |
| PGY-02 图文/视频报价口径 | 未运行 | 当前账户未选择合作品牌；遵循不擅自选择品牌、不发起合作的约束，未执行列表与报价筛选。 |
| MR-04 / MR-06 / MR-07 checkpoint、复核、五表 Excel | 未通过 / 未完成 | 星图运行被错误报价档位阻断后停止，只留下 5 个分页 checkpoint；未生成 Excel，不应伪造复核或最终名单。 |

## 运行记录与安全

- 手扒 run：`xingtu-e2e-beta31-xt-cascade-20260817-4cf3ada0abe4`。
- 独立工作目录：`/tmp/ypscan-beta31-e2e.CcPOvQ`。
- 截图：`evidence/xt-cascade-*-before|after.png` 与 `evidence/pgy-category-*-before|after.png`，共 12 张。
- checkpoint：`workspace/ypscan-manual-research/xingtu-e2e-beta31-xt-cascade-20260817-4cf3ada0abe4/checkpoint.jsonl`，共 6 行（run + 5 个分页），未生成 `.xlsx`。
- 未触发平台原生导出；未调用企微发送；未选择蒲公英合作品牌。
- checkpoint 未发现 Cookie、Token、Authorization 或 Set-Cookie 字段名；报告不记录私有响应内容。

## 未执行或被阻塞的范围

Provider 的真实 `validate_requirement → search_creators → rank_mcns`、询价轮询与企微门禁未执行：当前会话未提供独立 Provider 测试入口或可调用的远端 MCP 工具。不能将合成需求写入生产 Provider 作为替代测试。

其余人工拓展、异常路径与最终 Excel 用例也未继续执行：已确认的 P0 失败足以阻止 beta31 发布，继续以错误的类目/报价口径采集会污染测试产物。

## 建议复测门槛

1. 星图按路径先定位一级触发器（`美妆`），hover 稳定后再从其动态 `aria-controls` 菜单中点击二级叶子（`美妆教程`）；成功必须由叶子选中态和筛选行回读共同确认。
2. 蒲公英将 `--active` 纳入选中态识别，并在重试前重新读取该状态，避免二次点击取消已提交的选项。
3. 星图 `setPriceView` 必须在点击确认后回读列表表头；非 `60s以上` 时将其留在 `unexpressed_filters`，不得进入采集或详情队列。
4. 修复后，星图和蒲公英各连续 3 次通过后，再恢复完整 Provider、详情复核、checkpoint 恢复与五表 Excel 的 E2E 验收。
