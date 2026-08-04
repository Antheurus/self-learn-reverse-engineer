# Self-Correction Protocol

A playbook step just failed. The skill's job: figure out what changed, fix it, persist the fix, and continue — without asking the user to do the AI's job.

This is the heart of "self-learn". A playbook that breaks the first time UI shifts is barely a playbook. One that quietly updates itself is the real artifact.

---

## When a step fails

A step "fails" when:
- The selector returns no element
- The click happened but the expected post-condition didn't occur (URL didn't change, expected text didn't appear)
- A poll timed out
- A `Verify` step's assertion was false
- A Playwright tool returned an error

Don't proceed past a failure. Stop, diagnose, fix, then retry — or escalate to the user if you genuinely can't.

---

## Diagnostic sequence

1. **Snapshot the page.** `playwright-cli snapshot` — compare to playbook expectation.

2. **Check three common causes first:**
   - **Selector renamed.** The site changed `class="export-btn"` → `class="ExportButton"`. Look for the labeled text instead — labels are more stable than CSS classes.
   - **Element not yet rendered.** SPA hydration race. Re-`snapshot` and poll with `playwright-cli run-code` until the ref appears, or wait on a destination-specific label (5–10s) before clicking.
   - **Hidden behind a modal/popup.** Banners, cookie notices, "Berita Kampus"-style popups intercept clicks. Look for and dismiss before retrying.

3. **Check the playbook's `selector_alternates` if present.** Playbooks should record fallback selectors learned over time. Try them in order.

4. **If no alternates worked, discover.** Use the page snapshot to find the element by its labeled text or role:

```javascript
// In playwright-cli eval / run-code, find the "Export" button by text
const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'))
  .filter(el => el.textContent.trim().toLowerCase().includes('export'));
// Return the first one that's visible and not disabled
const visible = candidates.find(el => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.disabled;
});
return visible ? { selector: visible.outerHTML.slice(0, 200), id: visible.id, class: visible.className } : null;
```

5. **Build a new selector** from the discovered element. Prefer (in order): `data-testid` attribute → `id` → text-content match → a stable parent + role/text combo.

Bad selector: `body > div:nth-child(3) > div.flex > div:nth-child(2) > button`
Good selector: `button:has-text("Export")` or `[data-testid="export-btn"]` or `button[aria-label="Export earnings"]`

6. **Verify the new selector works** by performing the original action with it. If it works, persist the fix.

---

## Persisting the fix

When a new selector replaces an old one:

1. **Edit the playbook file** — the `## Selectors` section gets the new value plus a date comment:
   ```markdown
   - Export button: `[data-testid="export-btn"]` (2026-06-04, was `button.export-btn` until 2026-06-03)
   ```

2. **Add the old selector to `selector_alternates`** in the relevant step — sites sometimes A/B test and the old one might come back.

3. **Append a one-line entry to `## Run log`** noting what changed:
   ```markdown
   - 2026-06-04 — Export button selector changed (`.export-btn` → `[data-testid="export-btn"]`); updated and verified
   ```

4. **Update `last_verified`** to today's date.

Commit the playbook file. The next session that runs this playbook starts from the fixed state.

---

## When NOT to self-correct

Some failures aren't selector drift. Don't paper over these:

| Failure | What it really means | Action |
|---------|---------------------|--------|
| Login form looks completely different | Site rolled out a new auth system (OAuth, magic link, etc.) | Stop. Notify user. Don't guess credentials into a new form. |
| Captcha appeared | Site flagged the session as bot-like | Pause. Show screenshot. Ask user to solve. |
| Site shows "Your account is suspended" | Account problem | Stop. Notify user. Do not retry. |
| 2FA prompt where there wasn't one before | New security check | Pause. Ask user for the OTP. |
| Page is 404 / "feature deprecated" | The flow no longer exists | Notify user. Suggest re-capturing the playbook from scratch. |
| Step that used to take 30s now takes 5+ min and times out | Backend slowdown OR flow changed silently | Look at the page during the wait. If it's clearly still working, increase the timeout. If it shows an error, surface it. |

The principle: **self-correct mechanical drift, escalate semantic change.**

---

## Cascading fixes

If a step fix changes the playbook's flow shape (e.g., the site added an interstitial "Are you sure?" modal that now appears between steps 8 and 9), insert the new step and renumber. Don't try to merge it into an adjacent step — keep one action per step.

If renaming a step would break the run log's references (some logs say "step 9 failed"), that's fine — the log is human-readable, not machine-parsed.

---

## Logging the discovery, not just the fix

When you discover a new selector, also write down **how** you found it in the playbook — that intelligence is more durable than the selector itself:

```markdown
## Selectors
- Export button: `[data-testid="export-btn"]` (2026-06-04)
  - Discovered by: searching `button, a, [role="button"]` for text matching "export" (case-insensitive), then picking the visible non-disabled one. Same heuristic should work if testid changes again.
```

