---
type: Lesson
title: Test-script gates must narrow their claim to the boundary they control
description: npm lifecycle metadata and package.json re-reads are consistency signals, not attestation, so the gate's real guarantee is the action it performs under its own untampered process.
tags: [npm, testing, gates, attestation, threat-model, oas]
timestamp: 2026-08-20
---

# Lesson

A gate invoked from `npm test` cannot prove every property people want from it. It can only enforce the part that runs inside the boundary it controls.

Two earlier beliefs were corrected during the v2 review and should not be reintroduced:

1. **Re-reading `package.json` is not proof of the command npm is running.** npm resolves the lifecycle script text before spawning the shell. A noncanonical script can rewrite `package.json` to canonical and then invoke the checker; the checker reads true bytes while npm continues running the already-loaded noncanonical command.
2. **`npm_lifecycle_script` is a consistency check, not attestation.** It looks like npm-loaded command text, but the loaded shell command controls the environment of every process it spawns. The same hostile script can rewrite `package.json` and set `npm_lifecycle_script='<canonical>'` before launching the gate.

The correction matters because overstating either signal makes reviewers stop looking at the actual bypass. Keep the checks only as disagreement detectors, and test their limitation so they cannot quietly be described as proof later.

# Move the prize, not the proof

The useful fix was not a better variable. It was making the gate perform the step the hostile command was trying to skip. If validation lived only in a lifecycle string such as `npm run validate && node gate.mjs`, respelling the string could skip validation. Once the gate runs validation itself, respelling the caller's command no longer skips that child step.

That guarantee still has a boundary:

- A child spawned by an untampered gate process is covered when the gate constructs its child environment; see [child-process environment boundaries](/lessons/child-process-environment-boundaries.md).
- The gate's own process can be changed by the caller's Node environment, or by editing the checker itself. No in-repository check survives a committer willing to edit the checker.
- `pretest` and `posttest` lifecycle scripts run outside the gate. Reject unexpected lifecycle scripts where possible, document the residual, and treat review as the control for checker edits.

# Placement rule

A check cannot validate the mechanism that decides whether the check runs. An in-suite assertion can be filtered out by `--test-name-pattern` or other selection modes before it executes. Properties about "the right suites ran" belong before the runner, in a gate that then launches the suites itself.

# Related

- [The test-script gate runs the suites itself](/decisions/test-script-gate-runs-suites.md)
- [Adversarial guards must prove their own negative direction](/lessons/adversarial-guard-non-vacuity.md)
