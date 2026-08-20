import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ROOT, canonicalScripts, checkScripts, childEnv, inventoryProblems, inventorySuites,
} from "../scripts/check-test-scripts.mjs";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const inventory = () => inventorySuites(join(ROOT, "test"));

/**
 * Tests for the gate/runner in scripts/check-test-scripts.mjs — ONE
 * implementation, exercised here and enforced there before the suites run.
 *
 * Enforcement lives outside the test run because a selection flag can exclude
 * the very assertion that would report it. The unit tests below verify the
 * gate's logic; the END-TO-END tests run the real script in a throwaway
 * repository, because two of its properties are only true of the process:
 * which suites actually execute, and what npm loaded before it started.
 *
 * COVERAGE, stated precisely rather than generously:
 *  - REJECTED_TEST_COMMANDS is the accumulated table of `test`-command
 *    spellings that bypassed earlier designs. Each row must produce a problem.
 *  - Inventory-level cases (empty, shell-significant paths) and script-set
 *    cases (an extra or missing script, a pretest) have dedicated tests, as
 *    they vary the INVENTORY or the script map rather than the command string.
 *  - "A suite silently dropped from the command" has no test any more because
 *    it is no longer expressible: the command names no suites, the runner
 *    passes the inventory as argv, and the end-to-end test pins that.
 */

/**
 * Every `test`-command spelling that defeated a previous design. `SUITES` is
 * replaced with the real inventory so no fixture can pass merely by naming
 * paths that do not exist.
 */
const REJECTED_TEST_COMMANDS = [
  ["bare discovery", "node --test"],
  ["a reporter flag and no suites", "node --test --test-reporter tap"],
  ["a selection option whose VALUE is a suite path", "node --test --test-name-pattern SUITES"],
  ["an unenumerable value-taking option swallowing suites", "node --test --redirect-warnings SUITES"],
  ["a BACKSLASH-ESCAPED option the shell unescapes", "node --test \\--redirect-warnings SUITES"],
  ["a quoted option the shell unquotes", 'node --test "--redirect-warnings" SUITES'],
  ["--test-only, which runs no ordinary tests", "node --test --test-only SUITES"],
  ["--test-skip-pattern", "node --test --test-skip-pattern=x SUITES"],
  ["--test-shard", "node --test --test-shard=1/2 SUITES"],
  ["a glob instead of explicit paths", "node --test test/*.test.mjs"],
  ["command substitution in the arguments", "node --test $(ls test/*.test.mjs)"],
  ["a variable expansion in the arguments", "node --test $SUITES"],
  ["quoted suite paths (rejected by design; see the gate's header)", 'node --test "test/a.test.mjs"'],
  // The bypasses that beat DETECTION: a second invocation hidden from any
  // scanner, sitting beside a perfectly valid one. The shell reassembles
  // `--test` and that first process discovers everything.
  ["parameter expansion hiding an invocation", "node --te${UNSET}st && node --test SUITES"],
  ["command substitution hiding an invocation", "node --te$(printf st) && node --test SUITES"],
  ["a line continuation hiding an invocation", "node --te\\\nst && node --test SUITES"],
  ["an extra bare invocation after a valid one", "node --test SUITES && node --test"],
  ["an extra bare invocation before a valid one", "node --test && node --test SUITES"],
  ["the gate invoked, then bare discovery anyway", "node scripts/check-test-scripts.mjs && node --test"],
  ["validation named in the command instead of performed by the gate",
   "npm run validate && node scripts/check-test-scripts.mjs"],
];

/** Suite paths that must never be spliced into a command. */
const UNSAFE_SUITE_PATHS = [
  ["shell metacharacters that drop the suite and stay green", "test/ ; true #.test.mjs"],
  ["a space, which splits into two arguments", "test/a b.test.mjs"],
  ["command substitution", "test/$(id).test.mjs"],
  ["a variable expansion", "test/$HOME.test.mjs"],
  ["a parent-directory traversal", "test/../evil.test.mjs"],
  ["a single quote", "test/a'.test.mjs"],
  ["a backslash", "test/a\\b.test.mjs"],
  ["a newline", "test/a\nb.test.mjs"],
  ["a path outside test/", "other/a.test.mjs"],
];

