# Network-Flow Spec — the VERBATIM, flow-first capture contract

Read this whenever a capture involves network/API calls (any RE of a web app's data: lists, search,
messaging, exports). It defines the **required shape** of the output. The failure this prevents:
writing a synthesized, child's-report summary ("hit endpoint A, it returns creators") that the next
session cannot replay — so it re-opens the browser and re-REs the same thing, burning hours.

## The leverage (teacher vs. student)

This skill is the **teacher**; the verbatim evidence it makes the agent produce is the **real book**. A
teacher who only *says* the lesson — synthesized instructions, no full-context book — sends the student into
the real world to "find out," and finding-out fails more than it works. So the high-leverage asset is the
**per-project verbatim capture**: the literal calls + responses + HAR, saved in the project's `docs/automation/`.
That evidence lives **per-project, never at user level** — the skill (user level) holds the contract and
format; the project holds the book. The book is a single `docs/automation/<flow>.md` containing the sections
below (verbatim calls + mermaid flow + orchestration chain + component specs) plus its raw HAR in
`docs/automation/captures/`. Never hardcode a specific project's path into this skill — each project writes its own.

## The two non-negotiable laws

1. **VERBATIM, never synthesized.** Every network call is recorded as the literal, copy-pasteable
   `fetch(url, {headers, body, method, credentials})` exactly as the browser sent it (DevTools →
   Network → right-click request → **Copy as fetch**, or the capture script below). Do NOT paraphrase
   the URL, drop query params, summarize headers, or describe the body in prose. The reader must be
   able to paste it and have it run. A paraphrased endpoint is a guess; a verbatim one is a fact.

2. **A capture artifact exists on disk BEFORE the write-up, and is CHECKED before any re-capture.**
   Save a real HAR (or the capture JSON) into `docs/automation/captures/`. Before opening a browser to RE
   anything, grep `docs/automation/` for an existing playbook / capture / HAR for that flow. If one exists,
   READ IT — do not re-drive the site. Re-RE of already-captured flows is the #1 time sink and is banned.

## Required playbook sections (network flows)

A network-driven playbook MUST contain these, in this order, on top of the base `playbook-format.md` schema:

### 1. `## Flow` — mermaid diagram (REQUIRED)

A `mermaid` diagram of the actual user + data flow. Not prose. Use `flowchart` for data lineage,
`sequenceDiagram` for request ordering. Every network call and every data handoff is a node/edge.

```mermaid
flowchart TD
  U[User types in search input] -->|query string| A[POST crm/creator/list]
  A -->|response.data.creators[].base.oec_id + handle_name| P[Dropdown: avatar + @handle + name]
  P -->|user picks → oec_id| M[oec_id reused downstream]
  M --> MSG[conversation/create participants[].uid = oec_id]
  M --> CRD[creator card / collab uses oec_id]
```

### 2. `## Network calls (VERBATIM)` — REQUIRED

One block per call, copy-pasteable. Mark dynamic parts with `<<...>>` AFTER showing the real captured
value, so the reader sees both the literal call and what varies.

```js
// [A] crm/creator/list — connected creators (the data behind the search dropdown)
fetch("https://affiliate-id.tokopedia.com/api/v1/oec/affiliate/crm/creator/list?user_language=en&aid=4331&app_name=i18n_ecom_alliance&device_id=0&fp=verify_mqbdmnoa_...&device_platform=web&cookie_enabled=true&screen_width=1512&screen_height=982&browser_language=en-US&browser_platform=MacIntel&browser_name=Mozilla&browser_version=5.0+(Macintosh...)&browser_online=true&timezone_name=Asia%2FJakarta&oec_seller_id=7494083408627664605&shop_region=ID&X-Tts-Oec-Bsid=9a8c...&msToken=SIpz...&X-Bogus=DFSz...&X-Gnarly=MPuo...", {
  "headers": {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin"
  },
  "referrer": "https://affiliate-id.tokopedia.com/connection/creator-management?shop_region=ID&shop_id=7494083408627664605",
  "body": "{\"page_no\":1,\"page_size\":20,\"sorter\":{},\"filter\":{\"single_filters\":[],\"multi_filters\":[],\"range_filters\":[]}}",
  "method": "POST",
  "credentials": "include"
});
// DYNAMIC: oec_seller_id=<<getOecSellerId()>>  ·  body.page_no=<<page>>  ·  msToken/X-Bogus/X-Gnarly/X-Tts-Oec-Bsid=<<auto-signed by page; do NOT re-sign — reuse page fetch>>
// RESPONSE (verbatim shape): { code:0, data:{ creators:[ { base:{ oec_id, handle_name, nick_name, avatar:{thumb_url_list} }, im:{status} } ] } }
```

