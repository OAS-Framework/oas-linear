import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = Object.entries(pkg.scripts || {});

/**
 * Anti-regression for a wave-wide defect.
 *
 * `node --test` with no file arguments walks the working tree and executes
 * every `*.test.mjs` it finds. An OAS repository routinely contains nested
 * agent worktrees at `agents/<soul>/instances/<id>/work/`, each a full checkout
 * with its own test suite at whatever revision that instance happens to be on.
 * Bare discovery therefore runs OTHER instances' stale suites, and a green
 * result silently depends on which agent worktrees exist on the machine — it
 * passes in CI (clean checkout) and means something different locally.
 *
 * The fix is to name the suites explicitly. These tests keep it fixed, in both
 * directions: no script may reintroduce bare discovery, and no suite may be
 * quietly dropped from the list and stop running at all.
 */

/** `node --test` occurrences that are not followed by at least one path. */
function bareDiscoveryIn(command) {
  const offenders = [];
  // Each segment of a shell chain is considered on its own, so
  // `npm run validate && node --test` is caught in the second segment.
  for (const segment of command.split(/&&|\|\||;/)) {
    const match = segment.match(/\bnode\b([^&|;]*)--test\b(.*)$/);
    if (!match) continue;
    const after = match[2].trim();
    // Everything after --test that is not a flag counts as an explicit target.
    const targets = after.split(/\s+/).filter((token) => token && !token.startsWith("-"));
    if (!targets.length) offenders.push(segment.trim());
  }
  return offenders;
}

test("no npm script uses bare `node --test` discovery", () => {
  const offenders = scripts.flatMap(([name, command]) =>
    bareDiscoveryIn(command).map((segment) => `${name}: ${segment}`));
  assert.deepEqual(offenders, [],
    "bare `node --test` recursively executes nested agent-worktree suites — name the test files explicitly");
});

test("the test script names every suite in test/, and only suites that exist", () => {
  const command = pkg.scripts?.test || "";
  const named = command.split(/\s+/).filter((token) => token.endsWith(".test.mjs"));
  const present = readdirSync(join(ROOT, "test")).filter((file) => file.endsWith(".test.mjs")).sort();

  const namedBasenames = named.map((path) => path.replace(/^.*\//, "")).sort();
  assert.deepEqual(namedBasenames, present,
    "every suite in test/ must be named by the test script (a suite missing from it never runs)");
  for (const path of named) {
    assert.ok(present.includes(path.replace(/^.*\//, "")), `test script names a missing suite: ${path}`);
  }
});

test("the bare-discovery detector actually fires", () => {
  // Non-vacuity guard: prove the matcher catches the shape it exists to catch.
  assert.deepEqual(bareDiscoveryIn("npm run validate && node --test"), ["node --test"]);
  assert.deepEqual(bareDiscoveryIn("node --test --experimental-x"), ["node --test --experimental-x"]);
  assert.deepEqual(bareDiscoveryIn("node --test test/a.test.mjs"), []);
  assert.deepEqual(bareDiscoveryIn("node --test --reporter=tap test/a.test.mjs"), []);
});
