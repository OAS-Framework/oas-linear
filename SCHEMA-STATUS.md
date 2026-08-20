# Schema status

The three schemas under `schemas/` are vendored copies of the canonical
contract, kept here so CI can validate this package's manifests without a
kernel checkout. They are **not** the source of truth — the released kernel is.

- **Verified against the RELEASE**: `schemas/oas-package.schema.json`,
  `schemas/oas-lock.schema.json`, and `schemas/capability-manifest.schema.json`
  are byte-identical to `@oas-framework/oas@0.20.0`'s
  `docs/oas-package.schema.json`, `docs/oas-lock.schema.json`, and
  `docs/capability-manifest.schema.json`. Re-check with:

  ```bash
  npm --prefix /tmp/oas020 install @oas-framework/oas@0.20.0
  for f in oas-package oas-lock capability-manifest; do
    diff /tmp/oas020/node_modules/@oas-framework/oas/docs/$f.schema.json schemas/$f.schema.json
  done
  ```

- **Consumer gate CLOSED.** The previously open
  `TODO(engine-consumer-fixtures)` item — "run the released acquire → lock →
  trust → activate → spawn probe when fixtures are available" — no longer needs
  fixtures. `scripts/consumer-probe.mjs` drives the distributed payload through
  a real released `@oas-framework/oas@0.20.0` CLI in an isolated sandbox and
  runs in CI on every pull request (`npm run probe`).

## Known kernel defects observed by the probe (not package-side)

Released 0.20.0 `oas doctor` prints

```text
WARNING: oas.linear at <scope>/.agents/capabilities/installed/oas.linear is in
installed/ but has no lock entry — reacquire it or move it to owned/
```

for a correctly materialized capability under a valid `lockfileVersion: 2`
lock. `bin/oas.mjs` compares materialized capability manifests against
`readCapabilityLocks`, which reads only the **legacy v1** capability map, so
every v2-materialized capability trips it. It is cosmetic and affects any v2
package, not just this one. The package maintainer has confirmed it as a kernel
defect and ruled that no package-side workaround may be added; the probe
records the warning verbatim as evidence and does not treat it as a failure.

## Second divergence: `oas install` does not report available templates

`docs/packages.md` in the released kernel states that `oas install <package>`
"materializes capabilities and reports available templates as optional
follow-ups". It does not: no install path emits them, and the
`Config template "…"` line exists only in the `oas init --package` adoption
path (`bin/oas.mjs`). Verified on both a fresh install and a re-install against
0.20.0.

Consequence for adopters: after `oas install oas.linear` nothing tells you a
config template exists. Run `oas init --package oas.linear` (or
`oas config adopt`) to adopt it, or write your own config — see the README.

The consumer probe asserts what install actually guarantees (locks the
capability, activates nothing, names the trust gate) and records this
divergence as evidence rather than asserting documented-but-absent behavior.

## Version and compatibility

`oas.linear` is at **2.0.0** with `compatibility.oas: ">=0.20.0"`. Raising the
floor from `>=0.19.0` makes the package unconsumable by 0.19 kernels — a
breaking consumer-contract change — so the package and its capability both move
to 2.0.0 (the validator pins them equal). The published `v1.0.0` tag stays
immutable and untouched for 0.19 consumers.
