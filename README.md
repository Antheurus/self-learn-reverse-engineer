# self-learn-automation

A [Claude Code](https://claude.com/claude-code) skill bundle for capturing a repetitive browser
workflow **once**, then running it reliably forever — and turning it into production code that calls
the site's own HTTP APIs instead of driving a browser on every cron tick.

The core idea: **a playbook is durable knowledge.** Each session either confirms the playbook still
works or repairs the part that broke. Discovery happens once; production replays captured requests
with harvested auth context.

This is the opposite of "rediscover the DOM every run".

## The lifecycle

```
                ┌─────────────┐
                │ sla-capture │  ← playwright-cli: UI steps + network/API contracts
                └──────┬──────┘
                       │ playbook + network calls + auth harvest
                       ▼
                ┌─────────────┐         ┌──────────────┐
                │  sla-run    │ ──────▶ │ sla-correct  │
                └──────┬──────┘         └──────────────┘
                       │ verified
           ┌───────────┴───────────┐
           ▼                       ▼
    ┌─────────────┐         ┌─────────────────────────────┐
    │sla-extensify│         │ sla-codify                  │
    │  MV3 ext    │         │ 1) API mimic (default)      │
    └─────────────┘         │ 2) Patchright UI fallback   │
                            └─────────────────────────────┘
```

## The five sub-skills

| Sub-skill | Does | Triggered by |
|---|---|---|
| `sla-capture` | First-run discovery, writes the playbook | A brand-new workflow |
| `sla-run` | Executes a playbook, updates its run log | "run <name>" / a known playbook |
| `sla-correct` | Self-heals broken selectors and steps | A failed run, "automation broken" |
| `sla-extensify` | Builds an MV3 Chrome extension from the playbook | "extensify" |
| `sla-codify` | Backend adapter — HTTP mimic first, UI automation only as fallback | "codify", "mimic API" |

## What's in here

**References** — the accumulated technique:

| File | Covers |
|---|---|
| `references/playbook-format.md` | The full playbook schema |
| `references/primitives.md` | playwright-cli patterns, framework-specific traps |
| `references/network-flow-spec.md` | Capture-artifact contract: verbatim, never summarized |
| `references/network-discovery.md` | Wire vs post-decrypt vs in-memory; bulk URL compare |
| `references/api-mimic-codify.md` | Turning captured requests into a `fetch` adapter |
| `references/credential-harvest.md` | Where each auth key actually lives, and the four auth models |
| `references/authenticated-websocket-replay.md` | Write paths that ride an open socket |
| `references/self-correction.md` | Failure-mode catalog |
| `references/be-adapter-translation.md` | Patchright UI fallback |

**Scripts** — droppable probes, mostly for `playwright-cli run-code` or the DevTools console:

| Script | Does |
|---|---|
| `capture-har.js` | Passive HAR 1.2 capture |
| `capture-on-trigger.js` | Active fetch/axios monkeypatch capture |
| `route-intercept-capture.js` | Safe write-path capture — fakes success, sends nothing |
| `comprehensive-search-harvest.js` | Value-first credential locator (cookie / localStorage / IndexedDB / heap) |
| `probe-signature-enforcement.js` | Strips a signature param and resends — is it actually enforced? |
| `probe-field-levels.js` | Which nesting level carries the field |
| `find-fields-recursive.js` | Recursive field finder in unknown JSON |
| `replay-with-fresh-fields.js` | Steal-template-then-replay, with a dry-run mode |
| `walk-react-fiber.js` / `walk-vue-tree.js` | Read component state directly |
| `poll-async-export.js` | Poll a job-then-download export flow |
| `solve-shape-match-captcha.js` | Shape-match captcha solver via a vision model |
| `anonymize-export.py` | Strip identifying values out of a capture before sharing |
| `new-playbook.sh` | Scaffold a fresh playbook |

## A few things it insists on

- **Capture artifacts are saved verbatim** — the literal `fetch(...)`, the full URL, the real
  response, the HAR. A prose summary cannot be replayed, so the next session re-does the whole
  reverse-engineering pass. Session tokens get masked; everything else stays exact.
- **Don't reimplement per-call signatures.** A `fetch` issued from the page's own MAIN-world context
  is signed by the page's resident signer for free. And before assuming a signature matters at all,
  strip it and resend — at least one platform's was best-effort telemetry, not enforced.
- **Rate limits are assumed before the first loop, not discovered in production.** Every loop over a
  third-party endpoint gets its own configurable delay and a cache consulted first.
- **"Request failed" and "no result" are different buckets.** Merging them once turned ~1100 valid
  records into a "these don't exist" report.

## Install

```bash
git clone https://github.com/Antheurus/self-learn-automation.git ~/.claude/skills/self-learn-automation
```

Requires [`playwright-cli`](https://github.com/vercel-labs/playwright-cli) for the capture and run
phases. `sla-codify` emits plain `fetch` adapters with no browser dependency; the Patchright fallback
path needs [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright).

## Scope

Built for automating **your own accounts on services you're authorized to use** — the seller
dashboard you log into daily, the internal tool with no API, the export that only exists as a button.
It pairs deliberately with rate-limit discipline and gentle pacing because the alternative gets
accounts captcha-walled.

The bundled examples under `assets/example-playbooks/` are sanitized: hostnames, account names, and
record IDs are placeholders. The techniques and the lessons in them are verbatim from real runs.

## License

MIT — see [LICENSE](LICENSE).