test("the repository's own scripts are exactly canonical", () => {
  assert.deepEqual(checkScripts(pkg, inventory()), []);
  assert.deepEqual(pkg.scripts, canonicalScripts(inventory()));
});

test("every known bypass spelling is rejected", () => {
  const suites = inventory();
  for (const [label, template] of REJECTED_TEST_COMMANDS) {
    const command = template.replaceAll("SUITES", suites.join(" "));
    const problems = checkScripts({ scripts: { ...canonicalScripts(suites), test: command } }, suites);
    assert.ok(problems.length, `MUST be rejected but was accepted — ${label}: ${JSON.stringify(command)}`);
  }
});

test("a hidden second invocation cannot ride along with a valid one", () => {
  // This is the case that defeated every detector: the gate never sees an
  // invocation to check, so anything undetected was implicitly allowed.
  // Comparing the whole command removes the question.
  const suites = inventory();
  const canonical = canonicalScripts(suites);
  const smuggled = `node --te\${UNSET}st && ${canonical.test}`;
  const problems = checkScripts({ scripts: { ...canonical, test: smuggled } }, suites);
  assert.ok(problems.some((p) => p.includes("not the canonical command")), problems.join(" | "));
});

test("an EMPTY inventory is rejected, not blessed as canonical", () => {
  // `node --test` with zero paths IS bare discovery. A command built from an
  // empty inventory would compare equal to itself and pass, so deleting the
  // last suite would have blessed the defect this gate exists to prevent.
  assert.throws(() => canonicalScripts([]), /no suites found/);
  const problems = checkScripts({ scripts: {} }, []);
  assert.ok(problems.some((p) => p.includes("no suites found")), problems.join(" | "));
  assert.ok(inventoryProblems([]).length, "an empty inventory must be a problem on its own");
});

test("a shell-significant suite path is rejected before any command is built", () => {
  for (const [label, path] of UNSAFE_SUITE_PATHS) {
    assert.ok(
      inventoryProblems([path]).length,
      `MUST be rejected but was accepted — ${label}: ${JSON.stringify(path)}`,
    );
    assert.throws(() => canonicalScripts([path]), /unsafe suite path/, label);
    const problems = checkScripts({ scripts: {} }, ["test/ok.test.mjs", path]);
    assert.ok(problems.some((p) => p.includes("unsafe suite path")), label);
  }
});

test("an ordinary nested suite path is still accepted", () => {
  // Non-vacuity for the test above: the safe grammar must admit real paths.
  assert.deepEqual(inventoryProblems(["test/nested/deeper/a-b_c.1.test.mjs"]), []);
});

test("an extra script is reported rather than ignored", () => {
  const suites = inventory();
  const problems = checkScripts({
    scripts: { ...canonicalScripts(suites), smoke: `node --test ${suites[0]}` },
  }, suites);
  assert.ok(problems.some((p) => p.includes('unexpected script "smoke"')), problems.join(" | "));
});

test("a pretest hook is reported, because it runs before the gate does", () => {
  const suites = inventory();
  for (const hook of ["pretest", "posttest", "prepare"]) {
    const problems = checkScripts({ scripts: { ...canonicalScripts(suites), [hook]: "node evil.mjs" } }, suites);
    assert.ok(problems.some((p) => p.includes(`unexpected script "${hook}"`)), hook);
  }
});

test("a missing script is reported", () => {
  const suites = inventory();
  const { probe, ...withoutProbe } = canonicalScripts(suites);
  const problems = checkScripts({ scripts: withoutProbe }, suites);
  assert.ok(problems.some((p) => p.includes('missing script "probe"')), problems.join(" | "));
});

