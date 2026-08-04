// route-intercept-capture.js — capture the verbatim body of a MUTATING endpoint
// (create/update/delete) WITHOUT letting the real write reach the server.
//
// Passive listeners (capture-har.js) only see requests that actually fire — for a
// dangerous write path you don't want to fire for real (e.g. "create invitation",
// "delete product", "submit order"), intercept the route and fulfill a synthetic
// success instead. The page believes the write succeeded (spinner clears, success
// toast shows) so you can drive the UI normally; the backend never sees it.
//
// Run via: playwright-cli -s=<session> run-code --filename=<this file>
// The script waits up to CONFIG.timeoutMs for a matching request, then returns
// the captured body + a flag confirming the real network call was blocked.
//
// EDIT THIS CONFIG per capture:
async (page) => {
  const CONFIG = {
    // Playwright route glob or regex-as-string matching the mutating endpoint.
    // Examples: '**/invitation_group/create*', '**/api/v4/*/product/delete*'
    urlPattern: '**/invitation_group/*',
    // Only intercept these methods — GETs should pass through untouched.
    methods: ['POST', 'PUT', 'DELETE', 'PATCH'],
    // Synthetic response returned to the page instead of the real one.
    // Shape this to match what the page expects on success (check a real HAR
    // capture of this endpoint's shape first, or the JS will throw un-caught
    // parsing the fake response and you'll get a misleading failure signal).
    fakeResponse: {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, code: 0, message: 'ok', data: {} }),
    },
    timeoutMs: 120000,
  };

  const captured = [];
  await page.route(CONFIG.urlPattern, async (route, request) => {
    const method = request.method();
    if (!CONFIG.methods.includes(method)) {
      return route.continue();
    }
    let postData = '';
    try { postData = request.postData() || ''; } catch {}
    let headers = {};
    try { headers = await request.allHeaders(); } catch {}
    captured.push({
      method,
      url: request.url(),
      headers,
      body: postData,
      ts: Date.now(),
    });
    // Fulfill instead of continue — the real write never leaves the browser.
    await route.fulfill({
      status: CONFIG.fakeResponse.status,
      contentType: CONFIG.fakeResponse.contentType,
      body: CONFIG.fakeResponse.body,
    });
  });

  // Poll for a capture instead of a fixed sleep — the user triggers the action
  // manually (click "Create", "Delete", etc.) while this listener is armed.
  const deadline = Date.now() + CONFIG.timeoutMs;
  while (captured.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(1000);
  }

  await page.unroute(CONFIG.urlPattern);

  return {
    intercepted: captured.length > 0,
    count: captured.length,
    captures: captured,
    note: captured.length
      ? 'Real write was BLOCKED — the page saw a fake success. Verify nothing was actually created on the backend before assuming this is safe to replay for real.'
      : `No matching request within ${CONFIG.timeoutMs}ms — trigger the action in the UI while this script is running, or widen urlPattern.`,
  };
}
