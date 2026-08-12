// ENV: browser-run-code — Browser via `playwright-cli run-code --filename=<this>` — a single function expression. No require/import/fs/fetch/setTimeout; it never touches disk.
// find-fields-recursive.js — walk an unknown/undocumented JSON blob (an API
// response you don't have a schema for) and find every field whose KEY matches
// a keyword/regex set, regardless of nesting depth. Faster than eyeballing a
// 500-line minified response for "which field is the schedule id" or "where's
// the cursor".
//
// Shaped as a single `async (page) => {...}` expression so it runs directly via
// `playwright-cli run-code --filename=<this file>` (the sandbox requires the
// whole file be one arrow-function expression — see primitives.md §17). Edit
// KEYWORDS and TARGET_JSON below per use.
//
// Run via: playwright-cli -s=<session> run-code --filename=<this file>
async (page) => {
  const KEYWORDS = ['cursor', 'next_page', 'schedule', 'token', 'has_more'];
  const OPTS = { maxDepth: 12, maxArrayFanout: 10 };

  function findFields(obj, keywords, opts) {
    const maxDepth = opts.maxDepth ?? 12;
    const maxArrayFanout = opts.maxArrayFanout ?? 10; // cap how many array items to descend into
    const re = new RegExp(`(${keywords.join('|')})`, 'i');
    const hits = [];
    const seen = new WeakSet();

    const walk = (node, path, depth) => {
      if (depth > maxDepth || node === null || typeof node !== 'object') return;
      if (seen.has(node)) return; // cycle guard
      seen.add(node);

      if (Array.isArray(node)) {
        node.slice(0, maxArrayFanout).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
        return;
      }

      for (const key of Object.keys(node)) {
        const value = node[key];
        const currentPath = path ? `${path}.${key}` : key;
        if (re.test(key)) {
          hits.push({
            path: currentPath,
            key,
            value: typeof value === 'object' ? `<${Array.isArray(value) ? 'array' : 'object'}>` : value,
          });
        }
        if (value !== null && typeof value === 'object') walk(value, currentPath, depth + 1);
      }
    };

    walk(obj, '', 0);
    return { keywords, count: hits.length, hits };
  }

  // Fetch or inline the blob you're inspecting. Default: read a value the page
  // already stashed at window.__lastResponseJson (set that yourself in a prior
  // eval step, or replace this line with a direct fetch call).
  const TARGET_JSON = await page.evaluate(() => window.__lastResponseJson || null);
  if (!TARGET_JSON) {
    return { error: 'Set window.__lastResponseJson in the page first (via eval), or replace this line with a direct fetch call to the endpoint you want to inspect.' };
  }
  return findFields(TARGET_JSON, KEYWORDS, OPTS);
}
