/**
 * One predicate for "is this config template portable?", shared by the manifest
 * validator and the consumer probe so the two can never drift apart.
 *
 * A config template is copied VERBATIM into somebody else's repository and
 * committed there. Anything a specific deployment owns — a credential, an
 * account, a workspace, a provider-local ID, or a path that only exists on one
 * machine — becomes a leak in a foreign repo the moment the template is
 * adopted. Guidance for those values belongs in comments the adopter fills in,
 * never as a live setting.
 *
 * Two passes, because comments are copied too but prose is not a setting:
 *
 *   ALWAYS  things that are machine- or account-specific no matter where they
 *           appear, comments included: credentials, workspace URLs, provider
 *           UUIDs, and home-rooted paths.
 *   VALUES  scalar values of UNCOMMENTED settings: any absolute path in POSIX,
 *           Windows-drive, UNC or `~` form, and any deployment-local key.
 */

/** Deployment-local setting names: an adopter owns these, a package never ships them. */
const LOCAL_KEYS = /^(team|project|account|workspace|organization|org|api[_-]?key|apikey|token|secret|password|credential)$/i;

/** Machine- or account-specific no matter where it appears. */
const ALWAYS = [
  [/lin_api_[A-Za-z0-9]/, "a Linear API key"],
  [/https:\/\/linear\.app\/[^\s"']+/, "a workspace-local linear.app URL"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a provider-local UUID"],
  [/(^|[\s"'(=])(\/Users\/|\/home\/|\/root\/|~\/|[A-Za-z]:[\\/]Users[\\/])/, "a home-rooted machine path"],
];

/** Absolute in ANY filesystem dialect a config might carry. */
export function isAbsolutePathValue(value) {
  return /^\//.test(value)                 // POSIX            /opt/acme/x
    || /^[A-Za-z]:[\\/]/.test(value)       // Windows drive    C:\x  and  C:/x
    || /^\\\\[^\\]+\\/.test(value)         // UNC              \\host\share\x
    || /^~(\/|\\|$)/.test(value);          // home-relative    ~/x
}

/** Strip line comments. Good enough for a config template, which is the only
 *  thing this is ever pointed at — a `#` inside a quoted scalar would be
 *  over-stripped, and over-stripping can only make this check more permissive
 *  on comment prose, never on a live setting. */
export const uncommented = (text) => text.split("\n").map((line) => line.replace(/#.*$/, "")).join("\n");

const unquote = (value) => value.replace(/^(['"])(.*)\1$/, "$2").trim();

/**
 * Key/value split mirroring the SUPPORTED YAML subset of released OAS 0.20
 * (`parseYamlNested` in lib/core.mjs), which accepts a quoted OR unquoted key:
 *
 *   /^(\s*)((?:["'][^"']+["'])|(?:[^:#][^:]*?)):\s*(.*?)\s*$/
 *
 * Matching a narrower shape than the kernel honors is how a leak slips
 * through: `"account": acme-inc` is a live setting to the kernel, so it must be
 * a live setting to this scanner too.
 */
const KEY_VALUE = /^\s*((?:["'][^"']+["'])|(?:[^:#][^:]*?)):\s*(.*?)\s*$/;

/** Inner `key: value` pairs of a flow mapping — `{ a: 1, b: /x }`. The kernel
 *  keeps a flow map as an opaque scalar rather than a nested map, but the bytes
 *  are still copied into the adopter's repository, so a machine path or an
 *  account inside one is still a leak. */
function flowPairs(value) {
  const pairs = [];
  const body = value.match(/^\{(.*)\}$/s);
  if (!body) return pairs;
  for (const part of body[1].split(",")) {
    const m = part.match(KEY_VALUE);
    if (m) pairs.push({ key: unquote(m[1]), value: unquote(m[2]) });
  }
  return pairs;
}

/** Every scalar-ish token in a value, so an absolute path embedded anywhere —
 *  a flow map, a list, an argument string — is still seen. */
const tokens = (value) => value.split(/[\s,{}[\]]+/).map(unquote).filter(Boolean);

/** Scalar values of uncommented settings: `key: value` pairs (quoted keys
 *  included), `- value` list items, and the innards of flow mappings. */
function scalarValues(text) {
  const found = [];
  const push = (key, value) => {
    found.push({ key, value });
    for (const inner of flowPairs(value)) found.push(inner);
  };
  for (const line of uncommented(text).split("\n")) {
    if (!line.trim()) continue;
    const pair = line.match(KEY_VALUE);
    if (pair) { push(unquote(pair[1]), unquote(pair[2])); continue; }
    const item = line.match(/^\s*-\s+(\S.*?)\s*$/);
    if (item) push(undefined, unquote(item[1]));
  }
  return found;
}

/**
 * @param {string} text  the template's contents
 * @returns {string[]}   human-readable reasons; empty means portable
 */
export function portabilityLeaks(text) {
  const leaks = [];
  for (const [pattern, what] of ALWAYS) {
    if (pattern.test(text)) leaks.push(`contains ${what}`);
  }
  for (const { key, value } of scalarValues(text)) {
    if (key && LOCAL_KEYS.test(key)) { leaks.push(`sets the deployment-local key \`${key}:\``); continue; }
    // Any token, not just a value that STARTS with a path: a flow mapping or an
    // argument string embeds the path mid-value.
    const path = tokens(value).find(isAbsolutePathValue);
    if (path) leaks.push(`sets an absolute path (${key ? `${key}: ` : ""}${path})`);
  }
  return [...new Set(leaks)];
}
