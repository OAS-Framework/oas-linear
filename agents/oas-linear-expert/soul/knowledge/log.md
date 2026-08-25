# Knowledge Log

## 2026-08-25
* **Fix**: [Released OAS 0.20 package behavior facts](/references/oas-020-package-behavior.md) — corrected the config-template section, which wrongly claimed `oas doctor` reports available-but-unadopted templates; released doctor deliberately reports adopted template state only.
* **Fix**: [The test-script gate runs the suites itself](/decisions/test-script-gate-runs-suites.md) — corrected the Decision section, which described the `test` script as chaining validation before the gate; the shipped `test` script is exactly the gate invocation and the gate runs the validator itself.

## 2026-08-20
* **Harvest**: processed the frozen `oas-linear-expert-resume-v2` notes set (25 files) into consolidated oas-linear v2 knowledge; no notes were dropped.
* **Creation**: [Adversarial guards must prove their own negative direction](/lessons/adversarial-guard-non-vacuity.md) — merged adversarial fixture, pinned-ref, sandboxed PATH, and probe non-vacuity lessons.
* **Creation**: [Child-process guarantees require constructing the child environment](/lessons/child-process-environment-boundaries.md) — merged child environment, `NODE_TEST_CONTEXT`, Windows-case denylist, `__proto__` copy, and shell-quoting lessons.
* **Creation**: [Test-script gates must narrow their claim to the boundary they control](/lessons/test-script-gate-threat-model.md) — reconciled npm load-order and forged `npm_lifecycle_script` corrections into the current gate guarantee.
* **Creation**: [Config portability scanners use the consumer parser as a floor, not as the whole policy](/lessons/config-portability-scanner-parity.md) — merged config parser parity and copied-byte policy review lessons.
* **Creation**: [OAS package self-containment is bounded by each materialized capability root](/lessons/oas-package-materialization-boundaries.md) — merged capability-root boundary and released-kernel self-containment asymmetry facts.
* **Creation**: [Released-kernel probes must isolate OAS instance state and PATH-dependent runtime facts](/lessons/oas-probe-isolation.md) — merged OAS/PI environment isolation, `spawn --no-launch` runtime resolution, and spawn-materialization anomaly lessons.
* **Creation**: [The test-script gate runs the suites itself](/decisions/test-script-gate-runs-suites.md) — promoted the gate-as-runner design decision.
* **Creation**: [Config templates ship outside capability roots and contain no deployment-local values](/decisions/config-templates-outside-capability-roots.md) — promoted the config-template location and portability decision.
* **Creation**: [oas.linear 2.0.0 is the compatibility-floor release for OAS 0.20](/decisions/oas-linear-v2-compatibility-major.md) — promoted the v2 versioning decision.
* **Creation**: [Probe an OAS package against a released kernel before shipping](/playbooks/released-kernel-consumer-probe.md) — promoted the released-kernel consumer probe playbook and merged its probe gotchas.
* **Creation**: [Released OAS 0.20 package behavior facts](/references/oas-020-package-behavior.md) — merged released-kernel facts for doctor warnings, config-template reporting, Git source spelling, self-containment parity, and no-launch runtime resolution.

## 2026-07-28
* **Initialization**: knowledge bundle scaffolded by oas-okf.
