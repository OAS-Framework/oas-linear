#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root holds dev tooling (scripts/, schemas/); the DISTRIBUTED package
// payload lives in the `oas-package/` subtree. Manifests and their resources
// are validated against the payload root; the containment boundary is the
// payload root, never the repo root (contract: repo-only tooling is not
// installed bytes and must never be reachable from a package resource path).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repoRoot, "oas-package");
const errors = [];
const report = (path, message) => errors.push(`${path}: ${message}`);
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { report(relative(root, path), `invalid JSON (${error.message})`); return undefined; }
};

function validateSchema(value, schema, at) {
  if (!schema || typeof schema !== "object") return;
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) report(at, `must be one of ${schema.enum.join(", ")}`);
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && actual !== schema.type) { report(at, `must be ${schema.type}, got ${actual}`); return; }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) report(at, `must contain at least ${schema.minLength} character(s)`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) report(at, `must match ${schema.pattern}`);
    if (schema.not?.pattern && (new RegExp(schema.not.pattern)).test(value)) report(at, `must not match ${schema.not.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) report(at, `must contain at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) report(at, "must contain unique items");
    value.forEach((item, index) => validateSchema(item, schema.items, `${at}[${index}]`));
  }
  if (value && actual === "object") {
    for (const key of schema.required || []) if (!(key in value)) report(at, `missing required property ${key}`);
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames?.pattern && !(new RegExp(schema.propertyNames.pattern)).test(key)) report(`${at}.${key}`, `property name must match ${schema.propertyNames.pattern}`);
      if (properties[key]) validateSchema(item, properties[key], `${at}.${key}`);
      else if (schema.additionalProperties === false) report(`${at}.${key}`, "unknown property");
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(item, schema.additionalProperties, `${at}.${key}`);
    }
  }
}

// `boundary` is the directory the resource may not escape after symlink
// resolution. For package-level paths that is the payload root. For anything a
// CAPABILITY declares it is that capability's own dedicated root: 0.20 install
// materializes each capability alone into
// .agents/capabilities/installed/<id>/, so a capability resource that resolves
// into package-only territory simply is not there at runtime.
function safeResource(base, candidate, at, kind = "path", boundary = root, boundaryLabel = "package root") {
  if (typeof candidate !== "string" || !candidate.trim()) { report(at, `${kind} must be a non-empty string`); return; }
  if (isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) { report(at, `${kind} must be package-relative and may not contain '..'`); return; }
  const target = resolve(base, candidate);
  if (!existsSync(target)) { report(at, `${kind} does not exist: ${candidate}`); return; }
  const realBoundary = realpathSync(boundary);
  const realTarget = realpathSync(target);
  if (realTarget !== realBoundary && !realTarget.startsWith(realBoundary + sep)) report(at, `${kind} escapes the ${boundaryLabel} after symlink resolution`);
}

const packagePath = join(root, "oas-package.json");
const packageSchemaPath = join(repoRoot, "schemas", "oas-package.schema.json");
const capabilitySchemaPath = join(repoRoot, "schemas", "capability-manifest.schema.json");
const packageManifest = readJson(packagePath);
const packageSchema = readJson(packageSchemaPath);
const capabilitySchema = readJson(capabilitySchemaPath);

if (packageManifest && packageSchema) validateSchema(packageManifest, packageSchema, "oas-package.json");

// ── Config templates (0.20 contract) ────────────────────────────────────────
// `configTemplates` is the canonical spelling; `configs` stays READABLE in the
// schema only so already-published 0.19 tags remain consumable. New authoring
// emits `configTemplates` and never both.
const hasTemplates = packageManifest?.configTemplates && typeof packageManifest.configTemplates === "object";
const hasLegacyConfigs = packageManifest?.configs && typeof packageManifest.configs === "object";
if (hasTemplates && hasLegacyConfigs) {
  report("oas-package.json", "carrying both `configTemplates` and the deprecated `configs` spelling is an invalid manifest");
} else if (hasLegacyConfigs) {
  report("oas-package.json.configs", "deprecated 0.19 spelling — newly authored packages must emit `configTemplates`");
}

const declaredCapabilities = Array.isArray(packageManifest?.capabilities) ? packageManifest.capabilities : [];
const capabilityRootDirs = declaredCapabilities
  .filter((dir) => typeof dir === "string" && dir && !isAbsolute(dir) && !dir.split(/[\\/]+/).includes(".."))
  .map((dir) => resolve(root, dir));

