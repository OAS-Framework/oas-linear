import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ROOT, canonicalScripts, checkScripts, inventorySuites,
} from "../scripts/check-test-scripts.mjs";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const inventory = () => inventorySuites(join(ROOT, "test"));

/**
 * Unit tests for the gate in scripts/check-test-scripts.mjs — ONE
 * implementation, exercised here and enforced there before `node --test` runs.
 *
 * Enforcement lives outside the test run because a selection flag can exclude
 * the very assertion that would report it. These tests verify the gate's logic;
 * the gate is what actually blocks a bad script.
 *
 * COVERAGE, stated precisely rather than generously:
 *  - REJECTED_TEST_COMMANDS below is the accumulated table of `test`-command
 *    spellings that bypassed earlier designs. Each row must produce a problem.
 *  - Inventory-level cases (a suite dropped, a same-basename decoy, an unlisted
 *    nested suite) and script-set cases (an extra or missing script) have their
 *    own dedicated tests further down, because they vary the INVENTORY or the
 *    script map rather than the command string.
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

test("an extra script is reported rather than ignored", () => {
  const suites = inventory();
  const problems = checkScripts({
    scripts: { ...canonicalScripts(suites), smoke: `node --test ${suites[0]}` },
  }, suites);
  assert.ok(problems.some((p) => p.includes('unexpected script "smoke"')), problems.join(" | "));
});

test("a missing script is reported", () => {
  const suites = inventory();
  const { probe, ...withoutProbe } = canonicalScripts(suites);
  const problems = checkScripts({ scripts: withoutProbe }, suites);
  assert.ok(problems.some((p) => p.includes('missing script "probe"')), problems.join(" | "));
});

test("a suite dropped from `test` is reported", () => {
  // Built from the inventory, never by editing the real script's text: a string
  // replace silently becomes a no-op when the path is spelled differently, and
  // a fixture that stops mutating proves nothing.
  const suites = inventory();
  assert.ok(suites.length > 1, "this fixture needs at least two suites");
  const dropped = canonicalScripts(suites).test.replace(` ${suites[0]}`, "");
  const problems = checkScripts({ scripts: { ...canonicalScripts(suites), test: dropped } }, suites);
  assert.ok(problems.some((p) => p.includes("not the canonical command")), problems.join(" | "));
  assert.notEqual(dropped, canonicalScripts(suites).test, "the fixture must actually mutate the command");
});

test("a same-basename path outside test/ is reported", () => {
  const suites = inventory();
  const decoy = canonicalScripts(suites).test.replace(suites[0], suites[0].replace(/^test\//, "other/"));
  const problems = checkScripts({ scripts: { ...canonicalScripts(suites), test: decoy } }, suites);
  assert.ok(problems.some((p) => p.includes("not the canonical command")), problems.join(" | "));
});

test("an unlisted suite changes the canonical command, so it cannot be added silently", () => {
  const suites = inventory();
  const withNew = [...suites, "test/nested/new.test.mjs"].sort();
  // The canonical command is derived from the inventory, so adding a suite
  // without updating package.json is a mismatch by construction.
  assert.notEqual(canonicalScripts(withNew).test, canonicalScripts(suites).test);
  const problems = checkScripts({ scripts: canonicalScripts(suites) }, withNew);
  assert.ok(problems.some((p) => p.includes("test/nested/new.test.mjs")), problems.join(" | "));
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
