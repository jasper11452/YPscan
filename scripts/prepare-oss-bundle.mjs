/**
 * npm prepack 脚本：把本机 OSS 凭据注入发布包（只进 tgz，不进 git）。
 *
 * 从仓库根 `.env` 与进程环境变量读取（进程环境变量优先，与 Node 的
 * process.loadEnvFile 语义一致），生成 `src/tools/file-bridge-oss-defaults.json`
 * （已被 .gitignore 忽略），由 `file_bridge` 作为“打包内置凭据”配置源读取。
 *
 * 缺少 AccessKeyId / AccessKeySecret 时：删除旧 bundle 并警告，仍然退出 0，
 * 让 npm pack / npm publish 继续（安装包不带凭据，运行时回落到插件配置或环境变量）。
 *
 * 安全约束：本脚本绝不打印任何密钥值，只输出缺失的键名。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE_PATH = join(REPO_ROOT, ".env");
const BUNDLE_PATH = join(REPO_ROOT, "src", "tools", "file-bridge-oss-defaults.json");
/** [环境变量键, bundle 键]；region/bucket/objectPrefix 可选，密钥必需。 */
const FIELD_MAP = [
  ["AccessKeyId", "accessKeyId"],
  ["AccessKeySecret", "accessKeySecret"],
  ["Region", "region"],
  ["Bucket", "bucket"],
  ["Object", "objectPrefix"],
];

try {
  process.loadEnvFile(ENV_FILE_PATH);
} catch {
  // .env 不存在时仅使用进程环境变量。
}

const bundle = {};
for (const [envKey, bundleKey] of FIELD_MAP) {
  const value = (process.env[envKey] ?? "").trim();
  if (value) bundle[bundleKey] = value;
}

const missingKeys = ["AccessKeyId", "AccessKeySecret"].filter(
  (key) => !(process.env[key] ?? "").trim(),
);
if (missingKeys.length > 0) {
  await rm(BUNDLE_PATH, { force: true });
  console.warn(`[prepare-oss-bundle] 缺少 ${missingKeys.join("、")}：本次打包不注入 OSS 凭据。`);
} else {
  await mkdir(dirname(BUNDLE_PATH), { recursive: true });
  await writeFile(BUNDLE_PATH, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  console.warn(
    "[prepare-oss-bundle] OSS 凭据已写入 src/tools/file-bridge-oss-defaults.json（gitignored，仅随 npm pack 进入安装包）。",
  );
}
