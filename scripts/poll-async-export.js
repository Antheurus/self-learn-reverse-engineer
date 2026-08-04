// poll-async-export.js — generalized polling for a submit → poll → download-URL
// async job (report generation, video export, order export). Goes beyond the
// simple pollUntil() in primitives.md §3 with three additions real captures
// needed:
//   1. DUAL-SIGNAL check — some jobs need BOTH a status-list flag AND a
//      separate file-readiness check before the file is actually fetchable.
//   2. TERMINAL-FAILURE fast-fail — a known failure status code should stop
//      polling immediately instead of running out the full timeout.
//   3. SELF-THROTTLE on hang — if the job neither succeeds nor fails for an
//      unusually long time, that's often anti-abuse throttling, not "almost
//      done" — stop retrying instead of hammering the endpoint.
//   4. FRESH SIGNED URL — many export APIs return a disposable, single-use
//      pre-signed download URL from the "ready" check. Do not cache it across
//      polls; re-resolve it on the tick you actually download.
//
// Not every export API has all four shapes above — verify on YOUR target
// before wiring blindly (api-mimic-codify.md "Async export chain template"):
// omit `resolveDownloadUrl` entirely if the "ready" response already contains
// the file/bytes directly (no separate resolve step exists); omit
// `isTerminalFailure` if there's no distinct failure status to fast-fail on.
//
// EXECUTION CONTEXT: this is a snippet to COPY into your own run-code file's
// `async (page) => {...}` body, not a standalone --filename script — it takes
// closures (checkStatus/isReady/etc.) that need to call `page.evaluate(...)`,
// and run-code requires the whole file be one arrow-function expression (see
// primitives.md §17), so `pollAsyncExport` must be declared INSIDE that
// wrapper, not alongside it at the top level.
//
// Usage — paste this whole comment block's function bodies inside your
// run-code file, then:
//   async (page) => {
//     function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
//     async function pollAsyncExport({ ... }) { /* body below */ }
//
//     const result = await pollAsyncExport({
//       checkStatus: async () => page.evaluate(() => fetch('/api/status').then(r => r.json())),
//       isReady: (status) => status.state === 'done',
//       isTerminalFailure: (status) => status.state === 'failed' || status.code === 3,
//       resolveDownloadUrl: async () => {
//         const j = await page.evaluate(() => fetch('/api/download-url').then(r => r.json()));
//         return j.url;
//       },
//     });
//     return result;
//   }

async function pollAsyncExport({
  checkStatus,
  isReady,
  isTerminalFailure,
  resolveDownloadUrl,
  intervalMs = 20000,
  timeoutMs = 600000,
  // If no state change (same JSON) for this long, assume throttling and stop
  // instead of continuing to hammer the endpoint for the remaining timeout.
  stuckThresholdMs = 180000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatusJson = null;
  let lastChangeAt = Date.now();
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    let status;
    try {
      status = await checkStatus();
    } catch (e) {
      await sleep(intervalMs);
      continue; // transient error — retry, don't fail the whole poll on one blip
    }

    if (isTerminalFailure && isTerminalFailure(status)) {
      return { ok: false, reason: 'terminal_failure', status, attempts };
    }

    if (isReady(status)) {
      // resolveDownloadUrl is optional — some "ready" responses already carry
      // the file/bytes directly and have no separate resolve step (verify
      // this on your target rather than assuming the 4-step shape applies).
      const url = resolveDownloadUrl ? await resolveDownloadUrl() : null;
      return { ok: true, status, downloadUrl: url, attempts };
    }

    const statusJson = JSON.stringify(status);
    if (statusJson === lastStatusJson) {
      if (Date.now() - lastChangeAt > stuckThresholdMs) {
        return {
          ok: false,
          reason: 'stuck_no_progress',
          status,
          attempts,
          note: `Status unchanged for ${stuckThresholdMs}ms — likely anti-abuse throttling rather than slow processing. Stopped instead of exhausting the full timeout.`,
        };
      }
    } else {
      lastStatusJson = statusJson;
      lastChangeAt = Date.now();
    }

    await sleep(intervalMs);
  }

  return { ok: false, reason: 'timeout', attempts };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
