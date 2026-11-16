import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppRunScript } from "./linux-apprun.mjs";

test("AppRun mantiene il sandbox Chromium quando user namespace sono disponibili e avvisa sul fallback", {
  skip: process.platform !== "linux",
}, async (suite) => {
  async function runAppRun(unshareStatus, inheritedFallback = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-publish-apprun-"));
    try {
      const appDirectory = path.join(root, "usr/lib/histos-publish");
      const fakeBin = path.join(root, "bin");
      await mkdir(appDirectory, { recursive: true });
      await mkdir(fakeBin);
      const appRunPath = path.join(root, "AppRun");
      const appPath = path.join(appDirectory, "histos-publish");
      const unsharePath = path.join(fakeBin, "unshare");
      await writeFile(appRunPath, createAppRunScript(), { mode: 0o755 });
      await writeFile(appPath, '#!/bin/sh\nprintf "fallback=%s\\narg1=%s\\narg2=%s\\n" "${HISTOS_PUBLISH_SANDBOX_FALLBACK-unset}" "${1-}" "${2-}"\n', { mode: 0o755 });
      await writeFile(unsharePath, `#!/bin/sh\nexit ${unshareStatus}\n`, { mode: 0o755 });
      await Promise.all([chmod(appRunPath, 0o755), chmod(appPath, 0o755), chmod(unsharePath, 0o755)]);
      const environment = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` };
      if (inheritedFallback) environment.HISTOS_PUBLISH_SANDBOX_FALLBACK = "1";
      else delete environment.HISTOS_PUBLISH_SANDBOX_FALLBACK;
      return spawnSync(appRunPath, ["--from-test"], { encoding: "utf8", env: environment });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  await suite.test("non passa --no-sandbox se il controllo namespace riesce", async () => {
    const result = await runAppRun(0, true);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fallback=unset/u);
    assert.match(result.stdout, /arg1=--from-test/u);
    assert.doesNotMatch(result.stderr, /senza sandbox Chromium/u);
  });

  await suite.test("passa --no-sandbox e avvisa se il controllo namespace fallisce", async () => {
    const result = await runAppRun(1);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fallback=1/u);
    assert.match(result.stdout, /arg1=--no-sandbox/u);
    assert.match(result.stdout, /arg2=--from-test/u);
    assert.match(result.stderr, /Installa il pacchetto \.deb/u);
  });
});