test("an UNSPOOFED mismatch between the loaded command and package.json is reported", () => {
  // npm resolves the lifecycle command BEFORE running it, so the file the gate
  // reads and the command npm is running can disagree. This is a consistency
  // check and nothing more: the loaded command controls the environment of
  // everything it spawns, so it can override the value its child sees. The
  // forgery is exercised, and asserted to succeed, further down.
  const suites = inventory();
  const canonical = canonicalScripts(suites);
  const problems = checkScripts({ scripts: canonical }, suites, {
    npm_lifecycle_event: "test",
    npm_lifecycle_script: "node rewrite-package-json.mjs && node scripts/check-test-scripts.mjs && node --test",
  });
  assert.ok(problems.some((p) => p.includes("npm_lifecycle_script")), problems.join(" | "));

  // Non-vacuity: the matching command must pass, and an unrelated lifecycle
  // event must not be compared against the `test` command.
  assert.deepEqual(checkScripts({ scripts: canonical }, suites, {
    npm_lifecycle_event: "test", npm_lifecycle_script: canonical.test,
  }), []);
  assert.deepEqual(checkScripts({ scripts: canonical }, suites, {
    npm_lifecycle_event: "probe", npm_lifecycle_script: canonical.probe,
  }), []);
});

test("the suite inventory really is recursive", (t) => {
  // Built under a UNIQUE temp root, never in the real checkout: an earlier
  // version used a fixed directory here and recursively deleted it, which
  // silently destroyed a pre-existing file while still reporting green.
  const tempRoot = mkdtempSync(join(tmpdir(), "oas-linear-inventory-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  mkdirSync(join(tempRoot, "test", "nested", "deeper"), { recursive: true });
  writeFileSync(join(tempRoot, "test", "top.test.mjs"), "// fixture\n");
  writeFileSync(join(tempRoot, "test", "nested", "new.test.mjs"), "// fixture\n");
  writeFileSync(join(tempRoot, "test", "nested", "deeper", "deep.test.mjs"), "// fixture\n");
  writeFileSync(join(tempRoot, "test", "nested", "not-a-suite.txt"), "ignored\n");

  assert.deepEqual(inventorySuites(join(tempRoot, "test"), tempRoot), [
    "test/nested/deeper/deep.test.mjs",
    "test/nested/new.test.mjs",
    "test/top.test.mjs",
  ], "inventory must walk every level and ignore non-suite files");
});

// ---------------------------------------------------------------------------
// End-to-end: the real script, in a throwaway repository.
// ---------------------------------------------------------------------------

/**
 * A minimal repository containing the REAL gate, two suites under test/, and a
 * decoy suite in a nested agent worktree — the exact layout bare discovery
 * mis-executes. Each suite records that it ran by creating a marker file, at
 * import time, so the record survives any reporter or test outcome.
 */
function fixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "oas-linear-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const markers = join(root, "markers");
  mkdirSync(markers);

  const suite = (relative, name) => {
    mkdirSync(join(root, relative, ".."), { recursive: true });
    mkdirSync(join(root, relative.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(root, relative), [
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      `writeFileSync(${JSON.stringify(join(markers, name))}, "");`,
      `test(${JSON.stringify(name)}, () => {});`,
      "",
    ].join("\n"));
  };

  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(ROOT, "scripts", "check-test-scripts.mjs"), join(root, "scripts", "check-test-scripts.mjs"));
  writeFileSync(join(root, "scripts", "validate-manifests.mjs"), [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(markers, "validate"))}, "");`,
    "",
  ].join("\n"));
  suite("test/alpha.test.mjs", "alpha");
  suite("test/nested/beta.test.mjs", "beta");
  suite("agents/soul/instances/i1/work/test/stale.test.mjs", "decoy");

  const suites = inventorySuites(join(root, "test"), root);
  assert.deepEqual(suites, ["test/alpha.test.mjs", "test/nested/beta.test.mjs"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture", private: true, type: "module", scripts: canonicalScripts(suites),
  }, null, 2));

  return {
    root,
    ran: () => readdirSync(markers).sort(),
    runGate: (env = {}) => spawnSync(process.execPath, ["scripts/check-test-scripts.mjs"], {
      cwd: root, encoding: "utf8", env: { ...process.env, ...env },
    }),
  };
}

test("end-to-end: the gate runs exactly the inventoried suites", (t) => {
  const repo = fixtureRepo(t);
  const run = repo.runGate();
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(repo.ran(), ["alpha", "beta", "validate"],
    "validation, every suite under test/, and nothing else");
});

test("end-to-end: bare discovery WOULD have run the nested agent worktree", (t) => {
  // Non-vacuity for the test above. Without this, "the decoy did not run" could
  // be true merely because the decoy was undiscoverable.
  const repo = fixtureRepo(t);
  // NODE_TEST_CONTEXT must be stripped by hand here: this spawn deliberately
  // bypasses the gate, which is what does the stripping for real runs.
  const run = spawnSync(process.execPath, ["--test"], {
    cwd: repo.root, encoding: "utf8", env: childEnv(process.env),
  });
  assert.ok(repo.ran().includes("decoy"), `bare discovery must reach the decoy: ${run.stdout}`);
});

test("end-to-end: an unforged mismatch is reported before anything runs", (t) => {
  // Same consistency check, end to end. It catches divergence that nobody is
  // hiding; it does NOT survive a command that forges the variable, which the
  // real-npm test below demonstrates rather than papers over.
  const repo = fixtureRepo(t);
  const run = repo.runGate({
    npm_lifecycle_event: "test",
    npm_lifecycle_script: "node rewrite.mjs && node scripts/check-test-scripts.mjs && node --test",
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /npm_lifecycle_script/);
  assert.deepEqual(repo.ran(), [], "the gate must refuse before running anything");
});

test("end-to-end: a suite whose NAME is shell syntax fails the gate", (t) => {
  // Spliced into a shell command, `; true #` would drop the suite and leave the
  // run green. The gate must refuse to build a command from it at all.
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "test", " ; true #.test.mjs"), "// unsafe fixture\n");
  const run = repo.runGate();
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /unsafe suite path/);
  assert.deepEqual(repo.ran(), [], "nothing may run while the inventory is unsafe");
});

