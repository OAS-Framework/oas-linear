#!/usr/bin/env node
/**
 * Gate AND runner: `npm test` must run exactly this repository's suites, and
 * all of them. This file both checks that property and performs the run.
 *
 * The property can be violated in ways a check inside the test run cannot see:
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
 * WHY THIS SHAPE, AND NOTHING CLEVERER.
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
 * So this gate parses nothing and detects nothing. It builds the scripts block
 * the package MUST have, character for character, and compares. Then it runs
 * the suites ITSELF, spawning node with the inventory as ARGV (`shell: false`),
 * so no shell ever re-reads those paths. Two consequences worth stating:
 *
 *  - A suite path is never shell text. A file named `test/ ; true #.test.mjs`
 *    would otherwise splice `; true #` into the command, dropping the suite and
 *    making the run green. Such a name is now REJECTED, loudly, before any
 *    command is built — the safe grammar below is the whole allowed alphabet.
 *  - An EMPTY inventory is rejected. `node --test` with zero paths IS bare
 *    discovery, so a canonical-looking command built from an empty inventory
 *    would bless the exact defect this gate exists to prevent.
 *
 * The same reasoning governs VALIDATION. `npm run validate && node <this>` puts
 * the validator in a command string, where whatever runs the string decides
 * whether it happens; a `test` that rewrote package.json and called this file
 * directly skipped validation entirely and still exited 0. So this file runs the
 * validator too. A step this gate performs cannot be skipped by re-spelling the
 * command that invokes the gate.
 *
 * WHAT THIS GATE DOES NOT PROMISE — stated precisely, because an overstated
 * guarantee is worse than none.
 *
 * `npm_lifecycle_script` is a CONSISTENCY CHECK, not attestation. npm sets it to
 * the command it loaded, so it catches an on-disk `test` that disagrees with the
 * running one. It does NOT prove what npm loaded: the loaded command controls
 * the environment of everything it spawns, so it can rewrite package.json AND
 * export a canonical-looking value. That bypass is real and reproducible; it is
 * checked here because divergence is worth reporting, not because it is
 * unforgeable.
 *
 * More broadly: a `pretest`, an edit to THIS file, or a hostile `test` executes
 * before or as the gate. No in-repository check survives a committer willing to
 * edit the checker, and moving the check to another file in the same repository
 * relocates that boundary without closing it. The canonical-scripts comparison
 * rejects `pretest`/`posttest` in the tree; review, protected CI and branch
 * policy are the controls beyond it.
 *
 * That boundary includes RUNTIME INJECTION into this process. `NODE_OPTIONS`
 * carries `--require`/`--import`, so whoever launches the gate can load code
 * into it and rewrite what it does — which is editing the checker by another
 * means, not a separate weakness. It is listed here so nobody reads the
 * guarantee below as wider than it is.
 *
 * What this gate DOES guarantee is narrower and load-bearing: when it runs in a
 * process whose own runtime has not been tampered with, validation and exactly
 * the inventoried suites run with it. Its CHILDREN are covered unconditionally,
 * because it builds their environment rather than inheriting one (see
 * `childEnv`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Repository-relative, POSIX-separated. */
const normalize = (path) => String(path).replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * The entire alphabet a suite path may use. Deliberately far narrower than the
 * filesystem allows: everything outside it — whitespace, quotes, `;`, `&`, `|`,
 * `$`, `#`, backslashes, newlines — is shell-significant somewhere, and this
 * gate does not own the shell's semantics (see header). Anchored, `..` excluded.
 */
const SAFE_SUITE_PATH = /^test(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9._-]+\.test\.mjs$/;
const isSafeSuitePath = (path) =>
  SAFE_SUITE_PATH.test(path) && !path.split("/").includes("..");

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
 * Problems with the inventory ITSELF, checked before any command is built.
 * @returns {string[]} empty means the inventory is safe to name in a command.
 */
export function inventoryProblems(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    return [
      "no suites found under test/ — refusing to build a `node --test` command with no paths, " +
        "because that IS bare discovery: it would walk the tree and execute nested agent worktrees.",
    ];
  }
  return inventory
    .filter((path) => !isSafeSuitePath(path))
    .map(
      (path) =>
        `unsafe suite path ${JSON.stringify(path)} — suite paths must match ${SAFE_SUITE_PATH}. ` +
        "Characters outside that alphabet are shell-significant, and a path spliced into a shell " +
        "command can drop its own suite while leaving the run green. Rename the file.",
    );
}

