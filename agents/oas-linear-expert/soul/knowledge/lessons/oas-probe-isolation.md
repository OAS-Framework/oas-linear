---
type: Lesson
title: Released-kernel probes must isolate OAS instance state and PATH-dependent runtime facts
description: A consumer probe that inherits agent environment or host PATH can pass locally while exercising the host deployment or a local runtime binary instead of the sandbox.
tags: [oas, probe, isolation, spawn, ci]
timestamp: 2026-08-20
---

# Lesson

A released-kernel consumer probe must make the sandbox the only deployment the child can see. Setting `HOME` to a temp directory is not enough when the probe runs inside an OAS agent instance.

Operational dispatch can read `PI_AGENT_HOME` or `OAS_HOME`, then use that instance's `instance.json` to resolve the host repository. In one oas-linear probe, `oas linear teams` inside a temp scope reached the host laptop's stale lock chain because inherited `OAS_HOME` pointed at the agent instance.

Build child environments by dropping every variable matching `^(OAS_|PI_)` and `HOME`, then set `HOME` to the sandbox.

# PATH must be intentional too

Filtering `process.env` while keeping the developer's `PATH` hides runtime dependencies. Released OAS 0.20 resolves the selected runtime binary while constructing an `oas spawn --no-launch` command, before the `launch` branch. A scaffold-only spawn therefore still requires `pi` or the resolved Claude binary on `PATH`; only `tmux` is genuinely launch-gated.

Probe both directions:

- with no runtime on the sandbox PATH, assert spawn fails with the released error;
- with a stub runtime on PATH, assert `--no-launch` succeeds, reports `launched: false`, and the stub was not executed;
- keep `tmux` absent to prove the launch branch was not reached;
- make the stub fail loudly and add a self-test that executes it deliberately so marker checks are not vacuous.

# Spawn output is not enough

A separate reviewer-spawn anomaly showed `oas spawn` exit 0 and print a home path, tmux window, and attach command even though no instance home, tmux window, or verdict ever materialized. Treat spawn output as intent, not proof. Confirm the instance home exists before waiting for a child agent's result, and if it is missing, re-spawn with a new purpose slug rather than reusing the vanished one.

Do not change package behavior for lifecycle anomalies; report them upward and keep package probes focused on released-kernel consumer behavior.

# Related

- [Released-kernel consumer probe playbook](/playbooks/released-kernel-consumer-probe.md)
- [Adversarial guards must prove their own negative direction](/lessons/adversarial-guard-non-vacuity.md)
