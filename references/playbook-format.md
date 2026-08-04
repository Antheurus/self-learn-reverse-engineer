# Playbook Format

A playbook is a markdown file with YAML frontmatter that describes a reproducible web workflow. It's both human-readable documentation and machine-executable instructions — Claude is the runtime, not Node or Python.

## File location and naming

- Lives in `<project>/docs/automation/<kebab-case-name>.md`
- Name describes the outcome, not the site: `shopee-saldo-export.md`, not `shopee-stuff.md`
- One playbook = one outcome. If a workflow has two outputs (e.g., saldo + penghasilan), make two playbooks even if some steps overlap.

## Full frontmatter schema

```yaml
---
name: shopee-saldo-export                  # required, matches filename
description: One-line summary               # required
account: storefront-a                       # which account this is for (matters when one site has multiple accounts)
credentials:                                # which .env vars this playbook needs
  - SHOPEE_PASSWORD_STOREFRONT_A
params:                                     # default parameters (user can override at runtime)
  days_back: 8
  output_dir: ~/Downloads                   # if applicable
requires:                                   # optional — other playbooks that must run first
  - shopee-login
last_verified: 2026-05-21                   # YYYY-MM-DD when this whole flow was confirmed end-to-end
playwright_session: sla-probe               # optional — playwright-cli -s= name
browser_profile: docs/profile/playwright-cli/           # optional — persistent profile dir (project-relative)
api_contracts: []                           # legacy — prefer the verbatim `## Network calls` body section
capture_artifacts:                          # REQUIRED for network flows — durable HAR/JSON, read before re-RE
  - docs/automation/captures/<name>.har
extension_path: extensions/my-feature/      # optional — after sla-extensify
ext_tier: M                                 # S | M | L
ext_build: franken                          # optional — Tier L CSS pipeline
flaky_steps:                                # optional — known fragile steps and their fallbacks
  - step: 9
    note: "Polling occasionally hangs past 5 min when Shopee is under load"
---
```

Only `name` and `description` are strictly required. The rest grow as the playbook matures.

## Body sections

### `## Goal` (required)
One paragraph. What the user gets at the end. Be concrete about the artifact (file path, value, state change).

### `## Steps` (required)
Numbered list. Each step is one action with a clear outcome. Format:

```markdown
N. **<verb>** <object> → <outcome>
   - selector: `<css selector>` (last verified YYYY-MM-DD)
   - alt: `<fallback selector>`
   - wait: `<post-condition>`
   - note: `<anything subtle>`
```

The `<verb>` is one of:
- **Navigate** — `page.goto()`
- **Click** — by text, selector, or role
- **Type** — fill a field (use `${ENV_VAR}` for secrets, never plaintext)
- **Wait** — for a selector / network idle / timeout
- **Poll** — repeatedly check a condition until true (or timeout)
- **Extract** — read text/attribute/state from the page (record into a variable for later steps)
- **Verify** — assert a condition; fail the playbook if false
- **Download** — trigger and wait for a file download
- **Switch account** — when the site has account picker

### `## Selectors` (recommended)
Centralized list of every selector the playbook uses, with `last verified` date. Makes it easy to spot-fix when one selector changes — you don't have to grep the whole steps section.

```markdown
- Login password field: `input[type="password"]` (2026-05-21)
- Export button: text "Export" (2026-05-21)
- Latest export row: `table tbody tr:first-child` (2026-05-21)
```

### `## Run log` (required, auto-maintained)
Append one line per execution. Prune entries > 90 days old.

```markdown
- 2026-05-21 — initial capture, OK
- 2026-05-28 — OK
- 2026-06-04 — selector for "Export" changed (button text now "Ekspor"), updated
- 2026-06-11 — OK
```

### `## Known issues` (optional)
Things that don't break the playbook but the user should know.

### `## Parameters` (optional, only if non-obvious)
Document what each `params:` key means and valid ranges.

### Network-flow sections (REQUIRED when the flow touches any API)

If the playbook involves network calls, these are not optional — they are the spine of the playbook, and
must follow `references/network-flow-spec.md` exactly. Selectors/steps become secondary.

- **`## Flow`** — a `mermaid` diagram of the user + data flow (every call + every data handoff is a node/edge).
- **`## Network calls (VERBATIM)`** — one literal copy-as-`fetch(url,{headers,body,method,credentials})` block
  per call, pasted exactly as the browser sent it (signing params kept), each annotated with which parts are
  dynamic and the verbatim response shape. NEVER paraphrase an endpoint.
- **`## Orchestration chain`** — a table mapping `responseN.field → requestN+1.param` (e.g. `crm/creator/list`
  `oec_id` → `conversation/create` `participants[].uid`). The chain is the orchestrator; prose is rejected.
- **`## Reusable components`** — ASCII mock + exact data binding, when the flow drives a UI piece.
- **`## Capture artifacts`** — paths to the saved `.har` / capture JSON in `docs/automation/captures/` (+ date).

A network playbook with a prose endpoint summary instead of verbatim calls is a FAILED capture — see the
anti-patterns in `network-flow-spec.md`.

### `## API contracts` (legacy alias)
The older optional field. For new captures use the Network-flow sections above instead. Wire vs post-decrypt,
`payload_paths`, `dynamic_params` belong inside `## Network calls (VERBATIM)`. See
`assets/example-playbooks/lms-quiz-network-probe.md`.

---

## Playwright-cli execution

Playbooks are executed with **playwright-cli**, not Playwright MCP. Acquire `<playwright_session>` + `<browser_profile>` per `primitives.md` §0.5 (default-first, copy-on-collision, login-probe) before the `open`:

```bash
playwright-cli -s=<playwright_session> open "<url>" --headed --profile=<browser_profile>/
playwright-cli -s=<playwright_session> goto "<url>"
playwright-cli -s=<playwright_session> snapshot
playwright-cli -s=<playwright_session> run-code --filename=path/to/script.js
```

Record `playwright_session` and `browser_profile` in frontmatter when login cookies matter.

---

## Date parameter convention

When a playbook needs "last N days":

- `days_back: 8` means: today minus 8 days through today, inclusive of both endpoints (9 calendar days span)
- Always resolve at runtime via `date`. Don't bake `2026-05-13` into the playbook.
- The site's expected date format goes in the step note: `format: DD/MM/YYYY` or `format: YYYY-MM-DD`.

Example resolution in shell (the skill runs this and passes results to Playwright):
```bash
TO=$(date +%Y-%m-%d)
FROM=$(date -v -8d +%Y-%m-%d)   # macOS; on Linux: date -d "8 days ago" +%Y-%m-%d
```

---

## Credential reference convention

In the playbook body, reference variables as `${VAR_NAME}`. The skill resolves these at execution time:

```markdown
3. **Type** password → field `input[type="password"]`, value `${SHOPEE_PASSWORD_JIERA}`
```

The skill loads `docs/automation/.env`:
```bash
set -a
source docs/automation/.env
set +a
```

Then for the `type` step, it reads `$SHOPEE_PASSWORD_JIERA` and feeds it via `playwright-cli fill` (see `primitives.md`). Never echo secrets in tool descriptions.

If the env var is missing, the skill stops and asks the user to add it before running. Don't prompt for it inline and run with the typed value — the user wants the password stored, not retyped each session.

---

## Versioning playbooks

Playbooks aren't versioned formally. Git history is the audit log. When a major flow change happens (site redesign, new pages), prefer rewriting the playbook in place over keeping an old version — stale steps cause more confusion than they save.

If the user wants a "before" reference, copy the old playbook to `<name>.archive-YYYY-MM-DD.md` before rewriting.
