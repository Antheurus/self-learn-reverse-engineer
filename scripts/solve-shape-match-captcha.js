// ENV: browser-run-code — Browser via `playwright-cli run-code --filename=<this>` — a single function expression. No require/import/fs/fetch/setTimeout; it never touches disk.
// solve-shape-match-captcha.js — drive a "pick N objects with the same
// shape" visual captcha (first seen: TikTok Seller Center's "Pilih 2 objek
// yang bentuknya sama") to completion via an OpenRouter vision model, run
// live through playwright-cli's run-code against a real open dialog.
//
// Born from module-auto-scrape-integration-service-mono's tiktok-ai-
// assisted-login plan (2026-07-15) after several rounds of debugging a
// production adapter (keepalive/src/captcha.js) blind via remote deploy-and-
// poll cycles. Driving it live through playwright-cli surfaced bugs no
// amount of guessing from a truncated remote error string would have:
// coordinate math bugs turned out NOT to be the problem (verified twice —
// see below); the real bugs were JSON-parsing robustness, a duplicate-point
// vision-model failure mode, and a dialog-remount race. Save this script so
// the NEXT agent doesn't have to rediscover the run-code sandbox's specific
// footguns from scratch.
//
// EXECUTION CONTEXT — READ THIS BEFORE PASTING ANYTHHING:
// playwright-cli's `run-code` sandbox is NOT a normal Node.js process:
//   1. NO global `setTimeout` in the outer (page-callback) scope. A helper
//      like `const delay = ms => new Promise(r => setTimeout(r, ms))` throws
//      "setTimeout is not defined" the instant it's called — and because
//      it's usually called AFTER a real side effect (e.g. after
//      page.mouse.click), the side effect silently partially happens before
//      the crash, which is exactly the kind of half-done state that looks
//      like "the click doesn't work" from the outside. Use
//      `await page.waitForTimeout(ms)` instead — it's a page method, not a
//      global, and always available.
//   2. NO global `fetch` in the outer scope either. Any HTTP call (vision
//      model API, an internal polling endpoint) must be wrapped in
//      `page.evaluate(async (args) => { return await fetch(...) }, args)` —
//      fetch DOES exist inside the real browser page context.
//   3. import/export/require syntax is not supported (playwright-cli's own
//      docs). Everything below must be inlined into one
//      `async page => { ... }` expression — no importing the real
//      keepalive/src/captcha.js module directly. Keep this file's logic in
//      sync with the real production file by hand when either changes.
//   4. `run-code`'s own tool output ECHOES BACK the full script it ran,
//      including any literal secret you embedded in the script text (e.g. an
//      API key string). If you inline a real credential to run this, that
//      value will land in the calling agent's transcript. Prefer reading the
//      credential from wherever the caller keeps it and be aware of this
//      before running — don't paste a live prod secret in here in the first
//      place if it can be avoided.
//
// VERIFIED FINDINGS (2026-07-15, TikTok's "Pilih 2 objek yang bentuknya
// sama", `anthropic/claude-sonnet-4.5` via OpenRouter):
//   - Coordinate translation math (fraction -> page.mouse.click) was verified
//     correct multiple ways: TikTok's own numbered selection markers landed
//     exactly where the math predicted, and grid-annotating a raw captured
//     image with Python PIL confirmed the model's claimed fractions land
//     close to the real shapes when translated.
//   - TRIED AND REVERTED: sending a FULL-VIEWPORT screenshot (instead of a
//     crop of just the captcha image) so the prompt/image/click math all
//     shared one coordinate frame end to end (fraction-of-viewport), with no
//     per-round element-bounding-box lookup. This looked like the more
//     "predictable" design and was worth testing, but live-tested via
//     playwright-cli it was measurably WORSE: 0/3 rounds even enabled the
//     confirm button (vs. the crop reliably enabling it), with a consistent
//     systematic offset — grid-annotating the screenshot showed the model's
//     returned fractions matched the shapes' raw PIXEL coordinates divided
//     by ~1000, not by the real (e.g. 1280x900) viewport dimensions. The
//     model does not reliably normalize spatial answers against a large,
//     non-square image; it does much better when the target shapes fill
//     most of the frame (the crop). Function below crops to the captcha
//     image specifically — KEEP the caller's viewport forced to a fixed size
//     regardless (still legitimate: makes the crop region itself
//     deterministic run to run), just don't switch the screenshot/prompt/
//     click math to full-viewport fractions.
//   - Real, load-bearing bugs, all fixed below:
//     a. `response_format:{type:"json_object"}` does not reliably stop the
//        model wrapping JSON in a markdown fence OR appending trailing prose
//        after a complete JSON object — a naive fence-strip regex misses the
//        second case ("Unexpected non-whitespace character after JSON at
//        position N"). Fix: extract the first balanced {...} object instead
//        of trying to strip wrappers.
//     b. The model can return two near-identical points (picks the same
//        object twice). Clicking the same spot twice never selects 2
//        distinct objects, so the confirm button stays `aria-disabled` and a
//        click on it times out for no informative reason. Fix: reject two
//        points closer than MIN_POINT_SEPARATION_FRACTION and force a retry.
//     c. After a wrong answer, the site can tear down the current challenge
//        and mount an entirely new one (fresh portal element) rather than
//        mutating it in place — the dialog's matching text is briefly absent
//        during that transition. A round-to-round presence check with no
//        grace period concludes "solved" mid-transition, and the caller's
//        next action then hangs on an overlay that's still covering it. Fix:
//        give every "dialog gone?" check a short grace-period re-check
//        (`waitForCaptchaDialog`), not just the very first one.
//   - Real per-round vision-model accuracy is roughly 70-80%, not 100% — plan
//     retry budget accordingly, and don't mistake "the model was wrong this
//     round" for "the automation is broken".
//
// USAGE — paste the function bodies below inside your own run-code file's
// `async (page) => { ... }` wrapper (see primitives.md §17: the whole
// run-code file must be one arrow-function expression), replace the dialog
// text / image accessible-name / confirm-button-name constants for your
// target site's captcha, supply your own API key (read from wherever your
// caller keeps it — see gotcha #4 above), then call:
//
//   const result = await solveShapeMatchCaptcha(page, {
//     dialogText: "Pilih 2 objek yang bentuknya sama",
//     imgName: "Verifikasi bahwa Anda bukan robot",
//     confirmButtonName: "Konfirmasikan",
//     apiKey: OPENROUTER_API_KEY,
//     model: OPENROUTER_VISION_MODEL, // optional, defaults below
//   });
//   // result: { solved: boolean, rounds: number, log: [...], error?: string }
//
// Force a fixed viewport before calling this (e.g.
// `page.setViewportSize({width:1280, height:900})`, or the `viewport` launch
// option) — not required by this function directly, but keeps the captcha
// image's crop region deterministic run to run (see the findings note above
// on why the screenshot itself stays a crop, not the full viewport).

