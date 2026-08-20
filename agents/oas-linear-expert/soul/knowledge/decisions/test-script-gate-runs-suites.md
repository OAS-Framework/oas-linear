---
type: Decision
title: The test-script gate runs the suites itself
description: oas-linear's test script invokes the gate without naming suites, and the gate inventories test files and spawns node --test with argv under shell:false.
tags: [testing, gates, shell-injection, design, oas-linear]
timestamp: 2026-08-20
---

# Decision

`oas-linear`'s `scripts/check-test-scripts.mjs` is both the test-script gate and the runner. The canonical `test` script runs validation and then `node scripts/check-test-scripts.mjs`; it does not name suite files in `package.json`. The gate inventories `test/` and spawns:

```text
node --test <suite paths...>
```

with `shell: false`.

# Why

The earlier string-comparison design put the suite inventory into a shell command string, which left two direct holes:

1. With an empty inventory, the canonical command became a bare `node --test`, and the string compared equal to itself while enabling the behavior the gate existed to prevent.
2. A suite filename containing shell metacharacters was executable shell text. A path such as `test/ ; true #.test.mjs` could drop the suite and leave a trailing `true` to make the run green.

As argv, paths are data rather than shell syntax. The gate still refuses empty inventories and paths outside a narrow suite filename policy because the next consumer of the inventory might not use argv.

# Consequences

- Adding a suite requires no `package.json` edit; omission from the command is not expressible.
- The end-to-end test plants a decoy suite in a nested agent worktree and asserts the real gate does not run it while bare discovery would have.
- The gate must propagate the suite exit status and strip child environment variables that can change Node execution; see [child-process environment boundaries](/lessons/child-process-environment-boundaries.md).
- This decision does not make npm lifecycle metadata attestation; see [test-script gate threat model](/lessons/test-script-gate-threat-model.md).
