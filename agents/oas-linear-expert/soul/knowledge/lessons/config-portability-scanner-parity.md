---
type: Lesson
title: Config portability scanners use the consumer parser as a floor, not as the whole policy
description: A template scanner must catch every value the kernel parser would honor and separately label broader copied-byte policy rejections such as comments or block-sequence paths.
tags: [oas, config, yaml, portability, validation, review]
timestamp: 2026-08-20
---

# Lesson

A config portability scanner must never recognize less than the consumer. If the OAS kernel parser accepts a spelling as a live value and the scanner ignores it, a deployment-local setting can leak through exactly that difference.

For released OAS 0.20, `parseYamlNested` accepts quoted and unquoted keys and strips quotes afterwards. The first oas-linear scanner matched only an unquoted `key: value` pair or `- item`, so `"account": acme-inc` was live to the kernel and invisible to the scanner. Flow collections also matter: the kernel keeps some as opaque scalars, but recursive scalar handling still sees nested values inside `{...}` and `[...]` forms.

# Floor vs policy

Keep two rules separate in code, tests, and wording:

- **Parser floor**: every form the consumer parser would turn into a live value must be caught. Mirror the parser's recursion, not just its top-level syntax.
- **Copied-byte policy**: a scanner may deliberately reject bytes the parser ignores when those bytes are copied verbatim into an adopter's repository. Comments, copied guidance, and block-sequence paths can be policy failures even if the released parser would drop them.

A policy rejection is not evidence of parser parity. Reviewers caught earlier wording that claimed an "exact supported subset" while rejecting shapes the parser ignored. State which rule each fixture exercises.

# Practices

- Derive the grammar floor from the released consumer parser and name that source in a comment.
- Detect paths at argument or punctuation boundaries; `--config=/opt/x` and `(/opt/x)` are ordinary spellings. Exclude `:` from boundary sets so `https://host/path` is not a false positive.
- Keep accept controls for relative paths, URLs, and commented generic guidance so tightening the scanner cannot silently over-reject.
- Share the policy predicate between the authoring gate and consumer probe so the two cannot drift.

# Related

- [Config templates ship outside capability roots](/decisions/config-templates-outside-capability-roots.md)
- [Released-kernel consumer probe playbook](/playbooks/released-kernel-consumer-probe.md)
