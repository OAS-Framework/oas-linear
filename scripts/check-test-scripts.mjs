#!/usr/bin/env node
/**
 * Gate: `npm test` must run exactly this repository's suites, and all of them.
 *
 * Runs BEFORE `node --test`, deliberately. The property it protects can be
 * violated in ways a check inside the test run cannot see:
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
 *    can exclude the very assertion that would report it.
 *
 * WHY EXACT COMPARISON, AND NOTHING CLEVERER.
 *
 * Four designs failed before this one, each beaten by a spelling it did not
 * model:
 *
 *   1. classify targets by suite-path shape → `--test-name-pattern
 *      test/a.test.mjs`, where the VALUE has that shape;
 *   2. track which options consume a value  → `--redirect-warnings
 *      test/a.test.mjs`, one omission from an unenumerable set;
 *   3. tokenize the script text             → `\--redirect-warnings`: the SHELL
 *      removes the escape, node sees the real option, the tokenizer sees an
 *      inert word;
 *   4. a strict grammar for the invocation, applied to segments a DETECTOR
 *      found → `node --te${UNSET}st && node --test test/a.test.mjs`: the shell
 *      reassembles `--test` from an expansion, so the first process performs
 *      bare discovery while the detector never sees an invocation to check.
 *
 * Every one of them lost the same way: they tried to UNDERSTAND a command
 * assembled by two systems whose semantics this gate does not own — the shell's
 * quoting, escaping, expansion and substitution, and Node's option grammar.
 * Detection is the weak point, because anything undetected is implicitly
 * allowed.
 *
 * So this gate parses nothing and detects nothing. It builds the command the
 * scripts MUST be, character for character, and compares. Anything else — an
 * extra segment, an expansion, a renamed script, a stray flag — differs from a
 * string and is reported. Changing what the scripts do is a deliberate edit
 * here, in view of the failure modes above.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Repository-relative, POSIX-separated. */
const normalize = (path) => String(path).replace(/\\/g, "/").replace(/^\.\//, "");

/** RECURSIVE inventory of a suite tree, as sorted paths relative to `root`. */
export function inventorySuites(dir, root = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...inventorySuites(path, root));
    else if (entry.name.endsWith(".test.mjs")) out.push(normalize(relative(root, path)));
  }
  return out.sort();
}

/**
 * THE package scripts, derived from what is on disk. `test` names every suite
 * under test/, in sorted order, with no options at all.
 */
export function canonicalScripts(inventory) {
  return {
    validate: "node scripts/validate-manifests.mjs",
    test: `npm run validate && node scripts/check-test-scripts.mjs && node --test ${inventory.join(" ")}`,
    probe: "node scripts/consumer-probe.mjs",
  };
}

/** @returns {string[]} problems; empty means package.json's scripts are exactly canonical. */
export function checkScripts(pkg, inventory) {
  const problems = [];
  const actual = pkg.scripts || {};
  const expected = canonicalScripts(inventory);

  for (const [name, command] of Object.entries(expected)) {
    if (!(name in actual)) { problems.push(`missing script "${name}": ${command}`); continue; }
    if (actual[name] !== command) {
      problems.push(`script "${name}" is not the canonical command\n    expected: ${command}\n    actual:   ${actual[name]}`);
    }
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) {
      problems.push(`unexpected script "${name}": ${actual[name]} — this gate compares the whole scripts block against a canonical set, because anything it merely failed to RECOGNIZE would be implicitly allowed. Add it to canonicalScripts() deliberately.`);
    }
  }
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
  process.stdout.write(`package.json scripts are canonical; \`npm test\` names exactly the ${inventory.length} suite(s) under test/.\n`);
}
