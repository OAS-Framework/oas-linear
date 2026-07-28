import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../oas-package", import.meta.url)));
const DIR = join(ROOT, "capabilities", "oas-linear");
const CLI = join(DIR, "bin", "oas-linear.mjs");
const HOOK = join(DIR, "bin", "oas-linear-hook.mjs");

function run(script, args = [], env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function mockApi(responder, fn) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ headers: request.headers, ...parsed });
    const payload = await responder(parsed, requests);
    response.writeHead(payload.status || 200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload.body || payload));
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${server.address().port}/graphql`;
  try { await fn({ url, requests }); }
  finally { await new Promise((closed) => server.close(closed)); }
}

const team = { id: "team-1", key: "ENG", name: "Engineering" };
const issue = {
  id: "issue-1", identifier: "ENG-1", title: "Test issue", description: "body",
  url: "https://linear.app/issue/ENG-1", priority: 0, priorityLabel: "No priority",
  team, state: { id: "started-1", name: "In Progress", type: "started" },
  project: null, parent: null, assignee: { id: "human-1", name: "Human", email: "human@example.com" },
  labels: { nodes: [] },
};

function operation(query) { return query.match(/(?:query|mutation)\s+(\w+)/)?.[1]; }

test("missing API key fails once with setup guidance", async () => {
  const result = await run(CLI, ["auth"], { LINEAR_API_KEY: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /LINEAR_API_KEY is not set/);
  assert.match(result.stderr, /Security & access/);
});

test("auth uses the personal-key Authorization header", async () => {
  await mockApi(() => ({ data: {
    viewer: { id: "user-1", name: "Human", email: "human@example.com" },
    organization: { id: "org-1", name: "Acme", urlKey: "acme" },
  } }), async ({ url, requests }) => {
    const result = await run(CLI, ["auth"], { LINEAR_API_KEY: "secret-key", LINEAR_API_URL: url });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).authenticated, true);
    assert.equal(requests[0].headers.authorization, "secret-key");
    assert.equal(operation(requests[0].query), "OasLinearAuth");
  });
});

test("issue list builds an open agent/project filter", async () => {
  await mockApi(({ query }) => {
    if (operation(query) === "OasLinearTeam") return { data: { teams: { nodes: [team] } } };
    if (operation(query) === "OasLinearProjects") return { data: { projects: { nodes: [
      { id: "project-1", name: "Agent Platform", slugId: "agent-platform", status: { id: "ps-1", name: "Started", type: "started" }, teams: { nodes: [team] } },
    ] } } };
    if (operation(query) === "OasLinearIssues") return { data: { issues: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: null } } } };
    throw new Error(`unexpected operation ${operation(query)}`);
  }, async ({ url, requests }) => {
    const result = await run(CLI, ["issue", "list", "--team", "ENG", "--agent", "worker-1", "--project", "Agent Platform"], {
      LINEAR_API_KEY: "key", LINEAR_API_URL: url,
    });
    assert.equal(result.code, 0, result.stderr);
    const listRequest = requests.find((request) => operation(request.query) === "OasLinearIssues");
    assert.deepEqual(listRequest.variables.filter, {
      team: { id: { eq: "team-1" } },
      state: { type: { nin: ["completed", "canceled", "duplicate"] } },
      labels: { some: { name: { eqIgnoreCase: "agent-worker-1" } } },
      project: { id: { eq: "project-1" } },
    });
  });
});

test("issue create provisions the agent label and records identity", async () => {
  await mockApi(({ query, variables }) => {
    const op = operation(query);
    if (op === "OasLinearTeam") return { data: { teams: { nodes: [team] } } };
    if (op === "OasLinearLabels") return { data: { issueLabels: { nodes: [] } } };
    if (op === "OasLinearCreateLabel") return { data: { issueLabelCreate: {
      success: true, issueLabel: { id: "label-1", name: variables.input.name, color: "#5E6AD2", team },
    } } };
    if (op === "OasLinearIssueCreate") return { data: { issueCreate: { success: true, issue } } };
    throw new Error(`unexpected operation ${op}`);
  }, async ({ url, requests }) => {
    const result = await run(CLI, ["issue", "create", "--team", "ENG", "--title", "Bounded work", "--description", "Acceptance", "--agent", "worker-1"], {
      LINEAR_API_KEY: "key", LINEAR_API_URL: url,
    });
    assert.equal(result.code, 0, result.stderr);
    const create = requests.find((request) => operation(request.query) === "OasLinearIssueCreate");
    assert.equal(create.variables.input.teamId, "team-1");
    assert.deepEqual(create.variables.input.labelIds, ["label-1"]);
    assert.match(create.variables.input.description, /Acceptance\n\n---\nAgent: worker-1/);
  });
});

test("terminal transitions require explicit authorization", async () => {
  await mockApi(({ query }) => {
    const op = operation(query);
    if (op === "OasLinearIssue") return { data: { issue } };
    if (op === "OasLinearStates") return { data: { team: { states: { nodes: [
      { id: "done-1", name: "Done", type: "completed", position: 1 },
    ] } } } };
    throw new Error(`unexpected operation ${op}`);
  }, async ({ url, requests }) => {
    const result = await run(CLI, ["issue", "update", "ENG-1", "--state", "Done"], {
      LINEAR_API_KEY: "key", LINEAR_API_URL: url,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing terminal state/);
    assert.equal(requests.some((request) => operation(request.query) === "OasLinearIssueUpdate"), false);
  });
});

test("comment accepts multiline markdown from a file", async () => {
  const temp = mkdtempSync(join(tmpdir(), "oas-linear-test-"));
  const bodyFile = join(temp, "comment.md");
  writeFileSync(bodyFile, "[worker-1] handoff: details\n\n- tests pass\n");
  try {
    await mockApi(({ query }) => {
      assert.equal(operation(query), "OasLinearComment");
      return { data: { commentCreate: { success: true, comment: { id: "comment-1", body: "ok", createdAt: "2026-07-10", url: "https://linear.app/c/1", user: { id: "user-1", name: "Human" } } } } };
    }, async ({ url, requests }) => {
      const result = await run(CLI, ["issue", "comment", "ENG-1", "--body-file", bodyFile], {
        LINEAR_API_KEY: "key", LINEAR_API_URL: url,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests[0].variables.input.body, "[worker-1] handoff: details\n\n- tests pass");
    });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("spawn hook briefs settings and warns without auth", async () => {
  const result = await run(HOOK, ["spawn"], {
    OAS_EVENT: "spawn", OAS_INSTANCE: "worker-1",
    OAS_SETTINGS: JSON.stringify({ team: "ENG", project: "Agent Platform" }),
    LINEAR_API_KEY: "",
  });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.meta, { label: "agent-worker-1", team: "ENG", project: "Agent Platform" });
  assert.match(payload.brief, /team ENG, default project Agent Platform/);
  assert.match(payload.warning, /LINEAR_API_KEY/);
});