async function solveShapeMatchCaptcha(page, opts) {
  const {
    dialogText,
    imgName,
    confirmButtonName,
    apiKey,
    model,
    maxRounds = 3,
    maxWallClockMs = 3 * 60 * 1000,
    minPointSeparationFraction = 0.03,
    initialGraceMs = 5000,
    remountGraceMs = 2000,
  } = opts;

  const delay = (ms) => page.waitForTimeout(ms);

  const PROMPT = `You are solving a visual matching captcha titled "${dialogText}". The attached image shows several objects arranged on a surface. Exactly 2 of them share the same shape/outline (ignore color, texture, and material — match by silhouette/shape only, e.g. two objects that are both shaped like a star, or both shaped like a specific letter or digit).

Identify the 2 matching objects and respond with their center points as fractions of the image width/height (0.0 to 1.0, top-left origin).

Respond with ONLY strict JSON, no markdown, no extra text:
{"reasoning": "<one short sentence identifying the matching shape>", "points": [{"x": <0-1 fraction>, "y": <0-1 fraction>}, {"x": <0-1 fraction>, "y": <0-1 fraction>}]}`;

  function extractFirstJsonObject(text) {
    const start = text.indexOf("{");
    if (start === -1) throw new Error("no JSON object found in vision model response");
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    throw new Error("unterminated JSON object in vision model response");
  }

  async function callVisionModel(base64) {
    // Wrapped in page.evaluate — see gotcha #2 at the top of this file.
    const content = await page.evaluate(
      async ({ apiKey, model, prompt, base64 }) => {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: model || "anthropic/claude-sonnet-4.5",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
                ],
              },
            ],
            response_format: { type: "json_object" },
          }),
        });
        if (!res.ok) throw new Error(`vision API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        return data?.choices?.[0]?.message?.content;
      },
      { apiKey, model, prompt: PROMPT, base64 },
    );
    if (!content) throw new Error("vision model response missing content");
    const parsed = JSON.parse(extractFirstJsonObject(content));
    const points = parsed?.points;
    if (!Array.isArray(points) || points.length !== 2) {
      throw new Error(`vision model did not return 2 points: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    for (const p of points) {
      if (typeof p?.x !== "number" || typeof p?.y !== "number") {
        throw new Error(`vision model point missing numeric x/y: ${JSON.stringify(p)}`);
      }
    }
    const dx = points[0].x - points[1].x;
    const dy = points[0].y - points[1].y;
    if (Math.sqrt(dx * dx + dy * dy) < minPointSeparationFraction) {
      throw new Error(`vision model returned two points too close together (likely the same object): ${JSON.stringify(points)}`);
    }
    return { points, reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning : "" };
  }

  async function isDialogPresent() {
    try {
      const t = page.getByText(dialogText);
      if ((await t.count()) === 0) return false;
      return await t.first().isVisible();
    } catch {
      return false;
    }
  }
  async function waitForDialog(timeoutMs) {
    try {
      await page.getByText(dialogText).first().waitFor({ state: "visible", timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  const startedAt = Date.now();
  const log = [];
  let round = 0;

  if (!(await waitForDialog(initialGraceMs))) {
    return { solved: true, rounds: 0, log };
  }

  while (true) {
    if (round > 0 && !(await isDialogPresent())) {
      // Grace-period re-check — see gotcha (c) above. Without this, a
      // dialog remount after a wrong answer is misread as "solved".
      if (!(await waitForDialog(remountGraceMs))) {
        return { solved: true, rounds: round, log };
      }
    }

    round += 1;
    const elapsedMs = Date.now() - startedAt;
    if (round > maxRounds || elapsedMs > maxWallClockMs) {
      return { solved: false, rounds: round - 1, log, error: `exceeded retry budget (rounds=${round - 1}, elapsedMs=${elapsedMs})` };
    }

    try {
      const img = page.getByRole("img", { name: imgName });
      const box = await img.boundingBox();
      if (!box) throw new Error("captcha image element not found or not visible");
      const buffer = await page.screenshot({ clip: box });
      const result = await callVisionModel(buffer.toString("base64"));
      log.push({ round, reasoning: result.reasoning, points: result.points });

      for (const p of result.points) {
        const x = box.x + p.x * box.width;
        const y = box.y + p.y * box.height;
        await page.mouse.click(x, y);
        await delay(300);
      }
      await page.getByRole("button", { name: confirmButtonName }).click({ timeout: 5000 });
      await delay(1500);
    } catch (err) {
      log.push({ round, error: err.message });
    }
  }
}
