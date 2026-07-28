#!/usr/bin/env node
/**
 * JSON-first Linear task operations for OAS.
 *
 * Uses Linear's official GraphQL API directly. No third-party Linear CLI or
 * SDK is required; authentication is a personal key in LINEAR_API_KEY.
 */
import { readFileSync } from "node:fs";

const API_URL = process.env.LINEAR_API_URL || "https://api.linear.app/graphql";
const argv = process.argv.slice(2);
const command = argv.shift();

function die(message, details) {
  process.stderr.write(JSON.stringify({ error: String(message), ...(details ? { details } : {}) }, null, 2) + "\n");
  process.exit(1);
}
function print(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function parseArgs(values) {
  const options = new Map();
  const positional = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const name = value.slice(2);
    const next = values[i + 1];
    const parsed = next !== undefined && !next.startsWith("--") ? values[++i] : true;
    const previous = options.get(name) || [];
    previous.push(parsed);
    options.set(name, previous);
  }
  return {
    positional,
    has: (name) => options.has(name),
    one: (name) => options.get(name)?.at(-1),
    many: (name) => options.get(name) || [],
  };
}
const args = parseArgs(argv);

async function graphql(query, variables = {}) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) die("LINEAR_API_KEY is not set", "Create a personal API key in Linear Settings → Security & access → API keys, export it, then run `oas linear auth`.");
  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": key,
        "Content-Type": "application/json",
        "User-Agent": "oas-linear/0.1",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    die(`Linear API request failed: ${error.message || error}`);
  }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { die(`Linear API returned HTTP ${response.status} with non-JSON content`, text.slice(0, 500)); }
  if (!response.ok || payload.errors?.length) {
    const errors = (payload.errors || []).map((error) => ({
      message: error.extensions?.userPresentableMessage || error.message,
      code: error.extensions?.code,
      path: error.path,
    }));
    const hint = response.status === 401 ? "Check LINEAR_API_KEY and run `oas linear auth`." : undefined;
    die(`Linear API request failed (HTTP ${response.status})`, { errors, ...(hint ? { hint } : {}) });
  }
  return payload.data;
}

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const ISSUE_FIELDS = `
  id identifier title description url priority priorityLabel
  team { id key name }
  state { id name type }
  project { id name slugId }
  parent { id identifier title }
  assignee { id name email }
  labels(first: 100) { nodes { id name } }
`;

async function teamByKey(key) {
  if (!key || key === true) die("--team <KEY> is required");
  const data = await graphql(`
    query OasLinearTeam($key: String!) {
      teams(first: 2, filter: { key: { eqIgnoreCase: $key } }) { nodes { id key name } }
    }
  `, { key });
  if (data.teams.nodes.length === 0) die(`Linear team "${key}" was not found`, "Run `oas linear teams` and use its key.");
  if (data.teams.nodes.length > 1) die(`Linear team key "${key}" is ambiguous`);
  return data.teams.nodes[0];
}

async function statesForTeam(team) {
  const data = await graphql(`
    query OasLinearStates($id: String!) {
      team(id: $id) { states(first: 100) { nodes { id name type position } } }
    }
  `, { id: team.id });
  return data.team.states.nodes.sort((a, b) => a.position - b.position);
}
async function stateByName(team, name) {
  const states = await statesForTeam(team);
  const matches = states.filter((state) => state.id === name || state.name.toLowerCase() === String(name).toLowerCase());
  if (matches.length !== 1) die(`Workflow state "${name}" was not found for team ${team.key}`, { available: states.map((state) => `${state.name} (${state.type})`) });
  return matches[0];
}