test("end-to-end: an empty test/ fails the gate instead of discovering", (t) => {
  const repo = fixtureRepo(t);
  rmSync(join(repo.root, "test"), { recursive: true, force: true });
  mkdirSync(join(repo.root, "test"));
  const run = repo.runGate();
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /no suites found/);
  assert.deepEqual(repo.ran(), [], "an empty inventory must never fall through to discovery");
});

test("end-to-end: a nonzero suite exit becomes the gate's exit code", (t) => {
  // The runner replaces `node --test` in the command; if it swallowed failures,
  // every one of these gates would be reporting green over a red suite.
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "test", "alpha.test.mjs"), [
    'import test from "node:test";',
    'test("failing", () => { throw new Error("boom"); });',
    "",
  ].join("\n"));
  const run = repo.runGate();
  assert.notEqual(run.status, 0, "a failing suite must fail the gate");
});

test("end-to-end: a failing validator stops the run before any suite", (t) => {
  const repo = fixtureRepo(t);
  writeFileSync(join(repo.root, "scripts", "validate-manifests.mjs"), 'process.exit(3);\n');
  const run = repo.runGate();
  assert.equal(run.status, 3, "the validator's exit status must propagate");
  assert.deepEqual(repo.ran(), [], "no suite may run after validation fails");
});

test("end-to-end: a spoofed lifecycle variable cannot skip validation", (t) => {
  // The reviewer-19d676d bypass, run through REAL npm. A noncanonical `test`
  // rewrites package.json to canonical and invokes the gate with a forged
  // npm_lifecycle_script, so both the file and the variable look canonical.
  //
  // That forgery still succeeds — the variable is a consistency check, not
  // attestation, and the gate says so. What it can no longer buy is the prize:
  // validation used to live in the command string as `npm run validate && …`,
  // and re-spelling the command skipped it. The gate performs it now.
  const repo = fixtureRepo(t);
  const canonical = canonicalScripts(["test/alpha.test.mjs", "test/nested/beta.test.mjs"]);
  writeFileSync(join(repo.root, "rewrite.mjs"), [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const p = new URL("./package.json", import.meta.url);',
    'const pkg = JSON.parse(readFileSync(p, "utf8"));',
    `pkg.scripts.test = ${JSON.stringify(canonical.test)};`,
    "writeFileSync(p, JSON.stringify(pkg, null, 2));",
    "",
  ].join("\n"));
  writeFileSync(join(repo.root, "package.json"), JSON.stringify({
    name: "fixture", private: true, type: "module",
    scripts: {
      ...canonical,
      test: `node rewrite.mjs && npm_lifecycle_script=${JSON.stringify(canonical.test)} `
        + "node scripts/check-test-scripts.mjs",
    },
  }, null, 2));

  const run = spawnSync("npm", ["test"], {
    cwd: repo.root, encoding: "utf8", env: childEnv(process.env),
  });

  assert.equal(run.status, 0, `the forgery is expected to pass the gate: ${run.stdout}${run.stderr}`);
  assert.ok(repo.ran().includes("validate"),
    "validation must run even when the lifecycle variable is forged — it is performed, not named");
  assert.ok(repo.ran().includes("alpha") && repo.ran().includes("beta"), "and the suites still run");
});

