# HAR to client — reverse-engineering a site from a saved capture

Read this when the job is "turn this website into an API": a goal, a site, and a client at the end.
It is the path through the bundle that never needs a UI playbook, and the path to take whenever a
`.har` already exists.

The shape comes from [reverse-api-engineer](https://github.com/kalil0321/reverse-api-engineer) (MIT):
browse, record a HAR, have a model read the traffic and write a client. What that tool does with a
Python CLI and a prompt, this bundle does with the scripts it already had plus one new one. Where the
two disagree, the last section says which side was kept and why.

---

## Three ways in, one pass out

| The situation | How the HAR gets made | Then |
|---|---|---|
| The agent can reach the data by itself | `sla-capture` drives; `scripts/capture-har.js` records | the pass below |
| The flow needs a human — a login, a captcha, a path only the user knows | Open headed (`--headed --persistent --profile=…`), the user drives, then DevTools → Network → **Save all as HAR** into `docs/automation/captures/` | the pass below |
| A `.har` is already in `docs/automation/captures/` | Nothing. **Do not open a browser** (hard rule 8) | the pass below |

The third row is the one that gets skipped. A saved HAR answers a new question about the same site —
a second endpoint, another output language, a field nobody extracted the first time — without a
single request to the site.

---

## The pass

**1. Digest.** Never `Read` a HAR and never print one: it is megabytes, and it holds every cookie of
the session.

```bash
python3 ~/.claude/skills/self-learn-reverse-engineer/scripts/har-digest.py docs/automation/captures/<name>.har
```

It prints names and shapes only — endpoints grouped by method, host and path template (GraphQL split
per operation), the header and cookie *names* that carry credentials, flags, and chain hints.

**2. Pick the calls that serve the goal.** Most of a capture is telemetry, feature flags and
analytics. Name the endpoints kept and the ones dropped; a client that replays all of them is a
client that breaks on the first analytics change.

**3. Record them verbatim.** The digest gives entry indexes; pull those entries and write the literal
call into the playbook per `network-flow-spec.md`. The `CHAIN` section is the raw material for the
`## Orchestration chain` table — but it only proves a value *reappears*, so confirm each row against
the two entries before writing it down.

**4. Measure what is required.** A HAR shows what the browser sent, not what the server needs. Field
levels come from the removal test (`api-mimic-codify.md` §1.6) and signature enforcement from the
three-arm replay (§1.5). Every `signature candidate` flag in the digest is a question for §1.5, not
a finding.

**5. Write the client** in the language of the project it lands in, through `sla-codify`. One function
per endpoint, the full response preserved, credentials read from where the project already keeps them.

**6. Run it against the live site.** The client is not done until a real call returns real data and
the count matches the capture (hard rule 1). Stop after three failed fix attempts and report what the
site answered; a fourth guess is not a diagnosis.

---

## Which transport the client uses

Try them in this order and stop at the first that reaches parity. Each step down costs more to run.

| Rung | When it is the answer | Cost |
|---|---|---|
| 1. Plain HTTP (`fetch`, `requests`) | The verbatim replay from `curl` returns 200 | none |
| 2. Fingerprint-matching HTTP client | Plain HTTP is refused (Cloudflare 1010, a captcha page, 403 on a request that is byte-identical to the browser's) while the same call succeeds in-page — the server is reading the TLS/HTTP2 handshake, not the request | one dependency |
| 3. In-page `fetch` (`page.evaluate`) | The request needs a per-request signature only the page's resident signer can produce (§1.5 arm C fails) | a browser per session |
| 4. Patchright UI | The data only exists as a generated file, or the server checks that the UI steps were walked | a browser per job |

Rung 2 is `httpcloak` (npm and PyPI, same name): it presents a real browser's TLS and HTTP/2
fingerprint from a plain HTTP client. **It has not been proven on any target in this bundle yet** —
the first use must run §1.5's arm A as a positive control and record the result here. If arm A fails
through it, go to rung 3; do not tune it.

---

## A 401 is handled once, and only by refresh

If the capture contains a **refresh or session-exchange call** (the digest flags candidates; see
`primitives.md` §25), the client calls it on the first 401/403, retries the original request once,
and raises `AuthError` if that also fails. That keeps an adapter alive across token expiry with no
human involved.

A **login with a password** is never automated inside the client, even when the HAR shows the whole
exchange. Credentials in an adapter are a separate liability from a refresh token, and a login
endpoint is where captcha and device checks live. `AuthError` names the command that re-authenticates.

---

## OpenAPI as a second output

When the user wants the API *documented* rather than only called — "bikin dokumentasi API-nya",
"OpenAPI spec", "swagger-nya" — write `docs/automation/<name>.openapi.json` (OpenAPI 3.0) beside the
playbook:

- Only endpoints present in the capture. A path guessed from a naming pattern is not in the spec.
- `required` comes from the L1/L2/L3 removal test. A field never tested is listed as optional with
  `x-untested: true`, not inferred from how important its name sounds.
- Example values come from the capture, with every credential replaced by a placeholder.
- `securitySchemes` describes where the credential travels (cookie name, header name), never its value.
- Response schemas describe the shape the digest printed; widen them only from a second real response.

The playbook stays the spec of record. The OpenAPI file is a rendering of it and is regenerated when
the playbook changes.

---

## What was not taken from upstream, and why

| Upstream does | Here | Reason |
|---|---|---|
| Hardcodes every cookie and token into the generated client | Credentials stay in `docs/automation/.env` or the project's session store | A generated file gets committed. A token in source is a token in git history, and this repo's own examples are public |
| Infers required vs optional parameters from reading traffic | Removal test | Traffic shows what was sent. `x-sap-sec` looked mandatory and tested as telemetry |
| Drives through Playwright MCP, Chrome DevTools MCP or `agent-browser` | `playwright-cli` on a persistent profile | A second automation stack is a second profile and no Patchright (hard rule 10) |
| Injects a stealth script and rotates user agents | Patchright with `channel: "chrome"` and no custom UA | A hand-set user agent is itself the signal (hard rule 5) |
| Tells the model to read the HAR file | `har-digest.py` | A HAR does not fit in context, and reading it prints the session's credentials into the transcript |
| Allows five fix attempts on the generated client | Three, then report | The fourth attempt is a guess about the site, and the site is the thing not yet understood |
| Collector mode (web search → JSONL) | Not here | It reverse-engineers nothing; `WebSearch` already does it |
| Client templates for ten languages | The project's language | A client in a language the project does not run is a file nobody maintains |
