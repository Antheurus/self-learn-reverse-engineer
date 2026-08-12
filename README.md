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

**Scripts** — droppable probes. They span three incompatible execution environments behind two
file extensions, so **the extension is not the signal**: every file carries an `ENV:` banner on its
first line, and `tests/check-env-banners.py` proves each one still parses in the form it is actually
consumed in.

| Runs in | What that means |
|---|---|
| `browser-run-code` | Fed to `playwright-cli run-code --filename=<file>`. Must be a **single function expression** — spliced into `await (<file>)(page)`. No `require`/`import`/`fs`/`fetch`/`setTimeout`, and it never touches disk. |
| `browser-console` | Pasted whole into DevTools Console on a logged-in page. Declares several top-level functions, so it does **not** fit run-code's single-expression sandbox. |
| `local-python` | Runs on your own machine and reads/writes real files. Not a browser snippet. |

| Script | Runs in | Does |
|---|---|---|
| `capture-har.js` | `browser-run-code` | Passive HAR 1.2 capture |
| `capture-on-trigger.js` | `browser-run-code` | Active fetch/axios monkeypatch capture |
| `route-intercept-capture.js` | `browser-run-code` | Safe write-path capture — fakes success, sends nothing |
| `comprehensive-search-harvest.js` | `browser-console` | Value-first credential locator (cookie / localStorage / IndexedDB / heap) |
| `probe-signature-enforcement.js` | `browser-run-code` | Strips a signature param and resends — is it actually enforced? |
| `probe-field-levels.js` | `browser-run-code` | Which nesting level carries the field |
| `find-fields-recursive.js` | `browser-run-code` | Recursive field finder in unknown JSON |
| `replay-with-fresh-fields.js` | `browser-run-code` | Steal-template-then-replay, with a dry-run mode |
| `walk-react-fiber.js` / `walk-vue-tree.js` | `browser-console` | Read component state directly |
| `poll-async-export.js` | `browser-console` | Poll a job-then-download export flow |
| `solve-shape-match-captcha.js` | `browser-run-code` | Shape-match captcha solver via a vision model |
| `anonymize-export.py` | `local-python` | Strip identifying values out of a capture before sharing |
| `new-playbook.py` | `local-python` | Scaffold a fresh playbook — `--dry-run`, credential stubbing, full frontmatter flags |

`anonymize-export.py` stays Python deliberately. It is the only script that reads and writes files
on disk, and openpyxl round-trips a workbook object so the fixture keeps its real structure —
which is the entire point of the tool. A JS port would need SheetJS as the repo's first runtime
dependency, would lose whatever SheetJS does not model on the round-trip, and would land a Node
script that looks identical to the browser snippets while being unpasteable into a console.

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
