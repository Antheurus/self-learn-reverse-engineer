# Credential harvest (auth context discovery)

Before mimicking an internal API, enumerate **where each required key lives** (cookie, URL param, localStorage, IndexedDB, `window` heap).

---

## When to run

- During `sla-capture`, after the target page is logged in and one successful action fired.
- During `sla-codify`, when `## API contracts` lists `auth_harvest` keys but locations are unknown.
- When mimic returns 401/403 or empty data despite valid-looking URL.

---

## Tool: comprehensive search

Bundled script:

`~/.claude/skills/self-learn-automation/scripts/comprehensive-search-harvest.js`

### Usage

1. Open Seller Center (or target) logged in — same profile as capture.
2. DevTools → Console → paste script (or run via `playwright-cli run-code` with file body).
3. Edit `searchTargets` at top: list **key aliases** from captured requests; optional `val` to disambiguate.
4. Read `console.table` output: `Source Type`, `Console JS Command`, IndexedDB metadata.

### Output fields

| Field | Meaning |
|-------|---------|
| `FOUND_VALUE` | Value at discovery time (do not commit to git) |
| `LOCATION_TYPE` | Cookie, URL Param, localStorage, IndexedDB, Window Property, … |
| `ACCESS_CODE` | JS snippet to read again (for docs / extension background) |
| `METADATA` | DB name, store, record key, nested path |

### Persisting results

Save to project (gitignored):

`docs/automation/captures/<playbook>-auth-context.json`

Structure:

```json
{
  "captured_at": "ISO-8601",
  "page_url": "https://seller.shopee.co.id/...",
  "keys": {
    "SPC_CDS_CHAT": { "location_type": "Cookie Key", "access_code": "document.cookie.split..." }
  }
}
```

Wire harvest into COE DB / env only via existing project patterns — never commit live tokens.

---

## Mapping harvest → mimic

| Captured request param | Harvest key | Typical source |
|------------------------|-------------|----------------|
| `SPC_CDS` query | `SPC_CDS`, `SPC_CDS_CHAT` | Cookie or chat bootstrap |
| `csrf_token` | `csrf`, `csrf_token` | Cookie or meta |
| `shop_id` | `shopid`, `shop_id` | localStorage / window |
| Custom headers | from HAR `request.headers` | Match name in `searchTargets` |

Refresh strategy: document in adapter whether token is session-long or per-request; align with your project's existing session/credential-refresh function (e.g. one existing implementation calls this `getShopeeCredentials`) or cookie table refresh in the service.

---

## Limitations

- Heap scan can freeze tab briefly — run on dashboard, not mid-export.
- Values change per login — harvest proves **location**, not permanent literals.
- httpOnly cookies: `ACCESS_CODE` via `document.cookie` may be incomplete; prefer extension export + `context.addCookies` for Playwright fallback.

---

## Auth models — identify which one each endpoint uses

Different endpoints on the *same* product often authenticate differently. Classify each before mimicking:

| Model | Where the credential rides | Replayable cold? | Tell |
|-------|----------------------------|------------------|------|
| **Cookie/session** | `Cookie` header (domain-scoped) | Only where that domain's cookies are in scope | JSON endpoint, no token in body/URL |
| **In-body token** | a token field *inside* the (often protobuf) request body | Yes — carry the harvested token; works cross-host | binary `x-protobuf` body with an opaque string field |
| **Per-call signature** | `X-Bogus`/`X-Gnarly`/`msToken`/HMAC query params | No — do not compute it, but verify first (below) | obfuscated wasm/JS signer |
| **Open-time socket** | token/access_key in the WebSocket connect URL | Reuse the open socket (`authenticated-websocket-replay.md`) | write path is a WS frame |

Before assuming a signature is load-bearing, test it — `api-mimic-codify.md` §1.5 / `scripts/probe-signature-enforcement.js` strips the param and resends. Confirmed at least once that a TikTok signature param was best-effort telemetry, not enforced — stripping it still returned 200 with identical data, saving a full reverse-engineering pass.

Two high-leverage consequences:

- **Do not re-implement per-call signatures.** A `fetch` issued from the **page's own MAIN-world context** is auto-signed by the page's resident signer — the injected `X-Bogus`/`msToken` are added for you. Replay signed JSON GET/POSTs through a MAIN-world fetch bridge (extension) or `page.evaluate(fetch)` (capture); supply only the base query params, let the page sign. Confirmed once on one endpoint (a creator-search `POST` returned 200 this way with no signature code) — that's evidence for THAT endpoint's signer, not a guarantee every signer on every platform auto-applies to a bare `page.evaluate(fetch)` call the same way. Verify with one test call on the specific endpoint before building a replay around this assumption.
- **In-body-token reads replay cross-host; cookie reads do not.** A protobuf read carrying its token in the body succeeds from any context; a sibling JSON endpoint on a different API host fails `not login` if that host's cookies aren't present. In a cookie-injected capture session this looks like a bug but is just scope — verify cookie-auth endpoints in the real browser.

One bootstrap call often mints the whole session (token + socket URL + service ids + app id + user id). Find it (e.g. an `im/get/token` returning `{token, ws_url, frontier_service_id, app_id, user_cursor}`) and harvest everything from that single response.
