# 配置与运行约束

## 1. 插件配置（`configSchema`，`additionalProperties: false`）

| 配置项               | 类型    | 默认    | 说明                                                                                   |
| -------------------- | ------- | ------- | -------------------------------------------------------------------------------------- |
| `testMode`           | boolean | `false` | 仅限隔离端到端测试。开启后仍要求生产形态业务 URL，但允许受控读取 loopback 测试 adapter |
| `testAdapterBaseUrl` | string  | —       | 仅在 `testMode=true` 时使用；必须是无凭据的 loopback HTTP origin                       |
| `fileBridgeOss`      | object  | —       | `file_bridge` 上传 OSS 的安装级覆盖配置；发布包通常已内置凭据，无需填写                |

约束（`src/tools/test-adapter.js` 的 `resolveTestAdapterBaseUrl`，在插件注册时执行）：

- `testMode !== true` → 返回 `null`，adapter 全部禁用。
- `testMode === true` 且 `testAdapterBaseUrl` 非空合法时生效；否则注册阶段抛错：
  - 必须是合法 URL、协议 `http:`、hostname 仅限 `127.0.0.1`/`::1`/`[::1]`；
  - 无 username/password、无 query、无 hash；path 为空或 `/`。
- 效果：Excel/CSV 下载重定向到 `<adapter>/mock/artifact?file_path=<原始 file_path>`；不接管 `file_bridge` 的 OSS 上传。

## 2. Provider MCP 连接（manifest `mcpServers.ypscan`）

| 配置                | 值                                             |
| ------------------- | ---------------------------------------------- |
| url                 | `https://mcp.eshypdata.com/mcp`                |
| transport           | `streamable-http`                              |
| connectionTimeoutMs | `5000`                                         |
| requestTimeoutMs    | `330000`                                       |
| toolFilter.include  | 14 个工具（见 [contracts.md](./contracts.md)） |

## 3. 运行约束（`package.json`）

- `type: module`（ESM）；`private: true`。
- `engines.node >= 22.22.2`；peerDependencies `openclaw >= 2026.7.1`（optional）。
- 运行时依赖为 `ali-oss` 与 `playwright-core`（后者仅为遗留 browser 工具保留，当前插件未注册任何 browser 工具，勿误用）。
- `file_bridge` 运行时凭据按“插件配置 `fileBridgeOss` → 打包内置凭据（`src/tools/file-bridge-oss-defaults.json`，由 prepack 注入）→ 宿主进程环境变量 `AccessKeyId`、`AccessKeySecret`、`Region`、`Bucket`、`Object`”读取；`region`/`bucket`/`objectPrefix` 未配置时回落到内置非敏感默认值，仅 AK/SK 缺失才报配置缺失。安装包不依赖仓库根 `.env`。
- 敏感凭据（Dify Workflow Key、OSS AK/SK）不得写入日志、命令参数、补丁或测试快照。

## 4. 发布约束

- 发布包 `files` 白名单：`index.js`、`openclaw.plugin.json`、`README.md`、`skills`、`src/contract/registry.js`、`src/hooks/register-flow-directives.js`、`src/tools/manual-research/platform-cascade-routes.json`、`src/tools/file-bridge.js`、`src/tools/file-bridge-oss-defaults.json`、`src/tools/merge-creator-csv.js`、`src/tools/parse-requirement.js`、`src/tools/popup-questions.js`、`src/tools/save-artifact.js`、`src/tools/test-adapter.js`、`src/tools/tool-result.js`、`src/util/value.js`。不含遗留 browser 工具与测试文件。
- OSS 凭据注入：`npm pack`/`npm publish` 前 npm 自动运行 `prepack`（`scripts/prepare-oss-bundle.mjs`），把本机 `.env`/环境变量中的 `AccessKeyId`、`AccessKeySecret`（可选 `Region`、`Bucket`、`Object`）写入 `src/tools/file-bridge-oss-defaults.json` 并随包发布；该文件被 `.gitignore` 忽略，凭据不进入 git。本机缺少密钥时脚本删除旧 bundle、警告并继续打包，安装包不含凭据，运行时回落到插件配置或环境变量。
- 版本同步：发布前 `openclaw.plugin.json.version` 必须等于 `package.json.version`，否则 smoke 失败。
- `*.tgz` 是发布产物，被 `.gitignore` 忽略，不提交；产物命名 `ypscan-<version>.tgz`。
- 本机 npm 缓存有 root 属主残留时用 `--cache /tmp/ypscan-npm-cache` 绕过，勿 `sudo chown`。

## 5. 验证命令（仓库根）

```bash
npm run lint          # ESLint flat config，0 错
npm run typecheck     # tsc --checkJs，0 错
npm test              # node --test tests/*.test.mjs，全绿
npm run smoke         # tools=3, hooks=5，版本/白名单/注册形态断言
npm run format:check  # Prettier 检查（format 会全量重排，只在明确要求时用）
npm pack --dry-run --cache /tmp/ypscan-npm-cache   # 发布包内容核对
```

CI（`.github/workflows/ci.yml`）固定执行 `lint → typecheck → test → smoke`。
