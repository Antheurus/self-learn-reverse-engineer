// ENV: browser-run-code — Browser via `playwright-cli run-code --filename=<this>` — a single function expression. No require/import/fs/fetch/setTimeout; it never touches disk.
// stealth-init.js — hide the automation flags a vanilla Playwright session exposes, for every page
// the context opens from now on.
//
//   playwright-cli -s=<session> run-code --filename=<this file>
//
// Run it once after `open` and BEFORE navigating to the target: an init script only reaches documents
// created after it is registered. Read the returned object — it is the page's own view after a reload.
//
// Measured on playwright-cli 0.1.17 against bot.sannysoft.com: `navigator.webdriver` was already false
// without this script, so the one flag it changed was `chrome.runtime` (absent → present). A HEADLESS
// session still fails on its user agent (`HeadlessChrome/…`), and no script here touches that: open
// with `--headed` instead, never with a hand-set user agent.
//
// NOT for Patchright, which closes the leak at the CDP layer; page-level getters on top of it are
// something a site can detect. Adapted from reverse-api-engineer's STEALTH_JS (MIT), minus its fixed
// WebGL/hardware values (a hardcoded "Apple M1 Pro" on other hardware is the mismatch a fingerprinter
// looks for), its closed-shadow-root override and its console.log.
async (page) => {
  await page.context().addInitScript(() => {
    const proto = Object.getPrototypeOf(navigator);
    Object.defineProperty(proto, 'webdriver', { get: () => false, configurable: true });

    for (const key of Object.keys(window)) {
      if (key.startsWith('cdc_') || key.startsWith('$cdc_')) delete window[key];
    }

    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};

    const query = navigator.permissions && navigator.permissions.query;
    if (query) {
      navigator.permissions.query = (descriptor) =>
        descriptor && descriptor.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : query.call(navigator.permissions, descriptor);
    }
  });

  await page.reload();

  return page.evaluate(() => ({
    webdriver: navigator.webdriver,
    chromeRuntime: !!(window.chrome && window.chrome.runtime),
    plugins: navigator.plugins.length,
    languages: navigator.languages,
    cdcKeys: Object.keys(window).filter((k) => k.includes('cdc_')).length,
  }));
}