Repeat for every call. Keep the signing tokens in the captured value (they prove it's verbatim) but
mark them dynamic — the production code reuses the page's auto-signed fetch, it never re-signs.

### 3. `## Orchestration chain` — REQUIRED when >1 call

The data-dependency map: which field of response N feeds which param of request N+1. This is the
orchestrator. State it as a table, never as prose.

| Step | Call | Take from response | Feed into next |
|---|---|---|---|
| A | `crm/creator/list` | `data.creators[].base.oec_id` | B `conversation/create` body `participants[].uid` |
| A | `crm/creator/list` | `data.creators[].base.handle_name` | shown in dropdown; `{username}` in message |
| B | `conversation/create` | `data.conversation_short_id` | C cmd-100 send frame `conversation_short_id` |

> The rule the user stated: "step A → check network A → when it returns responseA, take its code, feed
> into network B." That chain IS the deliverable. Without it, the next agent cannot reconstruct the flow.

### 4. `## Reusable components` — when the flow drives a UI piece

ASCII mock + the EXACT data binding (which response field renders where). Name it; it gets built once
and reused.

```
CreatorSearchPicker
┌─────────────────────────────────┐
│ 🔍 Cari kreator… @handle/nama    │  ← input; ≥2 chars, 300ms debounce → POST search_new
├─────────────────────────────────┤
│ (avatar) @creator.handle         │  ← data.creator_profile_list[].handle (av-enveloped)
│         Creator Display Name     │  ← .nick_name / display name      .avatar → avatar img
│ (avatar) @another.creator        │
└─────────────────────────────────┘
   click row → chip{ handle, oec_id }  (oec_id flows to Orchestration chain step B)
```

### 5. `## Capture artifacts` — REQUIRED

Absolute/relative paths to the saved HAR + capture JSON, and the date. These are what the next session
reads INSTEAD of re-driving the browser.

```
- docs/automation/captures/affiliate-crm-creator.har        (2026-06-13, 7 calls)
- docs/automation/captures/affiliate-crm-creator.json        (probe dump, verbatim req+resp)
```

## How to capture (mechanics)

1. **Check first:** `ls docs/automation/captures/ docs/automation/*.md` and grep for the host/endpoint. If found, READ — stop here.
2. **Record a HAR while driving** with the capture script: `scripts/capture-har.js` (edit its CONFIG
   block: target URLs to drive + output path under `docs/automation/captures/`), then
   `playwright-cli -s=<session> run-code --filename=.../scripts/capture-har.js`. It writes HAR 1.2.
   - Or, zero-code: in real Chrome DevTools → Network → record the flow → right-click → **Save all as HAR**
     → drop the file into `docs/automation/captures/`.
3. **For the verbatim fetch blocks:** DevTools → Network → the request → right-click → **Copy as fetch**,
   paste as-is. (`playwright-cli request <n>` / `request-headers` / `request-body` / `response-body`
   give the same data when DevTools isn't driving.)
4. **Decode binary/protobuf** bodies per `network-discovery.md` §9 and keep the decoded bytes in the capture dir.
5. **Gitignore the captures.** HAR/JSON captures contain the raw `cookie` header and signing tokens
   (`msToken`/`X-Bogus`/`X-Gnarly`). Ensure `docs/automation/captures/` and `*.har` are gitignored — NEVER commit
   them. In the verbatim `## Network calls` blocks, the signing values prove it's real, but mark them
   `<<auto-signed>>` and never paste a live token into a committed playbook body.

## Anti-patterns (these are the failures that wasted hours)

- Writing "endpoint returns a list of creators" instead of the literal `fetch(...)` block → next session re-REs.
- Dropping the signing params from the URL because they "look like noise" → the call is no longer verbatim/replayable.
- Describing the multi-step chain in a paragraph instead of the response-field → next-request-param table.
- Finishing capture without saving a HAR/JSON to `docs/automation/captures/` → nothing durable; the RE evaporates.
- Re-opening the browser for a flow already in `docs/automation/` → banned; read the capture.
