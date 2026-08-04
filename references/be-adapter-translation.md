# Backend Adapter Translation (Patchright UI — fallback path)

Use this file **only when `api-mimic-codify.md` cannot work**: generated XLSX/ZIP exports, unmappable signing, or failed parity after honest API mimic attempt.

**Primary codify path:** `api-mimic-codify.md` — replay internal APIs with harvested auth; register `method: "api"` (or thin `page.evaluate(fetch)` hybrid like Shopee `problematic-orders.ts`).

Three layers (discovery vs production):

1. **Discovery** — `playwright-cli` + `network-discovery.md` + `credential-harvest.md`. Playbook + `## API contracts` are the spec.
2. **Extension (optional)** — `sla-extensify` → MV3 in `extensions/`.
3. **Backend** — `sla-codify` → prefer **HTTP mimic**; this document covers **Patchright UI** fallback for scheduled jobs.

The translation gap (UI path only): playbook a11y notation → Patchright API (`page.getByRole`, `waitForURL`, etc.).

---

## 1. Browser context — the only correct setup

```typescript
import { chromium, type BrowserContext } from "patchright"; // NOT "playwright"
import { mkdir } from "node:fs/promises";

await mkdir(USER_DATA_DIR, { recursive: true });
const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  channel: "chrome",        // real Chrome binary — required for detection bypass
  headless: false,          // visible window — headless is detectable
  viewport: { width: 1440, height: 900 }, // viewport: null collapses sidebars
  acceptDownloads: true,
  locale: "id-ID",
  timezoneId: "Asia/Jakarta",
  // DO NOT set userAgent — overriding re-introduces the bot signal
});
```

**Why each line matters:**
- `patchright` patches the CDP `Runtime.enable` leak that vanilla Playwright has. Tokopedia and similar sites detect that leak and trigger captcha immediately.
- `channel: "chrome"` uses the installed Chrome (not Chromium) — fingerprint closest to a real user session.
- `headless: false` — many sites probe for headless markers.
- `viewport: { width, height }` — `viewport: null` defers to window size which on a headless-ish window collapses responsive nav.
- `acceptDownloads: true` — required for `page.waitForEvent("download")` to fire.
- **No custom `userAgent`** — Patchright + Chrome already has the right UA. Overriding undoes the patch.

---

## 2. Persistent profiles per adapter

Each adapter operation that needs a logged-in session gets its own `USER_DATA_DIR`. Concurrent adapters sharing a profile file-lock each other.

```typescript
// adapter A
export const USER_DATA_DIR = join(PROJECT_ROOT, "docs", "profile", "tokopedia-keuangan");
// adapter B (different operation, same marketplace)
export const USER_DATA_DIR = join(PROJECT_ROOT, "docs", "profile", "tokopedia-video");
```

A single `BrowserContext` per adapter is held as a process-lifetime singleton, created lazily via `chromium.launchPersistentContext()`. Each inbound request opens a new `Page` from the context, runs its flow, and closes the page in `finally` — but never closes the context.

---

## 3. Cookie injection (httpOnly-safe)

`document.cookie` cannot set httpOnly cookies. Shopee's `SPC_SC_SESSION`, `SPC_SC_OFFLINE_TOKEN`, etc. are all httpOnly. The capture session may have worked because the user logged in manually in a persistent profile; the backend must inject them another way:

```typescript
import { readFile, readdir } from "node:fs/promises";

async function injectCookies(ctx: BrowserContext, cookieDir: string, filePrefix: string) {
  const files = (await readdir(cookieDir))
    .filter(f => f.startsWith(filePrefix) && f.endsWith(".json"))
    .sort().reverse(); // YYYY-MM-DD suffix → latest first
  if (!files.length) throw new Error(`No cookie file matching "${filePrefix}*.json"`);

  const parsed = JSON.parse(await readFile(join(cookieDir, files[0]), "utf-8"));
  const cookies = parsed.cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly,
    sameSite: c.sameSite === "no_restriction" ? "None" : c.sameSite === "strict" ? "Strict" : "Lax",
    expires: c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate),
  }));
  await ctx.addCookies(cookies);
}
```

`ctx.addCookies()` is a CDP-level call — it sets httpOnly cookies that `document.cookie` cannot. This is the only reliable method for sites with httpOnly session cookies.

Source format: a JSON file exported from a browser extension like "EditThisCookie" — `{ cookies: [{ name, value, domain, path, httpOnly, secure, sameSite, expirationDate, session, ... }] }`.

---

## 4. Bootstrap script for manual login

