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

Start/resume agents from an environment that receives this variable. The spawn hook warns when it is absent; API commands fail with actionable authentication guidance rather than attempting login. The amended package schema and OAS `>=0.19.0` compatibility floor are frozen. See [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md) for the remaining released-kernel fixture gate.

## Acquire and activate

Acquisition does not activate the capability. After an official release exists:

```bash
oas install oas.linear --dir /path/to/scope
oas trust oas.linear --dir /path/to/scope
oas use oas.linear --global --dir /path/to/scope
oas doctor /path/to/scope --soul <soul-name>
```

A pinned Git source may be used after publication:

```bash
oas install git:https://github.com/OAS-Framework/oas-linear.git@v1.0.0 --dir /path/to/scope
```

The commands and spawn hook are executable, so they need explicit per-capability trust tied to the exact package integrity. Configure deployment-owned targeting and settings in `oas-config.yaml` (team is the Linear issue-prefix key; project is an optional briefing default):

```yaml
capabilities:
  layers:
    tasks:
      capability: oas.linear
      from: installed
      global:
        enabled: true
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
npm test
```

This validates both manifests, checks resource containment, and exercises the GraphQL wrapper and advisory hook against local mock servers. The full acquire → lock → trust → activate → spawn probe remains pending released OAS 0.19.0 consumer fixtures.
