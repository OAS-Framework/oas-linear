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

/** Scalar values of uncommented settings: `key: value` and `- value` list items. */
function scalarValues(text) {
  const found = [];
  for (const line of uncommented(text).split("\n")) {
    const pair = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*:\s*(\S.*?)\s*$/);
    if (pair) { found.push({ key: pair[1], value: unquote(pair[2]) }); continue; }
    const item = line.match(/^\s*-\s+(\S.*?)\s*$/);
    if (item) found.push({ key: undefined, value: unquote(item[1]) });
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
    if (key && LOCAL_KEYS.test(key)) leaks.push(`sets the deployment-local key \`${key}:\``);
    else if (isAbsolutePathValue(value)) leaks.push(`sets an absolute path (${key ? `${key}: ` : ""}${value})`);
  }
  return [...new Set(leaks)];
}