When cookies aren't available or have expired, the operator runs a one-time login script that opens the persistent profile and waits for them to log in manually. Once logged in, the profile is reused for all subsequent adapter runs.

```typescript
// scripts/login-<marketplace>.ts
import { chromium } from "patchright";
import { createInterface } from "node:readline";

const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  channel: "chrome", headless: false, viewport: { width: 1440, height: 900 },
  locale: "id-ID", timezoneId: "Asia/Jakarta",
});
const page = await ctx.newPage();
await page.goto(SITE_URL, { waitUntil: "domcontentloaded" });
console.log("Log in, then press Enter here to save and close...");
await new Promise<void>(r => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question("> ", () => { rl.close(); r(); });
});
await ctx.close();
```

Wire as: `"login:<marketplace>": "bun --env-file=docs/automation/.env scripts/login-<marketplace>.ts"`.

---

## 5. Selector translation (playbook / a11y notation → Playwright API)

| Playbook notation | Playwright API |
|---|---|
| `role link, name "Foo"` | `page.getByRole("link", { name: "Foo" })` |
| `role button, name "Submit"` | `page.getByRole("button", { name: "Submit" })` |
| `role textbox, name "Password"` | `page.getByRole("textbox", { name: "Password" })` |
| `text "Foo"` (exact) | `page.getByText("Foo", { exact: true })` |
| `text starting with "Foo:"` | `page.locator('text=/^Foo:/')` |
| `[role="tooltip"]` | `page.locator('[role="tooltip"]')` |
| `generic [cursor=pointer]` with text `^DD$` | `page.locator('[class*="cursor-pointer"]').filter({ hasText: new RegExp(\`^\${d}\$\`) })` |
| `.css-class` | `page.locator('.css-class')` |
| Element inside another | `page.locator('[role="tooltip"]').getByText("Foo")` (scoped) |

The `[cursor=pointer]` playbook notation typically maps to either a Tailwind `cursor-pointer` class OR an inline `style="cursor: pointer"`. Try the class first; fall back to a structural selector if the class isn't present.

---

## 6. SPA navigation pattern

Sidebar clicks on React Router dashboards (Shopee, many modern admin panels) do `history.pushState`, which does NOT fire a fresh `load` event. `waitForLoadState("load")` resolves immediately with the pre-click URL — `page.url()` then returns the wrong URL.

Pattern: direct URL nav with sidebar-click fallback.

```typescript
const TARGET_URL = `${BASE_URL}/portal/finance/income?type=2&dateRange=THIS_WEEK`;
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
if (!page.url().includes("/portal/finance/income")) {
  // direct URL got redirected — try sidebar click
  await page.getByRole("link", { name: "Penghasilan Saya" }).click();
  await page.waitForURL("**/portal/finance/income**", { timeout: 15_000 });
}
await page.waitForTimeout(2_000); // SPA render settle
```

The `waitForURL` pattern, NOT `waitForLoadState("load")`, is what survives SPA navigation.

---

## 7. SPA deep-route warm-up (Tokopedia example)

Some SPAs return a blank shell on direct navigation to deep routes. Warm the homepage first:

```typescript
await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
if (page.url().includes("login")) throw new AuthError("Cookies expired");
await page.waitForLoadState("load", { timeout: 30_000 });
await page.waitForTimeout(2_500);

await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForLoadState("load", { timeout: 30_000 });
await page.waitForTimeout(3_500); // hydration
```

**Never use `waitForLoadState("networkidle")`** on sites that poll background endpoints forever (Tokopedia). It will hit the 30s timeout every time. `"load"` + a fixed `waitForTimeout` is the working pattern.

---

## 8. Polling an export job

Two patterns depending on whether the page auto-refreshes its status:

**Auto-refreshing panel (Tokopedia example):**

```typescript
for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
  const buttons = page.getByRole("button", { name: "Unduh" });
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const cls = (await btn.getAttribute("class")) ?? "";
    if (cls.includes("p-btn-disabled")) continue;
    // ready
    const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
    await btn.click();
    return await downloadEvent;
  }
  await page.waitForTimeout(POLL_INTERVAL_MS);
}
```

**Stale-cached panel (Shopee example):** the inline panel caches the at-click status indefinitely. Navigate to the canonical reports URL each tick:

```typescript
const REPORTS_URL = `${BASE_URL}/portal/settings/shop/reports/income`;
for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
  if (attempt > 1) {
    await page.goto(REPORTS_URL, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(2_000);
  }
  const downloadBtn = page.getByRole("button", { name: "Download" }).first();
  if (await downloadBtn.isVisible().catch(() => false) && !(await downloadBtn.isDisabled().catch(() => true))) {
    const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
    await downloadBtn.click();
    return await downloadEvent;
  }
  await page.waitForTimeout(POLL_INTERVAL_MS);
}
```

`POLL_INTERVAL_MS` is typically 60_000 for slow exports (Shopee) and 20_000 for fast ones (Tokopedia). `POLL_MAX_ATTEMPTS` is 10 for a 10-min budget.

**Dual-signal + terminal-failure + self-throttle (async job APIs, not UI panels):** when the export is driven by an API job rather than a UI panel — `method: "api"` calling a submit→status→download-url chain — the two patterns above don't apply directly. Three additions matter here: (1) some jobs need BOTH a status-list flag and a separate file-readiness check before the file is fetchable; (2) a known terminal-failure status code should stop polling immediately instead of running out the timeout; (3) if status is unchanged for an unusually long time, that's likely anti-abuse throttling, not "almost done" — stop instead of hammering. Reference implementation: `scripts/poll-async-export.js`. Same pattern documented from the codify side in `api-mimic-codify.md`'s "Async export chain template".

---

## 9. Download capture

```typescript
const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
await button.click();
const download = await downloadEvent;
const filename = download.suggestedFilename();
const filePath = join(DOWNLOAD_DIR, filename);
await download.saveAs(filePath);
const { size } = await stat(filePath);
```

Always `await mkdir(DOWNLOAD_DIR, { recursive: true })` before the polling loop. `suggestedFilename()` returns the original filename from the server — preserve it; don't sanitize unless filesystem-unsafe characters force the issue.

---

## 10. Date range math

```typescript
function isoDate(d: Date): string {
  // Local-time — toISOString().slice(0,10) returns UTC which is wrong at UTC+7 midnight
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseRange(q: { days_back?: number; from?: string; to?: string }) {
  if (q.from || q.to) {
    if (!q.from || !q.to) throw new ParseError("Both from and to required.");
    const start = new Date(`${q.from}T00:00:00`);
    const end = new Date(`${q.to}T00:00:00`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new ParseError("Use YYYY-MM-DD.");
    if (end < start) throw new ParseError("to must be on or after from.");
    return { start, end };
  }
  const daysBack = q.days_back ?? 8;
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - daysBack);
  return { start, end };
}
```

`days_back: 8` → 9 inclusive days (today − 8 to today). Match the playbook's run-log dates to confirm interpretation.

---

## 11. AuthError with recovery instructions

When the session is dead, the error message tells the operator exactly what to run:

```typescript
if (page.url().includes("login")) {
  throw new AuthError(
    "Shopee redirected to login — persistent profile session expired. " +
    "Run `bun run login:shopee` to re-authenticate, then retry."
  );
}
```

Don't throw bare `Error("session dead")` — give the next person a path forward.

---

## 12. The adapter scaffold

```typescript
import { type Page } from "patchright";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Adapter, AuthError, NetworkError, ParseError } from "../../../types";
import { registerAdapter } from "../../../dispatcher";
import { getContext, shutdownContext } from "./shared-context";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");
const DOWNLOAD_DIR = join(PROJECT_ROOT, "downloads", "<marketplace>-<operation>");

export interface MyQuery { days_back?: number; from?: string; to?: string; }
export interface MyData {
  filename: string; filePath: string; sizeBytes: number; mimeType: string;
  dateRange: { from: string; to: string };
}

async function run(query: MyQuery): Promise<MyData> {
  const { start, end } = parseRange(query);
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    // step 1: warm + auth check
    // step 2: navigate to target page
    // step 3: select date range
    // step 4: trigger export
    // step 5: poll + download
    const { filename, filePath, sizeBytes } = await pollAndDownload(page);
    return {
      filename, filePath, sizeBytes,
      mimeType: mimeTypeFromFilename(filename),
      dateRange: { from: isoDate(start), to: isoDate(end) },
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const adapter: Adapter<MyQuery, MyData> = {
  marketplace: "<marketplace>",
  method: "playwright",
  operation: "<operation-kebab>",
  run,
  shutdown: shutdownContext,
};
registerAdapter(adapter);
export default adapter;
```

---

## 13. Env loading

`docs/automation/.env` is the source of truth for credentials. Load it explicitly via Bun's `--env-file` flag:

