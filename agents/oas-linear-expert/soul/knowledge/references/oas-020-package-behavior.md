---
type: Reference
title: Released OAS 0.20 package behavior facts
description: Provider facts from oas-linear v2 probing that describe released kernel behavior, including known defects and command spelling traps.
tags: [oas, 0.20.0, packages, install, doctor, spawn]
timestamp: 2026-08-20
---

# Known 0.20.0 behavior

These facts were verified against released `@oas-framework/oas@0.20.0` during the oas-linear v2 package wave. Treat them as released-kernel facts unless a later kernel is explicitly checked.

## `oas doctor` false orphan warning

`oas doctor` reports every v2-materialized capability as being in `installed/` with no lock entry because the orphan check reads only the legacy v1 capability-lock map. The v2 lock's `packages`/`capabilities` data is not consulted by that check.

Maintainer ruling for the release wave: this is a kernel defect, not a package defect; do not add package-side workarounds, do not reacquire, and do not move installed capabilities to `owned/`. Preserve the warning verbatim in probe evidence and continue when install, materialization, lock, trust, and runtime gates pass.

## `oas install` does not report available config templates

Released docs say `oas install <package>` reports available templates as optional follow-ups. The install paths do not emit that notice. The config-template validation notice exists in the `oas init --package` adoption path, and `oas doctor` can report available-but-unadopted templates, but install output itself does not surface them.

A package that ships a template should document adoption in its own README, and probes should assert released behavior rather than failing on the documented-but-unimplemented notice.

## `git:` is shorthand, not a URL scheme prefix

The accepted Git URL spelling for install is the raw URL, for example:

```bash
oas install https://github.com/org/repo.git@v2.0.0 --dir /scope
```

`oas install git:https://github.com/org/repo.git@v2.0.0 --dir /scope` is rejected as `invalid-source` because released source parsing treats `git:` without `//` as `git:host/org/repo[@ref][#path]` shorthand. Locks may normalize accepted raw URLs back to `git:<url>@<ref>`, so lock-file spelling is not necessarily command spelling.

A Git source for a repository containing `oas-package/` selects that payload root by default, records `path: "oas-package"`, and records the commit behind the ref. The materialized bytes match a directory-sourced install except for `.oas-installation.json` provenance fields.

## Self-containment parity facts

Released self-containment validation rejects `agents[]` entries that resolve to files, accepts `skills[]` entries that resolve to files, and walks declared directories to catch broken symlinks and descendant symlink escapes. Validators should mirror those facts to predict install behavior; see [materialization boundaries](/lessons/oas-package-materialization-boundaries.md).

## `spawn --no-launch` still resolves the runtime

`oas spawn --no-launch` still resolves the configured runtime binary while constructing the launch command. A scaffold-only spawn needs `pi` or the selected Claude binary on `PATH`; only `tmux` is gated by the actual launch branch. Consumer probes should control this explicitly; see [probe isolation](/lessons/oas-probe-isolation.md).
