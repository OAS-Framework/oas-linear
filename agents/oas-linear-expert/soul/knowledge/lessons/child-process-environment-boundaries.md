---
type: Lesson
title: Child-process guarantees require constructing the child environment
description: A gate can perform the right child step and still be bypassed if caller-controlled environment variables decide what that child executes.
tags: [node, environment, gates, security, portability, oas]
timestamp: 2026-08-20
---

# Lesson

Moving a required step from a shell string into a gate's own `spawnSync()` closes the skip-by-respelling bypass, but not every bypass. The child still inherits environment by default, and Node treats several environment variables as executable input:

- `NODE_OPTIONS` can preload `--require`, `--import`, and loader code.
- `NODE_REPL_EXTERNAL_MODULE` is another arbitrary-code load vector.
- `NODE_TEST_CONTEXT=child-v8`, set inside Node test-file processes, makes a nested `node --test` serialize results to a parent that is not listening; observed nested runs produced no readable output and exited 0 over failing suites.

In oas-linear review, `NODE_OPTIONS=--require=./skip.cjs` let a preload exit only the spawned validator with status 0. The gate then announced success, ran the suites, and exited green while validating nothing.

# Hardening rules

- Construct the child environment for steps whose execution is part of the guarantee. Strip `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`, and `NODE_TEST_CONTEXT` before spawning Node children.
- Keep the guarantee honest: this protects children spawned by an untampered gate process. It does not prove the gate's own Node process was not preloaded; that boundary remains review/trusted-entrypoint territory.
- If a child step matters, consider whether it can leave positive evidence. A silent exit 0 is indistinguishable from success unless the parent checks something the child had to produce.

# Copying environment maps safely

Environment names can be case-insensitive at lookup time but case-sensitive after copying. On Windows, `process.env.node_test_context` resolves like `NODE_TEST_CONTEXT`, but `{ ...process.env }` is an ordinary object; deleting only the uppercase spelling can miss a lowercase one that the child later resolves.

Use a rebuild/filter pattern with normalized names:

```js
const denied = new Set(["NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "NODE_TEST_CONTEXT"]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !denied.has(name.toUpperCase())),
);
```

Use `Object.fromEntries` (or define-property semantics) rather than `out[name] = value` for data keys. Assignment to `__proto__` hits `Object.prototype`'s inherited setter and silently fails to create an own property, so a legitimate environment/header/config key named `__proto__` can disappear during a copy.

# Shell text is executable input too

`JSON.stringify(value)` is JavaScript quoting, not shell quoting. It emits double quotes, inside which POSIX shell still expands `$`, backticks, and `$(...)`. If generated shell cannot be avoided, use POSIX single-quoting for every dynamic value:

```js
const shellQuote = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;
```

Prefer argv with `shell: false`, or pass dynamic values through a data file, whenever possible.

# Related

- [The test-script gate runs the suites itself](/decisions/test-script-gate-runs-suites.md)
- [Test-script gates must narrow their claim to the boundary they control](/lessons/test-script-gate-threat-model.md)