test("end-to-end: an inherited NODE_OPTIONS preload cannot skip validation", (t) => {
  // Performing a step is not enough if the caller controls what the step DOES.
  // NODE_OPTIONS carries --require, so a preload that exits when argv[1] is the
  // validator made the gate announce validation, run the suites and exit 0
  // having validated nothing. The gate builds its children's environment now.
  const repo = fixtureRepo(t);
  const canonical = canonicalScripts(["test/alpha.test.mjs", "test/nested/beta.test.mjs"]);
  writeFileSync(join(repo.root, "skip.cjs"),
    'if (process.argv[1] && process.argv[1].endsWith("validate-manifests.mjs")) process.exit(0);\n');
  // The full exploit: rewrite package.json to canonical, forge the lifecycle
  // variable, AND preload the skip — so every check the gate can make on its
  // own inputs passes, and only the child environment stands between the
  // announcement "running validation" and validating nothing.
  writeFileSync(join(repo.root, "rewrite.mjs"), [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const p = new URL("./package.json", import.meta.url);',
    'const pkg = JSON.parse(readFileSync(p, "utf8"));',
    `pkg.scripts.test = ${JSON.stringify(canonical.test)};`,
    "writeFileSync(p, JSON.stringify(pkg, null, 2));",
    "",
  ].join("\n"));
  writeFileSync(join(repo.root, "package.json"), JSON.stringify({
    name: "fixture", private: true, type: "module",
    scripts: {
      ...canonical,
      test: `node rewrite.mjs && npm_lifecycle_script=${JSON.stringify(canonical.test)} `
        + `NODE_OPTIONS=--require=./skip.cjs ${canonical.test}`,
    },
  }, null, 2));

  const env = childEnv(process.env);
  const run = spawnSync("npm", ["test"], { cwd: repo.root, encoding: "utf8", env });
  assert.ok(repo.ran().includes("validate"),
    `validation must run despite the preload: ${run.stdout}${run.stderr}`);
});

test("childEnv removes every way to change what a child executes", () => {
  const env = childEnv({
    NODE_OPTIONS: "--require=./skip.cjs",
    NODE_REPL_EXTERNAL_MODULE: "./skip.cjs",
    NODE_TEST_CONTEXT: "child-v8",
    PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "test",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "test" },
    "injection vectors stripped, ordinary environment preserved");
});

test("childEnv matches denied names case-insensitively", () => {
  // Windows resolves environment names case-insensitively, but the object
  // spread of process.env does not: a lowercase `node_test_context` would
  // survive an uppercase delete and still reach the child as NODE_TEST_CONTEXT,
  // whose effect is a `node --test` that exits 0 over FAILING suites.
  for (const name of [
    "node_test_context", "Node_Test_Context", "NODE_test_CONTEXT",
    "node_options", "Node_Options", "node_repl_external_module",
  ]) {
    assert.deepEqual(childEnv({ [name]: "x", KEEP: "y" }), { KEEP: "y" },
      `${name} must be stripped regardless of case`);
  }
  // Non-vacuity: names that merely resemble the denied ones are preserved.
  assert.deepEqual(
    childEnv({ NODE_ENV: "test", NODE_OPTIONS_EXTRA: "x", MY_NODE_OPTIONS: "y" }),
    { NODE_ENV: "test", NODE_OPTIONS_EXTRA: "x", MY_NODE_OPTIONS: "y" },
    "only exact names, case-insensitively, are denied");
});