async function labelsForTeam(team) {
  const data = await graphql(`
    query OasLinearLabels($teamId: ID!) {
      issueLabels(first: 250, filter: { or: [
        { team: { null: true } },
        { team: { id: { eq: $teamId } } }
      ] }) {
        nodes { id name color isGroup team { id key } }
      }
    }
  `, { teamId: team.id });
  return data.issueLabels.nodes;
}
async function findLabel(team, name) {
  const labels = await labelsForTeam(team);
  const matches = labels.filter((label) => !label.isGroup && label.name.toLowerCase() === String(name).toLowerCase());
  const scoped = matches.find((label) => label.team?.id === team.id);
  return scoped || matches.find((label) => !label.team);
}
async function ensureAgentLabel(team, alias) {
  const name = `agent-${alias}`;
  const existing = await findLabel(team, name);
  if (existing) return existing;
  const data = await graphql(`
    mutation OasLinearCreateLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) { success issueLabel { id name color team { id key } } }
    }
  `, { input: { name, teamId: team.id, color: "#5E6AD2", description: "OAS agent instance identity" } });
  if (!data.issueLabelCreate.success) die(`Linear did not create label "${name}"`);
  return data.issueLabelCreate.issueLabel;
}
async function labelByName(team, name) {
  const label = await findLabel(team, name);
  if (!label) die(`Label "${name}" was not found for team ${team.key}`, "Create it in Linear first. Agent labels are created automatically by --agent.");
  return label;
}

async function projectsForTeam(team) {
  const data = await graphql(`
    query OasLinearProjects($teamId: ID!) {
      projects(first: 250, filter: { accessibleTeams: { some: { id: { eq: $teamId } } } }) {
        nodes { id name slugId status { id name type } teams(first: 20) { nodes { id key name } } }
      }
    }
  `, { teamId: team.id });
  return data.projects.nodes;
}
async function projectByRef(team, ref) {
  const projects = await projectsForTeam(team);
  const needle = String(ref).toLowerCase();
  const matches = projects.filter((project) =>
    project.id === ref || project.slugId.toLowerCase() === needle || project.name.toLowerCase() === needle);
  if (matches.length !== 1) die(`Project "${ref}" ${matches.length ? "is ambiguous" : "was not found"} for team ${team.key}`, { available: projects.map((project) => ({ name: project.name, slug: project.slugId })) });
  return matches[0];
}

async function issueById(id) {
  if (!id || id === true) die("an issue identifier such as ENG-123 is required");
  const data = await graphql(`
    query OasLinearIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }
  `, { id });
  return data.issue;
}

function textOption(name) {
  const inline = args.one(name);
  const file = args.one(`${name}-file`);
  if (inline !== undefined && file !== undefined) die(`use only one of --${name} or --${name}-file`);
  if (file !== undefined) {
    if (file === true) die(`--${name}-file needs a path`);
    try { return readFileSync(file, "utf8").trim(); }
    catch (error) { die(`cannot read --${name}-file ${file}: ${error.message}`); }
  }
  return inline;
}
function assertTerminalAllowed(state) {
  if (["completed", "canceled", "duplicate"].includes(state.type) && !args.has("allow-terminal")) {
    die(`refusing terminal state "${state.name}" without --allow-terminal`, "Agents should hand work to review, not close or cancel it. Use --allow-terminal only with explicit human authorization.");
  }
}

async function auth() {
  const data = await graphql(`
    query OasLinearAuth { viewer { id name email } organization { id name urlKey } }
  `);
  print({ authenticated: true, endpoint: API_URL, viewer: data.viewer, workspace: data.organization });
}
async function teams() {
  const data = await graphql(`
    query OasLinearTeams { teams(first: 100) { nodes { id key name } } }
  `);
  print(data.teams.nodes);
}
async function states() {
  const team = await teamByKey(args.one("team"));
  print(await statesForTeam(team));
}
async function projects() {
  const team = await teamByKey(args.one("team"));
  print(await projectsForTeam(team));
}
async function labels() {
  const team = await teamByKey(args.one("team"));
  print(await labelsForTeam(team));
}

