# Network Discovery (playwright-cli)

Find which **fetch** carries the payload you need — before guessing DOM or Vuex alone.

Read this when: capturing API contracts for playbooks, **sla-extensify**, or comparing two URLs on the same platform.

> **This file is the mechanics. The OUTPUT contract is `network-flow-spec.md` — read it first.** Captures must
> be VERBATIM (literal copy-as-`fetch`, never a prose summary), flow-first (mermaid `## Flow`), and produce a
> saved `.har`/JSON in `docs/automation/captures/`. And **before any capture, grep `docs/automation/` — if the flow is
> already captured, READ it and stop.** Re-RE-ing a captured flow is banned.

---

## 0. Session setup

```bash
cd "$PROJECT_ROOT"
playwright-cli -s=sla-probe open "https://example.com/" --headed --profile=docs/profile/playwright-cli/
# If redirect to login: goto dashboard first, then target URL
playwright-cli -s=sla-probe goto "<target-url>"
```

Use a **named session** (`-s=`) and persistent **profile** so cookies survive.

---

## 1. Three layers (never confuse them)

| Layer | What you read | Wire-encrypted LMS quiz example |
|-------|----------------|-----------------------------------|
| **Wire** | `response.text()` in listener | **No** — encrypted blob |
| **Post-decrypt** | `vm.$axios.post(...)` in `page.evaluate` / `run-code` | **Yes** — `res.data.data` |
| **In-memory** | Vuex / React state after app commits | **Yes** — `store.state.quizes.run` |

**Rule:** If wire has no field, replay via **same client as the app** (`$axios`) before concluding the API doesn't leak it.

---

## 2. Probe pattern (attach listener BEFORE goto)

Save as `extensions/.../scripts/probe-network-run.js` or project `docs/automation/scripts/`:

```javascript
async (page) => {
  const hits = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('api.example.com')) return;
    let text = '';
    try { text = await response.text(); } catch { return; }
    hits.push({
      method: response.request().method(),
      url,
      hasField: text.includes('isCorrect'), // rename per target
      len: text.length,
    });
  });
  await page.goto('TARGET_URL', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(3000);
  return hits;
}
```

Run:

```bash
playwright-cli -s=sla-probe run-code --filename=path/to/probe-network-run.js
```

---

## 3. Bulk compare (same platform, 2+ URLs)

| Column | Source |
|--------|--------|
| `quizUuid` / ids | URL path + query |
| Endpoints fired | Filter `hits` by path pattern |
| `hasField` on wire | Per response |
| `isCorrect` count | After `$axios` replay only |
| JSON paths | e.g. `data.member.quiz.questions[].answers[].isCorrect` |
| Diff notes | shuffle, question count, review mode |

**Verified shape (hostname genericized):**

```http
POST https://api.kelasku.example/api/v1.4/quiz/{quizUuid}/{quizMemberUuid}
(body empty)
```

```http
POST .../quiz/done/{quizUuid}/{quizMemberUuid}   → only lastSubmittedAt, no isCorrect
```

---

## 4. `playwright-cli requests`

After navigation:

```bash
playwright-cli -s=sla-probe requests
playwright-cli -s=sla-probe request 3   # detail one entry
```

Use for quick listing; **encrypted bodies** still need axios replay (section 1).

---

## 5. Playbook output — VERBATIM, per `network-flow-spec.md`

Do NOT distill the call into a synthesized YAML stub. The output is the literal copy-as-`fetch()` block in
`## Network calls (VERBATIM)`, a mermaid `## Flow`, and the `## Orchestration chain` table — plus a saved HAR.
The `payload_paths` / `dynamic_params` notes live as annotations under each verbatim block (`// DYNAMIC: …`,
`// RESPONSE: …`), not as a paraphrase that replaces the call. See `network-flow-spec.md` for the full shape
and worked example.

## 5b. Save the HAR (durable artifact)

