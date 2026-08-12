// ENV: browser-run-code — Browser via `playwright-cli run-code --filename=<this>` — a single function expression. No require/import/fs/fetch/setTimeout; it never touches disk.
// capture-har.js — record a real HAR 1.2 of a flow, VERBATIM (headers + bodies + responses).
//
// run-code is sandboxed (no `require`, no fs), so this RETURNS the HAR object. Save it to disk:
//
//   playwright-cli -s=<session> run-code --filename=<this file> > /tmp/har.out
//   node -e 'const fs=require("fs");const r=fs.readFileSync("/tmp/har.out","utf8");\
//     fs.writeFileSync(process.argv[1], r.match(/\{[\s\S]*\}(?=\s*###|\s*$)/)[0])' \
//     docs/automation/captures/<name>.har
//
// Then record the verbatim fetch() blocks + mermaid + orchestration chain into the playbook
// (see references/network-flow-spec.md). The HAR is the durable artifact the NEXT session reads
// instead of re-driving the browser.
//
// EDIT THIS CONFIG per capture:
async (page) => {
  const CONFIG = {
    // URLs to navigate through, in order. The listener is attached before the first goto.
    drive: [
      'https://affiliate-id.tokopedia.com/connection/creator-management?shop_region=ID',
    ],
    // Only keep requests whose URL matches this. Narrow it to the target API to avoid noise.
    urlFilter: /\/api\/|graphql|gql\.|\/oec\/|product|creator|sample|crm|conversation|search/i,
    // Skip static assets.
    skip: /\.(js|css|png|jpe?g|svg|gif|woff2?|ico|map)(\?|$)/i,
    settleMs: 4000,
    maxBodyChars: 200000,
  };

  // run-code listeners persist on the page across calls — clear stale ones from prior runs first,
  // otherwise an old (possibly buggy) handler keeps firing and floods the output with its errors.
  page.removeAllListeners('response');

  const entries = [];
  const toHeaderArr = (h) => Object.entries(h || {}).map(([name, value]) => ({ name, value }));
  // run-code sandbox has no `URL` global — parse the query string by hand.
  const queryArr = (u) => {
    const q = u.split('?')[1];
    if (!q) return [];
    return q.split('&').map((kv) => {
      const i = kv.indexOf('=');
      const name = i === -1 ? kv : kv.slice(0, i);
      const value = i === -1 ? '' : kv.slice(i + 1);
      let dv = value;
      try { dv = decodeURIComponent(value); } catch {}
      return { name: decodeURIComponent(name), value: dv };
    });
  };

  page.on('response', async (response) => {
    const req = response.request();
    const url = req.url();
    if (!CONFIG.urlFilter.test(url) || CONFIG.skip.test(url)) return;
    let reqHeaders = {};
    let resHeaders = {};
    try { reqHeaders = await req.allHeaders(); } catch {}
    try { resHeaders = await response.allHeaders(); } catch {}
    let postData = '';
    try { postData = req.postData() || ''; } catch {}
    let body = '';
    let encoding;
    try {
      body = await response.text();
      if (body.length > CONFIG.maxBodyChars) body = `${body.slice(0, CONFIG.maxBodyChars)}…<truncated>`;
    } catch {
      body = '<binary or unreadable — capture bytes via network-discovery.md §8/§9>';
      encoding = 'note';
    }
    entries.push({
      startedDateTime: '',
      time: 0,
      request: {
        method: req.method(),
        url,
        httpVersion: 'HTTP/1.1',
        headers: toHeaderArr(reqHeaders),
        queryString: queryArr(url),
        postData: postData
          ? { mimeType: reqHeaders['content-type'] || 'application/json', text: postData }
          : undefined,
        cookies: [],
        headersSize: -1,
        bodySize: postData.length,
      },
      response: {
        status: response.status(),
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: toHeaderArr(resHeaders),
        content: { size: body.length, mimeType: resHeaders['content-type'] || '', text: body, encoding },
        cookies: [],
        redirectURL: '',
        headersSize: -1,
        bodySize: body.length,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    });
  });

  for (const target of CONFIG.drive) {
    try { await page.goto(target, { waitUntil: 'networkidle', timeout: 90000 }); }
    catch { try { await page.waitForTimeout(3000); } catch {} }
  }
  await page.waitForTimeout(CONFIG.settleMs);

  return {
    log: {
      version: '1.2',
      creator: { name: 'sla-capture-har', version: '1.0' },
      entries,
    },
    _count: entries.length,
  };
}
