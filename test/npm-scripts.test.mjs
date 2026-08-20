import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ROOT, bareDiscoveryIn, checkScripts, filteringFlagsIn,
  inventorySuites, parseNodeInvocation, suitesNamedBy, unrecognizedOptionsIn,
} from "../scripts/check-test-scripts.mjs";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const inventory = () => inventorySuites(join(ROOT, "test"));

/**
 * Unit tests for the gate in scripts/check-test-scripts.mjs — ONE
 * implementation, exercised here and enforced there before `node --test` runs.
 *
 * Why the enforcement lives outside the test run: a filtering flag
 * (`--test-name-pattern`) can exclude the very assertion that would report it,
 * so an in-suite check cannot catch its own filtering. These tests therefore
 * verify the gate's logic; the gate itself is what actually blocks a bad script.
 *
 * Every fixture below is a form that previously slipped through or was wrongly
 * rejected, kept so a future rewrite has to keep handling it.
 */

test("the repository's own scripts pass the gate", () => {
  assert.deepEqual(checkScripts(pkg, inventory()), []);
});

test("bare discovery is reported", () => {
  assert.deepEqual(bareDiscoveryIn("npm run validate && node --test"), ["node --test"]);
  assert.deepEqual(bareDiscoveryIn("node --test --experimental-x"), ["node --test --experimental-x"]);
  assert.deepEqual(bareDiscoveryIn("node --test test/a.test.mjs"), []);
  assert.deepEqual(bareDiscoveryIn("npm run validate && node --test test/a.test.mjs"), []);
  assert.deepEqual(bareDiscoveryIn("node scripts/consumer-probe.mjs"), []);
});

test("a suite-shaped flag value cannot satisfy the list", () => {
  // Historically this was handled by tracking which options consume a value, so
  // `--test-name-pattern test/a.test.mjs` would not count the path as a target.
  // The gate is now fail-closed instead: the option is rejected outright, which
  // is strictly stronger — it does not depend on knowing that this particular
  // option takes a value.
  const suites = inventory();
  const asFlagValue = `node --test --test-name-pattern ${suites.join(" ")}`;
  const problems = checkScripts({ scripts: { test: asFlagValue } }, suites);
  assert.ok(problems.length, "a suite-shaped flag value must never yield a clean gate");
  assert.ok(problems.some((p) => p.includes("--test-name-pattern")), problems.join(" | "));

  // A bare invocation with no positionals at all is still reported as bare.
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter tap"), ["node --test --test-reporter tap"]);
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter=tap"), ["node --test --test-reporter=tap"]);
  // `--` ends option parsing, so the paths after it are unambiguously targets.
  assert.deepEqual(suitesNamedBy(`node --test -- ${suites.join(" ")}`), suites);
});

test("`--test-reporter` alone is not a `node --test` invocation", () => {
  assert.equal(parseNodeInvocation("node --test-reporter tap"), undefined);
  assert.deepEqual(bareDiscoveryIn("node --test-reporter tap"), []);
  assert.equal(parseNodeInvocation("npm run validate"), undefined);
});

test("quoted targets are accepted, in both quote styles", () => {
  assert.deepEqual(bareDiscoveryIn('node --test "test/a.test.mjs"'), []);
  assert.deepEqual(bareDiscoveryIn("node --test 'test/a.test.mjs'"), []);
  assert.deepEqual(suitesNamedBy('node --test "test/a.test.mjs"'), ["test/a.test.mjs"]);
  assert.deepEqual(suitesNamedBy("node --test './test/a.test.mjs'"), ["test/a.test.mjs"]);
});

test("test-filtering options are reported, including --test-only", () => {
  assert.deepEqual(filteringFlagsIn("node --test --test-name-pattern x test/a.test.mjs"), ["--test-name-pattern"]);
  assert.deepEqual(filteringFlagsIn("node --test --test-skip-pattern=y test/a.test.mjs"), ["--test-skip-pattern"]);
  assert.deepEqual(filteringFlagsIn("node --test --test-shard=1/2 test/a.test.mjs"), ["--test-shard"]);
  // `--test-only` is the easy one to miss: node exits 0 having run no ordinary
  // tests at all, so every suite "passes" without executing.
  assert.deepEqual(filteringFlagsIn("node --test --test-only test/a.test.mjs"), ["--test-only"]);
  assert.deepEqual(filteringFlagsIn("node --test test/a.test.mjs"), []);
  assert.deepEqual(filteringFlagsIn("npm run validate"), []);
});

test("the gate is FAIL-CLOSED on options it does not recognize", () => {
  // Enumerating Node's value-taking options is unwinnable: one omission turns
  // suite paths into option values while the invocation still discovers
  // everything. `--redirect-warnings <suite-path>` was the proof.
  const suites = inventory();
  const swallowed = `node --test ${suites.map((p) => `--redirect-warnings ${p}`).join(" ")}`;
  assert.deepEqual(unrecognizedOptionsIn(swallowed), suites.map(() => "--redirect-warnings"));
  const problems = checkScripts({ scripts: { test: swallowed } }, suites);
  assert.ok(problems.some((p) => p.includes("--redirect-warnings") && p.includes("does not recognize")),
    problems.join(" | "));
  // A filtering option gets the specific message rather than the generic one.
  const only = checkScripts({ scripts: { test: `node --test --test-only ${suites.join(" ")}` } }, suites);
  assert.ok(only.some((p) => p.includes("--test-only") && p.includes("the tests that ran passed")), only.join(" | "));
  // And the repository's own invocation uses nothing that needs allowlisting.
  assert.deepEqual(unrecognizedOptionsIn(pkg.scripts.test), []);
});

test("a suite dropped from `test` fails even if another script names it", () => {
  // Built from the inventory, never by editing the real script's text: a string
  // replace silently becomes a no-op when the path is spelled differently
  // (quoted, "./"-prefixed), and a fixture that stops mutating proves nothing.
  const suites = inventory();
  assert.ok(suites.length > 1, "this fixture needs at least two suites");
  const [dropped, ...remaining] = suites;
  const problems = checkScripts({
    scripts: { test: `node --test ${remaining.join(" ")}`, smoke: `node --test ${dropped}` },
  }, suites);
  assert.ok(problems.some((p) => p.includes(dropped) && p.includes("never run")),
    `expected a missing-suite problem for ${dropped}, got: ${problems.join(" | ")}`);
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

  assert.deepEqual(inventorySuites(join(tempRoot, "test"), tempRoot), [
    "test/nested/deeper/deep.test.mjs",
    "test/nested/new.test.mjs",
    "test/top.test.mjs",
  ], "inventory must walk every level and ignore non-suite files");

  // An unlisted nested suite must be reported as never running.
  const problems = checkScripts({ scripts: { test: "node --test test/top.test.mjs" } },
    inventorySuites(join(tempRoot, "test"), tempRoot));
  assert.ok(problems.some((p) => p.includes("test/nested/new.test.mjs")), problems.join(" | "));
});
