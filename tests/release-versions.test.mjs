import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("smoke rejects version drift in the manifest and both lockfile locations", () => {
  const fixture = mkdtempSync(join(tmpdir(), "ypscan-version-smoke-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    copyFileSync(join(root, "scripts/smoke-test.mjs"), join(fixture, "scripts/smoke-test.mjs"));
    copyFileSync(join(root, "package.json"), join(fixture, "package.json"));
    symlinkSync(join(root, "index.js"), join(fixture, "index.js"));
    symlinkSync(join(root, "skills"), join(fixture, "skills"), "dir");
    const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    for (const scenario of ["aligned", "manifest", "lock-top", "lock-root", "missing-root"]) {
      const nextManifest = structuredClone(manifest);
      const nextLock = structuredClone(lock);
      if (scenario === "manifest") nextManifest.version = "0.0.0-drift";
      if (scenario === "lock-top") nextLock.version = "0.0.0-drift";
      if (scenario === "lock-root") nextLock.packages[""].version = "0.0.0-drift";
      if (scenario === "missing-root") delete nextLock.packages[""];
      writeFileSync(join(fixture, "openclaw.plugin.json"), JSON.stringify(nextManifest));
      writeFileSync(join(fixture, "package-lock.json"), JSON.stringify(nextLock));
      const result = spawnSync(process.execPath, [join(fixture, "scripts/smoke-test.mjs")], {
        encoding: "utf8",
        timeout: 30000,
      });
      assert.ifError(result.error);
      if (scenario === "aligned") {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /tools=5, hooks=5/u);
      } else {
        assert.equal(result.status, 1, `${scenario} must fail: ${result.stderr}`);
        assert.match(result.stderr, /versions must stay in sync/u);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
