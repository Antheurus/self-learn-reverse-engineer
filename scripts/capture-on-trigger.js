// capture-on-trigger.js — capture the exact outgoing payload of an action that
// DevTools Network tab keeps missing: composers that send on blur, video-progress
// pings, encrypted-body requests where only the pre-encryption call matters, or
// bursts too fast to click "preserve log" in time.
//
// Unlike capture-har.js (passive: listens to whatever fires), this actively
// monkeypatches the client the app uses BEFORE you trigger the action, so it
// catches the call at the moment of construction — before signing/encryption
// mutates the body, and even if the app is a SPA that free-runs before you can
// open Network tab. Patch window.fetch by default; switch CONFIG.target to an
// app-specific client name (e.g. axios instance in a Vuex plugin) when the app
// doesn't use fetch directly.
//
// Run via: playwright-cli -s=<session> run-code --filename=<this file>
// Trigger the action manually in the headed browser WHILE this is running —
// the script waits and returns as soon as it sees a matching call, or times out.
//
// EDIT THIS CONFIG per capture:
async (page) => {
  const CONFIG = {
    // 'fetch' patches window.fetch. 'axios-window' patches a global axios
    // instance if the app exposes one (e.g. window.$axios or window.axios).
    // Anything else is treated as a dotted window path, e.g. 'app.$http'.
    target: 'fetch',
    // Only keep calls whose URL matches. Narrow this — a broad match on a
    // chatty SPA will capture noise before your real trigger fires.
    urlFilter: /\/(api|graphql|comment|message|track|progress)\//i,
    maxCaptures: 5,
    timeoutMs: 120000,
  };

  const captured = [];
  const record = (method, url, body, headers) => {
    if (!CONFIG.urlFilter.test(url)) return;
    captured.push({ method, url, body, headers, ts: Date.now() });
  };

  if (CONFIG.target === 'fetch') {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input.url;
        const method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
        const body = (init && init.body) ? String(init.body) : '';
        record(method, url, body, (init && init.headers) || {});
      } catch {}
      return origFetch.apply(this, arguments);
    };
  } else {
    // Generic axios-shaped client at a dotted window path (e.g. 'app.$http').
    const path = CONFIG.target === 'axios-window'
      ? (window.$axios ? '$axios' : 'axios')
      : CONFIG.target;
    const parts = path.split('.');
    let obj = window;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    const key = parts[parts.length - 1];
    const client = obj[key];
    if (!client) {
      return { error: `target '${CONFIG.target}' not found on window — inspect window manually and adjust CONFIG.target` };
    }
    ['request', 'post', 'put', 'patch', 'delete'].forEach((method) => {
      if (typeof client[method] !== 'function') return;
      const orig = client[method].bind(client);
      client[method] = function (...args) {
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          const body = typeof args[0] === 'string' ? args[1] : (args[0] && args[0].data);
          record(method.toUpperCase(), url, JSON.stringify(body), {});
        } catch {}
        return orig(...args);
      };
    });
  }

  const deadline = Date.now() + CONFIG.timeoutMs;
  while (captured.length < CONFIG.maxCaptures && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  return {
    count: captured.length,
    captures: captured,
    note: captured.length
      ? 'Bodies captured pre-flight (before any signing/encryption interceptor mutated them, if the client applies one after this hook point — check by diffing against the wire capture in capture-har.js).'
      : `No matching call within ${CONFIG.timeoutMs}ms — trigger the action now, or the client wraps a different global (inspect window and adjust CONFIG.target).`,
  };
}
