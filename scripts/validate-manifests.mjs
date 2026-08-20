#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { portabilityLeaks } from "./lib/config-portability.mjs";

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
  if (typeof candidate !== "string" || !candidate.trim()) { report(at, `${kind} must be a non-empty string`); return false; }
  if (isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) { report(at, `${kind} must be package-relative and may not contain '..'`); return false; }
  const target = resolve(base, candidate);
  if (!existsSync(target)) { report(at, `${kind} does not exist: ${candidate}`); return false; }
  const realBoundary = realpathSync(boundary);
  const realTarget = realpathSync(target);
  if (realTarget !== realBoundary && !realTarget.startsWith(realBoundary + sep)) {
    report(at, `${kind} escapes the ${boundaryLabel} after symlink resolution`);
    return false;
  }
  return true;
}

/** Walk a DECLARED directory tree and bound every descendant by the capability
 *  root. The declared path resolving inside the root is not enough: a
 *  descendant symlink can still point at package-only bytes that
 *  materialization never copies, and the released kernel rejects exactly that
 *  ("contains a path escaping its capability root"). A visited set keeps
 *  contained link cycles from looping. */
function walkContained(capabilityRoot, dir, at, kind, visited = new Set()) {
  if (!statSync(dir).isDirectory()) return;
  const realBoundary = realpathSync(capabilityRoot);
  const realDir = realpathSync(dir);
  if (visited.has(realDir)) return;
  visited.add(realDir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    let realChild;
    try { realChild = realpathSync(child); }
    catch { report(at, `${kind} contains a broken symlink: ${relative(capabilityRoot, child)}`); continue; }
    if (realChild !== realBoundary && !realChild.startsWith(realBoundary + sep)) {
      report(at, `${kind} contains a path escaping the capability root: ${relative(capabilityRoot, child)} → ${realChild}`);
      continue;
    }
    if (statSync(realChild).isDirectory()) walkContained(capabilityRoot, realChild, at, kind, visited);
  }
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
  // Compare REAL paths: a lexical comparison is bypassable with a symlink whose
  // target sits inside a capability root, which is exactly the case that
  // matters here because such a template WOULD be materialized.
  const realTemplate = realpathSync(target);
  for (const capabilityRoot of capabilityRootDirs) {
    if (!existsSync(capabilityRoot)) continue;
    const realCapabilityRoot = realpathSync(capabilityRoot);
    if (realTemplate === realCapabilityRoot || realTemplate.startsWith(realCapabilityRoot + sep)) {
      report(at, `config template must live outside every capability root (resolves inside ${relative(root, capabilityRoot)})`);
    }
  }
  // Portability — one shared predicate with the consumer probe (scripts/lib).
  for (const leak of portabilityLeaks(readFileSync(target, "utf8"))) {
    report(at, `config template must stay portable but ${leak}`);
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
  for (const [resourceIndex, resource] of (manifest.skills || []).entries()) {
    const at = `${capabilityDir}/oas.json.skills[${resourceIndex}]`;
    if (safeResource(capabilityRoot, resource, at, "skill path", capabilityRoot, "capability root")) {
      // A skills entry may be a file OR a directory — the released kernel walks
      // it only when it is a directory. Parity: same rule here.
      walkContained(capabilityRoot, resolve(capabilityRoot, resource), at, "skill tree");
    }
  }
  if (manifest.inject) safeResource(capabilityRoot, manifest.inject, `${capabilityDir}/oas.json.inject`, "injection path", capabilityRoot, "capability root");
  for (const [agentIndex, agent] of (manifest.agents || []).entries()) {
    const at = `${capabilityDir}/oas.json.agents[${agentIndex}]`;
    if (!safeResource(capabilityRoot, agent, at, "agent path", capabilityRoot, "capability root")) continue;
    // ASYMMETRY WITH skills[], and it is the released kernel's, not ours: a
    // capability-defined agent MUST resolve to a soul DIRECTORY. The 0.20
    // kernel rejects a non-directory outright ("capability-defined agent ... is
    // not a directory"), so a validator that merely walks-if-directory would
    // green-light a package that install refuses.
    if (!statSync(resolve(capabilityRoot, agent)).isDirectory()) {
      report(at, "capability-defined agent must be a directory (a soul directory), not a file");
      continue;
    }
    walkContained(capabilityRoot, resolve(capabilityRoot, agent), at, "capability-defined agent");
  }
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
