// replay-with-fresh-fields.js — steal the app's OWN assembled request body once
// (fields you can't hand-build: a signed profileId, a server-issued session
// token embedded in the payload, a computed hash), then replay it repeatedly
// with only the short-lived fields swapped (a schedule id, a fresh price, a
// fresh captcha token). Use when a request body is too expensive/risky to
// reverse-engineer field-by-field but is trivial to CAPTURE once and reuse.
//
// Includes a DRY-RUN mode: instead of letting the swapped request actually
// hit the network, it returns a fabricated Response so you can verify the
// body shape is right before ever sending a real one — critical when the
// endpoint being replayed is a purchase/order/limited-resource action where a
// wrong request could burn a real attempt.
//
// Run via: playwright-cli -s=<session> run-code --filename=<this file>
// Trigger the ORIGINAL action once in the UI while this is armed to capture
// the template; the script then lets you replay it via the returned function
// reference conceptually — in practice, re-run this file with CONFIG.replay
// filled in from the first run's captured template.
//
// EDIT THIS CONFIG per use:
async (page) => {
  const CONFIG = {
    urlFilter: /\/order\/create|\/purchase|\/checkout/i,
    // Fields to swap on replay — dot-path into the captured JSON body.
    // Leave empty on the first run (capture-only pass).
    swapFields: {
      // 'scheduleId': '99999',
      // 'priceId': 'abc123',
    },
    dryRun: true, // true = fabricate a success Response, never touch the network
    captureTimeoutMs: 60000,
  };

  let template = null;
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (CONFIG.urlFilter.test(url) && !template) {
      // First matching call: steal the template, let it through for real
      // (capture pass) unless CONFIG.dryRun is already true for this call.
      try {
        const body = init && init.body ? JSON.parse(init.body) : null;
        template = { url, method: (init && init.method) || 'POST', headers: (init && init.headers) || {}, body };
      } catch {}
      if (!CONFIG.dryRun) return origFetch.apply(this, arguments);
    } else if (template && url === template.url && Object.keys(CONFIG.swapFields).length) {
      // Subsequent calls to the same endpoint: build a swapped-field replay.
      const cloned = JSON.parse(JSON.stringify(template.body));
      for (const [path, value] of Object.entries(CONFIG.swapFields)) {
        setPath(cloned, path, value);
      }
      if (CONFIG.dryRun) {
        return new Response(JSON.stringify({ success: true, dryRun: true, sentBody: cloned }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return origFetch(url, { ...init, body: JSON.stringify(cloned) });
    }
    if (CONFIG.dryRun && template && url === template.url) {
      return new Response(JSON.stringify({ success: true, dryRun: true, sentBody: template.body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return origFetch.apply(this, arguments);
  };

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === undefined) return; // path doesn't exist in this template — no-op, don't create garbage
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  const deadline = Date.now() + CONFIG.captureTimeoutMs;
  while (!template && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  return {
    templateCaptured: !!template,
    template,
    note: template
      ? 'Template captured. Fill CONFIG.swapFields with the dot-paths to override, keep dryRun:true, re-run, and inspect sentBody before ever setting dryRun:false.'
      : `No matching request within ${CONFIG.captureTimeoutMs}ms — trigger the original action in the UI while this script runs.`,
  };
}
