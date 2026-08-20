import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Build a throwaway repo with the real validator + real schemas and a synthetic
 * payload, then run the validator against it.
 *
 * @param {object} options
 *   capabilities     value for oas-package.json.capabilities (undefined = omit)
 *   capabilityExtra  extra keys merged into each generated capability oas.json
 *   manifestExtra    extra keys merged into oas-package.json
 *   files            { "payload/relative/path": "contents" } written before validation
 *   symlinks         { "payload/relative/link": "payload/relative/target" }
 */
function runFixture(t, options = {}) {
  const { capabilities, capabilityExtra = {}, manifestExtra = {}, files = {}, symlinks = {} } = options;
  const fixture = mkdtempSync(join(tmpdir(), "oas-manifest-negative-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts", "lib"), { recursive: true });
  mkdirSync(join(fixture, "schemas"), { recursive: true });
  mkdirSync(join(fixture, "oas-package"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "validate-manifests.mjs"), join(fixture, "scripts", "validate-manifests.mjs"));
  copyFileSync(join(ROOT, "scripts", "lib", "config-portability.mjs"), join(fixture, "scripts", "lib", "config-portability.mjs"));
  copyFileSync(join(ROOT, "schemas", "oas-package.schema.json"), join(fixture, "schemas", "oas-package.schema.json"));
  copyFileSync(join(ROOT, "schemas", "capability-manifest.schema.json"), join(fixture, "schemas", "capability-manifest.schema.json"));

  const packageManifest = {
    package: "test.package",
    version: "1.0.0",
    description: "Negative manifest-validation fixture.",
    compatibility: { oas: ">=0.20.0" },
    ...(capabilities === undefined ? {} : { capabilities }),
    ...manifestExtra,
  };
  writeFileSync(join(fixture, "oas-package", "oas-package.json"), JSON.stringify(packageManifest, null, 2) + "\n");

  for (const [index, capabilityDir] of (capabilities || []).entries()) {
    if (capabilityDir === ".") continue;
    const path = join(fixture, "oas-package", capabilityDir, "oas.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      capability: `test.capability-${index + 1}`,
      version: "1.0.0",
      compatibility: { oas: ">=0.20.0" },
      description: "Negative manifest-validation fixture capability.",
      requires: [],
      ...capabilityExtra,
    }, null, 2) + "\n");
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(fixture, "oas-package", relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  for (const [linkPath, targetPath] of Object.entries(symlinks)) {
    const link = join(fixture, "oas-package", linkPath);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(fixture, "oas-package", targetPath), link);
  }

  return spawnSync(process.execPath, [join(fixture, "scripts", "validate-manifests.mjs")], {
    cwd: fixture,
    encoding: "utf8",
  });
}

/** A portable template body: nothing deployment-local is ever uncommented. */
const PORTABLE_TEMPLATE = `name: fixture-deployment
capabilities:
  layers:
    tasks:
      capability: test.package
      from: installed
      # settings:
      #   team: ENG
`;

// The validator pins package id == capability id and package version ==
// capability version for a single-capability official package, so a fixture
// that must PASS declares the matching identity.
const MATCHING_IDENTITY = { capability: "test.package", version: "1.0.0" };

const withTemplate = (path, contents = PORTABLE_TEMPLATE, extra = {}) => ({
  capabilities: ["capabilities/thing"],
  capabilityExtra: MATCHING_IDENTITY,
  manifestExtra: { configTemplates: { default: { path, default: true, ...extra } } },
  files: { [path]: contents },
});

test("validator rejects a missing capability enumeration", (t) => {
  const result = runFixture(t, { capabilities: undefined });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must enumerate exactly one capability directory \(found 0\)/);
});

