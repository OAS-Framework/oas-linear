# oas-linear

Official [OAS](https://github.com/OAS-Framework/oas) tasks-layer integration for [Linear](https://linear.app). It ships the `linear-tasks` skill, task instructions, an advisory spawn hook, and JSON-first `oas linear ...` commands for issue work.

## Why GraphQL instead of a Linear CLI?

Linear's official `@linear/cli` only supports interactive issue creation and
branch checkout. It cannot list queues, read issues, transition workflow
states, label ownership, or post comments. Third-party CLIs expose different
and unstable command contracts. This integration therefore calls Linear's
official GraphQL API directly with Node's built-in `fetch`; it adds no external
CLI or SDK dependency.

- Endpoint: `https://api.linear.app/graphql`
- Authentication: personal API key in the `Authorization` header
- Documentation: <https://linear.app/developers/graphql>

## Requirements

The commands use Node's built-in `fetch` and add no external CLI or SDK dependency. Create a Linear personal API key in **Settings → Security & access → API keys**, then expose it through your shell or secret manager, never `oas-config.yaml`:

```bash
export LINEAR_API_KEY='lin_api_...'
```

Start/resume agents from an environment that receives this variable. The spawn hook warns when it is absent; API commands fail with actionable authentication guidance rather than attempting login.

This is **`oas.linear` 2.0.0**, which requires OAS `>=0.20.0` — the capability-materialization contract. A 0.19 kernel cannot consume it; the immutable [`v1.0.0`](https://github.com/OAS-Framework/oas-linear/releases/tag/v1.0.0) tag stays available for `>=0.19.0` deployments. See [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md) for the vendored-schema provenance and the one known kernel-side diagnostic defect.

## Acquire, trust, activate

Linear is an **adopter's deliberate choice**. It is never an implicit `oas.dev`
dependency and never a default tasks provider — nothing acquires it for you.

Acquisition does not activate the capability, and installing applies no config:

```bash
oas install oas.linear --dir /path/to/scope     # materialize + exact-lock
oas trust oas.linear --dir /path/to/scope       # approve commands/hooks
oas use oas.linear --global --dir /path/to/scope  # activate
oas doctor /path/to/scope --soul <soul-name>
```

A pinned Git source works the same way:

```bash
oas install git:https://github.com/OAS-Framework/oas-linear.git@v2.0.0 --dir /path/to/scope
```

The repository *contains* the package rather than being one: the payload is the
`oas-package/` subtree, which is the default a `git:` source selects. The
repository's schemas, tests, CI, and owner soul stay outside the package's
payload and integrity.

Installation **materializes** the capability into
`.agents/capabilities/installed/oas.linear/`, flat: that directory is
`capabilities/oas-linear/` from this repository and nothing else, plus a
generated `.oas-installation.json` provenance record. It is gitignored and
reprojected from `oas-lock.json` by a bare `oas install`.

The commands and spawn hook are executable, so they need explicit
per-capability trust. **Trust binds to the materialized artifact's integrity**,
never to package identity: any change to those bytes — including `oas update` —
resets the approval and forces a fresh review.

### Adopt the config template, or write your own

The package ships one config template, `default`. It is a recommended starting
point, not installed policy, and it carries no Linear API key, workspace,
account, team key, project, or machine path — you fill those in. Adopt it
explicitly:

```bash
oas init --package oas.linear --dir /path/to/scope   # adopts the "default" template
```

Note that released OAS 0.20.0 does not mention available templates after
`oas install`, despite documenting that it does — so nothing prompts you. See
[`SCHEMA-STATUS.md`](SCHEMA-STATUS.md).

Adoption records the exact template as a commit-safe base under
`.agents/config-templates/adopted/oas.linear/default/`, so `oas config diff` and
`oas config sync` can compare against it later. What lands in your
`oas-config.yaml` is then **yours**: every copied setting is editable, and
package updates never rewrite it.

Or configure it by hand. Targeting and settings are config-owned, never
manifest-owned (team is the Linear issue-prefix key; project is an optional
briefing default):

```yaml
capabilities:
  layers:
    tasks:
      capability: oas.linear
      from: installed
      settings:
        team: ENG
        project: Agent Platform
```

Verify the active command surface:

```bash
oas linear auth
oas linear teams
oas linear states --team ENG
oas linear projects --team ENG
```

The API key acts as the human who created it. Agents preserve the human
assignee, identify themselves with `agent-<instance-name>` labels, and do not
move issues to terminal states without explicit human authorization.

## Command surface

All successful output is JSON; errors are JSON on stderr and return non-zero.
Run an incomplete command for usage, or load the `linear-tasks` skill for the
workflow and exact examples.

```text
oas linear auth
oas linear teams
oas linear states --team <KEY>
oas linear projects --team <KEY>
oas linear labels --team <KEY>
oas linear issue list|get|create|update|comment ...
```

Agent labels are created team-locally on first use of `--agent`. Other labels
must already exist. `--description-file` and `--body-file` avoid shell quoting
problems for multiline Markdown.

## Projects, project documentation, and related issues

### Operating model

Use each Linear object for one kind of durable information:

| Linear object | What belongs there | Who manages it with this integration |
|---|---|---|
| Project | Outcome, ownership, lifecycle, target dates, and the container for related issues | Humans in the Linear UI; agents can discover it |
| Project overview | Intent, scope/non-goals, architecture, constraints, human gates, and success criteria | Humans in the Linear UI |
| Project documents | Detailed designs, decision records, runbooks, research, and other long-form project context | Humans in the Linear UI |
| Issue | One bounded deliverable with acceptance criteria | Agents through `oas linear issue ...` |
| Sub-issue | An independently verifiable part of a larger issue | Agents through `--parent` |
| Issue comment | Milestones, blockers, handoffs, verification, and PR/branch links | Agents through `issue comment` |
| Messaging | Conversation and nudges | The configured messaging layer, never the durable task record |

The project overview and documents explain the work; issues execute it. Keep
project-wide decisions out of an arbitrary issue description, and keep task
status out of chat. When a project document governs an issue, link that
document from the issue description or a durable comment.

### Discover projects

The wrapper currently reads project metadata but not project overview/document
content:

```bash
oas linear projects --team ENG
```

The JSON includes project IDs, names, slugs, status, and associated teams. Use
an exact project name or slug in issue commands. If the configured project is
missing or ambiguous, stop and ask the human rather than selecting a similar
name.

### List issues in a project

```bash
# Open issues in the project
oas linear issue list --team ENG --project "Agent Platform"

# Open issues claimed by one OAS instance
oas linear issue list --team ENG --project "Agent Platform" \
  --agent my-agent-instance

# Include terminal issues when auditing history
oas linear issue list --team ENG --project "Agent Platform" --all
```

`issue list` excludes completed, canceled, and duplicate states unless `--all`
is supplied. Use `issue get` before acting; its JSON includes the issue's
project and parent context:

```bash
oas linear issue get ENG-123
```

### Create issues in a project

Prefer a Markdown file for acceptance criteria:

```bash
cat > /tmp/issue.md <<'EOF'
Why this work is needed.

Acceptance:
- [ ] Observable outcome implemented
- [ ] Verification evidence recorded
- [ ] Relevant documentation updated
EOF

oas linear issue create --team ENG --project "Agent Platform" \
  --title "Implement token refresh" \
  --description-file /tmp/issue.md \
  --agent my-agent-instance
```

Create a sub-issue only when it is independently verifiable and the parent
really decomposes into multiple pieces:

```bash
oas linear issue create --team ENG --parent ENG-123 \
  --title "Add refresh-token tests" \
  --description-file /tmp/issue.md \
  --agent my-agent-instance
```

Project membership and parentage are independent: `--project` associates an
issue with a project; `--parent` makes it a sub-issue. Supply both when the
sub-issue must explicitly carry project membership.

### Work and report within the project

```bash
oas linear issue update ENG-123 --agent my-agent-instance
oas linear issue update ENG-123 --state "In Progress"
oas linear issue comment ENG-123 \
  --body "[my-agent-instance] milestone: implementation complete; tests pass"
oas linear issue comment ENG-123 \
  --body "[my-agent-instance] handoff → reviewer: PR <url>; run npm test"
```

Use the team's exact workflow names from `oas linear states --team ENG`.
Agents normally stop at the review state. Terminal transitions require both
explicit human authorization and `--allow-terminal`.

### Manage project overviews and documents

The current command wrapper does **not** read or mutate project overview
Markdown or Linear documents. Manage them through the Linear UI:

1. Open the project returned by `oas linear projects --team <KEY>`.
2. Maintain project intent, scope, non-goals, ownership, gates, architecture,
   and success criteria in its overview.
3. Keep detailed designs, decisions, and runbooks in project documents.
4. Link governing project documents from related issues.
5. Record implementation progress on issues; use Linear's project updates for
   human-facing project-level summaries.

An agent that needs unavailable project-document context must ask the human for
its URL/content. It must not infer missing project policy from issue titles.

## Current support boundary

| Operation | Supported by `oas linear`? | Current path |
|---|---:|---|
| Discover teams, workflow states, projects, and labels | Yes | `teams`, `states`, `projects`, `labels` |
| List/get/create/update/comment on project issues | Yes | `issue ...` commands |
| Create sub-issues | Yes | `issue create --parent ...` |
| Create, rename, schedule, change status, or close a project | No | Linear UI; human-owned |
| Read or edit project overview Markdown | No | Linear UI |
| List, read, create, or edit project documents | No | Linear UI |
| Move an existing issue into/out of a project | No | Linear UI |
| Change an existing issue's parent | No | Linear UI |
| Publish Linear project status updates | No | Linear UI |
| Create issue-to-issue relations such as blocks/related | No | Linear UI |

Do not invent GraphQL calls or undocumented command flags to bypass this
boundary. A future, separately reviewed extension could add commands such as:

```text
oas linear project get|create|update
oas linear project issue-add|issue-remove
oas linear document list|get|create|update
oas linear project-update create
oas linear relation create
```

Before adding those operations, the deployment must decide which project and
document mutations agents may perform and which remain human-only.

## Development

```bash
npm test       # test-script gate, which then runs manifest validation + unit tests
npm run probe  # isolated consumer probe against a released kernel
```

`npm test` runs its suites explicitly rather than using `node --test`'s bare
discovery: this repository contains nested agent worktrees under
`agents/<soul>/instances/<id>/work/`, and bare discovery would recursively
execute those instances' stale suites, making a green run depend on which agent
worktrees happen to exist on the machine.
[`scripts/check-test-scripts.mjs`](scripts/check-test-scripts.mjs) is both the
gate and the runner. It parses nothing and detects nothing: it builds the
`package.json` scripts block that this repository must have and compares it
character for character, then runs manifest validation and spawns the suites
itself, with the inventory of `test/` passed as **argv** (`shell: false`), so no
shell ever re-reads a suite path. `test` is therefore just
`node scripts/check-test-scripts.mjs` — a step the gate *performs* cannot be
skipped by re-spelling the command that invokes the gate, which a
`npm run validate && …` chain could be.

That bluntness is the result of four sharper designs failing, each to a spelling
it did not model: a selection option whose *value* is a suite path
(`--test-name-pattern test/a.test.mjs`); an unenumerable value-taking option
swallowing paths (`--redirect-warnings test/a.test.mjs`); a backslash-escaped
option (`\--redirect-warnings`) that the shell unescapes after the check has
read the text; and — fatally for any detector — a second invocation the shell
reassembles from an expansion (`node --te${UNSET}st && node --test …`), which
performs bare discovery while never looking like an invocation at all. Anything
a gate merely fails to *recognize* is implicitly allowed, so this one recognizes
nothing and compares everything. Changing what a script does means editing
`canonicalScripts()` deliberately.

Three properties are not statements about the text and are enforced separately:

- An **empty** inventory is refused. `node --test` with zero paths *is* bare
  discovery, so a command built from an empty `test/` would otherwise compare
  equal to itself and bless the defect.
- A suite path outside a narrow plain-path grammar is refused. A file named
  `test/ ; true #.test.mjs` spliced into a shell command would drop its own
  suite and leave the run green; as argv it cannot, and the gate refuses the
  name outright rather than relying on that.
- A noncanonical `test` can rewrite `package.json` to canonical before calling
  the gate. The gate compares `npm_lifecycle_script`, which npm sets to the
  command it loaded — but that is a **consistency check, not attestation**: the
  loaded command controls the environment of everything it spawns, so it can
  forge the variable too. The check reports divergence; it does not prove
  provenance, and the code says so rather than implying otherwise.

- The gate builds its children's environment rather than inheriting one.
  Performing a step is not enough if the caller controls what the step *does*:
  `NODE_OPTIONS` carries `--require`, so a preload that exits when `argv[1]` is
  the validator made the gate announce validation, run the suites and exit 0
  having validated nothing. `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE` and
  `NODE_TEST_CONTEXT` are stripped for every child — matched case-insensitively
  and by rebuilding the environment, because Windows resolves variable names
  case-insensitively while an object spread of `process.env` does not, so a
  lowercase spelling would survive a `delete` and still reach the child. That
  normalization is unit-tested; the repository's CI is Linux-only, so it is not
  covered by an end-to-end Windows run.

What the gate guarantees is correspondingly narrow, and stated plainly: **when
it runs in a process whose own runtime has not been tampered with, manifest
validation and exactly the inventoried suites run with it** — its children are
covered unconditionally, because it constructs their environment. It is not a
trust anchor against a hostile commit. A `pretest`, an edit to the gate itself,
runtime injection into the gate's *own* process, or a hostile `test` executes
before or as the gate, and moving the check into another file in this repository
would relocate that boundary without closing it. `pretest`/`posttest` are
rejected as unexpected scripts; review, protected CI and branch policy are the
controls beyond that point.

[`test/npm-scripts.test.mjs`](test/npm-scripts.test.mjs) unit-tests the gate,
keeps every historical bypass as a fixture, and runs the real script
end-to-end in a throwaway repository containing a decoy suite in a nested agent
worktree — asserting both that the decoy does not run and that bare discovery
*would* have run it. Two end-to-end cases drive **real npm** with a `test` that
rewrites `package.json` and forges `npm_lifecycle_script` — one asserting the
forgery still passes the gate and that validation runs anyway, one adding a
`NODE_OPTIONS` preload that tries to no-op the validator. A limitation with a
test on it cannot quietly be re-described as closed.

It validates both manifests against the vendored 0.20 schemas, enforces
the dedicated-capability-root and config-template contracts, and exercises the
GraphQL wrapper and advisory hook against local mock servers. Manifest
validation deliberately mirrors released-0.20 self-containment exactly,
including its asymmetry: an `agents[]` entry must be a soul **directory**, while
a `skills[]` entry may be a file, and declared directory trees are walked so a
descendant symlink cannot escape the capability root. Config-template
portability uses the shared predicate in
[`scripts/lib/config-portability.mjs`](scripts/lib/config-portability.mjs),
which the consumer probe imports too, so the authoring gate and the consumer
gate cannot drift apart. That predicate governs **copied bytes**, not only what
the kernel parses: the supported YAML subset is a floor it must catch (quoted
keys and nested flow collections included), and it deliberately reaches further
— comments and block-sequence items are scanned too, because they land in the
adopter's repository verbatim whether or not the parser honors them.

`npm run probe` is the acceptance gate. It npm-installs a real released
`@oas-framework/oas` (0.20.0 by default; override with `OAS_PROBE_VERSION`, or
point `OAS_PROBE_CLI` at an existing binary), builds a throwaway scope whose
environment is *constructed rather than inherited* — an allowlisted `PATH` of
symlinked tools plus controlled stubs, a sandbox `HOME`, a sandbox npm cache,
and nothing of the caller's OAS/pi context — and drives
the distributed payload exactly as a consumer would: install → flat
materialization → `lockfileVersion: 2` → exact restore → explicit template
adoption and recorded base → per-capability trust → `oas linear` dispatch →
`oas spawn` briefing, injection, and task-layer composition. Both run in CI on
every pull request.

Host-executable isolation matters more than it looks: released 0.20 resolves the
runtime binary *before* it honors `--no-launch`, so even a scaffold-only spawn
needs `pi` on `PATH`. A probe that inherited the developer's `PATH` would pass
locally and fail in CI. The probe therefore controls both directions — it
asserts spawn refuses with no runtime present, then supplies a stub runtime that
fails loudly if executed and asserts `launched: false` with the stub never run.

Layout note: `oas-package/` is the exact distributed payload. Everything else in
this repository — `schemas/`, `scripts/`, `test/`, CI, and the owner soul under
`agents/` — is tooling that is never installed.
