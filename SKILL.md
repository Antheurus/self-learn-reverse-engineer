---
name: self-learn-automation
description: Build, run, and progressively improve browser-based automation playbooks for repetitive web tasks — multi-step click sequences, form fills, file downloads with polling, scraping flows. Uses playwright-cli (NOT Playwright MCP browser_*). Each playbook lives in `docs/automation/`. Router dispatches sla-capture, sla-run, sla-correct, sla-extensify (MV3 extensions), sla-codify (API mimic first, Patchright UI fallback). Trigger on "docs/automation", playbook names, "run/jalanin", "extensify", "codify", "mimic API", or multi-step web workflows.
---

# Self-Learn Automation

A bundle of skills for capturing repetitive browser workflows once, then running them reliably forever — with self-improvement when sites change, and a translation path to production backend adapters.

The core idea: **a playbook is durable knowledge**. Each session either confirms it works or updates the parts that broke. The first run uses **playwright-cli** to discover UI steps **and** internal API contracts. **Codify** turns that into production code that **mimics the platform's own HTTP APIs** (lightweight `fetch`) — not a permanent heavy browser per cron job. Patchright UI adapters are **fallback** when data only exists as generated files (XLSX/ZIP) or mimic cannot reach parity.

This is the opposite pattern from "rediscover the DOM each time" — discovery is once; production replays captured requests with harvested auth context.

---

## The lifecycle

```
                ┌─────────────┐
                │ sla-capture │  ← playwright-cli: UI steps + network/API contracts
                └──────┬──────┘
                       │ playbook + ## API contracts + auth harvest
                       ▼
                ┌─────────────┐         ┌──────────────┐
                │  sla-run    │ ──────▶ │ sla-correct  │
                └──────┬──────┘         └──────────────┘
                       │ verified
           ┌───────────┴───────────┐
           ▼                       ▼
    ┌─────────────┐         ┌─────────────────────────────┐
    │sla-extensify│         │ sla-codify                  │
    │  MV3 ext    │         │ 1) API mimic (method: api)  │  ← default
    └─────────────┘         │ 2) Patchright UI fallback   │
                            └─────────────────────────────┘
```

---

## The bundle — five sub-skills

| Sub-skill | Does | Entry point |
|---|---|---|
| `sla-capture` | First-run discovery via **playwright-cli**, save playbook | New workflow |
| `sla-run` | Execute playbook via **playwright-cli**, update run log | "run/jalanin" / known playbook |
| `sla-correct` | Self-heal broken selectors/steps | Failed run or "automation broken" |
| `sla-extensify` | MV3 extension from playbook + network contracts | "extensify", `extensions/` deliverable |
| `sla-codify` | API mimic adapter first; Patchright UI only if needed | "codify", "mimic API", service endpoint |

**Start here:** invoke `Skill({skill: "<sla-name>"})` for the mode that matches the user's intent.

---

## Mode picker

| Situation | Sub-skill |
|---|---|
| User describes a brand-new workflow ("Goto X > click Y > download Z") | `sla-capture` |
| User says "run/jalanin/jalankan <name>" or names a known playbook | `sla-run` (falls through to `sla-capture` if no match) |
| A step in `sla-run` failed mid-execution | `sla-correct` |
| User reports "automation X is broken" or "this used to work" | `sla-correct` (then back to `sla-run`) |
| User wants Chrome extension from playbook / network discovery | `sla-extensify` |
| User wants a backend adapter / service endpoint from an existing playbook | `sla-codify` |

If the user's intent is ambiguous (e.g., "do the shopee thing"), check `docs/automation/*.md` first — if a matching playbook exists, default to `sla-run`. If not, ask via `AskUserQuestion` whether they want to capture a new one.

---

## Layout

