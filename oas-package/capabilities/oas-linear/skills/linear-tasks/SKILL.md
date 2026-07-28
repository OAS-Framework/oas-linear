---
name: linear-tasks
description: >-
  Linear task tracking for OAS agent instances. Use when reading an agent's
  Linear work queue, opening or inspecting an issue, creating issues or
  sub-issues, claiming work with an agent label, posting progress/blocker/
  handoff comments, or moving work through Linear workflow states. Also use
  when asked about "my issue", "the project", "the board", a Linear issue key
  such as ENG-123, or shared task status. Uses JSON-first `oas linear` commands.
---

# Agent task tracking in Linear

Linear is your deployment's **tasks layer**: task status and outcomes live
here. Conversation lives in the messaging layer; a message may nudge someone,
but it never replaces the Linear update.

## Deployment target and authentication

Get the target from the `Tasks: Linear` line in your `TASK.md` briefing:

- **team** is required and uses Linear's issue-prefix key (for example `ENG`).
- **project** is an optional deployment default. Do not invent one when unset.
- **alias** is your exact OAS instance name; your label is `agent-<alias>`.

Before the first operation, run:

```bash
oas linear auth
oas linear teams
```

If `LINEAR_API_KEY` is missing or rejected, **stop and ask the human** to create
or export a personal API key (Linear Settings → Security & access → API keys).
Never ask for the key's value, print it, put it in a command argument, or store
it in OAS config/files. Never attempt an interactive login.

Commands emit JSON. An error is JSON on stderr with a non-zero exit code; act
on that error rather than retrying variants blindly.

## Hierarchy

- **Project** — an optional, human-owned outcome or initiative container. Do
  not create, rename, change status, or close projects.
- **Issue** — the normal bounded work item assigned to an agent.
- **Sub-issue** — an issue with a parent, used only when the parent genuinely
  decomposes into multiple independently verifiable pieces.

Do not create placeholder parent issues for one child. Every issue belongs to
a team; project membership is optional unless your briefing names a project.

## Project context and documentation

Use project-level and issue-level records deliberately:

- **Project overview**: intent, scope/non-goals, ownership, constraints, human
  gates, architecture, and success criteria.
- **Project documents**: detailed designs, decisions, runbooks, and research.
- **Issues/sub-issues**: bounded execution and acceptance criteria.
- **Issue comments**: milestones, blockers, handoffs, verification, and links.

The overview/documents explain the work; issues execute it. Link a governing
project document from each affected issue rather than copying inconsistent
versions. Keep task status in issues, not project prose or messaging.

The current wrapper can discover project metadata but **cannot read or mutate
project overview Markdown or Linear documents**:

```bash
oas linear projects --team <TEAM>
```

That output includes project IDs, names, slugs, status, and teams. Project
creation, lifecycle/status, overview content, documents, and project updates
remain human-owned in the Linear UI. If your task depends on unavailable
project documentation, ask the human for its URL/content; never infer policy
from an issue title.

## Identity and ownership

- Keep the **human assignee unchanged**. A personal API key acts as its human;
  OAS agents are not Linear users.
- Claim work with label `agent-<exact-instance-name>`. `--agent <alias>` creates
  this team-scoped label on first use and applies it.
- New issue descriptions also receive `Agent: <alias>`. On existing issues,
  use the label and comments; do not rewrite a human's description merely to
  add the line.
- Never delete issues, labels, or comments. Do not change cycle, priority,
  project, parent, or assignee unless explicitly directed.

## Read before writing

```bash
# Your open queue (terminal states excluded by default)
oas linear issue list --team <TEAM> --agent <alias>

# Narrow to the deployment project when one is configured
oas linear issue list --team <TEAM> --agent <alias> --project "<PROJECT>"

# Read full task context before acting
oas linear issue get <TEAM>-123

# Discover this team's real workflow names; never guess them
oas linear states --team <TEAM>
```

`issue get` includes team, status/type, project, parent, assignee, labels,
description, and URL. Read the parent too when working a sub-issue. Record the
issue key in instance memory (`STATE.md`) if your knowledge layer provides it.

## Work an issue

1. Read the issue and parent/project context.
2. If not already claimed, apply your identity label:

   ```bash
   oas linear issue update <TEAM>-123 --agent <alias>
   ```

3. Move to the deployment's `started` workflow state (often `In Progress`),
   using the exact name returned by `oas linear states`:

   ```bash
   oas linear issue update <TEAM>-123 --state "In Progress"
   ```

4. Post only useful durable events, prefixed with your alias:

   ```bash
   oas linear issue comment <TEAM>-123 \
     --body "[<alias>] milestone: implemented parser; tests pass with node --test"
   oas linear issue comment <TEAM>-123 \
     --body "[<alias>] blocked: need API scope decision from @owner"
   oas linear issue comment <TEAM>-123 \
     --body "[<alias>] handoff → <next-alias>: branch agents/x, verify with npm test"
   ```

5. When implementation is review-ready, comment the outcome (branch/PR and
   verification), then move to the team's review state. Do **not** mark it
   completed:

   ```bash
   oas linear issue comment <TEAM>-123 \
     --body "[<alias>] review-ready: PR <url>; verified npm test"
   oas linear issue update <TEAM>-123 --state "In Review"
   ```

Workflow names vary. Agents may use backlog/unstarted/started states. The
wrapper refuses `completed`, `canceled`, and `duplicate` state types unless
`--allow-terminal` is supplied; use that override only after explicit human
authorization and mention that authorization in a comment.

## Create bounded work

Use ≤12 words in the title. Describe requirements and acceptance checks, not a
speculative implementation. For multiline Markdown, prefer a file so shell
quoting cannot corrupt it.

```bash
cat > /tmp/linear-description.md <<'EOF'
Why this is needed.

Acceptance:
- [ ] Observable outcome one
- [ ] Verification command or evidence
EOF

oas linear issue create --team <TEAM> --project "<PROJECT>" \
  --title "Bounded outcome" --description-file /tmp/linear-description.md \
  --agent <alias>
```

Omit `--project` when the briefing has none. Create a sub-issue only for a real
independent slice:

```bash
oas linear issue create --team <TEAM> --parent <TEAM>-123 \
  --title "Independent child outcome" \
  --description-file /tmp/linear-description.md --agent <alias>
```

`--project` sets project membership; `--parent` sets issue hierarchy. They are
independent, so supply both when a sub-issue must explicitly carry the project:

```bash
oas linear issue create --team <TEAM> --project "<PROJECT>" \
  --parent <TEAM>-123 --title "Independent child outcome" \
  --description-file /tmp/linear-description.md --agent <alias>
```

Use an existing non-agent label only after discovery:

```bash
oas linear labels --team <TEAM>
oas linear issue create --team <TEAM> --title "Fix token refresh" \
  --label bug --agent <alias>
```

## Current command boundary

Supported: discover teams/states/projects/labels; list/get/create/update/comment
on issues; create sub-issues; claim work with agent labels.

Not supported: create/update/close projects; read/edit project overviews;
list/read/create/edit project documents; publish project updates; move an
existing issue into/out of a project; reparent an existing issue; or create
issue relations such as blocks/related. Those operations stay in the Linear
UI with the human. **Do not invent GraphQL calls or command flags to bypass
this boundary.**

## Validate every mutation

Mutation output is the resulting issue/comment. Check its identifier, status,
project/parent, and labels immediately. Then run `issue get` for
correctness-critical changes. If a GraphQL permission or validation error
persists, post no partial workaround: preserve the task state and escalate to
the human with the exact error (never the key).
