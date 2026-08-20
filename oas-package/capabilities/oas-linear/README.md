# `oas.linear` — tasks layer via Linear

This directory is the **dedicated capability root** for `oas.linear`. Everything
the capability declares — `oas.json`, `bin/`, `injects/`, `skills/`, this README
— lives inside it and nothing it declares reaches outside it, so `oas install`
can materialize it as a self-contained, independently hashable, independently
trustable artifact at `.agents/capabilities/installed/oas.linear/`.

The contents of this directory ARE the installed artifact: after installation
this file is `.agents/capabilities/installed/oas.linear/README.md`, and the
paths below are relative to that root. The repository that ships this
capability, its schemas, tests and CI, and the package's config templates are
NOT part of it.

- **Layer**: `tasks` (an exclusive slot — one provider, or an explicit `none`)
- **Command namespace**: `oas linear …`
- **Requires**: nothing on the host beyond Node (the commands use built-in
  `fetch`; there is no Linear CLI or SDK dependency)
- **Executable surface** (needs explicit trust): commands `auth`, `teams`,
  `states`, `projects`, `labels`, `issue`; hook `spawn`

## Authentication — environment only

The commands read a Linear personal API key from `LINEAR_API_KEY` and from
nowhere else. Create one in Linear under **Settings → Security & access → API
keys**, then export it from your shell or secret manager:

```bash
export LINEAR_API_KEY='lin_api_...'
```

Never put the key in `oas-config.yaml`, in a config template, in a command
argument, or in any committed file. The spawn hook warns when the key is absent
from the spawn environment; API commands fail with actionable JSON on stderr
rather than attempting an interactive login.

The key acts as the human who created it. Agents preserve the human assignee,
identify themselves with `agent-<instance-name>` labels, and do not move issues
to terminal states without explicit human authorization.

## Install, trust, activate

Installing materializes this capability; it does not activate or approve it.

```bash
oas install oas.linear --dir <scope>     # materialize + exact-lock
oas trust oas.linear --dir <scope>       # approve commands/hooks at this artifact integrity
oas use oas.linear --global --dir <scope>  # activate (or adopt the package's config template)
oas doctor <scope>
```

Trust binds to this artifact's integrity, never to package identity. Any change
to the materialized bytes — including `oas update` — resets it and forces a
fresh review.

## Deployment settings

Targeting and settings are config-owned, never manifest-owned. In your scope's
`oas-config.yaml`:

```yaml
capabilities:
  layers:
    tasks:
      capability: oas.linear
      from: installed
      settings:
        team: ENG                 # required: Linear issue-prefix key
        project: Agent Platform   # optional briefing default
```

`team` is the Linear issue-prefix key (the `ENG` in `ENG-123`). `project` is an
optional default for new issues — leave it unset rather than inventing one. The
spawn hook reads both, briefs each instance with the resolved target and its
`agent-<instance>` label, and warns when `team` is unset. It makes no API calls
and never fails a spawn.

## Files in this root

| Path | What it is |
|---|---|
| `oas.json` | the capability manifest — identity, layer, commands, hook, skill and injection paths |
| `bin/oas-linear.mjs` | the JSON-first GraphQL command wrapper behind `oas linear …` |
| `bin/oas-linear-hook.mjs` | the advisory spawn hook (briefing + warnings; no API calls) |
| `injects/linear.md` | the `Tasks: Linear` instruction block composed into each instance's `AGENTS.md` |
| `skills/linear-tasks/SKILL.md` | the workflow skill agents load before touching issues |

Load the `linear-tasks` skill for the full command surface, the operating model
for projects/issues/sub-issues/comments, and the support boundary. The shipping
repository's `README.md` covers acquisition, the config template, and the
support boundary in more depth.
