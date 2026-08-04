// probe-signature-enforcement.js — before spending hours reverse-engineering an
// obfuscated per-call signature (X-Bogus, X-Gnarly, msToken, HMAC param), test
// EMPIRICALLY whether the backend actually validates it. Some of these are
// best-effort bot-scoring telemetry that the server logs but does not reject
// on — confirmed on at least one TikTok endpoint where stripping the signature
// param still returned 200. This script automates the strip-and-resend test
// safely (GET/idempotent calls only by default).
//
// Run via: playwright-cli -s=<session> run-code --filename=<this file>, or
// paste the probe() body into `playwright-cli eval` for a one-off check.
//
// Result interpretation:
//   - Same 200 + same shape with signature stripped  → NOT enforced. Replay
//     without reproducing the signer. Still verify: does the response with
//     the real vs stripped signature actually differ in content (a server
//     might 200 either way but silently degrade/rate-limit the unsigned path)?
//   - 401/403/empty body/different error code                 → enforced. Do not
//     strip it; go through the MAIN-world-fetch replay approach instead
//     (credential-harvest.md "Auth models" — let the page's own signer sign).
//
// EDIT THIS CONFIG per probe:
async (page) => {
  const CONFIG = {
    url: 'https://example.com/api/some-read-endpoint?a=1&X-Bogus=abcdEXAMPLE',
    method: 'GET', // only use GET/idempotent reads here — never probe a write endpoint this way
    // Names of query params or header keys that ARE the signature — stripped
    // for the second call.
    signatureParams: ['X-Bogus', 'msToken', '_signature'],
    signatureHeaders: ['x-gorgon', 'x-khronos'],
  };

  if (CONFIG.method !== 'GET') {
    return { error: 'This probe only supports GET/idempotent reads — do not run it against a write endpoint (POST/PUT/DELETE) where a stripped-signature call might still execute the mutation for real.' };
  }

  const buildStrippedUrl = (url, paramsToStrip) => {
    const [base, query] = url.split('?');
    if (!query) return url;
    const kept = query.split('&').filter((kv) => {
      const key = decodeURIComponent(kv.split('=')[0]);
      return !paramsToStrip.some((p) => p.toLowerCase() === key.toLowerCase());
    });
    return kept.length ? `${base}?${kept.join('&')}` : base;
  };

  const callOnce = async (url, stripHeaders) => {
    const result = await page.evaluate(async ({ url, stripHeaders }) => {
      const res = await fetch(url, { credentials: 'include' });
      const text = await res.text();
      return { status: res.status, len: text.length, snippet: text.slice(0, 500) };
    }, { url, stripHeaders });
    return result;
  };

  const withSig = await callOnce(CONFIG.url, false);
  const strippedUrl = buildStrippedUrl(CONFIG.url, CONFIG.signatureParams);
  const withoutSig = await callOnce(strippedUrl, true);

  const sameStatus = withSig.status === withoutSig.status;
  const sameLen = Math.abs(withSig.len - withoutSig.len) < Math.max(20, withSig.len * 0.05);

  return {
    withSignature: withSig,
    withoutSignature: withoutSig,
    verdict: sameStatus && sameLen
      ? 'LIKELY NOT ENFORCED — same status and similar response size with signature stripped. Verify snippet content matches before committing to skip the signer.'
      : 'LIKELY ENFORCED — response differs materially without the signature. Do not strip it; use MAIN-world fetch replay so the page signs for you.',
    caveat: 'This only tested query-param signatures. If CONFIG.signatureHeaders is non-empty, also manually verify header-based signatures — this script does not yet strip headers on the fetch call (page.evaluate\'s fetch is same-origin and headers are harder to override generically per-target).',
  };
}