async function listIssues() {
  const team = await teamByKey(args.one("team"));
  const requestedLimit = Number(args.one("limit") || 100);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 250) die("--limit must be an integer from 1 to 250");
  const filter = { team: { id: { eq: team.id } } };
  if (!args.has("all")) filter.state = { type: { nin: ["completed", "canceled", "duplicate"] } };
  if (args.one("agent")) filter.labels = { some: { name: { eqIgnoreCase: `agent-${args.one("agent")}` } } };
  if (args.one("project")) {
    const project = await projectByRef(team, args.one("project"));
    filter.project = { id: { eq: project.id } };
  }
  const data = await graphql(`
    query OasLinearIssues($first: Int!, $filter: IssueFilter) {
      issues(first: $first, filter: $filter) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }
    }
  `, { first: requestedLimit, filter });
  print({ issues: data.issues.nodes, pageInfo: data.issues.pageInfo });
}
async function createIssue() {
  const team = await teamByKey(args.one("team"));
  const title = args.one("title");
  if (!title || title === true) die("--title <text> is required");
  let description = textOption("description");
  const input = { teamId: team.id, title };
  if (description !== undefined) input.description = description;
  if (args.one("project")) input.projectId = (await projectByRef(team, args.one("project"))).id;
  if (args.one("parent")) input.parentId = args.one("parent");
  if (args.one("state")) {
    const state = await stateByName(team, args.one("state"));
    assertTerminalAllowed(state);
    input.stateId = state.id;
  }
  const issueLabels = [];
  if (args.one("agent")) {
    const alias = args.one("agent");
    issueLabels.push(await ensureAgentLabel(team, alias));
    if (!/^Agent:/mi.test(description || "")) {
      description = `${description ? `${description.trim()}\n\n` : ""}---\nAgent: ${alias}`;
      input.description = description;
    }
  }
  for (const name of args.many("label")) issueLabels.push(await labelByName(team, name));
  if (issueLabels.length) input.labelIds = [...new Set(issueLabels.map((label) => label.id))];
  const data = await graphql(`
    mutation OasLinearIssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
    }
  `, { input });
  if (!data.issueCreate.success || !data.issueCreate.issue) die("Linear did not create the issue");
  print(data.issueCreate.issue);
}
async function updateIssue(id) {
  const current = await issueById(id);
  const team = current.team;
  const input = {};
  if (args.has("title")) input.title = args.one("title");
  const description = textOption("description");
  if (description !== undefined) input.description = description;
  if (args.one("state")) {
    const state = await stateByName(team, args.one("state"));
    assertTerminalAllowed(state);
    input.stateId = state.id;
  }
  const added = [];
  if (args.one("agent")) added.push((await ensureAgentLabel(team, args.one("agent"))).id);
  for (const name of args.many("add-label")) added.push((await labelByName(team, name)).id);
  const removed = [];
  for (const name of args.many("remove-label")) removed.push((await labelByName(team, name)).id);
  if (added.length) input.addedLabelIds = [...new Set(added)];
  if (removed.length) input.removedLabelIds = [...new Set(removed)];
  if (Object.keys(input).length === 0) die("no update supplied", "Use --title, --description[-file], --state, --agent, --add-label, or --remove-label.");
  const data = await graphql(`
    mutation OasLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
    }
  `, { id, input });
  if (!data.issueUpdate.success || !data.issueUpdate.issue) die(`Linear did not update ${id}`);
  print(data.issueUpdate.issue);
}
async function commentIssue(id) {
  const body = textOption("body");
  if (!body || body === true) die("--body <markdown> or --body-file <path> is required");
  const data = await graphql(`
    mutation OasLinearComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id body createdAt url user { id name } } }
    }
  `, { input: { issueId: id, body } });
  if (!data.commentCreate.success) die(`Linear did not comment on ${id}`);
  print(data.commentCreate.comment);
}

function usage() {
  process.stderr.write(`oas linear commands (all output JSON):
  auth
  teams
  states --team <KEY>
  projects --team <KEY>
  labels --team <KEY>
  issue list --team <KEY> [--agent <alias>] [--project <name|slug>] [--all] [--limit 100]
  issue get <KEY-123>
  issue create --team <KEY> --title <text> [--description <md>|--description-file <path>]
      [--project <name|slug>] [--parent <KEY-123>] [--state <name>] [--agent <alias>]
      [--label <name> ...]
  issue update <KEY-123> [--title <text>] [--description <md>|--description-file <path>]
      [--state <name>] [--agent <alias>] [--add-label <name> ...] [--remove-label <name> ...]
      [--allow-terminal]
  issue comment <KEY-123> (--body <md>|--body-file <path>)
`);
  process.exit(1);
}

if (command === "auth") await auth();
else if (command === "teams") await teams();
else if (command === "states") await states();
else if (command === "projects") await projects();
else if (command === "labels") await labels();
else if (command === "issue") {
  const subcommand = args.positional[0];
  const id = args.positional[1];
  if (subcommand === "list") await listIssues();
  else if (subcommand === "get") print(await issueById(id));
  else if (subcommand === "create") await createIssue();
  else if (subcommand === "update") await updateIssue(id);
  else if (subcommand === "comment") await commentIssue(id);
  else usage();
} else usage();
