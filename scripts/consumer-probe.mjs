#!/usr/bin/env node
/**
 * Isolated consumer probe against a RELEASED @oas-framework/oas kernel.
 *
 * This is the acceptance gate that the repository's unit tests cannot give:
 * unit tests check what we AUTHOR, this drives what a consumer actually GETS.
 * It installs `oas-package/` into a throwaway scope with a real released CLI
 * and asserts the 0.20 capability-materialization contract end to end:
 *
 *   1  flat materialization      the artifact is the capability root alone
 *   2  lock shape                lockfileVersion 2, both maps, exact row shapes
 *   3  install adopts nothing    no config is written by installation
 *   4  ignore behavior           only installed/ is ignored
 *   5  exact restore             bare install reprojects byte-identically
 *   6  explicit adoption         oas init --package writes the adopted base
 *   7  executable trust          blocked before trust, dispatches after
 *   8  Linear command surface    `oas linear ...` resolves and fails cleanly
 *   9  spawn + task-layer        hook briefing and injection compose
 *
 * ISOLATION. The probe must not read or write the host's real deployment.
 * `HOME` alone is not enough: the operational-command dispatcher reads
 * `instance.json` via `OAS_HOME`/`PI_AGENT_HOME` and resolves the scope to
 * `meta.repo`, which reaches the host's own config and lock chain. Every
 * OAS/pi variable is therefore stripped from the child environment.
 *
 * Usage:
 *   node scripts/consumer-probe.mjs                 # npm-installs the kernel
 *   OAS_PROBE_CLI=/path/to/oas node scripts/…       # reuse an installed CLI
 *   OAS_PROBE_VERSION=0.20.0 node scripts/…         # pin the released version
 *   OAS_PROBE_KEEP=1 node scripts/…                 # keep the sandbox
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { portabilityLeaks } from "./lib/config-portability.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const payloadRoot = join(repoRoot, "oas-package");
const KERNEL_VERSION = process.env.OAS_PROBE_VERSION || "0.20.0";

const results = [];
let failures = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail });
    process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ""}\n`);
  } catch (error) {
    failures += 1;
    results.push({ ok: false, name, detail: error.message });
    process.stdout.write(`  FAIL ${name} — ${error.message}\n`);
  }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, what) => assert(
  actual === expected,
  `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const step = (title) => process.stdout.write(`\n${title}\n`);

// ── Sandbox ─────────────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "oas-linear-consumer-probe-"));
const home = join(sandbox, "home");
const scope = join(sandbox, "scope");
mkdirSync(home, { recursive: true });
mkdirSync(join(scope, "agents"), { recursive: true });

process.on("exit", () => {
  if (process.env.OAS_PROBE_KEEP) process.stdout.write(`\nsandbox kept at ${sandbox}\n`);
  else rmSync(sandbox, { recursive: true, force: true });
});

/**
 * HOST EXECUTABLE ISOLATION.
 *
 * The probe must not pass or fail because of what happens to be installed on
 * the developer's machine. Two things make that easy to get wrong:
 *
 *  - `oas spawn` resolves the RUNTIME binary before it honors `--no-launch`
 *    (`lib/core.mjs`: `const bin = which(runtime === "claude" ? claudeBin :
 *    "pi")` throws "pi binary not found on PATH" well above the `if (launch)`
 *    branch). A scaffold-only spawn therefore still needs `pi` on PATH, so a
 *    probe that inherits the host PATH silently depends on the developer
 *    having pi installed — and fails in CI, which does not.
 *  - host-requirement warnings are `command -v` lookups, so an ambient tool
 *    changes what the kernel reports.
 *
 * So PATH is built, never inherited: an explicit allowlist of tools the probe
 * genuinely needs, symlinked into a sandbox bin, plus STUBS we control. The
 * stubs are executable and fail loudly, so "resolved on PATH" and "actually
 * executed" stay distinguishable — nothing here should ever run one.
 */
const sandboxBin = join(sandbox, "bin");
const stubMarker = join(sandbox, "stub-was-executed");
mkdirSync(sandboxBin, { recursive: true });