```
<project>/docs/automation/              # project-local playbooks (visible, committed docs)
├── README.md                            # auto-maintained index
├── .env                                 # credentials, gitignored, never committed
├── captures/                             # HAR/JSON network captures, gitignored
└── *.md                                 # one playbook per outcome

<project>/docs/profile/                 # project-local playwright-cli browser profiles (gitignored)
├── playwright-cli/                      # the default profile — one per project, reused across sessions
└── <session-name>/                      # named copies, one per parallel/dedicated session (e.g. hq/, shopee/, bts-day2-slot-1/)

~/.claude/skills/
├── self-learn-automation/               # ← this skill (router + shared references)
│   ├── SKILL.md
│   ├── references/
│   │   ├── playbook-format.md           # full playbook schema
│   │   ├── primitives.md                # playwright-cli patterns
│   │   ├── api-mimic-codify.md          # primary codify: HTTP mimic (sla-codify)
│   │   ├── credential-harvest.md        # auth key locations (comprehensive-search)
│   │   ├── network-discovery.md         # fetch compare, wire vs decrypt, bulk URL probe
│   │   ├── self-correction.md           # failure mode catalog
│   │   └── be-adapter-translation.md    # Patchright UI fallback only
│   ├── scripts/
│   │   ├── new-playbook.sh                    # scaffold a fresh playbook
│   │   ├── capture-har.js                     # passive HAR 1.2 capture (run-code)
│   │   ├── comprehensive-search-harvest.js    # DevTools credential harvest v3
│   │   ├── route-intercept-capture.js         # safe write-path capture (fake-success route)
│   │   ├── capture-on-trigger.js              # active fetch/axios monkeypatch capture
│   │   ├── replay-with-fresh-fields.js        # steal-template-then-replay + dry-run
│   │   ├── find-fields-recursive.js           # recursive field finder in unknown JSON
│   │   ├── probe-signature-enforcement.js     # strip-and-resend signature-enforcement test
│   │   ├── probe-field-levels.js              # full L1/L2/L3 field classification by removal-test
│   │   ├── poll-async-export.js               # dual-signal + terminal-fail + self-throttle poll
│   │   ├── walk-react-fiber.js                # React fiber read/force (DevTools paste)
│   │   ├── walk-vue-tree.js                   # Vue $data-shape component search (DevTools paste)
│   │   └── anonymize-export.py                # XLSX/CSV → safe dummy fixture
│   └── assets/example-playbooks/        # reference examples (read for shape)
├── sla-capture/SKILL.md                 # discovery sub-skill
├── sla-run/SKILL.md                     # execution sub-skill
├── sla-correct/SKILL.md                 # self-heal sub-skill
├── sla-extensify/SKILL.md               # MV3 extension from playbook
└── sla-codify/SKILL.md                  # BE translation sub-skill
```

**Browser engine:** `playwright-cli`, headed, on an isolated per-session profile (default-first: use `docs/profile/playwright-cli/` when free, copy it to `docs/profile/<name>/` when taken — full procedure in `references/primitives.md` §0.5). **Do not** use Playwright MCP `browser_*` or `cursor-ide-browser` for SLA unless the user explicitly overrides. **Headed is the default — never pass `--headless` unless the user explicitly asks for headless mode.**

**Why this split:** shared references and playbook format; each phase (capture → run → correct → extensify → codify) loads only what it needs.

---

## Hard rules (apply across all sub-skills)

1. **Live verification is non-negotiable.** Don't save a playbook from a partial run. Don't declare a codify done without a real adapter call producing a real file. Don't declare an **extensify** done from `build_prod/` marker greps alone — load the built extension into a real browser and drive its UI (`sla-extensify/references/load-extension-verify.md`); markers prove "built", a rendered+measured UI proves "works". By DEFAULT the model self-verifies — *model load + model eyeball* (load headed, drive via eval + screenshot, report evidence): do it, don't ask. Escalate to *model load + user eyeball* (`AskUserQuestion`) ONLY on a real issue the model can't settle alone; *auto-merge* is opt-in only. Label options "model"/"user", never "I"/"you" (ambiguous → wrong actor). The user's standing rule: "first run is to playwright, DOING UNTIL FILE DOWNLOADED, then code after it."
2. **Credentials live in `docs/automation/.env` only.** Reference by variable name (`${SHOPEE_PASSWORD_JIERA}`) in playbooks. Never hardcode values. Never echo values back to the user. Never commit `docs/automation/.env`.
3. **The playbook is the spec.** When backend adapter code and the playbook disagree, the playbook is correct. When a site changes, update both the adapter AND the playbook — playbooks are living documents, not historical artifacts.
4. **Persistent profiles per adapter.** Two adapters sharing a Playwright `USER_DATA_DIR` will file-lock each other. Each adapter gets its own profile path.
5. **Use Patchright, not Playwright.** For any backend code that drives the browser, `import { ... } from "patchright"`. Vanilla Playwright leaks the automation signal via CDP `Runtime.enable` and triggers captchas on Tokopedia and similar sites.
6. **playwright-cli always runs headed by default.** Never add `--headless` or any headless flag unless the user explicitly requests it. The user must say "headless" or "tanpa GUI" to override. Running headed is mandatory — it's how you confirm the browser is doing what you think it's doing, and how the user can intervene if something goes wrong.
7. **Network captures are VERBATIM and flow-first — never synthesized.** Any flow touching an API is captured per `references/network-flow-spec.md`: a mermaid `## Flow`, literal copy-as-`fetch()` blocks (URL + headers + body kept exactly, signing params included), and an `## Orchestration chain` table mapping each response field to the next request's param. A paraphrased endpoint ("it returns the creators") is a guess and is rejected. The user's standing rule: this is SUPER VERBATIM "karena sangat rawan ngasal" — the literal call is the fact, the summary is the error.
8. **Save the HAR; check it before re-capturing.** Every network capture writes a real `.har` (or capture JSON) into `docs/automation/captures/` (`scripts/capture-har.js`, or DevTools → Save all as HAR). Before opening a browser to RE anything, grep `docs/automation/` — if a playbook/capture/HAR already covers the flow, READ it and stop. Re-RE-ing an already-captured flow is banned; it is the single biggest documented time sink.
9. **Default-first profile, copy-on-collision, login-probe gate.** Each playwright-cli session must reach the site logged-in, in its own isolated profile. At session start, probe whether the default profile (`docs/profile/playwright-cli/`) is already in use: **free → use it; taken → tell the user and `cp` it to a per-session copy under `docs/profile/<name>/`** (delete `Singleton*` in the copy) so cookies/login carry over. Copy is the default collision behavior — `--fresh` (empty), loading extensions, and a different-account cookie export are explicit opt-ins only. Whatever profile is acquired, it must pass a **login-probe** (navigate, confirm no redirect to `/login`) before the session does any work. Parallel sessions each get a unique `-s=<task>` + unique profile dir — never share a `user-data-dir`. Full procedure: `references/primitives.md` §0.5.