```json
// package.json
{
  "scripts": {
    "dev": "bun --env-file=docs/automation/.env --watch src/index.ts",
    "start": "bun --env-file=docs/automation/.env src/index.ts",
    "login:shopee": "bun --env-file=docs/automation/.env scripts/login-shopee.ts"
  }
}
```

Adapters read credentials lazily inside `run()` so a missing env var throws `AuthError` at request time (not at process start time):

```typescript
function getShopeePassword(): string {
  const pw = process.env.SHOPEE_PASSWORD_JIERA;
  if (!pw) throw new AuthError("SHOPEE_PASSWORD_JIERA not set. Start with: bun --env-file=docs/automation/.env src/index.ts");
  return pw;
}
```

---

## 14. ResponseEnvelope shape

```typescript
interface ResponseEnvelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
  meta: {
    source: string;        // e.g. "shopee-saldo-saya"
    method: "playwright" | "http" | "graphql" | "api";
    marketplace: string;
    duration_ms: number;
  };
}
```

Invariants: `success === true` iff `data !== null && error === null`. `success === false` iff `data === null && error !== null`. `meta` is always populated. The dispatcher wraps adapter results and adapter `ScrapeError` throws into this envelope — adapters don't construct the envelope themselves.

---

## 15. Automated OTP retrieval for production login (skip the human escape hatch)

`primitives.md` §7's captcha/2FA escape hatch (`AskUserQuestion`, pause for a human) is correct for discovery, but a scheduled production adapter can't pause for a human. When the 2FA is an email OTP (not SMS/authenticator), a service-account read of a shared mailbox can close the loop unattended:

1. Domain-wide delegation grants the backend service account read access to one shared mailbox (not per-user — a mailbox the automation account's OTPs land in).
2. After triggering login, search Gmail with `after:<login_timestamp>` plus a distinguishing token from the login flow (e.g. the salutation/account name in the email body) — not just "most recent email in the inbox," which races against other mail arriving concurrently.
3. Extract the OTP from the matched message body, submit it, continue.

This is a production alternative to §7's pause-and-ask, not a discovery-time technique — wire it only in the backend adapter, never in a `playwright-cli` capture session (capture sessions still use the human escape hatch; a human is present by definition during capture).

## 16. Server-only import stubbing — running app internals from a standalone script

A `docs/automation/` verification/reconciliation script (e.g. "recompute this brand's P&L using the real app logic and diff against a snapshot") often needs to import the app's own `lib/` code — DB clients, business logic — rather than reimplementing it. Frameworks that guard server-only modules at build time (Next.js's `server-only` package) throw when that guard package is imported outside the framework's own bundler. A small preload plugin no-ops the guard so the script can import real app internals directly:

```typescript
// scripts/_preload-server-only.ts — a Bun/esbuild plugin
import { plugin } from "bun";
plugin({
  name: "stub-server-only",
  setup(build) {
    build.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "" }));
  },
});
```

Load it before the script's real imports (`bun --preload ./scripts/_preload-server-only.ts scripts/recheck-tiktok.ts`). This lets a one-off `docs/automation/` reconciliation script call the exact same functions production uses, instead of a second, divergent reimplementation (see the coding standard's "Same Business Rule In Two Files Will Diverge").

**`server-only` is the Next.js-specific example — check what the target framework actually guards before reusing this verbatim.** Confirm the failure first (`grep -r "server-only\|import 'server-only'"` in the target repo, or just try the import and read the actual thrown error) rather than assuming Next.js's guard package applies. Nuxt/SvelteKit have different build-time guards (or none); the stub-and-preload technique generalizes, the specific package name being stubbed does not.

---

## Common translation pitfalls

1. **Translating `getByText` too literally.** `page.getByText("Minggu Ini:")` matches anything *containing* "Minggu Ini:". For startsWith, use `page.locator('text=/^Minggu Ini:/')`. For exact, pass `{ exact: true }`.
2. **Forgetting `.filter({ visible: true })`** on selectors that match multiple elements where only the visible one is the target.
3. **Trusting `isDisabled()` for custom disabled state.** Some frameworks use `class*="disabled"` instead of the `disabled` attribute. Check both: `(await btn.isDisabled().catch(() => true)) || ((await btn.getAttribute("class")) ?? "").includes("disabled")`.
4. **Not adding `.catch(() => false)` to `isVisible()` calls** — `isVisible()` can throw if the element detached mid-check. Always wrap in `.catch()` for polling loops.
5. **Skipping `await page.waitForTimeout()` after navigation** — many SPAs need 1-3s after `load` to hydrate event handlers. Without this, clicks no-op silently.