Record the flow with `scripts/capture-har.js` (returns HAR 1.2 — save its output to
`docs/automation/captures/<name>.har`, see the script header for the save one-liner), or DevTools → Network →
**Save all as HAR** → drop into `docs/automation/captures/`. This is what the next session reads instead of
re-driving the browser. No saved artifact = the capture is not done.

---

## 6. Anti-patterns

- Parse wire JSON when body is encrypted
- One URL defines global rules for the whole platform
- Map UI index to API index when `shuffleQuestions: true` — use **questionId**
- `comment/create` to "list" comments (side effect POST)
- **Hook only `fetch`** — see §8; many SDKs use XHR or WebSocket and a fetch-only hook captures nothing
- **Trust a HAR for the write path** — HAR exports omit WebSocket frame payloads; a "missing send" often means it went over WS, not that it wasn't sent (§8, §9)

---

## 8. Transport hooking — `fetch` is not the only client

`playwright-cli requests` records all transports, but to capture **request/response bodies** (especially binary), hook the client the app actually uses. Hook all three in one MAIN-world init script:

- **`fetch`** — wrap `window.fetch`; clone the response to read its body.
- **`XMLHttpRequest`** — wrap `XHR.prototype.open`/`send`; many SDKs (incl. TikTok IM protobuf reads) use XHR, not fetch. A fetch-only hook silently misses them.
- **`WebSocket`** — wrap the constructor + `ws.send`; the realtime/write path often lives here (see `authenticated-websocket-replay.md`).

Capture raw bytes safely:
- Base64-encode `ArrayBuffer`/typed-array bodies in **0x8000 chunks** (`String.fromCharCode(...bigArray)` overflows the stack).
- Store captures on a `window.__cap` array; read it back with `eval` after driving the UI.
- Skip noise (e.g. WS keep-alive frames that are a literal `"hi"`/ping string).

## 9. Binary / protobuf wire — `protoc --decode_raw`

When `content-type` is `application/x-protobuf`/`grpc` or the body is non-UTF-8:
- HAR stores the response base64 (`content.encoding == "base64"`); the request `postData.text` is a lossy latin1 string — prefer capturing request **bytes** via the live hook (§8) over the HAR for requests.
- Decode field structure with no `.proto`: `protoc --decode_raw < frame.bin`. Field numbers + wire types reveal the schema; infer meaning from the values.
- The same envelope usually serves every command — only a `cmd` field and the payload sub-message change. Map one read, and the write (and other commands) follow.
- Re-encode with the tiny writer in `authenticated-websocket-replay.md` (BigInt varints for int64 ids).

---

## 11. Fake-success route interception — capture a write path without writing

`capture-har.js` (passive) only sees requests that actually fire — but a dangerous mutating endpoint (create/delete/submit-order) shouldn't fire for real just to learn its body shape. Intercept the route and fulfill a synthetic success instead:

```javascript
await page.route('**/invitation_group/create*', async (route, request) => {
  const body = request.postData();
  // record body here
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
});
```

The page believes the write succeeded (spinner clears, toast shows) so you can drive the UI normally while the backend never sees the real request. Full config-driven script: `scripts/route-intercept-capture.js`.

## 12. Active capture-on-trigger — for actions the Network tab keeps missing

Passive listeners work when the request is easy to catch (page loads, obvious clicks). Some actions aren't: composers that send on blur, progress pings that fire in a burst, or SPAs that free-run before you can open DevTools. Monkeypatch the client the app uses (`window.fetch`, or an app-specific instance like `window.$axios`) **before** triggering the action, so the hook fires at construction time — before any signing/encryption interceptor mutates the body:

```javascript
const origFetch = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input.url;
  if (/\/(comment|message|track)\//i.test(url)) captured.push({ url, body: init && init.body });
  return origFetch.apply(this, arguments);
};
```

Full config-driven script: `scripts/capture-on-trigger.js`. Complements §8's passive transport hooking — use this specifically when timing, not transport type, is the problem.

