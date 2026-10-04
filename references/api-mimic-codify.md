# API Mimic Codify (primary path)

Translate a verified playbook into a **lightweight HTTP adapter** that calls the platform's own internal APIs — not a permanent Patchright UI driver.

Playwright-cli during capture is **discovery only**. Production should replay the same requests the Seller Center SPA makes, with the same headers, query params, and body shape.

---

## Why this path exists

| Approach | Cost | When |
|----------|------|------|
| **API mimic** (`method: "api"` or thin `page.evaluate(fetch)`) | Low CPU/RAM, fast, schedulable | Default after capture |
| **Patchright UI** (`method: "playwright"`) | Heavy browser per job | Export ZIP/XLSX with no stable API, captcha-only flows, or mimic failed after honest attempt |

The scrape service already shows the hybrid pattern in `problematic-orders.ts`: browser warms session; `window.fetch` hits internal API. Codify should push further: **Node `fetch` + harvested credentials**, drop the browser from the hot path when possible.

---

## Codify pipeline (order matters)

### 1. Network discovery (during or right after capture)

Follow `network-discovery.md`:

- Attach response listener **before** navigation.
- Record method, URL, query keys, body, response paths.
- Distinguish wire vs decrypt vs in-memory (Vuex).
- Write `## API contracts` on the playbook (see playbook-format.md).

```bash
playwright-cli -s=sla-probe requests
playwright-cli -s=sla-probe request <id>
```

### 1.5 Signature-enforcement probe (do this before reverse-engineering a signer)

Before spending hours on an obfuscated per-call signature (`X-Bogus`, `X-Gnarly`, HMAC query param), test **empirically** whether the backend actually validates it. Some are best-effort bot-scoring telemetry that gets logged but never rejected on.

> **RUN THIS FROM OUTSIDE THE PAGE.** An in-page probe cannot strip a header the page's own
> monkeypatched `fetch` re-adds, so it answers `200` for a header that is mandatory and the whole
> mimic gets designed on that. `scripts/probe-signature-enforcement.js` is a `[run-code]` in-page
> script and has exactly this blind spot for HEADER-borne signatures — it is only trustworthy for a
> signature carried as a URL QUERY PARAM, which the page's wrapper does not rewrite. Any past
> "not enforced" verdict reached with it against a header is unproven, not proven.

The honest form is a **verbatim replay from `curl`** (or the target language), built from the saved
HAR so every other header matches the real request:

```bash
# arm A — positive control: the request replayed verbatim MUST return 200,
#         or the harness is broken and no other arm means anything
curl -s -o /dev/null -w '%{http_code}\n' -H @verbatim_hdr.txt "<url>"
# arm B — the same thing with ONLY the signature header removed
grep -iv '^x-sap-sec:' verbatim_hdr.txt > nosec.txt
curl -s -o /dev/null -w '%{http_code}\n' -H @nosec.txt "<url>"
# arm C — per-request or per-session? put endpoint 1's signature on endpoint 2
curl -s -o /dev/null -w '%{http_code}\n' -H @swapped.txt -X POST --data @body2.json "<url2>"
```

- **A 200, B 200** → not enforced. Skip the signer; call the endpoint plain.
- **A 200, B 4xx, C 200** → enforced but **per-session**: harvest one signature and reuse it.
- **A 200, B 4xx, C 4xx** → enforced **per-request**. No HTTP client can reproduce it — run the calls
  in-page instead, through the resident signer (`credential-harvest.md` "Auth models"), which is what
  the Shopee Brand Portal adapter does.

Arm C is the one people skip, and it is the one that decides whether a mimic is possible at all.

Only probe idempotent reads this way — never a write endpoint (a stripped-signature POST might still execute for real).

### 1.6 Field leveling (L1/L2/L3) — classify every field before harvesting

Don't harvest or hand-build every field you see in a captured request — classify each one by what happens when you remove it, then only spend harvest effort on the fields that actually matter. This is by-removal classification only, no DTO file, no entity mapping — the test, not a code-generation output:

| Level | Test | Meaning | Handling |
|-------|------|---------|----------|
| **L1** | Remove it → 401/403/400 or a materially different error | Required — auth or a mandatory param | Must always be sent; harvest it (step 2) |
| **L2** | Remove it → still 200, but the response content changes | Functional — customizes the result (pagination, sort, filter) | Send with a sensible default |
| **L3** | Remove it → still 200, response is effectively identical | Optional — telemetry, SDK version, tracking id | Safe to omit from the mimic entirely |

**A field's name is not evidence of its level.** `x-sap-sec` sounds critical; on one captured Shopee endpoint it turned out to be L3 (telemetry, logged but not checked). Base every classification on an actual removal test, the same discipline as the §1.5 signature probe — this is that same test generalized to every field, not just the signature.

```bash
playwright-cli -s=sla-probe run-code --filename=scripts/probe-field-levels.js
```

Only probe idempotent reads this way (same safety constraint as §1.5) — never strip-and-resend a write endpoint. Record the result in the playbook's `## API contracts` under `field_levels` (template below) so the mimic adapter only harvests/sends L1+L2 fields and skips L3 entirely.

### 2. Credential / context harvest

For each dynamic token the contract needs, **scoped to the L1/L2 fields identified in step 1.6** — don't harvest fields you already classified as L3 and are going to omit:

1. Run `scripts/comprehensive-search-harvest.js` in DevTools on the logged-in page (or via `playwright-cli run-code` with the same logic).
2. Fill `searchTargets` from L1/L2 keys seen in captured requests (names only — values come from the live session).
3. Export the console table → `docs/automation/captures/<playbook>-auth-context.json` (gitignore if sensitive).

Canonical implementation: `scripts/comprehensive-search-harvest.js` in this skill.

### 3. Build the mimic adapter

Target shape in a Bun/Node service (e.g. `module-auto-scrape-integration-service-be`):

```typescript
// Preferred: method "api" — no browser
const adapter: Adapter<Query, Data> = {
  marketplace: "shopee",
  method: "api",
  operation: "problematic-orders", // or new operation name
  async run(query) {
    const creds = await getShopeeSessionContext(query.brand); // from COE DB / env
    const url = buildUrl(capturedPathPattern, creds);
    const res = await fetch(url, { method: "POST", headers: buildHeaders(creds), body: buildBody(query) });
    // validate + map to rows; preserve raw in envelope if needed
  },
};
```

Field levels for the adapter's request/response shape come from §1.6 (classify by removal-testing, not by guessing which fields "look" required) — always keep `raw_data`/the full response preserved in the adapter's return shape rather than cherry-picking fields, so a field that turns out to matter later doesn't require re-capturing.

**Hybrid (step down from pure api):** one Playwright page per brand, `page.evaluate(() => fetch(...))` so cookies attach automatically — same as `problematic-orders.ts`. Still cheaper than clicking through export UI.

**Async export chain template (submit → poll → resolve-url → fetch):** the shape seen on every order/income/balance/video export captured so far — but confirm it on YOUR target before assuming all four steps exist; some export APIs collapse steps 3-4 into a single response that returns bytes directly. Check one real "ready" response body before wiring the adapter:

1. Submit the job → get a job/task id.
2. Poll a status endpoint until ready. Prefer dual-signal checks when the API exposes them (a status-list flag AND a separate file-readiness check) — some jobs report "done" on one signal before the file is actually fetchable on the other. **Verify the API actually exposes two signals before building a dual-signal check** — if there's only one, a single-signal poll is correct and a dual-signal one is dead code checking a field that doesn't exist.
3. **Resolve a fresh download URL** on the tick you're actually ready to download, IF the "ready" response returns a URL rather than bytes. Export APIs commonly return a disposable, single-use pre-signed URL — caching it from an earlier poll tick and reusing it later fails silently or 403s. If the "ready" response already contains the file bytes, there is no step 3 — don't add a needless extra fetch.
4. `GET` that URL separately (it's usually unauthenticated / pre-signed, not the same auth as the status endpoint) — only when step 3 applies.

Also fold in terminal-failure fast-fail (a known failure status code should stop polling immediately, not run out the timeout) and self-throttle detection (if status is unchanged for an unusually long time, that's likely anti-abuse throttling, not "almost done" — stop instead of hammering). Reference implementation: `scripts/poll-async-export.js` — pass `null`/omit `resolveDownloadUrl` when step 3 doesn't apply to your target.

**Opaque-cursor pagination:** when a response carries a pagination block shaped like `{has_more, next_page, search_key, next_item_cursor}`, treat the server-issued cursor/`search_key` as opaque and carry it forward verbatim on the next request — do not just increment a page number. Some platforms invalidate pagination consistency if you do.

### 4. Parity verification (required)

| Check | Pass criteria |
|-------|----------------|
| Same row count / IDs | Mimic vs one UI export or capture HAR sample |
| Date range | `time_from` / `time_to` match playbook window |
| Pagination | All pages until empty `exceptional_case_list` (or equivalent) |
| Auth failure | One silent refresh when the capture holds a refresh call, then a clear `AuthError` with re-login instructions (`har-to-client.md`) |

Do **not** declare codify done until mimic returns equivalent data without driving the export dialog.

### 5. Fallback to Patchright UI

Only when:

- File is only available as generated XLSX/ZIP with no list API.
- Request signing cannot be reproduced (try in-page `$axios` replay first).
- Mimic parity fails after fixing harvest + contract.

Then use `be-adapter-translation.md` (Patchright path).

---

## Playbook `## API contracts` template

```yaml
api_contracts:
  - name: exceptional-case-list
    method: POST
  - path: /api/v4/seller_center/return/return_list/get_exceptional_case_list
    query_params:
      SPC_CDS: "{harvest:SPC_CDS_CHAT}"
      SPC_CDS_VER: "2"
    body_template: |
      { "case_tab": 0, "flow_tab": 1, "pagination": { "page_number": 1, "page_size": 40 } }
    response_paths:
      - data.exceptional_case_list[]
    auth_harvest:
      - SPC_CDS_CHAT
      - csrf_token
    field_levels:            # from §1.6 removal-testing, not guessed
      L1: [SPC_CDS_CHAT, case_tab]       # required — harvest + always send
      L2: [page_number, page_size]        # functional — send with defaults
      L3: [x-sap-sec, x-sz-sdk-version]   # optional — omit from the mimic
    mimic_status: pending | verified | fallback_playwright
```

---

## Anti-patterns

- Codify straight to `page.getByRole` click export when HAR already shows a list API.
- Hardcode one `SPC_CDS` forever — harvest per session/brand.
- Skip parity check because "fetch returned 200".
- Keep Playwright in cron for data that mimic already serves.
- Assume a Node/Go `fetch()` will reach every endpoint a browser reaches. Some token-refresh/login-adjacent calls are gated by a Cloudflare (or similar) bot-fingerprint check that only passes from inside a real browser context — if a call 1010s or CAPTCHAs from a raw HTTP client but succeeds from `page.evaluate(fetch)`, that's the signal to keep that one call browser-driven (hybrid) rather than pure `method: "api"`, not a bug to keep chasing. One rung sits between the two and is cheaper than a browser — a fingerprint-matching HTTP client; `har-to-client.md` "Which transport the client uses" says when it applies.
- Assume every action a browser can do is API-replayable at all. Some flows enforce **server-side sequential-action progression** — an identical-payload direct API call fails ("access restricted") while the same action via real UI clicks succeeds, because the server verifies the user actually stepped through the prior UI states, not just that the final payload is correct. Verify this empirically (one direct-replay attempt) before committing to a pure API-mimic design for a given flow; if it fails this way, `be-adapter-translation.md` (Patchright UI) is the only path, not a signing problem to solve.

---

## Cross-references

| File | Role |
|------|------|
| `network-discovery.md` | Find the right fetch |
| `har-to-client.md` + `scripts/har-digest.py` | Start from a saved HAR; transport ladder; refresh-on-401; OpenAPI output |
| `credential-harvest.md` | Find where tokens live |
| `scripts/comprehensive-search-harvest.js` | DevTools harvest script |
| `be-adapter-translation.md` | Patchright fallback only |
| §1.6 above + `scripts/probe-field-levels.js` | L1/L2/L3 field classification by removal-testing (self-contained — no external skill/DTO dependency) |
