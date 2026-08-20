import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
 * The fix is an explicit suite list in `npm test`. These tests keep it fixed in
 * BOTH directions, because an explicit list is also a list a suite can be
 * dropped from — which fails silently by never running.
 */

/** Split a command into shell words WITHOUT evaluating it, keeping quoted
 *  arguments whole and stripping their balanced quotes. */
function shellWords(command) {
  const words = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = pattern.exec(command); m; m = pattern.exec(command)) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

/** Repository-relative, POSIX-separated, no leading "./" or surrounding quotes. */
const normalize = (path) => String(path)
  .replace(/^(['"])([\s\S]*)\1$/, "$2")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "");

/**
 * Suite paths named by one `node --test` invocation, or undefined when the
 * segment is not such an invocation.
 *
 * `--test(?![-\w])` so `--test-reporter` is not mistaken for `--test`.
 *
 * A target is identified by SUITE-PATH SHAPE, not by "does not start with a
 * dash": in `node --test --test-reporter tap`, the token `tap` is a flag's
 * VALUE, and counting it as a target would bless a command that still performs
 * bare discovery.
 */
function testTargets(segment) {
  const words = shellWords(segment);
  const node = words.findIndex((w) => /(^|\/)node$/.test(w));
  if (node < 0) return undefined;
  const rest = words.slice(node + 1);
  if (!rest.some((w) => /^--test(?![-\w])$/.test(w))) return undefined;
  return rest.filter((w) => !w.startsWith("-") && /\.test\.mjs$/.test(w)).map(normalize);
}

/** `node --test` invocations naming no suite at all. */
function bareDiscoveryIn(command) {
  const offenders = [];
  for (const segment of command.split(/&&|\|\||;/)) {
    const targets = testTargets(segment);
    if (targets && !targets.length) offenders.push(segment.trim());
  }
  return offenders;
}

/** Suites named by ONE command, as normalized repo-relative paths. */
function suitesNamedBy(command) {
  const named = new Set();
  for (const segment of String(command || "").split(/&&|\|\||;/)) {
    for (const target of testTargets(segment) || []) named.add(target);
  }
  return [...named].sort();
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

// ── The properties ──────────────────────────────────────────────────────────

test("no npm script uses bare `node --test` discovery", () => {
  // Scanned across ALL scripts: any of them could reintroduce discovery.
  const offenders = Object.entries(pkg.scripts || {})
    .flatMap(([name, command]) => bareDiscoveryIn(command).map((s) => `${name}: ${s}`));
  assert.deepEqual(offenders, [],
    "bare `node --test` recursively executes nested agent-worktree suites — name the suite files explicitly");
});

test("`npm test` itself names exactly the repository's suites, by full path", () => {
  // Deliberately NOT a union over all scripts: a suite moved out of `test` into
  // an unrelated script (`smoke`, say) would keep a union green while `npm test`
  // silently stopped running it — the exact omission this guard exists to catch.
  assert.ok(pkg.scripts?.test, "package.json must define a test script");
  assert.deepEqual(suitesNamedBy(pkg.scripts.test), inventorySuites(join(ROOT, "test")),
    "`npm test` must name every suite under test/, and only suites that exist there");
});

// ── The guards' own guards ──────────────────────────────────────────────────
// Every fixture below is a form that previously slipped through or was wrongly
// rejected. They are kept so a future rewrite has to keep handling them.

test("bare-discovery detection distinguishes targets from flag values", () => {
  assert.deepEqual(bareDiscoveryIn("npm run validate && node --test"), ["node --test"]);
  // A flag VALUE is not a target — these still discover everything.
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter tap"), ["node --test --test-reporter tap"]);
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter=tap"), ["node --test --test-reporter=tap"]);
  assert.deepEqual(bareDiscoveryIn("node --test --experimental-x"), ["node --test --experimental-x"]);
  // Real targets, with and without flags around them.
  assert.deepEqual(bareDiscoveryIn("node --test test/a.test.mjs"), []);
  assert.deepEqual(bareDiscoveryIn("node --test --test-reporter tap test/a.test.mjs"), []);
  assert.deepEqual(bareDiscoveryIn("npm run validate && node --test test/a.test.mjs"), []);
});

test("quoted targets are accepted, in both quote styles", () => {
  // Over-rejection guard: quoting a path is a legitimate way to write it.
  assert.deepEqual(bareDiscoveryIn('node --test "test/a.test.mjs"'), []);
  assert.deepEqual(bareDiscoveryIn("node --test 'test/a.test.mjs'"), []);
  assert.deepEqual(suitesNamedBy('node --test "test/a.test.mjs"'), ["test/a.test.mjs"]);
  assert.deepEqual(suitesNamedBy("node --test './test/a.test.mjs'"), ["test/a.test.mjs"]);
});

test("`--test-reporter` alone is not a `node --test` invocation", () => {
  // `--test\b` would match the `--test` inside `--test-reporter`.
  assert.equal(testTargets("node --test-reporter tap"), undefined);
  assert.deepEqual(bareDiscoveryIn("node --test-reporter tap"), []);
  // And a command that is not node at all is never an offender.
  assert.deepEqual(bareDiscoveryIn("node scripts/consumer-probe.mjs"), []);
  assert.equal(testTargets("npm run validate"), undefined);
});

test("suite listing compares full paths, so a same-basename decoy fails", () => {
  const decoy = "node --test other/oas-linear.test.mjs test/manifest-validation.test.mjs";
  assert.notDeepEqual(suitesNamedBy(decoy), inventorySuites(join(ROOT, "test")));
  assert.ok(suitesNamedBy(decoy).includes("other/oas-linear.test.mjs"));
});

test("a suite moved to an unrelated script no longer satisfies `npm test`", () => {
  // Build the mutation from the INVENTORY rather than by editing the real
  // script's text: a string replace silently becomes a no-op the moment the
  // script spells that path differently (quoted, "./"-prefixed), and a fixture
  // that quietly stops mutating anything proves nothing.
  const inventory = inventorySuites(join(ROOT, "test"));
  assert.ok(inventory.length > 1, "this fixture needs at least two suites");
  const [dropped, ...remaining] = inventory;
  const moved = `node --test ${remaining.join(" ")}`;
  const elsewhere = `node --test ${dropped}`;

  assert.notDeepEqual(suitesNamedBy(moved), inventory,
    "dropping a suite from `npm test` must fail even if another script still names it");
  // The union across all scripts WOULD look complete — which is exactly why the
  // listing check reads `pkg.scripts.test` alone.
  assert.deepEqual([...suitesNamedBy(moved), ...suitesNamedBy(elsewhere)].sort(), inventory);
});

test("the suite inventory really is recursive", (t) => {
  // Build an actual nested fixture rather than comparing hand-written arrays:
  // an array comparison stays unequal even if inventorySuites() regresses to a
  // one-level scan, so it would prove nothing.
  const nestedDir = join(ROOT, "test", "__inventory_fixture__");
  const nestedFile = join(nestedDir, "new.test.mjs");
  t.after(() => rmSync(nestedDir, { recursive: true, force: true }));
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(nestedFile, "// inventory fixture; never executed by npm test\n");

  const found = inventorySuites(join(ROOT, "test"));
  assert.ok(found.includes("test/__inventory_fixture__/new.test.mjs"),
    `recursive inventory missed the nested fixture; found: ${found.join(", ")}`);
  // And because `npm test` does not name it, the listing check would now fail —
  // which is the behavior that makes an unlisted nested suite impossible to add
  // silently.
  assert.notDeepEqual(suitesNamedBy(pkg.scripts.test), found);
});
