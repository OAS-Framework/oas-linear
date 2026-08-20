#!/usr/bin/env node
/**
 * Gate: `npm test` must run exactly this repository's suites, and all of them.
 *
 * This runs BEFORE `node --test`, deliberately. The property it protects can be
 * violated in two ways, and one of them can hide an in-suite check:
 *
 *  - BARE DISCOVERY. `node --test` with no file arguments walks the working
 *    tree and executes every `*.test.mjs` it finds. An OAS repository contains
 *    nested agent worktrees at `agents/<soul>/instances/<id>/work/`, each a full
 *    checkout at whatever revision that instance is on. So bare discovery runs
 *    other instances' stale suites, and green depends on which worktrees exist
 *    on the machine — it passes in CI (clean checkout) and means something else
 *    locally.
 *  - FILTERING. `--test-name-pattern` and friends make green mean "the tests
 *    that ran passed" rather than "the intended suites passed". A filter can
 *    exclude the very assertion that would report it, so an assertion living
 *    inside the test run cannot catch this case. Hence a separate gate.
 *
 * The pure helpers are exported and unit-tested in test/npm-scripts.test.mjs;
 * there is one implementation, used by both.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Node flags that CONSUME the following word. Their value is not a positional,
 *  even when it looks exactly like a suite path. */
const VALUE_TAKING = new Set([
  "--test-name-pattern", "--test-skip-pattern", "--test-reporter",
  "--test-reporter-destination", "--test-concurrency", "--test-timeout",
  "--test-shard", "--test-coverage-include", "--test-coverage-exclude",
  "--import", "--require", "-r", "--loader", "--experimental-loader",
  "--conditions", "-C", "--env-file", "--max-old-space-size", "--title",
]);

/** Flags that make `node --test` run only SOME of the tests it was given. */
const FILTERING = new Set(["--test-name-pattern", "--test-skip-pattern", "--test-shard"]);

/** Split a command into shell words WITHOUT evaluating it, keeping quoted
 *  arguments whole and stripping their balanced quotes. */
export function shellWords(command) {
  const words = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = pattern.exec(command); m; m = pattern.exec(command)) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

/** Repository-relative, POSIX-separated, no leading "./" or surrounding quotes. */
export const normalize = (path) => String(path)
  .replace(/^(['"])([\s\S]*)\1$/, "$2")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "");

const isSuitePath = (word) => /\.test\.mjs$/.test(word) && !word.startsWith("-");

/**
 * Parse one shell segment as a node invocation: is this `node --test`, and
 * which words are POSITIONALS rather than flags or flag values?
 *
 * `--test(?![-\w])` so `--test-reporter` is not mistaken for `--test`.
 * `--` ends option parsing; everything after it is positional.
 */
export function parseNodeInvocation(segment) {
  const words = shellWords(segment);
  const node = words.findIndex((w) => /(^|\/)node$/.test(w));
  if (node < 0) return undefined;
  const rest = words.slice(node + 1);

  const positionals = [];
  let isTest = false;
  let endOfOptions = false;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    if (endOfOptions) { positionals.push(word); continue; }
    if (word === "--") { endOfOptions = true; continue; }
    if (word.startsWith("-")) {
      if (/^--test(?![-\w])$/.test(word)) isTest = true;
      if (!word.includes("=") && VALUE_TAKING.has(word)) i += 1;
      continue;
    }
    positionals.push(word);
  }
  return isTest ? { positionals } : undefined;
}

/** Suite paths named by one `node --test` invocation, or undefined. */
export function testTargets(segment) {
  const parsed = parseNodeInvocation(segment);
  return parsed && parsed.positionals.filter(isSuitePath).map(normalize);
}

const segmentsOf = (command) => String(command || "").split(/&&|\|\||;/);

/** `node --test` invocations naming no suite at all. */
export function bareDiscoveryIn(command) {
  return segmentsOf(command)
    .filter((segment) => { const t = testTargets(segment); return t && !t.length; })
    .map((segment) => segment.trim());
}

/** Suites named by ONE command, as normalized repo-relative paths. */
export function suitesNamedBy(command) {
  const named = new Set();
  for (const segment of segmentsOf(command)) {
    for (const target of testTargets(segment) || []) named.add(target);
  }
  return [...named].sort();
}

/** Test-filtering flags used by a command, in either flag form. */
export function filteringFlagsIn(command) {
  const found = [];
  for (const segment of segmentsOf(command)) {
    if (!parseNodeInvocation(segment)) continue;
    for (const word of shellWords(segment)) {
      const name = word.split("=")[0];
      if (FILTERING.has(name)) found.push(name);
    }
  }
  return found;
}

/** RECURSIVE inventory of a suite tree, as paths relative to `root`. */
export function inventorySuites(dir, root = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...inventorySuites(path, root));
    else if (entry.name.endsWith(".test.mjs")) out.push(normalize(relative(root, path)));
  }
  return out.sort();
}

/** @returns {string[]} problems; empty means the scripts are sound. */
export function checkScripts(pkg, inventory) {
  const problems = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    for (const segment of bareDiscoveryIn(command)) {
      problems.push(`script "${name}" uses bare \`node --test\` discovery (${segment}) — it would execute nested agent-worktree suites; name the suite files explicitly`);
    }
  }
  const test = pkg.scripts?.test;
  if (!test) { problems.push("package.json defines no test script"); return problems; }

  for (const flag of filteringFlagsIn(test)) {
    problems.push(`"test" uses ${flag}, so a green run means "the tests that ran passed", not "the suites passed"`);
  }
  const named = suitesNamedBy(test);
  const missing = inventory.filter((p) => !named.includes(p));
  const extra = named.filter((p) => !inventory.includes(p));
  if (missing.length) problems.push(`"test" does not name: ${missing.join(", ")} — those suites never run`);
  if (extra.length) problems.push(`"test" names suites that are not under test/: ${extra.join(", ")}`);
  return problems;
}

// Run as a gate only when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const problems = checkScripts(pkg, inventorySuites(join(ROOT, "test")));
  if (problems.length) {
    process.stderr.write(`Test-script check failed:\n- ${problems.join("\n- ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Test scripts name exactly the ${inventorySuites(join(ROOT, "test")).length} suite(s) under test/.\n`);
}