---

## Anti-patterns

| Don't | Why |
|---|---|
| Save a playbook before the workflow ran end-to-end successfully | A playbook that hasn't been verified is a guess; the next session believes it |
| Hardcode passwords in playbook files | `.env` exists for this. Refer by name. |
| Use brittle index-based selectors (`div:nth-child(7)`) when text/role/data-testid exists | Sites reflow; semantic selectors survive longer |
| Skip the post-condition check on a step | "Clicked Export" ≠ "Export started" |
| Rediscover the whole DOM on every run | That's the problem this skill exists to solve. Cache what worked. |
| Treat the playbook as immutable | It's living. Update it. That's the deal. |
| Trust `waitForLoadState("load")` after an SPA sidebar click | React Router does pushState — load doesn't fire again. Use `waitForURL` or direct nav. |
| Set a custom `userAgent` when using Patchright + `channel: "chrome"` | Re-introduces the bot detection signal — defeats the point of Patchright |
| Run `playwright-cli` with `--headless` by default | Headed is mandatory by default — headless only if the user explicitly says so |
| Open a second session on the same `--profile` dir as a running one | Chromium's `Singleton*` lock kills it — copy the profile (cookies carry over), `rm Singleton*`, use the copy. §0.5 |
| Use a blank fresh profile when the default is logged-in and just busy | A blank profile can't reach the site — `cp` the authed default so login carries over. Fresh is an explicit opt-in, not the collision default. |
| Summarize a captured endpoint in prose instead of the literal `fetch()` | A paraphrase isn't replayable; the next session re-REs it. Paste copy-as-fetch verbatim. |
| Describe a multi-step API flow as a paragraph | Use the `## Orchestration chain` table: responseN.field → requestN+1.param. The chain IS the deliverable. |
| Finish a network capture without saving a HAR/JSON to `docs/automation/captures/` | Nothing durable was produced; the RE evaporates and gets redone |
| Open a browser to RE a flow already in `docs/automation/` | Banned — read the saved playbook/HAR. This is the documented multi-hour time sink. |

---

## When to read what

| You're doing | Read |
|---|---|
| Writing or updating a playbook | `references/playbook-format.md` |
| **Capturing ANY network/API flow (the verbatim + mermaid + orchestration-chain + HAR contract)** | **`references/network-flow-spec.md` (MANDATORY)** |
| Implementing login / polling / downloads / SPA nav / httpOnly cookies | `references/primitives.md` |
| Finding which API fetch has the payload / comparing two URLs, capturing a write path safely, or finding an unknown field | `references/network-discovery.md` |
| The write/send path is a WebSocket frame (chat/IM/realtime/collab) — reproduce a send without DOM | `references/authenticated-websocket-replay.md` |
| Building MV3 extension from playbook | `sla-extensify` + `chrome-extension-mv3` |
| A step just failed and you need to fix it | `references/self-correction.md` |
| Codify to production (API mimic), testing if a signature/field is actually required (L1/L2/L3 by removal-testing, not by guessing), or an async export→poll→download chain | `references/api-mimic-codify.md` §1.5-1.6, `scripts/probe-signature-enforcement.js`, `scripts/probe-field-levels.js` |
| Reading React/Vue internal component state DevTools doesn't expose | `references/primitives.md` §22-23, `scripts/walk-react-fiber.js`, `scripts/walk-vue-tree.js` |
| Harvest SPC_CDS / csrf / session keys | `references/credential-harvest.md`, `scripts/comprehensive-search-harvest.js` |
| Patchright UI fallback only | `references/be-adapter-translation.md` |
| Looking for an example before writing your own | `assets/example-playbooks/*.md` |

Each reference file is self-contained. Don't read all of them upfront — pull only what's needed for the current task.

---

## Project-level rules sync

If the calling project has a `.claude/rules/` directory, the playbooks and any new automation-specific patterns should be cross-referenced there. Specifically:
- Project-level `lessons.md` should capture site-specific gotchas (e.g., "Shopee httpOnly cookies need context.addCookies").
- Project-level `automation.md` (if present) should reference the `docs/automation/` playbooks as the spec.
- Project-level `platform-adapters.md` and `scraping-patterns.md` (if present) hold the production-side knowledge that `sla-codify` populates.

Invoke `rules-writer` to push session learnings into the project's rule files after a substantial new playbook lands.
