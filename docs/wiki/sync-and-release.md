# 文档同步与发布

## 一次修改的完成条件

**不能只改最先找到的文件；也不能为了“同步”机械改所有文件。** 修改前按下表列受影响资料，修改后逐项核对：更新，或说明为什么不受影响。代码、规则、测试和相关文档应在同一任务中交付；用户要求提交时保持同一提交或 PR，不擅自提交。

| 修改类型                                  | 必查并按实际影响同步                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 业务步骤、暂停/恢复、澄清、放宽、交付     | `skills/media-assistant/SKILL.md`、受影响工具卡、Hook、`docs/spec/flows.md` / `hooks.md`、`docs/review-checklist.md`、相关行为/单元样本；公开流程变化时检查 README，项目不变量变化时检查 AGENTS |
| 工具入参、返回、错误语义、Provider schema | 受影响工具卡、`src/contract/registry.js`、Hook、`openclaw.plugin.json` 中相应契约、`docs/spec/contracts.md` / `tools.md`、测试及脱敏响应样本；流程受影响时再检查上一行                          |
| 工具注册、白名单、组件边界                | `index.js`、manifest、smoke、README、AGENTS 架构地图、`docs/spec/README.md` / `architecture.md` / `contracts.md` / `hooks.md` 中对应描述                                                        |
| 配置、依赖、上传或安装方式                | 源代码、manifest 配置、`package.json` / lock（依赖变化才更新）、README、相关工具卡、`docs/spec/config.md` / `tools.md`、测试及发布包核对                                                        |
| 工程流程、验证、发布规范                  | AGENTS、对应 Wiki 页、`docs/review-checklist.md` 工程条目、相关脚本/CI；改变验证能力时同步 README 与 Spec 的验证/发布章节                                                                       |
| 发版                                      | 三个 JSON 文件的四个版本位置、CHANGELOG 当前发布记录、此次变更涉及的文档、smoke、真实包内容和安装验收                                                                                           |
| 纯内部重构或测试调整                      | 相关测试；若外部行为、架构和命令均未变，可说明业务文档无需更新，不制造无意义差异                                                                                                                |

### 防漏复核

1. 先检查 `git status` 和已有 diff，保留用户及其他 Agent 的成果。
2. 按变更概念、工具名、旧字段名、旧行为说明用 `rg` 搜索当前资料；位置未知或涉及跨文件关系时用语义检索找线索，再读当前文件核实。
3. 检查旧描述是否仍在 README、AGENTS、Skill、工具卡、Spec、验收清单中作为当前规则存在。历史 CHANGELOG 和历史审计记录不是当前契约，不批量改写历史。
4. 检查新增文档链接和文件路径。新增 Wiki 页面必须加入入口；不要链接到不存在的评测记录。
5. 最终差异逐项对应本次目标。汇报已同步文件、无需更新类别及原因、验证结果和未验证范围；“已同步”不等于已完成模型或桌面验收。

## 版本：三个文件、四个位置

当前版本以仓库 `package.json.version` 为基准，不在 Wiki 另存一份版本号。只有用户要求发版或明确指定版本变更时才升版。

以下四个位置必须全部等于目标版本：

1. `package.json.version`
2. `openclaw.plugin.json.version`
3. `package-lock.json.version`
4. `package-lock.json.packages[""].version`

修改版本只更新这些根包位置，不全局替换 lock 中依赖包版本，不为升版无故重算依赖。`npm run smoke` 自动校验四处一致；现有 CI 已调用 smoke。`tests/release-versions.test.mjs` 用隔离副本验证一致时通过，manifest 或 lock 任一位置漂移、lock 根包记录缺失时失败，不修改工作区版本。

发布记录写入 `CHANGELOG.md`，标明本次交付变化和重要兼容性影响；未运行的验证不得写成通过。历史版本记录和历史示例不随当前版本批量替换。正常工程任务不因改了文档就自动发版。

## 发布步骤（获得用户发版授权后执行）

1. 核对目标版本、工作区和本次发布范围，完成上述同步矩阵，并更新四处版本及 CHANGELOG。
2. 执行 `npm run lint && npm run typecheck && npm test && npm run smoke`，检查退出状态和关键输出。
3. 阅读当前 `scripts/prepare-oss-bundle.mjs` 的行为后运行 `npm pack --dry-run --cache /tmp/ypscan-npm-cache`。dry-run 也会触发 prepack，不能当成完全只读：可能生成或删除 gitignored 凭据 bundle。
4. 执行 `npm pack --cache /tmp/ypscan-npm-cache`，用 `tar -tzf ypscan-<version>.tgz` 只列文件名核对包内容：白名单完整、无 tests/遗留 browser 工具。不得解包打印密钥内容。
5. 官方免配置上传包须包含 `src/tools/file-bridge-oss-defaults.json`；无凭据时 prepack 会警告并继续，不能把这种产物宣称为免配置可上传。确认凭据分发权限风险，不因存在 bundle 就断言权限安全或上传可用。
6. 在获授权的隔离环境验证真实安装、加载和必要能力；涉及外部上传或发送时必须有相应授权。不具备环境则明确未验收，不以开发目录 smoke 冒充安装成功。
7. `git status` 确认 tgz/bundle 不在待提交列表，报告包路径、版本一致性、包核对和安装验收结果。代码检查通过、包生成、上传可用是三个不同结论。
8. 仅在用户要求时提交，沿用 `release <version>: <变更摘要>`；不自动推送、发布到 registry 或部署。
