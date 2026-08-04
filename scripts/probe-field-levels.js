// probe-field-levels.js — classify EVERY header/query/body field of a captured
// request into L1 (auth/required) / L2 (functional/customizes result) / L3
// (optional/telemetry) by testing REMOVAL, never by guessing from the name.
//
// This is the field-leveling methodology from the api-dto-pattern skill
// (~/.kiro/skills/api-dto-pattern), stripped down to just the classification
// procedure — no DTO file, no entity mapping, no validate()/export scaffolding.
// What self-learn-automation needs is the TEST, not the code-generation output.
//
// Decision tree (from observed behavior only):
//   remove field → 401/403/400 or materially different error   → L1 (required)
//   remove field → 200 but response content differs             → L2 (functional, give it a default)
//   remove field → 200 and response is effectively identical    → L3 (optional, safe to drop)
//
// Generalizes probe-signature-enforcement.js (which only tests ONE named field)
// to a full sweep. Apply the SAME discipline it demonstrated: a field is "L1"
// because removing it broke the call, not because its name looks important
// (`x-sap-sec` sounds critical; on one captured Shopee endpoint it turned out
// to be L3 — the platform just logs it).
//
// SAFETY: GET/idempotent reads only — never run this against a write endpoint.
// Removing a field from a POST/PUT/DELETE and resending could execute a
// mutation with an incomplete/wrong payload.
//
// Run via: playwright-cli -s=<session> run-code --filename=<this file>
//
// EDIT THIS CONFIG per probe:
async (page) => {
  const CONFIG = {
    url: 'https://example.com/api/some-read-endpoint?shop_id=123&page=1&limit=20&tracking_id=abc',
    method: 'GET', // idempotent reads only — see SAFETY note above
    headers: {
      // Only headers you can actually control from page.evaluate's fetch —
      // browser-forbidden headers (Cookie, Host, etc.) aren't testable this
      // way; those ride automatically and can't be selectively stripped here.
      'x-custom-header': 'example-value',
    },
    // Fields to test removal on. Query params are auto-extracted from CONFIG.url;
    // list header names here separately since they're not part of the URL.
    headerFieldsToTest: ['x-custom-header'],
    maxFieldsToTest: 15, // cap — this makes N+1 real requests, don't hammer the target
    delayBetweenCallsMs: 500, // self-throttle — pace requests, don't burst them (primitives.md §29)
  };

  if (CONFIG.method !== 'GET') {
    return { error: 'This probe only supports GET/idempotent reads — removing a field from a write request and resending could execute a mutation with a broken payload.' };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const parseQuery = (url) => {
    const [base, query] = url.split('?');
    if (!query) return { base, params: [] };
    const params = query.split('&').map((kv) => {
      const i = kv.indexOf('=');
      return { name: i === -1 ? kv : kv.slice(0, i), raw: kv };
    });
    return { base, params };
  };

  const buildUrlWithoutParam = (base, params, skipName) => {
    const kept = params.filter((p) => p.name !== skipName).map((p) => p.raw);
    return kept.length ? `${base}?${kept.join('&')}` : base;
  };

  const callOnce = async (url, headers) => {
    return page.evaluate(async ({ url, headers }) => {
      try {
        const res = await fetch(url, { credentials: 'include', headers });
        const text = await res.text();
        return { status: res.status, len: text.length, snippet: text.slice(0, 300), ok: res.ok };
      } catch (e) {
        return { status: 0, len: 0, snippet: String(e), ok: false, threw: true };
      }
    }, { url, headers });
  };

  const classify = (baseline, stripped) => {
    if (stripped.threw || stripped.status === 0) return { level: 'L1', reason: 'request threw / network error without the field' };
    if (stripped.status !== baseline.status) {
      return stripped.status >= 400
        ? { level: 'L1', reason: `status changed ${baseline.status} → ${stripped.status}` }
        : { level: 'L2', reason: `status changed ${baseline.status} → ${stripped.status} but still non-error` };
    }
    const lenDiffRatio = Math.abs(stripped.len - baseline.len) / Math.max(1, baseline.len);
    if (lenDiffRatio > 0.15) {
      return { level: 'L2', reason: `same status, response size differs ${Math.round(lenDiffRatio * 100)}% — content changed` };
    }
    return { level: 'L3', reason: 'same status, near-identical response — safe to drop' };
  };

  const { base, params } = parseQuery(CONFIG.url);
  const baseline = await callOnce(CONFIG.url, CONFIG.headers);
  if (baseline.threw || baseline.status >= 400) {
    return { error: `Baseline call itself failed (status ${baseline.status}) — fix the baseline request before probing field removal.`, baseline };
  }

  const results = [];
  let tested = 0;

  for (const param of params) {
    if (tested >= CONFIG.maxFieldsToTest) break;
    await sleep(CONFIG.delayBetweenCallsMs);
    const strippedUrl = buildUrlWithoutParam(base, params, param.name);
    const result = await callOnce(strippedUrl, CONFIG.headers);
    results.push({ field: param.name, removedFrom: 'query', ...classify(baseline, result), rawStatus: result.status });
    tested++;
  }

  for (const headerName of CONFIG.headerFieldsToTest) {
    if (tested >= CONFIG.maxFieldsToTest) break;
    await sleep(CONFIG.delayBetweenCallsMs);
    const strippedHeaders = { ...CONFIG.headers };
    delete strippedHeaders[headerName];
    const result = await callOnce(CONFIG.url, strippedHeaders);
    results.push({ field: headerName, removedFrom: 'header', ...classify(baseline, result), rawStatus: result.status });
    tested++;
  }

  return {
    baseline: { status: baseline.status, len: baseline.len },
    tested,
    fieldLevels: results,
    summary: {
      L1: results.filter((r) => r.level === 'L1').map((r) => r.field),
      L2: results.filter((r) => r.level === 'L2').map((r) => r.field),
      L3: results.filter((r) => r.level === 'L3').map((r) => r.field),
    },
    note: 'Record this in the playbook\'s ## API contracts under field_levels (api-mimic-codify.md). L1 fields must always be harvested/sent; L2 fields get sensible defaults; L3 fields can be omitted from the mimic adapter entirely.',
  };
}
