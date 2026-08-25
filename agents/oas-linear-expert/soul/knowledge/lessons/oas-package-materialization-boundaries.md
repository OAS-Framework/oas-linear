---
type: Lesson
title: OAS package self-containment is bounded by each materialized capability root
description: A v2 install materializes one capability root at a time, so validators must check capability-declared resources against that root rather than the package payload root.
tags: [oas, packages, capabilities, materialization, validation]
timestamp: 2026-08-20
---

# Lesson

Under OAS 0.20 package materialization, the installed artifact for a capability is that capability root alone plus generated installation metadata. It is not the package payload root and it does not include sibling directories.

A validator that checks capability-declared resource paths against the package payload root is therefore too weak. A symlink can remain inside the package while escaping the capability root; it passes a payload-root check but points to bytes that are absent at runtime because they were never materialized.

# Boundary rule

Give resource-safety helpers an explicit boundary:

- Package-level declarations such as capability roots and config templates are bounded by the package payload root.
- Capability manifest resources such as `skills`, `inject`, `agents`, `commands`, and `hooks` are bounded by the capability's own root.

Use a real symlink fixture for the escape case. A plain `..` fixture exercises only lexical normalization and can pass even when descendant symlinks remain unchecked.

# Released-kernel parity facts to mirror

Released OAS 0.20 also has asymmetric self-containment behavior that package validators should predict rather than "improve":

- `agents[]` entries must resolve to directories; a file is rejected as `capability-defined agent "..." is not a directory`.
- `skills[]` entries may be files; directories are walked.
- Declared directories are walked for broken symlinks and descendant symlink escapes, not just checked at the top-level declared path.

Cover both accept and reject rows in fixtures so a future validator does not drift from released-kernel behavior in either direction.

# Related

- [Config templates ship outside capability roots](/decisions/config-templates-outside-capability-roots.md)
- [Released OAS 0.20 package behavior facts](/references/oas-020-package-behavior.md)
