#!/usr/bin/env node
/**
 * Gate: `npm test` must run exactly this repository's suites, and all of them.
 *
 * Runs BEFORE `node --test`, deliberately. The property it protects can be
 * violated in ways that hide from a check living inside the test run:
 *
 *  - BARE DISCOVERY. `node --test` with no file arguments walks the working
 *    tree and executes every `*.test.mjs` it finds. An OAS repository contains
 *    nested agent worktrees at `agents/<soul>/instances/<id>/work/`, each a full
 *    checkout at whatever revision that instance is on, so bare discovery runs
 *    other instances' stale suites. Green then depends on which worktrees exist
 *    on the machine: it passes in CI (clean checkout) and means something else
 *    locally.
 *  - SELECTION. `--test-name-pattern`, `--test-only` and friends make green mean
 *    "the tests that ran passed" rather than "the suites passed" — and a filter
 *    can exclude the very assertion that would report it, which is why this is a
 *    gate rather than a test.
 *
 * WHY A STRICT GRAMMAR RATHER THAN A PARSER.
 *
 * Two earlier designs tried to understand the command instead of constraining
 * it, and each lost to a spelling it did not model:
 *
 *   1. classify targets by suite-path shape  → beaten by `--test-name-pattern
 *      test/a.test.mjs`, where the VALUE has that shape;
 *   2. track which options consume a value   → beaten by `--redirect-warnings
 *      test/a.test.mjs`, one omission from an unenumerable set;
 *   3. tokenize the script text              → beaten by `\--redirect-warnings`,
 *      because the SHELL removes the backslash and Node sees the real option
 *      while the tokenizer sees an inert word.
 *
 * Approximating shell and Node semantics is unwinnable in the same way both
 * times. So this gate does not interpret the command: it requires the
 * invocation to be exactly
 *
 *     node --test <plain-suite-path> [<plain-suite-path> ...]
 *
 * with plain paths and nothing else — no options, no quoting, no escaping, no
 * expansion or substitution. Any spelling this grammar does not accept is
 * rejected on sight rather than reasoned about. Widening it is a deliberate
 * edit here, with the failure modes above in view.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A plain, relative suite path: no quotes, escapes, spaces or metacharacters. */
const SUITE = String.raw`[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.test\.mjs`;

/** THE accepted shape of a `node --test` invocation. */
const STRICT_INVOCATION = new RegExp(String.raw`^node[ ]+--test(?:[ ]+${SUITE})+$`);

/** Options that select WHICH tests run. Reported with a specific message; the
 *  strict grammar would reject them anyway. */
const SELECTION = ["--test-name-pattern", "--test-skip-pattern", "--test-shard", "--test-only"];

const segmentsOf = (command) => String(command || "").split(/&&|\|\||;/);

/**
 * The command as the SHELL would hand it over, approximately: escapes and
 * quotes removed. Used only to DETECT that a segment runs `node --test` — never
 * to decide that one is acceptable. Detection may be generous; acceptance is
 * the strict grammar's job.
 */
export const deEscape = (segment) => String(segment).replace(/[\\'"]/g, "");

/** Does this segment run `node --test`, however it is spelled? */
export function looksLikeNodeTest(segment) {
  const plain = deEscape(segment);
  return /(^|[\s/])node(\s|$)/.test(plain) && /(^|\s)--test(\s|$)/.test(plain);
}

/** Suite paths of a STRICTLY VALID invocation, or undefined if it is not one. */
export function strictTargets(segment) {
  const text = segment.trim();
  if (!STRICT_INVOCATION.test(text)) return undefined;
  return text.split(/[ ]+/).slice(2).sort();
}

/** Selection options visible in a segment, after de-escaping. */
export function selectionOptionsIn(segment) {
  const plain = deEscape(segment);
  return SELECTION.filter((option) => new RegExp(`(^|\\s)${option}(=|\\s|$)`).test(plain));
}

/** Repository-relative, POSIX-separated. */
const normalize = (path) => String(path).replace(/\\/g, "/").replace(/^\.\//, "");

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
  const scripts = pkg.scripts || {};

  // Only `test` may run the runner at all. This removes the question of what
  // some other script's invocation means, and with it the possibility of a
  // suite "covered" somewhere that `npm test` never reaches.
  for (const [name, command] of Object.entries(scripts)) {
    if (name === "test") continue;
    if (segmentsOf(command).some(looksLikeNodeTest)) {
      problems.push(`script "${name}" runs \`node --test\`; only "test" may, so that one command is the whole story`);
    }
  }

  const test = scripts.test;
  if (!test) { problems.push("package.json defines no test script"); return problems; }

  const invocations = segmentsOf(test).filter(looksLikeNodeTest);
  if (invocations.length !== 1) {
    problems.push(`"test" must contain exactly one \`node --test\` invocation (found ${invocations.length})`);
    return problems;
  }

  const [invocation] = invocations;
  for (const option of selectionOptionsIn(invocation)) {
    problems.push(`"test" uses ${option}, so a green run means "the tests that ran passed", not "the suites passed"`);
  }

  const targets = strictTargets(invocation);
  if (!targets) {
    problems.push(`"test" invocation is not of the accepted form \`node --test <suite> [<suite> ...]\` with plain paths and no other arguments — got: ${invocation.trim()}. This gate is fail-closed: it constrains the command rather than interpreting it, because escaping and option semantics are not reliably knowable from the script text.`);
    return problems;
  }

  const missing = inventory.filter((p) => !targets.includes(p));
  const extra = targets.filter((p) => !inventory.includes(p));
  if (missing.length) problems.push(`"test" does not name: ${missing.join(", ")} — those suites never run`);
  if (extra.length) problems.push(`"test" names suites that are not under test/: ${extra.join(", ")}`);
  return problems;
}

// Run as a gate only when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const inventory = inventorySuites(join(ROOT, "test"));
  const problems = checkScripts(pkg, inventory);
  if (problems.length) {
    process.stderr.write(`Test-script check failed:\n- ${problems.join("\n- ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Test scripts name exactly the ${inventory.length} suite(s) under test/.\n`);
}