const templates = hasTemplates ? packageManifest.configTemplates : {};
if (Object.entries(templates).filter(([, spec]) => spec?.default === true).length > 1) {
  report("oas-package.json.configTemplates", "at most one config template may be marked default");
}
for (const [name, spec] of Object.entries(templates)) {
  const at = `oas-package.json.configTemplates.${name}.path`;
  if (!spec?.path) continue;
  safeResource(root, spec.path, at, "config template");
  // Canonical location. The schema pattern says the same thing; saying it here
  // too keeps the authoring error readable instead of a bare regex.
  if (!/^config-templates\/[^/\\][^\\]*$/.test(spec.path)) {
    report(at, "config template must live under config-templates/ (e.g. config-templates/default/oas-config.yaml)");
    continue;
  }
  const target = resolve(root, spec.path);
  if (!existsSync(target)) continue;
  if (!statSync(target).isFile()) { report(at, "config template must be a file"); continue; }
  // A template is package SOURCE MATERIAL and is never materialized. Shipping
  // one inside a capability root would silently install it as capability bytes.
  for (const capabilityRoot of capabilityRootDirs) {
    if (target === capabilityRoot || target.startsWith(capabilityRoot + sep)) {
      report(at, `config template must live outside every capability root (found inside ${relative(root, capabilityRoot)})`);
    }
  }
  // Portability: a template is copied verbatim into somebody else's repository
  // and committed there, so it may carry no credential, account, workspace URL,
  // provider-local ID, or machine path. Comments count — they are copied too.
  const text = readFileSync(target, "utf8");
  const uncommented = text.split("\n").map((line) => line.replace(/#.*$/, "")).join("\n");
  const leaks = [
    [/lin_api_[A-Za-z0-9]/, "a Linear API key"],
    [/(^|[\s"'])(\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\)/, "an absolute machine path"],
    [/https:\/\/linear\.app\/[^\s"']+/, "a workspace-local linear.app URL"],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a provider-local UUID"],
  ];
  for (const [pattern, what] of leaks) {
    if (pattern.test(text)) report(at, `config template must stay portable but contains ${what}`);
  }
  // These must be present only as commented guidance for the adopter to fill in.
  const settings = [
    [/(^|\n)\s*(api[_-]?key|token|secret|password)\s*:\s*\S/i, "a credential setting"],
    [/(^|\n)\s*team\s*:\s*\S/, "a `team:` value (the adopter's Linear issue-prefix key)"],
    [/(^|\n)\s*project\s*:\s*\S/, "a `project:` value (the adopter's Linear project)"],
  ];
  for (const [pattern, what] of settings) {
    if (pattern.test(uncommented)) report(at, `config template must stay portable but sets ${what}`);
  }
}

if (declaredCapabilities.length !== 1) {
  report("oas-package.json.capabilities", `official single-capability package must enumerate exactly one capability directory (found ${declaredCapabilities.length})`);
}

const capabilities = [];
for (const [index, capabilityDir] of declaredCapabilities.entries()) {
  const capabilityAt = `oas-package.json.capabilities[${index}]`;
  // "." (the package root itself) is READ COMPATIBILITY for already-published
  // packages only. Authoring must never emit it: a package-root capability
  // cannot be materialized as a self-contained artifact, and the schema rejects
  // it outright once the manifest carries `configTemplates`.
  if (capabilityDir === ".") {
    report(capabilityAt, "capability root \".\" is read compatibility for already-published packages only — use a dedicated root such as capabilities/<slug>");
    continue;
  }
  safeResource(root, capabilityDir, capabilityAt, "capability directory");
  if (isAbsolute(capabilityDir) || capabilityDir.split(/[\\/]+/).includes("..")) continue;
  const manifestPath = join(root, capabilityDir, "oas.json");
  if (!existsSync(manifestPath)) { report(`oas-package.json.capabilities[${index}]`, `${capabilityDir} has no oas.json`); continue; }
  const manifest = readJson(manifestPath);
  if (!manifest) continue;
  capabilities.push(manifest);
  if (capabilitySchema) validateSchema(manifest, capabilitySchema, `${capabilityDir}/oas.json`);
  const capabilityRoot = dirname(manifestPath);
  // Self-containment: the materialized artifact is this directory alone, so
  // every declared path is resolved AND bounded by it.
  for (const [resourceIndex, resource] of (manifest.skills || []).entries()) safeResource(capabilityRoot, resource, `${capabilityDir}/oas.json.skills[${resourceIndex}]`, "skill path", capabilityRoot, "capability root");
  if (manifest.inject) safeResource(capabilityRoot, manifest.inject, `${capabilityDir}/oas.json.inject`, "injection path", capabilityRoot, "capability root");
  for (const [agentIndex, agent] of (manifest.agents || []).entries()) safeResource(capabilityRoot, agent, `${capabilityDir}/oas.json.agents[${agentIndex}]`, "agent path", capabilityRoot, "capability root");
  // A hook may be a plain "entrypoint args" string or the object form
  // { command, required } (only the spawn hook may set required). Commands are
  // always strings. Reduce either to the executable entrypoint for containment.
  const entrypoint = (spec) => {
    const command = typeof spec === "string" ? spec : (spec && typeof spec === "object" ? spec.command : undefined);
    return typeof command === "string" ? command.trim().split(/\s+/)[0] : command;
  };
  for (const [name, command] of Object.entries(manifest.commands || {})) safeResource(capabilityRoot, entrypoint(command), `${capabilityDir}/oas.json.commands.${name}`, "command entrypoint", capabilityRoot, "capability root");
  for (const [event, hook] of Object.entries(manifest.hooks || {})) safeResource(capabilityRoot, entrypoint(hook), `${capabilityDir}/oas.json.hooks.${event}`, "hook entrypoint", capabilityRoot, "capability root");
  for (const forbidden of ["global", "agent-types", "souls"]) if (forbidden in manifest) report(`${capabilityDir}/oas.json.${forbidden}`, "deployment targeting belongs to config, not a capability manifest");
}

if (capabilities.length === 1 && packageManifest) {
  const capability = capabilities[0];
  if (packageManifest.package === "oas.dev") {
    if (packageManifest.version !== "1.0.0") report("oas-package.json.version", "oas.dev distribution must start at 1.0.0");
    if (capability.capability !== "oas.review" || capability.version !== "1.2.0") {
      report("oas-package.json.capabilities[0]", "oas.dev must export capability oas.review@1.2.0");
    }
  } else {
    if (packageManifest.package !== capability.capability) report("oas-package.json.package", "single-capability official package ID must equal its capability ID");
    if (packageManifest.version !== capability.version) report("oas-package.json.version", "must start at the extracted capability version");
  }
  if (packageManifest.compatibility?.oas !== capability.compatibility?.oas) report("oas-package.json.compatibility.oas", "must match the staged capability compatibility floor");
}

if (errors.length) {
  process.stderr.write(`Manifest validation failed:\n- ${errors.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`Validated ${relative(process.cwd(), packagePath) || "oas-package.json"} and ${capabilities.length} capability manifest(s).\n`);