This way the next time the selector breaks, the fix protocol is in the playbook itself, not just in this skill file.

---

## The retry budget

Per session, per playbook: don't burn more than ~3 self-correction attempts before stopping and asking the user. If three different selector hypotheses all fail, the site has probably changed shape, not just renamed a class. That's a re-capture, not a patch.

---

## Documented failure modes (catalog)

Failures that recurred enough during real captures to deserve named patterns. Most new failures match one of these — check here before re-discovering.

### A. SPA navigation didn't fire `load`
**Symptom:** clicked sidebar link, wait-for-`load` resolved instantly, next step's selector times out because the page still shows the old route.
**Cause:** React Router / Vue Router uses `history.pushState`. No `load` event fires.
**Fix:** Wait on a destination-specific element label, not on `load`. Or use direct URL navigation. See `primitives.md` §12.

### B. Inline panel caches at-click state
**Symptom:** clicked Export, an inline status panel appeared showing "Processing", polled it for 5 minutes, never changed.
**Cause:** the panel captured status at the moment it opened and doesn't re-fetch.
**Fix:** find the canonical reports/jobs URL and re-navigate to it on each poll tick. Never poll an inline panel.

### C. Cross-element DOM relationship doesn't match visual layout
**Symptom:** the visual table shows filename + Download button on the same row, but the Download button selector scoped to that row finds nothing.
**Cause:** the page renders two sibling `<table>` elements stitched together visually. Filename is in table A, button is in table B.
**Fix:** use a global selector (`getByRole("button", { name: "Download" }).first()`) instead of a row-scoped one. If you need to match a specific row, find a stable global identifier (filename text) and use it to compute the row index, then apply that index to the button table.

### D. Staged filter needs explicit "Apply"
**Symptom:** set date range, clicked Export, the export came back with the wrong date range.
**Cause:** the filter is staged — clicking dates doesn't apply them. There's a separate "Apply" / "Terapkan" / "OK" button.
**Fix:** find the apply button near the filter widget and click it before the export action. Verify by checking the visible date pill changes from staged to applied.

### E. Label varies by session state
**Symptom:** selector `text="Minggu Ini:"` works on a fresh session but times out on the next run.
**Cause:** the label changes based on previous state (e.g., "Minggu Ini:" → "Pilih Tanggal:" after a custom range was applied).
**Fix:** use a regex matching all known variants: `text=/^(Minggu Ini|Pilih Tanggal|Dalam bulan ini):/`.

### F. Bot-detection captcha appeared
**Symptom:** site shows a captcha or "verify you're human" check that wasn't there last time.
**Cause:** the session or browser was fingerprinted as automated.
**Fix (playwright-cli):** escape hatch — `AskQuestion` and have the user solve. Note in the playbook as `requires_human: true` or document the trigger condition.
**Fix (backend):** confirm Patchright is used (not vanilla Playwright), `channel: "chrome"`, no custom `userAgent`. See `be-adapter-translation.md` §1.

### G. Cookies expired / session redirect
**Symptom:** navigated to the dashboard, got redirected to login.
**Cause:** session cookies expired or were invalidated.
**Fix (playwright-cli):** re-run the §0.5 acquisition on the session's own profile (the default `docs/profile/playwright-cli/` or its per-session copy) — `goto` the login URL, ask the user to log in once, then confirm with the §0.5 login-probe before resuming. Reuse the profile next run.
**Fix (backend):** throw `AuthError("Run \`bun run login:<marketplace>\` to re-authenticate")`. Do not try to log in via the adapter — credentials in the adapter is a separate scope.

### H. httpOnly cookies fail to inject via JS
**Symptom:** `playwright-cli eval` sets cookies via `document.cookie`, navigates to a protected page, gets login redirect.
**Cause:** target cookies have httpOnly flag — JavaScript cannot set them.
**Fix (playwright-cli):** log in manually in the persistent profile; do not rely on `document.cookie` for httpOnly.
**Fix (backend):** use `context.addCookies()` (CDP-level call that sets httpOnly cookies). See `be-adapter-translation.md` §3.

### I. SPA shell returns blank on deep route navigation
**Symptom:** navigated directly to `/finance/withdraw-new`, got a blank page with no content and no errors.
**Cause:** the SPA needs an initial homepage render before it can route to inner pages.
**Fix:** warm `/` or `/homepage` first, wait for a known element, then navigate to the target. See `primitives.md` §14.

### J. `networkidle` times out forever
**Symptom:** `goto` with `networkidle` (or equivalent wait) hits the 30s timeout and the playbook stalls.
**Cause:** the site polls background endpoints continuously (analytics, status, ads) — network never idles.
**Fix:** wait on `load` + a fixed timeout (2-3s) OR on a destination-specific element. Never use `networkidle` on real-world dashboards.
