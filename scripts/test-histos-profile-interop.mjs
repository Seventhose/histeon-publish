import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, parseJsonStrict } from "../packages/histos-contract/dist/src/index.js";
import { decodeStaticPageArchive, encodeStaticPageProfileArchive } from "../packages/cms/dist/page-transfer.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const publishRoot = path.resolve(scriptDirectory, "..");
const builderRoot = process.argv[2];
if (!builderRoot) throw new Error("Usage: node scripts/test-histos-profile-interop.mjs /path/to/histos-cms-builder");

const phpHarness = path.join(builderRoot, "plugin/tests/Fixtures/page-profile-interop.php");
const temporary = await mkdtemp(path.join(os.tmpdir(), "histos-profile-interop-"));
try {
  for (const fixtureName of ["histos-static-page-v1.json", "histos-static-project-v1.json", "histos-static-project-v2.json", "histos-static-project-v3.json", "histos-static-project-v4.json", "histos-static-markup-v1.json"]) {
    const fixturePath = path.join(publishRoot, "packages/histos-contract/test/fixtures", fixtureName);
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const wpFixturePath = path.join(builderRoot, "plugin/tests/Fixtures", fixtureName);
    assert.deepEqual(await readFile(wpFixturePath), await readFile(fixturePath), `PHP and TypeScript ${fixtureName} fixtures must be byte-identical`);

    const slug = fixtureName.replaceAll(/[^a-z0-9]/giu, "-");
    const phpArchive = path.join(temporary, `${slug}-php.xbsite`);
    const tsArchive = path.join(temporary, `${slug}-ts.xbsite`);
    execFileSync("php", [phpHarness, "encode", phpArchive, fixturePath], { stdio: "pipe" });
    const phpBytes = await readFile(phpArchive);
    const decodedByTs = await decodeStaticPageArchive(phpBytes);
    assert.deepEqual(decodedByTs.profile, fixture.profile, `TypeScript must read the PHP-generated ${fixtureName}`);
    for (const [file, encoded] of Object.entries(fixture.files)) {
      assert.deepEqual(decodedByTs.files.get(file), Buffer.from(encoded, "base64"), `TypeScript must preserve ${file} from PHP`);
    }

    const files = new Map(Object.entries(fixture.files).map(([file, encoded]) => [file, Buffer.from(encoded, "base64")]));
    await (await import("node:fs/promises")).writeFile(tsArchive, await encodeStaticPageProfileArchive(fixture.profile, files));
    const phpDecoded = JSON.parse(execFileSync("php", [phpHarness, "decode", tsArchive], { encoding: "utf8" }));
    assert.deepEqual(phpDecoded.profile, fixture.profile, `PHP must read the TypeScript-generated ${fixtureName}`);
    assert.deepEqual(phpDecoded.files, fixture.files, `PHP must preserve every ${fixtureName} byte from TypeScript`);
  }
  const numericFixturePath = path.join(publishRoot, "packages/histos-contract/test/fixtures/jcs-number-vectors.json");
  const wpNumericFixturePath = path.join(builderRoot, "plugin/tests/Fixtures/jcs-number-vectors.json");
  const numericFixtureBytes = await readFile(numericFixturePath);
  assert.deepEqual(await readFile(wpNumericFixturePath), numericFixtureBytes, "PHP and TypeScript JCS numeric fixtures must be byte-identical");
  const numericFixture = parseJsonStrict(numericFixtureBytes);
  const canonicalPhp = execFileSync("php", [phpHarness, "canonical", numericFixturePath], { encoding: "utf8" }).trimEnd();
  assert.equal(canonicalPhp, canonicalizeJson(numericFixture), "PHP and TypeScript must produce identical JCS numeric boundary bytes");
  for (const schemaName of ["site-transfer-v2.schema.json", "site-entity-v2.schema.json", "site-reference-v2.schema.json", "histos-static-page-v1.schema.json"]) {
    const canonicalSchema = await readFile(path.join(builderRoot, "packages/spec/schemas", schemaName));
    assert.deepEqual(canonicalSchema, await readFile(path.join(publishRoot, "packages/cms/vendor/histos/packages/spec/schemas", schemaName)), `vendored @xb/spec ${schemaName} must match the isolated builder source`);
    assert.deepEqual(canonicalSchema, await readFile(path.join(publishRoot, "packages/histos-contract/schemas", schemaName)), `CMS ${schemaName} mirror must match the shared builder source`);
  }
  process.stdout.write("PHP ↔ TypeScript page, component, template-v2, relational-project-v3, posts-and-roles-v4, transfer-markup-v1, JCS number and Unicode fixtures passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