/** Real tools the probe itself needs. Resolved once, explicitly. */
const HOST_TOOLS = ["node", "npm", "git", "sh", "env", "uname", "dirname", "basename", "cat"];
const missingTools = [];
for (const tool of HOST_TOOLS) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  const path = (found.stdout || "").trim();
  if (path) symlinkSync(path, join(sandboxBin, tool));
  else missingTools.push(tool);
}

/** A stub that is resolvable but must never actually run. */
const writeStub = (name) => {
  const path = join(sandboxBin, name);
  writeFileSync(path, `#!/bin/sh
echo "STUB ${name} WAS EXECUTED: $*" >> ${JSON.stringify(stubMarker)}
echo "probe stub ${name} must never be executed" >&2
exit 97
`);
  chmodSync(path, 0o755);
  return path;
};
const removeStub = (name) => rmSync(join(sandboxBin, name), { force: true });

/**
 * @param {object} options
 *   path  override PATH entirely (used for the runtime-absent direction)
 */
const probeEnv = (options = {}) => ({
  // Allowlist, not a filtered copy of process.env: nothing of this agent
  // instance's OAS/pi context, and no ambient tool, can reach the child.
  PATH: options.path === undefined ? sandboxBin : options.path,
  HOME: home,
  TMPDIR: join(sandbox, "tmp"),
  // Keep npm's network/store behavior inside the sandbox and reproducible.
  npm_config_cache: join(sandbox, "npm-cache"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  // Explicit, minimal passthrough so a proxied/CI network still works.
  ...Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "NPM_CONFIG_REGISTRY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "LANG", "LC_ALL"]
    .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
});
mkdirSync(join(sandbox, "tmp"), { recursive: true });

const run = (bin, args, options = {}) => spawnSync(bin, args, {
  cwd: options.cwd || scope,
  env: probeEnv(options),
  encoding: "utf8",
});

// ── Released kernel ─────────────────────────────────────────────────────────
step(`Resolving released kernel (@oas-framework/oas@${KERNEL_VERSION})`);
let cli = process.env.OAS_PROBE_CLI;
if (cli) {
  assert(existsSync(cli), `OAS_PROBE_CLI does not exist: ${cli}`);
  process.stdout.write(`  using OAS_PROBE_CLI ${cli}\n`);
} else {
  const kernelDir = join(sandbox, "kernel");
  mkdirSync(kernelDir, { recursive: true });
  writeFileSync(join(kernelDir, "package.json"), JSON.stringify({ name: "oas-probe-kernel", private: true }) + "\n");
  const install = spawnSync("npm", ["install", `@oas-framework/oas@${KERNEL_VERSION}`, "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: kernelDir, env: probeEnv(), encoding: "utf8",
  });
  if (install.status !== 0) {
    process.stderr.write(`consumer probe could not install the released kernel:\n${install.stderr || install.stdout}\n`);
    process.exit(1);
  }
  cli = join(kernelDir, "node_modules", ".bin", "oas");
  process.stdout.write(`  installed ${cli}\n`);
}
const oas = (...args) => run(cli, args);
/** Same, with env/PATH control for the isolation checks. */
const oasWith = (options, ...args) => run(cli, args, options);
const oasJson = (...args) => {
  const result = oas(...args);
  const line = (result.stdout || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
  assert(line, `no JSON envelope from \`oas ${args.join(" ")}\`:\n${result.stdout}\n${result.stderr}`);
  return { ...JSON.parse(line), _status: result.status, _stdout: result.stdout, _stderr: result.stderr };
};

const version = oas("version");
assert(version.status === 0, `\`oas version\` failed: ${version.stderr}`);
const kernelVersion = (version.stdout.match(/\b\d+\.\d+\.\d+\b/) || [])[0];
process.stdout.write(`  kernel reports ${version.stdout.trim()}\n`);
equal(kernelVersion, KERNEL_VERSION, "released kernel version under probe");

const git = (...args) => run("git", args);
git("init", "-q", ".");
git("config", "user.email", "probe@example.invalid");
git("config", "user.name", "consumer probe");

// ── 1. Install and flat materialization ─────────────────────────────────────
step("1. install → flat materialization");
const install = oasJson("install", payloadRoot, "--dir", scope, "--json");
const installedDir = join(scope, ".agents", "capabilities", "installed", "oas.linear");
// macOS hands out /var/folders/… temp dirs that the kernel canonicalizes to
// /private/var/folders/…, so a path the kernel reports back is compared against
// BOTH spellings rather than the one this process happened to build.
/** Relative paths of every file in a tree. */
const walk = (dir, prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
  entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
));

/**
 * A content snapshot of a materialized artifact: every relative path mapped to
 * its kind, mode, and either its symlink target or a hash of its bytes.
 * Comparing lock integrity strings proves only that the LOCK did not move;
 * proving the restored BYTES are the same needs an independent record.
 */
const snapshotTree = (dir) => {
  const snapshot = {};
  for (const rel of walk(dir).sort()) {
    const path = join(dir, rel);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { snapshot[rel] = `symlink:${readlinkSync(path)}`; continue; }
    const mode = (stat.mode & 0o777).toString(8);
    snapshot[rel] = `file:${mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  }
  return snapshot;
};
const describeDrift = (before, after) => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => before[k] !== after[k])
    .map((k) => `${k}: ${before[k] === undefined ? "ADDED" : after[k] === undefined ? "MISSING" : "CHANGED"}`)
    .join("; ");
};

const artifactRoots = () => [...new Set([installedDir, existsSync(installedDir) ? realpathSync(installedDir) : installedDir])];
const insideArtifact = (path) => artifactRoots().some((root) => path === root || path.startsWith(root + sep));

check("install succeeds", () => {
  assert(install.ok, `install failed: ${JSON.stringify(install.error || install)}`);
  return `oas.linear@${install.result.installed[0].version}`;
});

check("the materialized artifact is the capability root ALONE (flat)", () => {
  const materialized = walk(installedDir).sort();
  const authored = walk(join(payloadRoot, "capabilities", "oas-linear")).sort();
  // The engine adds exactly one file: the generated provenance record.
  const expected = [...authored, ".oas-installation.json"].sort();
  assert(
    JSON.stringify(materialized) === JSON.stringify(expected),
    `materialized artifact differs from the capability root:\n  got      ${materialized.join(", ")}\n  expected ${expected.join(", ")}`,
  );
  return `${materialized.length} files, oas.json at the artifact ROOT`;
});

check("no authoring nesting and no package-only bytes are materialized", () => {
  for (const absent of ["capabilities", "config-templates", "oas-package.json", "scripts", "schemas", "test"]) {
    assert(!existsSync(join(installedDir, absent)), `materialized artifact must not contain ${absent}`);
  }
  assert(existsSync(join(installedDir, "oas.json")), "oas.json must sit at the artifact root");
  return "capabilities/, config-templates/, oas-package.json, repo tooling all absent";
});

// ── 2. Lock shape ───────────────────────────────────────────────────────────
step("2. lockfileVersion 2 shape");
const lockPath = join(scope, "oas-lock.json");
const readLock = () => JSON.parse(readFileSync(lockPath, "utf8"));

check("lock records both levels with exactly the contract's fields", () => {
  const lock = readLock();
  equal(lock.lockfileVersion, 2, "lockfileVersion");
  assert(lock.packages && lock.capabilities, "both `packages` and `capabilities` maps are required");
  const pkg = lock.packages["oas.linear"];
  const cap = lock.capabilities["oas.linear"];
  assert(pkg, "packages['oas.linear'] missing");
  assert(cap, "capabilities['oas.linear'] missing");
  equal(Object.keys(pkg).sort().join(","), "commit,dependencies,integrity,path,source,version", "package row fields");
  equal(Object.keys(cap).sort().join(","), "integrity,package,path,trusted,version", "capability row fields");
  assert(!("capabilities" in pkg) && !("trustedCapabilities" in pkg) && !("depsIntegrity" in pkg),
    "package row carries the UNSUPPORTED transitional package-store fields");
  equal(cap.package, "oas.linear", "capability's provider package");
  assert(cap.package in lock.packages, "capability's provider package must be a key of `packages`");
  equal(cap.path, "capabilities/oas-linear", "locked capability root (dedicated, never '.')");
  equal(cap.version, "2.0.0", "locked capability version");
  equal(pkg.version, "2.0.0", "locked package version");
  equal(cap.trusted, false, "a fresh install must never be trusted");
  assert(/^sha256-[0-9a-f]{64}$/.test(cap.integrity), "capability artifact integrity");
  assert(/^sha256-[0-9a-f]{64}$/.test(pkg.integrity), "package payload integrity");
  assert(pkg.integrity !== cap.integrity, "payload and artifact integrity must be distinct hashes");
  return `package ${pkg.integrity.slice(0, 14)}…, artifact ${cap.integrity.slice(0, 14)}…`;
});

// ── 3. Install adopts nothing ───────────────────────────────────────────────
step("3. install applies no config template");
check("installation writes no oas-config.yaml and no adopted base", () => {
  assert(!existsSync(join(scope, "oas-config.yaml")), "`oas install` must not write a config");
  assert(!existsSync(join(scope, ".agents", "config-templates")), "`oas install` must not record an adopted base");
  return "config templates stay optional source material";
});

check("install locks the capability, adopts nothing, and points at the trust gate", () => {
  const human = oas("install", payloadRoot, "--dir", scope);
  assert(human.status === 0, `re-install failed: ${human.stderr}`);
  const output = human.stdout + human.stderr;
  assert(/oas\.linear@2\.0\.0/.test(output), "install must name the locked capability and version");
  assert(/nothing activated/.test(output), "install must state that it activated nothing");
  assert(/oas trust oas\.linear/.test(output), "install must point at the separate trust gate");
  assert(!existsSync(join(scope, "oas-config.yaml")), "re-install must still not write a config");
  // KERNEL/DOC DIVERGENCE (released 0.20.0): docs/packages.md says `oas install`
  // "materializes capabilities and reports available templates as optional
  // follow-ups", but no install path emits them — the `Config template "…"`
  // note lives only in the `oas init --package` adoption path. Recorded as
  // evidence; asserting the documented behavior would fail against the release,
  // and asserting nothing would hide the gap.
  if (!/Config template/.test(output)) {
    process.stdout.write("       KERNEL/DOC DIVERGENCE (not package-side): `oas install` does not report available config templates, though docs/packages.md says it does\n");
  }
  return "locks, activates nothing, names the trust gate";
});

// ── 4. Ignore behavior ──────────────────────────────────────────────────────
step("4. ignore behavior");
check("only installed/ is ignored; owned/ and adopted templates are committable", () => {
  const ignoreFile = join(scope, ".agents", "capabilities", ".gitignore");
  assert(existsSync(ignoreFile), ".agents/capabilities/.gitignore must exist at a Git scope");
  const rules = readFileSync(ignoreFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  equal(rules.join(","), "installed/", "ignore rules");
  const ignored = (path) => git("check-ignore", "-q", path).status === 0;
  assert(ignored(relative(scope, join(installedDir, "oas.json"))), "the materialized artifact must be ignored");
  assert(!ignored(".agents/capabilities/owned/x/oas.json"), "authored owned/ capabilities must NOT be ignored");
  assert(!ignored(".agents/config-templates/adopted/oas.linear/default/oas-config.yaml"),
    "the adopted base must NOT be ignored — it is meant to be committed");
  return "installed/ ignored; owned/ and adopted/ tracked";
});

// ── 5. Exact restore ────────────────────────────────────────────────────────
step("5. exact restore");
check("bare install reprojects the artifact byte-identically and never advances the lock", () => {
  const lockBefore = readFileSync(lockPath, "utf8");
  const integrityBefore = readLock().capabilities["oas.linear"].integrity;
  // Independent record of the actual BYTES. The lock's integrity string only
  // proves the lock did not move; a restore that dropped or corrupted every
  // file but oas.json would leave it untouched.
  const treeBefore = snapshotTree(installedDir);
  assert(Object.keys(treeBefore).length > 1, "snapshot should cover the whole artifact");

  rmSync(installedDir, { recursive: true, force: true });
  assert(!existsSync(installedDir), "artifact should be gone before restore");
  const restore = oasJson("install", "--dir", scope, "--json");
  assert(restore.ok, `bare restore failed: ${JSON.stringify(restore.error || restore)}`);

  const treeAfter = snapshotTree(installedDir);
  const drift = describeDrift(treeBefore, treeAfter);
  assert(!drift, `restored artifact differs from the original bytes — ${drift}`);
  equal(readFileSync(lockPath, "utf8"), lockBefore, "the lock must be byte-identical after a bare restore");
  equal(readLock().capabilities["oas.linear"].integrity, integrityBefore, "restored artifact integrity");
  return `${Object.keys(treeAfter).length} files byte-identical; lock unchanged`;
});

check("the restore comparison would actually catch a corrupted artifact", () => {
  // Guard against a vacuous check: mutate one file and prove the snapshot
  // comparison notices, then restore the real bytes.
  const victim = join(installedDir, "oas.json");
  const original = readFileSync(victim);
  const treeBefore = snapshotTree(installedDir);
  writeFileSync(victim, original.toString() + "\n");
  const drift = describeDrift(treeBefore, snapshotTree(installedDir));
  writeFileSync(victim, original);
  assert(/oas\.json: CHANGED/.test(drift), `snapshot comparison failed to notice a mutated file (drift: ${drift || "none"})`);
  assert(!describeDrift(treeBefore, snapshotTree(installedDir)), "restoring the original bytes should clear the drift");
  return "one-byte mutation detected";
});

// ── 6. Explicit adoption and the adopted base ───────────────────────────────
step("6. explicit adoption");
const adopt = oasJson("init", "--package", payloadRoot, "--dir", scope, "--json");
const adoptedDir = join(scope, ".agents", "config-templates", "adopted", "oas.linear", "default");

check("oas init --package adopts exactly one template and records the base", () => {
  assert(adopt.ok, `adoption failed: ${JSON.stringify(adopt.error || adopt)}`);
  equal(adopt.result.template, "default", "adopted template");
  equal(adopt.result.adopted, true, "adopted flag");
  assert(existsSync(join(scope, "oas-config.yaml")), "adoption must write the scope's oas-config.yaml");
  assert(existsSync(join(adoptedDir, "oas-config.yaml")), "adoption must record the base");
  assert(existsSync(join(adoptedDir, "adoption.json")), "adoption must record adoption.json");
  return `template "default" @ ${adopt.result.contentIntegrity.slice(0, 14)}…`;
});

check("the adopted base is the shipped template, byte for byte", () => {
  const shipped = readFileSync(join(payloadRoot, "config-templates", "default", "oas-config.yaml"), "utf8");
  equal(readFileSync(join(adoptedDir, "oas-config.yaml"), "utf8"), shipped, "recorded base");
  equal(readFileSync(join(scope, "oas-config.yaml"), "utf8"), shipped, "adopted config");
  return `${shipped.split("\n").length} lines`;
});

check("adoption metadata leaks no machine path for a local source", () => {
  const meta = JSON.parse(readFileSync(join(adoptedDir, "adoption.json"), "utf8"));
  equal(meta.source, null, "adoption.json source for a path: source");
  equal(meta.localSource, true, "adoption.json localSource");
  equal(meta.package, "oas.linear", "adoption.json package");
  equal(meta.templatePath, "config-templates/default/oas-config.yaml", "adoption.json templatePath");
  return "source: null, localSource: true";
});

check("the adopted config carries no credential and no provider-local identity", () => {
  // Same predicate the manifest validator uses (scripts/lib), so the gate the
  // package ships under and the gate a consumer actually experiences cannot
  // drift apart.
  const text = readFileSync(join(scope, "oas-config.yaml"), "utf8");
  const leaks = portabilityLeaks(text);
  assert(!leaks.length, `adopted config is not portable — it ${leaks.join("; it ")}`);
  assert(/capability:\s*oas\.linear/.test(text), "template must bind the tasks layer to oas.linear");
  // Guard against a vacuous check: the predicate must actually fire on a leak.
  const seeded = portabilityLeaks(text + "      injection-override: /opt/acme/linear.md\n");
  assert(seeded.length, "the portability predicate failed to flag a seeded absolute path");
  return "portable: no key, account, workspace URL, ID, or machine path";
});

// ── 7. Executable trust ─────────────────────────────────────────────────────
step("7. executable trust");
check("an untrusted capability's commands are BLOCKED", () => {
  equal(readLock().capabilities["oas.linear"].trusted, false, "trusted before `oas trust`");
  const blocked = oasJson("linear", "teams", "--json");
  equal(blocked.ok, false, "dispatch must fail while untrusted");
  equal(blocked.error?.code, "E_CAPABILITY_BLOCKED", "blocked error code");
  return blocked.error.code;
});

check("oas trust approves the capability at its artifact integrity", () => {
  const artifactIntegrity = readLock().capabilities["oas.linear"].integrity;
  const trust = oasJson("trust", "oas.linear", "--dir", scope, "--json");
  assert(trust.ok, `trust failed: ${JSON.stringify(trust.error || trust)}`);
  equal(trust.result.approvedIntegrity["oas.linear"], artifactIntegrity,
    "trust must bind to the MATERIALIZED artifact integrity");
  equal(readLock().capabilities["oas.linear"].trusted, true, "trusted after `oas trust`");
  const surface = trust.result.executableSurface["oas.linear"];
  equal(surface.commands.join(","), "auth,teams,states,projects,labels,issue", "approved commands");
  equal(surface.hooks.join(","), "spawn", "approved hooks");
  return `bound to ${artifactIntegrity.slice(0, 14)}…`;
});

check("trust survives an exact restore of the same bytes", () => {
  rmSync(installedDir, { recursive: true, force: true });
  const restore = oasJson("install", "--dir", scope, "--json");
  assert(restore.ok, `restore after trust failed: ${JSON.stringify(restore.error || restore)}`);
  equal(readLock().capabilities["oas.linear"].trusted, true, "trust after identical restore");
  return "same integrity → approval stands";
});

// ── 8. Linear command surface ───────────────────────────────────────────────
step("8. Linear command surface");
// Every command the SHIPPED manifest declares — read from the manifest rather
// than hardcoded, so a command added later cannot silently escape the probe.
const declaredCommands = Object.keys(
  JSON.parse(readFileSync(join(payloadRoot, "capabilities", "oas-linear", "oas.json"), "utf8")).commands,
);

check("bare-namespace usage lists every declared command", () => {
  const usage = oas("linear");
  equal(usage.status, 0, "bare namespace exit code");
  const output = usage.stderr + usage.stdout;
  for (const command of declaredCommands) {
    assert(new RegExp(`\\b${command}\\b`).test(output), `usage must list "${command}", got: ${output.trim()}`);
  }
  return declaredCommands.join(", ");
});

// Arguments each command needs to get PAST its own usage validation and reach
// the authentication gate. Usage validation deliberately runs first, so a
// command invoked bare reports the missing flag rather than the missing key.
const REQUIRED_ARGS = {
  auth: [],
  teams: [],
  states: ["--team", "ENG"],
  projects: ["--team", "ENG"],
  labels: ["--team", "ENG"],
  issue: ["list", "--team", "ENG"],
};

check("EVERY declared command fails cleanly and actionably without LINEAR_API_KEY", () => {
  for (const command of declaredCommands) {
    const args = REQUIRED_ARGS[command];
    assert(args !== undefined, `probe has no argument recipe for declared command "${command}" — add one`);
    const result = oas("linear", command, ...args);
    equal(result.status, 1, `\`oas linear ${command}\` exit code`);
    const raw = result.stdout.trim() || result.stderr.trim();
    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error(`\`oas linear ${command}\` must fail with JSON, got: ${raw}`); }
    assert(/LINEAR_API_KEY/.test(payload.error),
      `\`oas linear ${command} ${args.join(" ")}\` must reach the auth gate and name LINEAR_API_KEY, got ${payload.error}`);
    assert(payload.details, `\`oas linear ${command}\` must carry actionable details`);
    assert(!/lin_api_/.test(result.stdout + result.stderr), "no key material may appear in output");
  }
  return `${declaredCommands.length} commands: JSON error naming LINEAR_API_KEY, exit 1`;
});

