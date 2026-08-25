---
type: Lesson
title: Adversarial guards must prove their own negative direction
description: A guard that only ever runs in the passing direction can go inert, so fixtures must create the failure they claim would be caught and prove the detector notices it.
tags: [testing, non-vacuity, review, probes, oas]
timestamp: 2026-08-20
---

# Lesson

An anti-regression guard is itself silent-green code: if it stops catching the defect it was written for, the normal suite can remain green. Treat every guard as something that needs adversarial fixtures of its own.

The oas-linear v2 review rounds found this shape repeatedly:

- A bare-`node --test` guard could be bypassed by flag values, basename-vs-path confusion, one-level inventory scans, moving suites between scripts, omitted value-taking options, `--test-only`, shell escapes, and shell-expanded spellings of `--test`.
- A recursive-inventory fixture compared two hand-written arrays and would stay green even if the walker regressed, because it never created the nested file it claimed to require.
- A mutation fixture that string-replaced real configuration quietly matched nothing once the real command was quoted, so it failed for a reason unrelated to the property being tested.
- A pinned-ref fixture tagged `HEAD` and installed immediately, making `source@tag` indistinguishable from an unpinned default; the selector had no alternative candidate to reject.
- A shell-injection fixture used `$(touch SENTINEL)` inside a sandbox whose `PATH` did not contain `touch`, so the exploit could not fire even if quoting was unsafe.
- A byte-identical restore check compared only an integrity string and an existence check; corrupting file bytes would not have been detected.

# Practices

- For every property a guard asserts, write the violating artifact and assert the guard rejects it. Keep historical bypasses as named fixtures so rewrites inherit the same attack surface.
- Prove non-vacuity next to the fixed assertion: the old or unsafe construction must still fail in the same environment. If the exploit cannot fire, the safe case proves nothing.
- Build fixtures from derived state or constructed artifacts; when a mutation depends on a literal anchor, assert the anchor exists before mutating.
- When testing a selector (`@ref`, version range, default branch, filter), create an alternative that would be chosen if the selector were ignored and report that the alternatives differ before installing.
- Compare the real content whose integrity matters, not a proxy. For materialized trees, snapshot relative path, mode, bytes hash, and symlink target, then mutate one file in a self-test to prove the comparison fires.
- Name success messages for exactly what was asserted; overclaiming output is how vacuous checks survive review.

# Sandbox payloads

Sandbox hardening can disarm adversarial payloads. Prefer payloads that use shell syntax or builtins, not external tools:

```sh
$(: >/path/to/SENTINEL)
```

This needs no `PATH`, unlike `$(touch SENTINEL)`.

# Related

- [Test-script gates must narrow their claim to the boundary they control](/lessons/test-script-gate-threat-model.md)
- [Released-kernel consumer probe playbook](/playbooks/released-kernel-consumer-probe.md)
