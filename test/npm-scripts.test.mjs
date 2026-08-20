import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ROOT, checkScripts, inventorySuites, looksLikeNodeTest,
  selectionOptionsIn, strictTargets,
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
 * Every REJECT fixture below is a spelling that once slipped through, and every
 * ACCEPT fixture a form that must not be over-rejected. They are kept so a
 * future rewrite has to keep handling all of them.
 */

const REJECTED = [
  ["bare discovery", "node --test"],
  ["a reporter flag and no suites", "node --test --test-reporter tap"],
  ["a suite-shaped selection value", "node --test --test-name-pattern SUITES"],
  ["a value-taking option swallowing suites", "node --test --redirect-warnings SUITES"],
  ["a BACKSLASH-ESCAPED option the shell would unescape", "node --test \\--redirect-warnings SUITES"],
  ["a quoted option the shell would unquote", 'node --test "--redirect-warnings" SUITES'],
  ["--test-only, which runs no ordinary tests", "node --test --test-only SUITES"],
  ["--test-skip-pattern", "node --test --test-skip-pattern=x SUITES"],
  ["--test-shard", "node --test --test-shard=1/2 SUITES"],
  ["a glob instead of explicit paths", "node --test test/*.test.mjs"],
  ["command substitution", "node --test $(ls test/*.test.mjs)"],
  ["a variable expansion", "node --test $SUITES"],
  ["quoted suite paths", 'node --test "test/a.test.mjs"'],
];

test("the repository's own scripts pass the gate", () => {
  assert.deepEqual(checkScripts(pkg, inventory()), []);
  assert.ok(strictTargets(`node --test ${inventory().join(" ")}`), "the real invocation must match the strict grammar");
});

test("every known bypass spelling is rejected", () => {
  const suites = inventory();
  for (const [label, template] of REJECTED) {
    const command = template.replace("SUITES", suites.join(" "));
    const problems = checkScripts({ scripts: { test: command } }, suites);
    assert.ok(problems.length, `MUST be rejected but was accepted — ${label}: ${command}`);
  }
});

test("the escaped-option bypass specifically", () => {
  // The shell removes the backslash and node receives `--redirect-warnings`,
  // consuming each following suite path and discovering everything, while a
  // tokenizer of the script TEXT sees an inert word. Detection de-escapes;
  // acceptance is the strict grammar, so neither spelling can pass.
  const suites = inventory();
  const escaped = `node --test ${suites.map((p) => `\\--redirect-warnings ${p}`).join(" ")}`;
  assert.ok(looksLikeNodeTest(escaped), "an escaped option must not hide that this runs node --test");
  assert.equal(strictTargets(escaped), undefined, "it must not satisfy the strict grammar");
  assert.ok(checkScripts({ scripts: { test: escaped } }, suites).length);
});

test("selection options are named specifically, not just rejected", () => {
  const suites = inventory();
  for (const option of ["--test-name-pattern x", "--test-skip-pattern=x", "--test-shard=1/2", "--test-only"]) {
    const command = `node --test ${option} ${suites.join(" ")}`;
    assert.ok(selectionOptionsIn(command).length, `${option} must be recognized as a selection option`);
    const problems = checkScripts({ scripts: { test: command } }, suites);
    assert.ok(problems.some((p) => p.includes("the tests that ran passed")),
      `${option} should get the selection-specific message; got: ${problems.join(" | ")}`);
  }
});

test("only the `test` script may run the runner", () => {
  const suites = inventory();
  const problems = checkScripts({
    scripts: { test: `node --test ${suites.join(" ")}`, smoke: `node --test ${suites[0]}` },
  }, suites);
  assert.ok(problems.some((p) => p.includes('"smoke"') && p.includes("only \"test\" may")), problems.join(" | "));
});

test("a suite dropped from `test` is reported as never running", () => {
  // Built from the inventory, never by editing the real script's text: a string
  // replace silently becomes a no-op when the path is spelled differently, and
  // a fixture that stops mutating proves nothing.
  const suites = inventory();
  assert.ok(suites.length > 1, "this fixture needs at least two suites");
  const [dropped, ...remaining] = suites;
  const problems = checkScripts({ scripts: { test: `node --test ${remaining.join(" ")}` } }, suites);
  assert.ok(problems.some((p) => p.includes(dropped) && p.includes("never run")), problems.join(" | "));
});

test("a same-basename path outside test/ does not satisfy the list", () => {
  const suites = inventory();
  const decoy = suites[0].replace(/^test\//, "other/");
  const problems = checkScripts({
    scripts: { test: `node --test ${decoy} ${suites.slice(1).join(" ")}` },
  }, suites);
  assert.ok(problems.some((p) => p.includes("not under test/")), problems.join(" | "));
  assert.ok(problems.some((p) => p.includes("never run")), problems.join(" | "));
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

  const found = inventorySuites(join(tempRoot, "test"), tempRoot);
  assert.deepEqual(found, [
    "test/nested/deeper/deep.test.mjs",
    "test/nested/new.test.mjs",
    "test/top.test.mjs",
  ], "inventory must walk every level and ignore non-suite files");

  // Nested paths are accepted by the grammar, and an unlisted one is reported.
  assert.ok(strictTargets(`node --test ${found.join(" ")}`), "nested suite paths must be a valid invocation");
  const problems = checkScripts({ scripts: { test: "node --test test/top.test.mjs" } }, found);
  assert.ok(problems.some((p) => p.includes("test/nested/new.test.mjs")), problems.join(" | "));
});