check("a command missing a required flag reports the FLAG, not the missing key", () => {
  const result = oas("linear", "states");
  equal(result.status, 1, "`oas linear states` (no --team) exit code");
  const payload = JSON.parse(result.stdout.trim() || result.stderr.trim());
  assert(/--team <KEY> is required/.test(payload.error),
    `usage validation must precede authentication, got ${payload.error}`);
  return "usage validation precedes authentication";
});

// ── 9. Spawn and task-layer composition ─────────────────────────────────────
step("9. spawn and task-layer composition");
check("doctor resolves the tasks layer to oas.linear", () => {
  const doctor = oas("doctor", scope);
  equal(doctor.status, 0, "doctor exit code");
  assert(/tasks\s+oas\.linear/.test(doctor.stdout), "doctor must bind the tasks layer to oas.linear");
  assert(/Adopted config template:.*oas\.linear:default/s.test(doctor.stdout), "doctor must report the adopted template");
  // KERNEL DEFECT (released 0.20.0, confirmed by the package maintainer):
  // doctor compares materialized capabilities against readCapabilityLocks, the
  // LEGACY v1 map, so every correctly v2-materialized capability trips an
  // orphan warning. Recorded verbatim as probe evidence; no package-side
  // workaround, and it is not treated as a package failure.
  const orphan = doctor.stdout.split("\n").find((line) => /is in installed\/ but has no lock entry/.test(line));
  if (orphan) process.stdout.write(`       KNOWN KERNEL DEFECT (not package-side):${orphan.replace(/\s+WARNING:/, "")}\n`);
  return "tasks → oas.linear, adopted base reported";
});

