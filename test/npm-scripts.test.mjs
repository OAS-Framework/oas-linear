import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/**
 * Anti-regression for a wave-wide defect.
 *
 * `node --test` with no file arguments walks the working tree and executes
 * every `*.test.mjs` it finds. An OAS repository routinely contains nested
 * agent worktrees at `agents/<soul>/instances/<id>/work/`, each a full checkout
 * at whatever revision that instance is on, with its own test suite. Bare
 * discovery therefore runs OTHER instances' stale tests, so a green result is
 * not a property of the commit — it depends on which agent worktrees exist on
 * the machine. It passes in CI (clean checkout) and means something else
 * locally, which is the worst shape of the bug: CI green looks like proof.
 *
 * The fix is an explicit suite list. These tests keep it fixed in BOTH
 * directions, because an explicit list is also a list a suite can be forgotten
 * from — which fails silently by never running.
 */

/**
 * Suite paths named after `--test`.
 *
 * A target is identified by being a suite path, NOT merely by "does not start
 * with a dash": `node --test --test-reporter tap` has a non-dash token (`tap`)
 * that is a flag's VALUE, and treating it as a target would bless a command
 * that still performs bare discovery.
 */
function testTargets(segment) {
  const match = segment.match(/\bnode\b[^&|;]*--test\b(.*)$/);
  if (!match) return undefined; // not a `node --test` invocation at all
  return match[1].trim().split(/\s+/)
    .filter((token) => /\.test\.mjs$/.test(token) && !token.startsWith("-"))
    .map(normalize);
}

/** Repository-relative, POSIX-separated, no leading "./". */
const normalize = (path) => path.replace(/\\/g, "/").replace(/^\.\//, "");

/** `node --test` invocations naming no suite at all. */
function bareDiscoveryIn(command) {
  const offenders = [];
  for (const segment of command.split(/&&|\|\||;/)) {
    const targets = testTargets(segment);
    if (targets && !targets.length) offenders.push(segment.trim());
  }
  return offenders;
}

/** Every suite named by any script, as normalized repo-relative paths. */
function listedSuites(scripts) {
  const listed = new Set();
  for (const command of Object.values(scripts || {})) {
    for (const segment of command.split(/&&|\|\||;/)) {
      for (const target of testTargets(segment) || []) listed.add(target);
    }
  }
  return [...listed].sort();
}

/** RECURSIVE inventory of the repository's suites, as repo-relative paths. */
function inventorySuites(dir, root = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...inventorySuites(path, root));
    else if (entry.name.endsWith(".test.mjs")) out.push(normalize(relative(root, path)));
  }
  return out.sort();
}

test("no npm script uses bare `node --test` discovery", () => {
  const offenders = Object.entries(pkg.scripts || {})
    .flatMap(([name, command]) => bareDiscoveryIn(command).map((s) => `${name}: ${s}`));
  assert.deepEqual(offenders, [],
    "bare `node --test` recursively executes nested agent-worktree suites — name the suite files explicitly");
});

test("the scripts name exactly the repository's suites, by full path", () => {
  // Full repo-relative paths, not basenames: `other/oas-linear.test.mjs` has
  // the same basename as the real suite and would otherwise satisfy the check
  // while the real one never runs.
  assert.deepEqual(listedSuites(pkg.scripts), inventorySuites(join(ROOT, "test")),
    "every suite under test/ must be named by a script, and every named suite must be one of them");
});

// ── The guards' own guards ──────────────────────────────────────────────────
// Each fixture below is a form that previously slipped through.

test("bare-discovery detection distinguishes targets from flag values", () => {
  assert.deepEqual(bareDiscoveryIn("npm run validate && node --test"), ["node --test"]);
  // A flag VALUE is not a target — this invocation still discovers everything.
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter tap"), ["node --test --test-reporter tap"]);
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter=tap"), ["node --test --test-reporter=tap"]);
  assert.deepEqual(bareDiscoveryIn("node --test --experimental-x"), ["node --test --experimental-x"]);
  // Real targets, with and without flags around them.
  assert.deepEqual(bareDiscoveryIn("node --test test/a.test.mjs"), []);
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter tap test/a.test.mjs"), []);
  assert.deepEqual(bareDiscoveryIn("npm run validate && node --test test/a.test.mjs"), []);
  // Commands that are not `node --test` at all are not offenders.
  assert.deepEqual(bareDiscoveryIn("node scripts/consumer-probe.mjs"), []);
});

test("suite listing compares full paths, so a same-basename decoy fails", () => {
  const decoy = { test: "node --test other/oas-linear.test.mjs test/manifest-validation.test.mjs" };
  assert.notDeepEqual(listedSuites(decoy), inventorySuites(join(ROOT, "test")),
    "a path outside test/ with a suite's basename must not satisfy the list");
  assert.ok(listedSuites(decoy).includes("other/oas-linear.test.mjs"));
});

test("suite inventory is recursive, so a nested unlisted suite fails the list", () => {
  const nested = inventorySuites(join(ROOT, "test"));
  const withNested = [...nested, "test/nested/new.test.mjs"].sort();
  assert.notDeepEqual(nested, withNested);
  // And the real listing must equal the real inventory, which the test above
  // asserts — so adding test/nested/new.test.mjs without listing it fails.
  assert.ok(nested.every((p) => p.startsWith("test/")), "inventory must be repo-relative under test/");
});