test("validator rejects extra capability enumerations", (t) => {
  const result = runFixture(t, { capabilities: ["capability-one", "capability-two"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must enumerate exactly one capability directory \(found 2\)/);
});

test('validator rejects a "." capability root', (t) => {
  const result = runFixture(t, { capabilities: ["."] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /read compatibility for already-published packages only/);
});

test("validator rejects a capability resource outside its own capability root", (t) => {
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: { inject: "../../shared/inject.md" },
    files: { "shared/inject.md": "# shared\n" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /injection path must be package-relative and may not contain '\.\.'/);
});

test("validator rejects a capability resource that only escapes after symlink resolution", (t) => {
  // Declared with no "..", but the path it names is a symlink into package-only
  // bytes. Materialization copies the capability root alone, so the resource
  // would simply not be there — the boundary is the CAPABILITY root, not the
  // payload root, and a package-root check would wrongly accept this.
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: { inject: "injects/inject.md" },
    files: { "shared/inject.md": "# package-only, never materialized\n" },
    symlinks: { "capabilities/thing/injects/inject.md": "shared/inject.md" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /injection path escapes the capability root after symlink resolution/);
});

test("validator accepts a canonical, portable config template", (t) => {
  const result = runFixture(t, withTemplate("config-templates/default/oas-config.yaml"));
  assert.equal(result.status, 0, result.stderr);
});

test("validator rejects a config template outside config-templates/", (t) => {
  const result = runFixture(t, withTemplate("configs/default/oas-config.yaml"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must live under config-templates\//);
});

test("validator rejects a config template shipped inside a capability root", (t) => {
  const result = runFixture(t, {
    capabilities: ["config-templates"],
    manifestExtra: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": PORTABLE_TEMPLATE },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must live outside every capability root/);
});

test("validator rejects more than one default config template", (t) => {
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    manifestExtra: {
      configTemplates: {
        one: { path: "config-templates/one/oas-config.yaml", default: true },
        two: { path: "config-templates/two/oas-config.yaml", default: true },
      },
    },
    files: {
      "config-templates/one/oas-config.yaml": PORTABLE_TEMPLATE,
      "config-templates/two/oas-config.yaml": PORTABLE_TEMPLATE,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most one config template may be marked default/);
});

test("validator rejects carrying both configTemplates and the deprecated configs spelling", (t) => {
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    manifestExtra: {
      configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } },
      configs: { default: { path: "config-templates/default/oas-config.yaml" } },
    },
    files: { "config-templates/default/oas-config.yaml": PORTABLE_TEMPLATE },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /carrying both `configTemplates` and the deprecated `configs` spelling/);
});

test("validator rejects the deprecated configs spelling in new authoring", (t) => {
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    manifestExtra: { configs: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "config-templates/default/oas-config.yaml": PORTABLE_TEMPLATE },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /newly authored packages must emit `configTemplates`/);
});

test("validator rejects a config template carrying a Linear API key", (t) => {
  const result = runFixture(t, withTemplate(
    "config-templates/default/oas-config.yaml",
    PORTABLE_TEMPLATE + "      # export LINEAR_API_KEY=lin_api_AbC123\n",
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains a Linear API key/);
});

test("validator rejects a config template carrying a machine path", (t) => {
  const result = runFixture(t, withTemplate(
    "config-templates/default/oas-config.yaml",
    PORTABLE_TEMPLATE + "      injection-override: /Users/someone/.agents/injections/linear.md\n",
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains a home-rooted machine path/);
});

test("validator rejects a config template carrying a provider-local UUID", (t) => {
  const result = runFixture(t, withTemplate(
    "config-templates/default/oas-config.yaml",
    PORTABLE_TEMPLATE + "      # project id 3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607\n",
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains a provider-local UUID/);
});

test("validator rejects a config template carrying a workspace-local linear.app URL", (t) => {
  const result = runFixture(t, withTemplate(
    "config-templates/default/oas-config.yaml",
    PORTABLE_TEMPLATE + "      # board https://linear.app/acme-inc/team/ENG\n",
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains a workspace-local linear\.app URL/);
});

test("validator rejects a config template that sets a team", (t) => {
  const result = runFixture(t, withTemplate(
    "config-templates/default/oas-config.yaml",
    PORTABLE_TEMPLATE.replace("      #   team: ENG", "      settings:\n        team: ENG"),
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sets the deployment-local key `team:`/);
});

test("validator rejects a config template that sets a credential", (t) => {
  const result = runFixture(t, withTemplate(
    "config-templates/default/oas-config.yaml",
    PORTABLE_TEMPLATE + "      api_key: something\n",
  ));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sets the deployment-local key `api_key:`/);
});

// ── Review finding: lexical containment was bypassable with a symlink ───────
test("validator rejects a config template symlinked INTO a capability root", (t) => {
  // The declared path sits under config-templates/, but resolves into the
  // capability root — so it WOULD be materialized as capability bytes, counted
  // in the artifact integrity, and covered by executable trust.
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: MATCHING_IDENTITY,
    manifestExtra: { configTemplates: { default: { path: "config-templates/default/oas-config.yaml" } } },
    files: { "capabilities/thing/template.yaml": PORTABLE_TEMPLATE },
    symlinks: { "config-templates/default/oas-config.yaml": "capabilities/thing/template.yaml" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must live outside every capability root \(resolves inside capabilities\/thing\)/);
});

// ── Review finding: the portability scan missed most absolute-path dialects ──
for (const [label, value] of [
  ["a POSIX path outside home", "/opt/acme/linear.md"],
  ["a temp path", "/tmp/linear.md"],
  ["a Windows drive path with forward slashes", "C:/acme/linear.md"],
  ["a Windows drive path with backslashes", "C:\\acme\\linear.md"],
  ["a UNC path", "\\\\fileserver\\share\\linear.md"],
  ["a home-relative path", "~/acme/linear.md"],
]) {
  test(`validator rejects a config template setting ${label}`, (t) => {
    const result = runFixture(t, withTemplate(
      "config-templates/default/oas-config.yaml",
      PORTABLE_TEMPLATE + `      injection-override: ${value}\n`,
    ));
    assert.equal(result.status, 1, `expected rejection for ${value}`);
    assert.match(result.stderr, /sets an absolute path/);
  });
}

for (const key of ["account", "workspace", "organization", "token"]) {
  test(`validator rejects a config template setting the deployment-local key ${key}`, (t) => {
    const result = runFixture(t, withTemplate(
      "config-templates/default/oas-config.yaml",
      PORTABLE_TEMPLATE + `      ${key}: acme-inc\n`,
    ));
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`sets the deployment-local key \\\`${key}:`));
  });
}

test("validator accepts relative paths and commented guidance in a template", (t) => {
  // Guard against over-rejection: a template MAY point at scope-relative paths
  // and MAY carry commented scaffolding naming the values an adopter fills in.
  const result = runFixture(t, withTemplate(
    "config-templates/default/oas-config.yaml",
    PORTABLE_TEMPLATE
      + "      injection-override: .agents/injections/oas-linear/linear.md\n"
      + "      # settings:\n      #   team: ENG\n      #   project: Agent Platform\n",
  ));
  assert.equal(result.status, 0, result.stderr);
});

// ── Wave parity audit: released 0.20 is asymmetric on agents[] vs skills[] ───
test("validator rejects an agents[] entry that is a FILE (released-0.20 parity)", (t) => {
  // The released kernel throws "capability-defined agent ... is not a
  // directory". A validator that only walked-if-directory would green-light a
  // package that `oas install` refuses.
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: { ...MATCHING_IDENTITY, agents: ["agents/reviewer.md"] },
    files: { "capabilities/thing/agents/reviewer.md": "# a soul file, not a soul directory\n" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /capability-defined agent must be a directory/);
});

test("validator accepts an agents[] entry that is a DIRECTORY (released-0.20 parity)", (t) => {
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: { ...MATCHING_IDENTITY, agents: ["agents/reviewer"] },
    files: { "capabilities/thing/agents/reviewer/AGENTS.md": "# soul\n" },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("validator accepts a skills[] entry that is a FILE (released-0.20 parity)", (t) => {
  // Deliberately NOT symmetric with agents[]: the released kernel walks a
  // skills entry only when it is a directory and accepts a file.
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: { ...MATCHING_IDENTITY, skills: ["skills/s/SKILL.md"] },
    files: { "capabilities/thing/skills/s/SKILL.md": "# skill\n" },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("validator rejects a DESCENDANT symlink escaping the capability root", (t) => {
  // The declared tree resolves inside the capability root, but a file within it
  // points at package-only bytes materialization never copies. The released
  // kernel rejects this; a check on the declared path alone would miss it.
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: { ...MATCHING_IDENTITY, skills: ["skills"] },
    files: {
      "capabilities/thing/skills/s/SKILL.md": "# skill\n",
      "shared/leaked.md": "# package-only, never materialized\n",
    },
    symlinks: { "capabilities/thing/skills/s/leaked.md": "shared/leaked.md" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skill tree contains a path escaping the capability root/);
});

test("validator rejects a broken symlink inside a declared tree", (t) => {
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    capabilityExtra: { ...MATCHING_IDENTITY, skills: ["skills"] },
    files: { "capabilities/thing/skills/s/SKILL.md": "# skill\n" },
    symlinks: { "capabilities/thing/skills/s/gone.md": "capabilities/thing/skills/s/never-written.md" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skill tree contains a broken symlink/);
});

test("validator rejects a config template that does not exist", (t) => {
  const result = runFixture(t, {
    capabilities: ["capabilities/thing"],
    manifestExtra: { configTemplates: { default: { path: "config-templates/missing/oas-config.yaml" } } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config template does not exist/);
});