check("the probe's execution environment is synthetic, not the developer's", () => {
  assert(!missingTools.length, `probe could not resolve required host tools: ${missingTools.join(", ")}`);
  // PATH is exactly the sandbox bin — no ambient tool can change a result.
  const seen = oas("version");
  equal(seen.status, 0, "kernel runs under the synthetic PATH");
  const entries = readdirSync(sandboxBin).sort();
  assert(!entries.includes("tmux"), "tmux must NOT be on the probe PATH — --no-launch must never need it");
  assert(!entries.includes("pi") && !entries.includes("claude"), "no runtime should be present before the runtime checks");
  assert(!existsSync(stubMarker), "no stub may have been executed yet");
  return `PATH = ${entries.length} controlled entries (${entries.join(", ")})`;
});

check("scaffold-only spawn REFUSES when the runtime is absent from PATH", () => {
  git("add", "-A");
  git("commit", "-qm", "probe scope");
  const create = oas("create", "probe-agent", "--description", "consumer probe agent");
  assert(create.status === 0, `create failed: ${create.stderr}`);
  // Released 0.20 resolves the runtime binary ABOVE the `--no-launch` branch,
  // so a scaffold-only spawn still requires it. Proving the absent direction
  // here is what keeps the present direction below from being an accident of
  // the developer's machine.
  const absent = oasJson("spawn", "probe-agent", "--task", "runtime-absent probe", "--no-launch", "--json");
  equal(absent.ok, false, "spawn must fail with no runtime on PATH");
  assert(/binary not found on PATH/.test(absent.error?.message || ""),
    `expected a runtime-resolution failure, got ${JSON.stringify(absent.error)}`);
  assert(!existsSync(stubMarker), "nothing should have been executed");
  return absent.error.message;
});

