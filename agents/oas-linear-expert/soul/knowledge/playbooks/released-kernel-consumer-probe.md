---
type: Playbook
title: Probe an OAS package against a released kernel before shipping
description: Drive the package through a real released OAS CLI in an isolated sandbox to prove consumer install, trust, command, template, and spawn behavior.
tags: [oas, packages, probe, ci, release]
timestamp: 2026-08-20
---

# Purpose

Manifest validation proves what the repository authored. A released-kernel consumer probe proves what an adopter gets. Run this before shipping an OAS package and keep it in CI for release branches.

`oas-linear`'s `scripts/consumer-probe.mjs` is the reference implementation for the v2 materialization release.

# Setup

1. Resolve the released OAS CLI to test, usually by installing `@oas-framework/oas@<version>` into a temp directory.
2. Create a temp sandbox with `home/` and `scope/`; `git init` the scope and create `scope/agents/` before `oas create`.
3. Build child env as an allowlist: drop every `^(OAS_|PI_)` variable and `HOME`, then set `HOME` to the sandbox. Control `PATH` with explicit symlinks/stubs for only the tools under test; see [probe isolation](/lessons/oas-probe-isolation.md).
4. Leave provider credentials such as `LINEAR_API_KEY` unset. The probe should assert unauthenticated failure paths and never require real secrets.

# Stages

1. **Flat materialization** — compare the materialized file list to the authored capability root plus `.oas-installation.json`; assert no `capabilities/`, `config-templates/`, `oas-package.json`, or repo tooling appears.
2. **Lock shape** — assert `lockfileVersion: 2`, both `packages` and `capabilities` maps, exact field sets for both row kinds, provider package keyed under `packages`, distinct payload vs artifact integrity, and `trusted: false` before trust.
3. **Install adopts nothing** — assert no `oas-config.yaml` and no adopted template base after `oas install`.
4. **Ignore behavior** — assert `.agents/capabilities/.gitignore` ignores exactly `installed/`; verify `owned/` and adopted config-template bases are not ignored.
5. **Exact restore** — delete the artifact, run bare `oas install`, and compare the restored artifact tree byte-for-byte, not only lock strings. Include a self-test that mutates one file to prove the diff fires.
6. **Explicit adoption** — run `oas init --package`; compare the adopted template bytes to the shipped template; assert local `path:` adoption metadata records `source: null` and `localSource: true`; scan adopted config with the shared portability predicate.
7. **Executable trust** — assert dispatch is blocked before `oas trust`; after trust, `approvedIntegrity` equals artifact integrity, the lock flips to `trusted: true`, and approval survives an identical restore.
8. **Command surface** — list the bare namespace, then run each command without credentials and assert actionable JSON plus exit 1 with no secret material in output.
9. **Spawn composition** — run `oas spawn --no-launch --json`; assert hook warnings, `TASK.md` briefing, `AGENTS.md` injection source from the materialized artifact, and `instance.json` capability entries for layer, namespace, hooks, trust, and skills.

# Gotchas

- On macOS, temp paths may appear as `/var/folders/...` while the kernel canonicalizes to `/private/var/folders/...`; compare realpaths or allow both spellings.
- A fixture that must pass the repository validator needs package id and version to match the single capability id and version.
- Preserve known released-kernel noise verbatim instead of papering over it; see [OAS 0.20 behavior facts](/references/oas-020-package-behavior.md).
- Every check named for a failure mode should have a self-test that seeds that failure and proves the check fires; see [adversarial guard non-vacuity](/lessons/adversarial-guard-non-vacuity.md).
