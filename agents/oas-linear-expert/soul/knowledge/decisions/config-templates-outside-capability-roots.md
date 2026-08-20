---
type: Decision
title: Config templates ship outside capability roots and contain no deployment-local values
description: oas-linear ships templates under config-templates/ rather than inside a capability root, and mechanically rejects values that belong to a specific deployment.
tags: [oas, packages, config-templates, portability, validation]
timestamp: 2026-08-20
---

# Decision

`oas.linear@2.0.0` ships its config template at `config-templates/default/oas-config.yaml`: inside the package payload, outside every capability root. Repository validation enforces the location and portability policy.

# Why outside capability roots

`oas install` materializes capability roots. It does not apply templates. A template inside a capability root would be installed as capability bytes, included in artifact integrity, and placed under executable trust even though it is adopter source material rather than runtime capability content.

# Why portability is mechanical

An adopted template is copied verbatim into another repository. Anything deployment-local in it becomes a leak. The validator rejects Linear API keys, absolute machine paths, workspace-local `linear.app` URLs, provider-local UUIDs, and uncommented settings such as `team:`, `project:`, or credential-shaped values. Comments are scanned too because comments are copied too; concrete local guidance belongs outside the shipped template.

Released OAS 0.20 records local `path:` template adoption as `source: null` with `localSource: true`, so no absolute local source path needs to be committed in adoption metadata.

# Related

- [Config portability scanners use the consumer parser as a floor](/lessons/config-portability-scanner-parity.md)
- [OAS package self-containment is bounded by each materialized capability root](/lessons/oas-package-materialization-boundaries.md)
- [Released OAS 0.20 package behavior facts](/references/oas-020-package-behavior.md)