check("spawn runs the advisory hook and composes the Linear briefing", () => {
  // Present direction: a runtime the PROBE controls. The stub is resolvable but
  // fails loudly if executed, so `--no-launch` genuinely not running it is
  // observable rather than assumed.
  writeStub("pi");
  const spawn = oasJson("spawn", "probe-agent", "--task", "consumer probe", "--no-launch", "--json");
  assert(spawn.ok, `spawn failed: ${JSON.stringify(spawn.error || spawn)}`);
  const warnings = (spawn.result.warnings || []).join(" ");
  assert(/^.*oas-linear: settings\.team is unset; LINEAR_API_KEY is not in the spawn environment/.test(warnings),
    `expected the advisory hook warning, got: ${warnings}`);
  assert(spawn.result.instance, "spawn must report an instance");

  const instanceHome = spawn.result.home;
  const task = readFileSync(join(instanceHome, "TASK.md"), "utf8");
  assert(/Tasks: Linear —/.test(task), "TASK.md must carry the hook's briefing");
  // Derive the expected identity from the spawn result: the refused
  // runtime-absent attempt above already consumed an instance ordinal, so a
  // hardcoded name would be wrong (and would silently drift anyway).
  assert(task.includes(`label "agent-${spawn.result.instance}"`),
    `TASK.md must carry the agent label identity agent-${spawn.result.instance}`);
  assert(/capabilities\.layers\.tasks\.settings\.team/.test(task),
    "the briefing must name the CURRENT config path for an unset team");

  const agents = readFileSync(join(instanceHome, "AGENTS.md"), "utf8");
  assert(/<!-- oas:capability:oas\.linear src=/.test(agents), "AGENTS.md must carry the oas.linear injection block");
  assert(/## Tasks: Linear/.test(agents), "AGENTS.md must carry the Tasks: Linear instructions");
  const injectionSource = (agents.match(/<!-- oas:capability:oas\.linear src=(\S+) -->/) || [])[1];
  assert(injectionSource && insideArtifact(injectionSource),
    `the injection must be sourced from the MATERIALIZED artifact, got ${injectionSource}`);

  const meta = JSON.parse(readFileSync(join(instanceHome, "instance.json"), "utf8"));
  const entry = (meta.capabilities || []).find((c) => c.id === "oas.linear");
  assert(entry, "instance.json must record the oas.linear capability");
  equal(entry.layer, "tasks", "instance capability layer");
  equal(entry.command, "linear", "instance capability command namespace");
  equal(entry.trusted, true, "instance capability trust");
  assert(entry.hooks.includes("spawn"), "instance capability hooks");
  assert(entry.skills.length && entry.skills.every(insideArtifact),
    `skills must resolve inside the materialized artifact, got ${entry.skills.join(", ")}`);

  // --no-launch must SCAFFOLD ONLY: nothing started, and the controlled runtime
  // stub never actually ran.
  equal(spawn.result.launched, false, "--no-launch must not launch");
  assert(!existsSync(stubMarker),
    `--no-launch executed the runtime stub: ${existsSync(stubMarker) ? readFileSync(stubMarker, "utf8").trim() : ""}`);
  return `${spawn.result.instance}: launched:false, stub unexecuted, briefing, injection, skills, trust`;
});

check("the stub would actually report an execution if one happened", () => {
  // Non-vacuity guard for the two assertions above: run the stub deliberately
  // and prove the marker mechanism fires, then clear it.
  const stub = join(sandboxBin, "pi");
  const forced = spawnSync(stub, ["--probe-self-test"], { env: probeEnv(), encoding: "utf8" });
  equal(forced.status, 97, "stub must fail loudly when executed");
  assert(existsSync(stubMarker), "stub execution must leave a marker");
  rmSync(stubMarker, { force: true });
  removeStub("pi");
  return "stub fails with exit 97 and records execution";
});

// ── Report ──────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
process.stdout.write(`\nconsumer probe against @oas-framework/oas@${KERNEL_VERSION}: ${passed}/${results.length} checks passed\n`);
if (failures) {
  process.stderr.write(`consumer probe FAILED (${failures} check(s))\n`);
  process.exit(1);
}
