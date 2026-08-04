# Playwright-CLI Primitives

Reusable patterns for SLA playbooks. Engine: **`playwright-cli`** (invoke `playwright-cli` skill first). **Not** Playwright MCP `browser_*` unless the user explicitly overrides.

Session/profile acquisition is **§0.5** — run it before opening any browser. Short form:

```bash
playwright-cli -s=<task> open "<url>" --headed --persistent --profile=<acquired-profile>/
```

> **`--persistent` is MANDATORY alongside `--profile`.** Without it, playwright-cli ignores the profile and launches **headless with an in-memory user-data-dir** — the window is invisible AND login never persists across navigations (you'll keep bouncing to the login page). Verify after every open: `playwright-cli list` must show `headed: true` and `user-data-dir: <your-profile>/`, NOT `<in-memory>`. If it shows in-memory/headless, you omitted `--persistent` — `close` and reopen. Also: when a `-s=<task>` session is already open, a second `open` only NAVIGATES it; the `--headed/--persistent/--profile` flags are ignored. To change launch flags you must `close` first.

---

## 0. MCP → playwright-cli mapping (legacy playbooks)

| Old (MCP) | playwright-cli |
|-----------|----------------|
| `browser_navigate` | `playwright-cli goto <url>` (after `open`) |
| `browser_snapshot` | `playwright-cli snapshot` → refs `e5`, etc. |
| `browser_click` | `playwright-cli click e5` |
| `browser_type` / fill | `playwright-cli fill e5 "text" --submit` or `type` |
| `browser_evaluate` | `playwright-cli eval "..."` or `eval "..." e5` |
| `browser_evaluate` (async/page) | `playwright-cli run-code --filename=script.js` |
| `browser_take_screenshot` | `playwright-cli screenshot` |
| `browser_wait_for` | re-`snapshot` / `goto` with networkidle / poll in `run-code` |
| List network | `playwright-cli requests` |

Network / API discovery: `references/network-discovery.md`.

---

## 0.5 Session & profile acquisition — default-first, copy-on-collision, login-probe

The one invariant: **every session reaches the site logged-in, in its OWN profile dir.** Parallel sessions never share a `user-data-dir` — Chromium's `Singleton*` lock makes a shared dir fatal. Run this at the start of every session.

**Step 1 — probe the default profile.** Is `docs/profile/playwright-cli/` already taken by another live session?

```bash
playwright-cli list                                  # any session already bound to docs/profile/playwright-cli/?
[ -e docs/profile/playwright-cli/SingletonLock ] && echo "IN USE" || echo "FREE"
```

**Step 2 — pick the profile.**

- **FREE → use the default as-is** (`--profile=docs/profile/playwright-cli/`). One session = default, no copy. Touching the default is fine when it's free.
- **IN USE → tell the user it's taken, then `cp` the default into a per-session copy** so cookies/login carry over. The copy is the **default** collision behavior — don't ask, just do it (the user gave no other instruction):

```bash
cp -R docs/profile/playwright-cli "docs/profile/<task>"   # <task> = playbook/feature slug, e.g. kolab
rm -f "docs/profile/<task>"/Singleton*                     # MANDATORY — drop the inherited lock or the copy won't open
playwright-cli -s=<task> open "<url>" --headed --persistent --profile="docs/profile/<task>"/
```

  WAL caveat: if the source browser is mid-write, recent cookies may sit in `Cookies-wal` not yet checkpointed — copy while the source is idle when possible; the login-probe (Step 3) catches a stale copy anyway.

**Opt-ins — only when the user explicitly asks; each REPLACES the copy default:**

- **fresh / empty profile** → skip the copy, open on an empty `docs/profile/<task>/` (no login → must inject auth, below).
- **load extensions / special launch flags** → still copy the authed profile (login must carry over), but open via a `--config` JSON whose `launchOptions.args` carry `--load-extension=<build_prod>` instead of the plain `--profile` open. Full MV3 load + drive + verify procedure: `sla-extensify/references/load-extension-verify.md`.
- **different account / cookie export** ("pakai akun lain") → open empty, then inject the supplied cookies: `state-load auth.json`, or `addCookies` from a Cookie-Editor export (§18). httpOnly cookies come through both paths.

**Step 3 — login-probe gate (ALWAYS, whatever profile was acquired).** Before any real work, confirm the session is actually logged in:

```javascript
// playwright-cli eval after the first goto
const onLogin = location.pathname.includes('/login') ||
                document.querySelector('input[type="password"]') !== null;
return { loggedIn: !onLogin, url: location.href };
```

A `cp` of an authed default is almost always green — the gate still runs so "this profile can reach the site" is a verified fact, not an assumption. If red: re-acquire (log in manually in the headed copy, or inject a fresh cookie export). The session does not proceed until the gate is green.

**Parallel sessions:** repeat Steps 1–3 per session. Each gets a unique `-s=<task>` AND a unique `--profile="docs/profile/<task>"/`. Two sessions never point at the same dir.

---

## 1. Loading credentials from `docs/automation/.env`

In bash before the Playwright session, or inline before each step that needs a secret:

```bash
set -a
source docs/automation/.env
set +a
```

Then when filling the password field via CLI:

1. Bash: `set -a; source docs/automation/.env; set +a` (don't echo secrets)
2. `playwright-cli snapshot` → find password field ref
3. Prefer `playwright-cli fill eN "$SHOPEE_PASSWORD_JIERA"` (real keystrokes; works with Vue v-model)

Fallback — `playwright-cli eval` to set the field via the DOM, e.g.:

```javascript
// In playwright-cli eval / run-code:
const input = document.querySelector('input[type="password"]');
input.focus();
// But — Vue/React v-model won't pick up a direct .value assignment.
// Use the native input value setter to trigger reactivity:
const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
nativeSetter.call(input, 'THE_PASSWORD_VALUE');
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

Note: the password value still ends up in the tool-call args. That's fine for this user's setup (per their preference) — but if the playbook is ever shared, the env var should never get echoed back into logs or comments.

Reserve the eval setter dance for custom inputs `fill` cannot reach.

---

## 2. Date math (today − N days)

In bash:

```bash
# macOS (BSD date)
TO=$(date +%Y-%m-%d)
FROM=$(date -v -8d +%Y-%m-%d)        # 8 days ago
FROM_DDMMYYYY=$(date -v -8d +%d/%m/%Y)  # for sites that want DD/MM/YYYY

# Linux (GNU date)
FROM=$(date -d "8 days ago" +%Y-%m-%d)
```

Many Indonesian seller dashboards (Shopee, TikTokShop) use `DD/MM/YYYY` or `DD-MM-YYYY` in their date pickers. Read the input placeholder before typing — don't assume the format.

If the picker is a calendar widget (not a text input), the playbook needs to navigate the calendar via month-prev/month-next clicks then click the day cell by its text content. Capture this once, then the playbook tells future runs which calendar component is in use.

---

## 3. Polling — wait until X is true

The pattern: try the condition every N seconds, give up after T seconds. Don't busy-loop, don't sleep forever.

In `playwright-cli run-code` / `eval`:

```javascript
async function pollUntil(checkFn, { intervalMs = 20000, timeoutMs = 600000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await checkFn();
      if (result) return result;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Polling timed out after ${timeoutMs}ms`);
}

// Example: wait for an export row's Unduh button to become active
const result = await pollUntil(() => {
  const firstRow = document.querySelector('table tbody tr:first-child');
  if (!firstRow) return false;
  const unduhBtn = firstRow.querySelector('a[download], button:not([disabled])');
  // Heuristic: if the row text contains "Memproses" (Indonesian for "Processing"), still waiting
  if (firstRow.textContent.includes('Memproses')) return false;
  return unduhBtn ? { ready: true, href: unduhBtn.href } : false;
}, { intervalMs: 20000, timeoutMs: 600000 });
```

When polling, **re-snapshot** if you depend on CLI refs — refs go stale. Pure DOM queries inside `run-code` avoid refs.

---

## 4. File download verification

Two reliable approaches:

**(a) Before/after mtime check on ~/Downloads:**

```bash
# Before the click
BEFORE=$(ls -1t ~/Downloads | head -1)

# ... click Unduh, wait a bit ...

# After
AFTER=$(ls -1t ~/Downloads | head -1)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "FAIL: no new file appeared"
else
  echo "OK: new file = $AFTER"
fi
```

**(b) Download via click** — `playwright-cli click` on `<a download>`; verify file in `~/Downloads` (CLI may not always return path — use mtime check (a)).

For sites that download via blob URL (created client-side from data), the download dialog might not be a real `<a download>`. In that case, fall back to (a).

---

## 5. Account / login detection

Pattern: navigate to the dashboard URL. If the URL redirects to `/login` or a login form is visible, run the login sub-flow. Otherwise assume the session is still valid.

```javascript
// Inside playwright-cli eval after navigate
const isLoginPage = location.pathname.includes('/login') ||
                    document.querySelector('input[type="password"]') !== null;
return { isLoginPage, currentUrl: location.href };
```

Branch the playbook based on the result. Login flows should be their own sub-playbook (or a clearly-labeled section within the main playbook) so they can be skipped when not needed.

---

## 6. Multi-account switching

When the user has multiple accounts on the same site (e.g., two seller accounts on one marketplace), each account = each playbook, OR one playbook with an `account` param that controls which `.env` var the password comes from. The latter is cleaner for sites that just have a single login flow:

```yaml
params:
  account: storefront-a          # → uses SHOPEE_PASSWORD_STOREFRONT_A
```

The skill resolves `account: storefront-a` → looks for `SHOPEE_PASSWORD_STOREFRONT_A` in `.env`. Map this in the playbook's credentials section.

---

## 7. Captcha / 2FA escape hatch

When a step hits a captcha, OTP prompt, or other human-required check:

1. Pause execution.
2. Take a screenshot: `playwright-cli screenshot`.
3. Use `AskUserQuestion` with a single confirmation: "Please solve the captcha / enter 2FA in the browser, then click 'Done' here when you've completed it." (Phrase in the user's language.)
4. After the user confirms, snapshot the page to verify the captcha is past, then continue.

Mark the step as `requires_human: true` in the playbook so the user knows this run will pause.

---

## 8. The "first click after navigate" gotcha

Vue/React SPAs often need ~500ms after navigation before handlers attach. If a click right after `goto` fails, `snapshot` again and wait for a stable element (header/nav) before `click`.

Don't sleep blindly. Wait for a real signal that the page hydrated.

---

## 9. Vue v-model + DOM `.value` assignment doesn't work

Setting `input.value = 'foo'` bypasses Vue 2 reactivity. Use `playwright-cli fill` for real keystrokes, OR the native setter trick (section 1).

This isn't theoretical — it has bitten a real Nuxt/Vue 2 LMS capture. If a form submission shows "field is empty" after you typed via direct DOM assignment, this is why.

---

## 10. httpOnly cookies — `document.cookie` silently fails

Sites like Shopee set their session cookies (`SPC_SC_SESSION`, `SPC_SC_OFFLINE_TOKEN`) with the httpOnly flag. JavaScript cannot read or write httpOnly cookies — `document.cookie = "SPC_SC_SESSION=..."` looks like it worked but does nothing.

In a **playwright-cli** session with persistent profile: ask the user to log in once in the headed browser; cookies land in the session's acquired profile (`docs/profile/playwright-cli/` or its §0.5 per-session copy). Do not rely on `document.cookie` for httpOnly.

For backend code: `be-adapter-translation.md` §3 — `context.addCookies()`.

---

## 11. `networkidle` timeout on heavy-polling sites

`goto` with `networkidle` can hang on forever-polling sites (Tokopedia). Prefer `goto` + snapshot for a **specific element** instead of network idle.

If a step's "wait for the page to be ready" condition is `networkidle`, change it to "wait for `<specific element>` to be visible." Element-anchored waits survive sites that never idle.

---

## 12. SPA navigation — sidebar clicks don't fire `load`

React Router and similar SPAs change the URL via `history.pushState` on sidebar/nav clicks. No `load` event fires (the document was loaded once at the start of the session and never reloads).

Symptom: you click "Penghasilan Saya" in the sidebar, a wait-for-`load` step resolves immediately (it already fired earlier), and the next step's selector times out because the page is still showing the old route's content.

After sidebar click: `playwright-cli snapshot`. If URL/content unchanged, wrong ref or in-flight — wait and snapshot again, or `goto` canonical URL directly.

For backend code: see `be-adapter-translation.md` §6 — use direct URL navigation or `page.waitForURL("**/pattern**")` instead.

---

## 13. Page state caching — inline panels can lock at click-time

Some dashboards open an inline panel (dropdown, sidebar drawer) showing live status. The panel can capture state at the moment it opens and never refresh — Shopee's "Laporan Terakhir" dropdown is a classic case: it opens after clicking Export, shows `"Sedang Diproses"`, and stays at that status indefinitely even after the export actually completes.

Fix: `goto` canonical reports URL each poll tick — not the inline panel.

This pattern shows up on enough dashboards that the rule is: never trust an inline panel for polling; always have a canonical "list of jobs" URL and re-navigate to it.

---

## 14. Page warming for SPA shells

Some SPAs (Tokopedia is the textbook case) return a blank page when you navigate directly to a deep route from a fresh context. The SPA shell needs an initial render at the homepage before it can route to inner pages.

Pattern: `goto` `/` first, snapshot until shell visible, then `goto` deep route.

For backend code: `await page.goto(HOME_URL)` then `page.waitForTimeout(2500)` then the real navigation. See `be-adapter-translation.md` §7.

---

## 15. Calendar widget variants

Different calendars need different click strategies:

- **Arco Design** (Tokopedia): day cells are `.p-picker-cell` containing `.p-picker-date-value`. Out-of-range cells get a `disabled` class on the cell. After selecting the range, click an explicit "OK" button to commit — without it, the staged selection doesn't apply.
- **Shopee custom**: day cells use Tailwind `cursor-pointer` classes. The calendar typically auto-applies on the second-day click — no OK button. EXCEPT for Saldo Saya's date filter, which has a staged "Terapkan" pattern.
- **Element UI / Ant Design** (common on Chinese-built dashboards): day cells are `<td>` with `class*="day"`. Both ranges and single-day pickers exist; check the placeholder text on the input to know which one you're driving.

When in doubt: snapshot the open calendar, find the day cell that's visually highlighted (today, or the default range), and use its structural pattern as the selector template for the day you want.

---

## 16. Patchright vs Playwright (backend only — sla-codify)

Not used in playwright-cli sessions. When a playbook becomes backend code via `sla-codify`:

```typescript
import { chromium, type BrowserContext } from "patchright"; // NOT "playwright"
```

Patchright patches the CDP `Runtime.enable` leak that vanilla Playwright has. Tokopedia, Shopee, and similar sites fingerprint that leak and trigger captcha on the first navigation. With Patchright the captcha doesn't appear.

Combine with `channel: "chrome"` (real binary), no custom `userAgent`, `headless: false`, real viewport. Any deviation (especially setting a custom UA) re-introduces the bot signal.

---

## 17. `run-code` sandbox constraints

The `--filename` script is evaluated as a **single arrow-function expression** `async (page) => { ... }` — not a module.

- **No `require`, no `fs`, no `module.exports`.** `const x = require('fs')` throws `require is not defined`; a top-level `const`/`module.exports` throws `Unexpected token 'const'`.
- **Inline the data** the script needs (cookie arrays, payloads) directly into the file. Generate the file with a separate Python/Node step that embeds the JSON, then run it.
- Browser-side `page.evaluate(...)` inside the script runs in the page (real `crypto`, `TextEncoder`, `btoa`, `BigInt`, `Date.now()` all available).
- To return data, `return` from the arrow (it prints under `### Result`); for large/binary, base64 it and parse the `### Result` block in a follow-up step.

## 18. Session injection from a cookie export

When the user supplies a cookie export (Cookie-Editor / EditThisCookie JSON) instead of an interactive login:

- Map to Playwright `addCookies` shape: `expirationDate`→`expires` (int), and **normalize `sameSite`**: `no_restriction`→`None`, `strict`→`Strict`, `unspecified`/`lax`→`Lax` (raw values throw).
- Inject via `page.context().addCookies(mapped)` inside a `run-code` script (cookies inlined — see §17), then navigate.
- **Cookie scope = the exported domain only.** An export of `site.com` cookies authenticates `site.com` but NOT a sibling API host (`api.other-cdn.com`). Calls to the other host fail "not login" unless they carry their own in-body/header token. This is a *capture-session* limitation, not a production bug — the real browser has all domains' cookies. Flag such steps as "verify in real browser" rather than chasing them in the injected session.

## 19. New-tab traps — capture the URL, navigate in-tab

SPA "popout", "open full view", "discover/find" buttons frequently open a **new browser tab** that playwright-cli does not drive (no `tabs` switch command). Symptom: click succeeds, controlled page's URL is unchanged, no inputs appear.

Fix: capture the intended URL, then `goto` it in the controlled tab so the session's hooks/init scripts apply.
- Override `window.open` to record the arg: `const o=window.open; window.open=(u)=>{window.__nav=u; return null;}`.
- Or a capturing click listener for `target=_blank` anchors: `document.addEventListener('click',e=>{const a=e.target.closest?.('a[href]'); if(a) window.__nav=a.href;},true)`.
- Read `window.__nav`, then `playwright-cli goto "<that url>"`. A deep route like `/seller/im?creator_id=<id>` often drives the SDK to do the work (open/create the resource) in-tab.

## 20. Composer send triggers — Enter vs the Send button

Chat/comment composers vary: the compact widget may send on a `Send` button click, while the full-page composer ignores the button click (React handler bound to keydown) and only sends on **Enter**. If a button click leaves the text in the field, focus the textarea and `playwright-cli press Enter`. Confirm the send fired (text cleared + the write request/frame appears in the capture), not just that the click "worked".

## 21. Contenteditable composer fill-and-verify

A `contenteditable` div (rich-text composer, chat box, WYSIWYG prompt field) isn't an `<input>`/`<textarea>` — `fill()` still works but a stray click beforehand can land in the wrong element or pop a menu, and nothing tells you the text actually landed.

```javascript
const box = page.locator('[contenteditable="true"]').first(); // or .last() if there are several
await box.click();
await box.fill(''); // clear first — contenteditable can retain stale content across fills
await box.fill(PROMPT);
const landed = await box.evaluate((el) => el.innerText.length > 0);
if (!landed) throw new Error('Text did not land in the contenteditable field — wrong element or a menu intercepted the click.');
```

Distinct from §9 (Vue v-model native setter) — that targets real form inputs under framework reactivity; this targets rich-text divs with no `.value` at all.

## 22. React fiber walk — read/force internal component state

Redux/Context doesn't always expose what a component tracks locally, and a React-controlled `disabled` prop snaps back after a plain `el.disabled = false` (React re-renders it from state on the next tick — the React analog of §9's Vue v-model trap, but for read-only introspection **and** write-forcing instead of only writing).

```javascript
// In playwright-cli eval / DevTools console
function getFiberKey(el) {
  return Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
}
const el = document.querySelector('SEL');
const fiber = el[getFiberKey(el)];
// fiber.memoizedProps / fiber.memoizedState (hooks: a linked list, walk .next)
// fiber.return walks UP toward the owning component
```

Full read + force-a-prop implementation: `scripts/walk-react-fiber.js` (paste into DevTools Console — it defines multiple functions for interactive use, so it doesn't fit run-code's single-expression sandbox, §17). Forcing a prop is a discovery/verification tool, not a stable production technique — prefer finding the real unlock condition (e.g. actually filling the required field) once you know what it is.

## 23. Vue component-tree search by `$data` shape

When Vuex doesn't expose the state you need because a component holds it in local `$data`, and you don't know which of many nested components it lives on, search by the **shape** of `$data` (a set of expected keys) instead of guessing a DOM selector.

```javascript
// document.querySelector('#app').__vue__ is the Vue 2 root instance
findVueComponent(document.querySelector('#app').__vue__, ['comments', 'counterVideoLive']);
```

Full implementation: `scripts/walk-vue-tree.js` (DevTools Console paste, same reasoning as §22). Vue 3 Composition API instances don't expose `$children`/`$data` the same way — check `.setupState`/`.ctx` instead, or grab the instance from the Vue DevTools global hook.

## 24. Shadow-DOM piercing for extension UI verification

An MV3 extension (via `sla-extensify`) commonly renders its UI inside a Shadow DOM host to avoid CSS collisions with the page. Standard selectors don't reach inside — find the host first, then query its `shadowRoot`:

```javascript
// Find the shadow host by scanning for any element with a shadowRoot
const host = [...document.querySelectorAll('*')].find((el) => el.shadowRoot);
const root = host.shadowRoot;
root.querySelector('[data-testid="..."]').click();
root.querySelectorAll('table tbody tr'); // read rendered rows
```

Driven from outside the page (a standalone Node/Playwright script with the unpacked extension loaded via `--load-extension`), not from a `run-code` session inside the extension's own content script. See `sla-extensify/references/load-extension-verify.md` for the full load+drive+verify procedure this plugs into.

## 25. SSO silent session-refresh via exchange endpoint

Before treating an expired session as "needs full re-login" (§7's captcha/2FA escape hatch), check whether the platform has a **silent exchange endpoint** — a captcha-free call (often named `check_login`, `refresh`, or similar) that re-mints a short-lived app session from a still-valid long-lived SSO/refresh cookie. Bounded by a fixed ceiling (the refresh cookie itself eventually expires and forces a real re-login), but until then it avoids the human-in-the-loop escape hatch entirely.

Verify this exists by watching the network tab during a normal session-expiry-and-recovery cycle in the real UI — if the app itself silently recovers without showing a login form, it's using exactly this pattern; capture that exchange call as its own `## API contracts` entry.

## 26. Download-artifact normalization — zip-or-direct

Two download buttons on the same product's UI can yield different wrapper shapes: one gives a raw file directly, the sibling wraps the same content in a `.zip`. Don't assume either — always save first, then branch:

```bash
# after saveAs
kind=$(file --mime-type -b "$DOWNLOADED_PATH")
if [ "$kind" = "application/zip" ]; then
  unzip -o "$DOWNLOADED_PATH" -d "$(dirname "$DOWNLOADED_PATH")"
fi
```

Extends §5 (mtime-based download verification), which confirms *a* file appeared but says nothing about its wrapper shape.

## 27. Cartesian priority-ordered retry matrix

When a resource has multiple ordered variants (tiers, ticket categories, price codes) and any one succeeding is enough, iterate the full cartesian product in priority order — highest-preference tier × all its codes, then the next tier — rather than retrying one fixed combination:

```javascript
const TIERS = ['VIP', 'Platinum', 'Regular'];
const CODES = ['A', 'B', 'C'];
for (const tier of TIERS) {
  for (const code of CODES) {
    const res = await tryPurchase(tier, code);
    if (res.ok) return res;
    if (res.status === 429) await sleep(2000); // rate-limit-aware backoff between attempts
  }
}
throw new Error('All tier/code combinations exhausted');
```

Distinct from §3's simple `pollUntil` (waiting for one condition to become true over time) — this is trying prioritized *alternatives* until one lands, not waiting on one target.

## 28. N-slot session farm + best-of-N picker

For "race N parallel logged-in sessions and act on whichever gets furthest" scenarios (queue-waiting rooms, limited-slot drops), open N fresh/persistent browser contexts staggered (not simultaneous — stagger to avoid a shared rate-limit trip), attach a per-slot response listener, and rank sessions by a numeric progress score rather than picking the first one that responds:

```javascript
function pickBest(sessions) {
  return sessions
    .map((s) => ({ ...s, score: scoreProgress(s.lastStatus) })) // scoreProgress: app-specific ranking
    .sort((a, b) => b.score - a.score)[0];
}
```

Dedup repeated identical polls by hashing the JSON before scoring — a session polling every 2s produces mostly-identical payloads that shouldn't be re-scored as new progress. Tear down all non-winning sessions on `SIGINT`/completion — an orphaned N-tab farm is a resource leak and, on rate-limited sites, an accidental self-DoS.

## 29. Proactive pacing/jitter throttle for bulk action loops

For bulk outreach/blast loops (mass message send, mass follow), don't wait for a 429 to slow down — add a base delay + random jitter between each send from the start:

```javascript
async function runBlast(items, sendFn, { baseDelayMs = 3000, jitterMs = 1500 } = {}) {
  for (const item of items) {
    await sendFn(item);
    await sleep(baseDelayMs + Math.random() * jitterMs);
  }
}
```

Preventative, not reactive — distinct from a 429-triggered backoff (§27's rate-limit check). Expose an explicit stop signal (a flag checked each iteration) so a long blast can be cancelled cleanly instead of killed mid-request.

## 30. Content-verify completion detection — when there's no DOM signal at all

Some async UI operations (AI video/image generation) expose **no usable completion signal**: no progress percentage, no `aria-busy`, and the only visible text is a static label that produces false-positive matches against a naive poll. When §3's `pollUntil` has nothing truthy to check, fall back to verifying the **output artifact's content** instead of the page:

```bash
# Time-box a fixed wait, then verify the deliverable directly
sleep 90
ffmpeg -ss 2 -i "$DOWNLOADED_VIDEO" -frames:v 1 /tmp/check_frame.png
# then visually confirm /tmp/check_frame.png isn't black/placeholder
```

The lesson isn't "always ffmpeg" — it's: when the page gives you nothing trustworthy to poll, stop trusting the page and verify the thing you actually wanted (the file), directly.
