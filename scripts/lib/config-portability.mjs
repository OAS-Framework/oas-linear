/**
 * One predicate for "is this config template portable?", shared by the manifest
 * validator and the consumer probe so the two can never drift apart.
 *
 * A config template is copied VERBATIM into somebody else's repository and
 * committed there. Anything a specific deployment owns — a credential, an
 * account, a workspace, a provider-local ID, or a path that only exists on one
 * machine — becomes a leak in a foreign repo the moment the template is
 * adopted.
 *
 * POLICY SCOPE — deliberately BROADER than the kernel's parser.
 *
 * The rule is about COPIED BYTES, not about what `parseYamlNested` happens to
 * honor. That is why comments are scanned at all: the kernel ignores them
 * completely, yet they land in the adopter's repository word for word. By the
 * same reasoning a block-sequence item (`- /opt/acme/x`) is rejected even
 * though released 0.20's parser drops it, and a form the kernel would honor
 * tomorrow is caught today.
 *
 * The kernel's supported subset is therefore a FLOOR, not the definition:
 * anything `parseYamlNested`/`yamlScalar` would turn into a live value must be
 * caught, and this file mirrors their flow-collection recursion for exactly
 * that reason. It is not a claim of exact parser parity, and a rejection here
 * does not imply the kernel would have honored the value.
 *
 * Two passes:
 *   ALWAYS  machine- or account-specific wherever it appears, comments
 *           included: credentials, workspace URLs, provider UUIDs, home paths.
 *   VALUES  scalar values of UNCOMMENTED settings, recursively through flow
 *           mappings and sequences: absolute paths in POSIX, Windows-drive,
 *           UNC and `~` dialects, and deployment-local keys.
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

/**
 * Where an absolute path may START inside a scalar: the beginning, or after
 * whitespace or an argument/punctuation boundary. `=` and brackets matter
 * because `--config=/opt/acme/x` and `(/opt/acme/x)` are ordinary ways to write
 * one. `:` is deliberately NOT a boundary, so the `//` in `https://host/path`
 * is not mistaken for a POSIX path.
 */
const BOUNDARY = `(?:^|[\\s=(\\[{,"'])`;
const ABSOLUTE_PATH = new RegExp(
  `${BOUNDARY}(`
  + `\\/[^\\s)\\]},"']*`            // POSIX          /opt/acme/x
  + `|[A-Za-z]:[\\\\/][^\\s)\\]},"']*` // Windows drive  C:\x  C:/x
  + `|\\\\\\\\[^\\\\\\s]+\\\\[^\\s)\\]},"']*` // UNC       \\host\share\x
  + `|~[\\\\/][^\\s)\\]},"']*`      // home-relative  ~/x
  + `)`,
);

/** The absolute path a scalar contains, or undefined. */
export function findAbsolutePath(value) {
  const match = String(value).match(ABSOLUTE_PATH);
  // A bare "/" or a lone "~/" prefix is not a path worth reporting.
  return match && match[1].length > 1 ? match[1] : undefined;
}

/** Back-compat helper: does the value START with an absolute path? */
export const isAbsolutePathValue = (value) => {
  const found = findAbsolutePath(value);
  return Boolean(found) && String(value).trimStart().startsWith(found);
};

/** Strip line comments. Over-stripping a `#` inside a quoted scalar can only
 *  make the VALUES pass more permissive; the ALWAYS pass still sees raw text. */
export const uncommented = (text) => text.split("\n").map((line) => line.replace(/#.*$/, "")).join("\n");

const unquote = (value) => String(value).replace(/^(['"])([\s\S]*)\1$/, "$2").trim();

/**
 * Key/value split accepting a quoted OR unquoted key, mirroring
 * `parseYamlNested`'s line regex in released OAS 0.20 (lib/core.mjs). Matching
 * a narrower shape than the kernel honors is how a live setting slips through:
 * `"account": acme-inc` is a real setting to the kernel.
 */
const KEY_VALUE = /^\s*((?:["'][^"']+["'])|(?:[^:#][^:]*?)):\s*([\s\S]*?)\s*$/;

/**
 * Mirror of `yamlScalar`'s flow-collection recursion: `{ a: { b: 1 } }` and
 * `[{ a: 1 }]` nest arbitrarily, so a single level of descent is not enough.
 * Splitting on "," the way the kernel does keeps the two in step, including
 * where that split is naive.
 */
function flowChildren(value) {
  const raw = String(value).trim();
  const inner = (open, close) => (raw.startsWith(open) && raw.endsWith(close) ? raw.slice(1, -1) : undefined);

  const array = inner("[", "]");
  if (array !== undefined) return array.split(",").map((v) => ({ key: undefined, value: unquote(v) }));

  const map = inner("{", "}");
  if (map !== undefined) {
    const pairs = [];
    for (const part of map.split(",")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      pairs.push({ key: unquote(part.slice(0, i)), value: unquote(part.slice(i + 1)) });
    }
    return pairs;
  }
  return [];
}

/** Every uncommented setting, flattened recursively through flow collections. */
function scalarValues(text) {
  const found = [];
  const visit = (key, value, depth = 0) => {
    found.push({ key, value });
    if (depth > 16) return; // pathological nesting is not worth chasing
    for (const child of flowChildren(value)) visit(child.key, child.value, depth + 1);
  };
  for (const line of uncommented(text).split("\n")) {
    if (!line.trim()) continue;
    const pair = line.match(KEY_VALUE);
    if (pair) { visit(unquote(pair[1]), unquote(pair[2])); continue; }
    // Block-sequence item. Released 0.20's parser DROPS these (no colon on the
    // line), but the bytes are still copied — see POLICY SCOPE above.
    const item = line.match(/^\s*-\s+(\S[\s\S]*?)\s*$/);
    if (item) visit(undefined, unquote(item[1]));
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
    const path = findAbsolutePath(value);
    if (path) leaks.push(`sets an absolute path (${key ? `${key}: ` : ""}${path})`);
  }
  return [...new Set(leaks)];
}
