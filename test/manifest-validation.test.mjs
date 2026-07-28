import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function runFixture(t, capabilityDirs) {
  const fixture = mkdtempSync(join(tmpdir(), "oas-manifest-negative-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  mkdirSync(join(fixture, "schemas"), { recursive: true });
  mkdirSync(join(fixture, "oas-package"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "validate-manifests.mjs"), join(fixture, "scripts", "validate-manifests.mjs"));
  copyFileSync(join(ROOT, "schemas", "oas-package.schema.json"), join(fixture, "schemas", "oas-package.schema.json"));
  copyFileSync(join(ROOT, "schemas", "capability-manifest.schema.json"), join(fixture, "schemas", "capability-manifest.schema.json"));

  const packageManifest = {
    package: "test.package",
    version: "1.0.0",
    description: "Negative manifest-validation fixture.",
    compatibility: { oas: ">=0.6.2" },
    ...(capabilityDirs === undefined ? {} : { capabilities: capabilityDirs }),
  };
  writeFileSync(join(fixture, "oas-package", "oas-package.json"), JSON.stringify(packageManifest, null, 2) + "\n");

  for (const [index, capabilityDir] of (capabilityDirs || []).entries()) {
    const path = join(fixture, "oas-package", capabilityDir, "oas.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      capability: `test.capability-${index + 1}`,
      version: "1.0.0",
      compatibility: { oas: ">=0.6.2" },
      description: "Negative manifest-validation fixture capability.",
      requires: [],
    }, null, 2) + "\n");
  }

  return spawnSync(process.execPath, [join(fixture, "scripts", "validate-manifests.mjs")], {
    cwd: fixture,
    encoding: "utf8",
  });
}

test("validator rejects a missing capability enumeration", (t) => {
  const result = runFixture(t, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must enumerate exactly one capability directory \(found 0\)/);
});

test("validator rejects extra capability enumerations", (t) => {
  const result = runFixture(t, ["capability-one", "capability-two"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must enumerate exactly one capability directory \(found 2\)/);
});
