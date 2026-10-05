// ENV: browser-run-code — Browser via `playwright-cli run-code --filename=<this>` — a single function expression. No require/import/fs/fetch/setTimeout; it never touches disk.
// stealth-check.js — report what the current page can see of the automation, before a bot-checked
// target sees it. It patches nothing: on this stack every page-level patch tried made the session
// MORE detectable (references/har-to-client.md "Staying undetected"), so the fix for a finding is a
// launch option, never a script.
//
//   playwright-cli -s=<session> run-code --filename=<this file>
async (page) => {
  const signals = await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    return {
      uaHeadless: navigator.userAgent.includes('Headless'),
      brandsHeadless: !!(navigator.userAgentData && navigator.userAgentData.brands.some((b) => b.brand.includes('Headless'))),
      webdriver: navigator.webdriver,
      webdriverGetterNative: descriptor && descriptor.get ? /\[native code\]/.test(Function.prototype.toString.call(descriptor.get)) : null,
      playwrightGlobals: Object.getOwnPropertyNames(window).filter((k) => /^__(pw|playwright)/.test(k)),
      outerZero: outerWidth === 0 || outerHeight === 0,
      plugins: navigator.plugins.length,
    };
  });
  const findings = [];
  if (signals.uaHeadless || signals.brandsHeadless) findings.push('headless is announced in the user agent — close and reopen with --headed; never set a user agent by hand');
  if (signals.webdriver) findings.push('navigator.webdriver is true — this browser was launched with automation flags; use playwright-cli or Patchright with channel chrome');
  if (signals.webdriverGetterNative === false) findings.push('navigator.webdriver was overridden from page script — remove the init script that does it');
  if (signals.playwrightGlobals.length) findings.push('Playwright globals are visible on window: ' + signals.playwrightGlobals.join(', '));
  if (signals.outerZero) findings.push('window has zero outer size — a headless tell; reopen with --headed');
  if (signals.plugins === 0) findings.push('navigator.plugins is empty — not a real Chrome channel');
  return { clean: findings.length === 0, findings, signals };
}