/**
 * THE package scripts, derived from what is on disk. `test` validates, then
 * hands the run to this file, which names every suite under test/ as argv.
 * @throws if the inventory is not safe to build a command from.
 */
export function canonicalScripts(inventory) {
  const problems = inventoryProblems(inventory);
  if (problems.length) throw new Error(problems.join("\n"));
  return {
    validate: "node scripts/validate-manifests.mjs",
    // No `npm run validate &&` chain: the gate runs the validator itself, so no
    // re-spelling of this command can skip it. See the header.
    test: "node scripts/check-test-scripts.mjs",
    probe: "node scripts/consumer-probe.mjs",
  };
}

/**
 * @param {object} pkg parsed package.json
 * @param {string[]} inventory suite paths under test/
 * @param {NodeJS.ProcessEnv} [env] the environment the gate is running in
 * @returns {string[]} problems; empty means the scripts block is exactly canonical.
 */
export function checkScripts(pkg, inventory, env = {}) {
  const problems = inventoryProblems(inventory);
  if (problems.length) return problems;

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

  // Consistency check, NOT attestation: the loaded command controls this
  // variable in everything it spawns, so a hostile `test` can forge it. It is
  // still worth reporting when the running command disagrees with the file.
  if (env.npm_lifecycle_event === "test" && typeof env.npm_lifecycle_script === "string") {
    if (env.npm_lifecycle_script !== expected.test) {
      problems.push(
        `npm is running a "test" command that is not the canonical one\n` +
          `    expected: ${expected.test}\n` +
          `    npm_lifecycle_script: ${env.npm_lifecycle_script}\n` +
          "    package.json on disk disagrees with the command npm loaded.",
      );
    }
  }
  return problems;
}

/**
 * Environment for the processes this gate spawns. Inheriting the caller's
 * environment wholesale hands a hostile `test` command control of what the
 * children DO, which defeats the point of the gate running them:
 *
 *  - NODE_OPTIONS carries `--require`/`--import`/`--experimental-loader`, so a
 *    preload can no-op the validator by inspecting `process.argv[1]` — the gate
 *    then announces validation, runs the suites and exits 0 having validated
 *    nothing. Reproduced through real npm; regression-tested.
 *  - NODE_REPL_EXTERNAL_MODULE is a second load-arbitrary-code vector.
 *  - NODE_TEST_CONTEXT makes a spawned `node --test` emit no report and exit 0
 *    even when suites FAIL (it is set in every test-file process and inherited
 *    by that process's children).
 *
 * Denied rather than allow-listed: an allow-list of everything a child may
 * need is unenumerable, and getting it wrong breaks legitimate runs. This is a
 * short, closed list of ways to change what a child EXECUTES.
 *
 * Matched case-INSENSITIVELY, and by rebuilding rather than deleting. Windows
 * resolves environment names case-insensitively, but `{ ...process.env }` is an
 * ordinary object with ordinary case-sensitive keys: a caller who spells it
 * `node_test_context` survives three uppercase `delete`s and is still
 * `NODE_TEST_CONTEXT` to the child. Copying only what passes the filter cannot
 * miss a spelling that way.
 */
const CHILD_ENV_DENYLIST = new Set(["NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "NODE_TEST_CONTEXT"]);

export function childEnv(source) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (!CHILD_ENV_DENYLIST.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

// Run as gate + runner only when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const inventory = inventorySuites(join(ROOT, "test"));
  const problems = checkScripts(pkg, inventory, process.env);
  if (problems.length) {
    process.stderr.write(`Test-script check failed:\n- ${problems.join("\n- ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `package.json scripts are canonical; running validation and exactly the ${inventory.length} suite(s) under test/.\n`,
  );
  // argv, not shell text: the paths are handed to node as separate arguments.
  //
  // NODE_TEST_CONTEXT is deleted deliberately. Node sets it in every process it
  // spawns for a test file, and it is INHERITED by that file's own children. A
  // `node --test` that inherits it believes it is a serialized child of a test
  // runner: it emits no readable report and exits 0 even when suites FAIL. So a
  // gate invoked from inside a test process would print green over red — the
  // precise failure this file exists to prevent.
  const env = childEnv(process.env);

  const spawn = (label, args) => {
    const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", shell: false, env });
    if (run.error) {
      process.stderr.write(`Failed to run ${label}: ${run.error.message}\n`);
      process.exit(1);
    }
    if (run.status !== 0) process.exit(run.status === null ? 1 : run.status);
  };

  // Validation first, performed here rather than named in the `test` command.
  spawn("manifest validation", ["scripts/validate-manifests.mjs"]);
  spawn("the suites", ["--test", ...inventory]);
}