## 13. Recursive field finder — for an unknown response blob

When you have a captured JSON response with no schema and need to find "which field is the cursor" or "where's the schedule id" without eyeballing 500 lines of minified keys:

```javascript
function findFields(obj, keywords, opts = {}) {
  const re = new RegExp(`(${keywords.join('|')})`, 'i');
  const hits = [];
  const walk = (node, path, depth) => {
    if (depth > (opts.maxDepth ?? 12) || !node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (re.test(key)) hits.push({ path: path ? `${path}.${key}` : key, key, value: node[key] });
      if (node[key] && typeof node[key] === 'object') walk(node[key], path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(obj, '', 0);
  return hits;
}
```

Full implementation with cycle guard and array fan-out cap: `scripts/find-fields-recursive.js`.

## 14. Capture-template-then-replay for expensive-to-build bodies

When a request body has fields you can't hand-build (a signed `profileId`, a server-issued token embedded mid-payload) but the app assembles them correctly every time, don't reverse-engineer the field — steal the app's own assembled body once via a `window.fetch` monkeypatch, then replay it with only the short-lived fields swapped (a schedule id, a fresh price, a fresh captcha token):

```javascript
let template = null;
const origFetch = window.fetch;
window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input.url;
  if (/\/order\/create/.test(url) && !template) {
    template = JSON.parse(init.body); // steal it once, let the original call through
  }
  return origFetch.apply(this, arguments);
};
// Later: clone `template`, overwrite only the swap fields, JSON.stringify, fetch() it yourself.
```

Add a **dry-run mode** for anything purchase/order/limited-resource-shaped: instead of letting the swapped replay hit the network, return a fabricated `Response` object so you can verify the body shape before ever risking a real attempt. Full config-driven script with dry-run built in: `scripts/replay-with-fresh-fields.js`.

## 15. Webpack/Next.js bundle mining for hidden decision logic

When a client makes an undocumented branching decision (e.g. "which of two API versions to call, based on some condition") and probing production traffic alone won't reveal the rule, read the SPA's own minified bundle instead of guessing:

```javascript
// Grab the build id and chunk manifest
const buildId = window.__NEXT_DATA__?.buildId;
const manifest = window.__BUILD_MANIFEST;
// Then fetch and grep the relevant chunk file for the branching function
```

Download the chunk, search it for the function name or a distinguishing string near the suspected branch point, and read the real condition instead of inferring it from black-box probing. This is how a "v2 vs v3 endpoint selection rule" was confirmed on one integration — cheaper than dozens of probe requests trying to trigger both paths.

**`window.__NEXT_DATA__`/`__BUILD_MANIFEST` is Next.js-specific — verify the framework before assuming this shape.** Check `document.querySelector('#__next')` or a `<script id="__NEXT_DATA__">` tag first. A different framework needs its own equivalent: Vite/Rollup apps expose a manifest at `/manifest.json` or inline `import.meta.env`; plain webpack apps expose `__webpack_require__.cache`. Don't paste the Next.js snippet against an unconfirmed target and conclude "no hidden logic" when the real cause is "wrong bundler."

## 16. Canon examples

Name reference cases by the **technology/technique**, not the platform — so they're findable for the next system that shares the mechanism.

No single canonical repo holds these — substitute whichever project in the current workspace has already captured the matching mechanism.

- **JSON-fetch wire, encrypted-field replay-via-page-client** (read path):
  a worked example of this shape may exist in a prior project's own `docs/automation/*.md` capture + probe scripts; if none is available, capture fresh via `sla-capture`.
- **Protobuf-over-XHR reads + authenticated-WebSocket protobuf send** (write path, no DOM, no re-sign):
  technique generalized in `authenticated-websocket-replay.md`; a live implementation may exist in a prior extension's MAIN-world bridge (socket reuse + frame builder) if one is available in the current workspace.
