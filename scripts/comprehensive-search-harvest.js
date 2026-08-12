// ENV: browser-console — DevTools Console — paste the whole file into the console on a logged-in page. Defines multiple functions, so it does NOT fit run-code's single-expression sandbox.
// Credential harvest v3 — value-first locator. Paste in DevTools Console on a logged-in page.
// Docs: references/credential-harvest.md
//
// WHO FILLS THIS: the AI. You (human) give the AI a HAR / copy-as-fetch / URL + how it's
// reproduced; the AI extracts the exact request values and populates KNOWN below, then hands
// you the script to paste. The harvester EXACT-MATCHES those values against everything the
// page exposes and reports WHERE each lives + the JS accessor to re-read it. Exact-match = zero
// i18n/route/analytics noise (the v2 substring firehose is gone).
//
// AI-CENTRIC OUTPUT: one JSON artifact, delivered file-first:
//   1) auto-downloads harvest-<host>.json  (AI reads it directly — most reliable)
//   2) copy()s the same string to clipboard (paste fallback)
//   3) console.logs it between ===HARVEST_V3_START/END=== sentinels (last resort)
// No console.table / console.group / %c (they copy badly and truncate tokens).
//
// TWO TIERS:
//   TIER 1 (KNOWN)     — exact-locate the request values you already have. The precision path.
//   TIER 2 (DISCOVERY) — strict safety net: credential-shaped values you did NOT list, so you
//                        notice tokens you forgot to extract. High bar, i18n/route/analytics excluded.

(async function () {
  // ============================== CONFIG (AI fills KNOWN) ==============================
  // Each entry: { label, value | valueRegex, origin?, httpOnly? }
  //   label      — what this is ("oec_seller_id", "msToken", "X-Bogus", "_csrf", "sessionid")
  //   value      — EXACT value from the captured request (preferred)
  //   valueRegex — use instead of value when it rotates per request (e.g. "^eyJ" for a JWT)
  //   origin     — where it appeared in the REQUEST: "query" | "header" | "body" | "cookie"
  //   httpOnly   — true if it's an httpOnly cookie (JS can't read it; flagged accordingly)
  const KNOWN = [
    // EXAMPLES — replace with values extracted from the target HAR:
    // { label: "oec_seller_id", value: "7494083408627664605", origin: "query" },
    // { label: "msToken",       value: "xDcmm...",            origin: "query" },
    // { label: "X-Bogus",       valueRegex: "^[A-Za-z0-9_-]{20,}$", origin: "query" },
    // { label: "_csrf",         value: "90ff689f...",         origin: "header" },
    // { label: "sessionid",     value: "16bb6a6b...",         origin: "cookie", httpOnly: true },
  ];

  const DISCOVERY = true; // run Tier 2 safety net
  const MASK = false; // true → redact values. Default false: RE needs the real value.
  const MAX_DISCOVERY = 40; // cap total discovery candidates (logs how many were dropped)
  const MAX_DISCOVERY_PER_KEY = 3; // cap candidates sharing the same key name (e.g. many "token")
  const MIN_LEN = 16; // discovery: ignore short values
  const MAX_LEN = 4096; // ignore heap/i18n blobs

  // TIER-1 precision guards (generic — tune per target, no platform assumptions)
  const MAX_LOCATIONS_PER_LABEL = 6; // a real cred lives in a few places; more ⇒ value too common
  const MIN_LOCATE_LEN = 6; // values shorter than this only locate from HIGH_TRUST sources
  const HIGH_TRUST_SOURCES = ["Cookie", "URL Param"]; // where a short/common exact value is meaningful

  // DISCOVERY tuning — EDITABLE ARRAYS, not hardcoded rules. Defaults are generic web noise.
  // Add target-specific noise here when a run is dirty; never edit the logic below.
  const KEY_SIGNAL_TERMS = [
    "token", "secret", "csrf", "session", "auth", "sign", "bogus", "mstoken",
    "sid", "ticket", "guard", "bearer", "jwt", "apikey", "api_key", "access", "uid",
  ];
  const DISCOVERY_EXCLUDE_TERMS = [
    // generic analytics / i18n / build-config noise common to most SPAs
    "i18n", "text\\.", "locale", "lang\\b", "translation", "_ga", "_gcl",
    "_tea_", "__tea", "ttcsid", "_tt_", "fullstory", "sentry", "datadog", "gtm",
  ];

  // ============================== HELPERS ==============================
  const present = (v) => {
    if (!MASK) return v;
    const s = String(v);
    return s.length <= 6 ? "***" : `${s.slice(0, 4)}…(${s.length})`;
  };
  // accessor stability ranking — pick the simplest/most durable way to re-read a value
  const SOURCE_RANK = {
    Cookie: 6,
    "URL Param": 5,
    localStorage: 4,
    "localStorage (nested)": 4,
    sessionStorage: 3,
    "sessionStorage (nested)": 3,
    IndexedDB: 2,
    "Window Heap": 1,
  };

  // KNOWN normalization + matchers
  const known = KNOWN.map((k, i) => ({
    label: k.label || `known_${i}`,
    value: k.value != null ? String(k.value) : undefined,
    valueRegex: k.valueRegex ? new RegExp(k.valueRegex) : undefined,
    origin: k.origin || null,
    httpOnly: !!k.httpOnly,
  }));
  const knownValues = new Set(known.filter((k) => k.value != null).map((k) => k.value));
  const located = Object.fromEntries(known.map((k) => [k.label, []])); // label -> [{source,accessor,value}]
  const matchKnown = (value) => {
    const v = value == null ? "" : String(value);
    const hits = [];
    for (const k of known) {
      if (k.value != null && v === k.value) hits.push(k.label);
      else if (k.valueRegex && k.valueRegex.test(v)) hits.push(k.label);
    }
    return hits;
  };

  // DISCOVERY strict gate — regexes built from the editable CONFIG arrays above (generic)
  const RE_JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const KEY_SIGNAL = new RegExp(`(${KEY_SIGNAL_TERMS.join("|")})`, "i");
  const EXCLUDE = new RegExp(`(${DISCOVERY_EXCLUDE_TERMS.join("|")})`, "i");
  // structural noise: routes / urls / regex-config strings (shape-based, no platform terms)
  const looksRouteOrUrl = (v) => /^https?:\/\//.test(v) || /\(\\?\?|\(\?\.\*\)|\\\?/.test(v) || /^\/[\w-]/.test(v);
  const highEntropy = (v) => v.length >= 24 && /[A-Za-z]/.test(v) && /[0-9]/.test(v);
  const candidates = [];
  let discoveryDropped = 0;
  const seenCand = new Set();
  const considerDiscovery = (key, value, source, accessor) => {
    if (!DISCOVERY) return;
    if (typeof value !== "string") return;
    if (value.length < MIN_LEN || value.length > MAX_LEN) return;
    if (/\s/.test(value)) return; // tokens don't contain spaces
    if (knownValues.has(value)) return; // already a KNOWN hit
    if (EXCLUDE.test(key) || EXCLUDE.test(accessor)) return;
    if (looksRouteOrUrl(value)) return;
    const shape = RE_JWT.test(value) ? 4 : highEntropy(value) ? 2 : 0;
    if (!shape) return;
    const keySig = KEY_SIGNAL.test(key) || KEY_SIGNAL.test(accessor);
    const fromAuthStore = source === "Cookie" || source.startsWith("sessionStorage");
    if (!keySig && !fromAuthStore) return; // need a reason beyond raw shape
    if (seenCand.has(value)) return;
    seenCand.add(value);
    candidates.push({ key: String(key), value, source, accessor, score: shape + (keySig ? 3 : 0) + (fromAuthStore ? 1 : 0) });
  };

  // every scanner funnels here
  const matchCount = Object.fromEntries(known.map((k) => [k.label, 0])); // total exact-matches per label
  const HARD_CAP = MAX_LOCATIONS_PER_LABEL * 4; // stop storing locations past this (still count)
  const consider = (key, value, source, accessor) => {
    const v = value == null ? "" : String(value);
    const shortVal = v.length < MIN_LOCATE_LEN;
    for (const label of matchKnown(value)) {
      // short/common values are only meaningful from high-trust sources (cookie/url),
      // never from heap/storage where a value like "2" matches thousands of cells
      if (shortVal && !HIGH_TRUST_SOURCES.includes(source)) continue;
      matchCount[label]++;
      const arr = located[label];
      if (arr.length < HARD_CAP && !arr.some((l) => l.accessor === accessor)) arr.push({ source, accessor, value });
    }
    considerDiscovery(key, value, source, accessor);
  };

  // ============================== SCANNERS ==============================
  // Cookies
  if (document.cookie) {
    document.cookie.split(";").forEach((c) => {
      const idx = c.indexOf("=");
      const k = c.slice(0, idx).trim();
      const v = c.slice(idx + 1).trim();
      if (!k) return;
      consider(
        k,
        v,
        "Cookie",
        `document.cookie.split('; ').find(r=>r.startsWith('${k}=')).split('=').slice(1).join('=')`
      );
    });
  }

  // URL params
  new URLSearchParams(location.search).forEach((v, k) => {
    consider(k, v, "URL Param", `new URLSearchParams(location.search).get('${k}')`);
  });

  // local / session storage (+ deep JSON)
  ["localStorage", "sessionStorage"].forEach((storeName) => {
    const store = window[storeName];
    if (!store) return;
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      const v = store.getItem(k);
      const baseCmd = `${storeName}.getItem('${k}')`;
      consider(k, v, storeName, baseCmd);
      try {
        const deep = (o, path) => {
          if (!o || typeof o !== "object") return;
          for (const prop in o) {
            const val = o[prop];
            const accessor = `JSON.parse(${baseCmd})${path}['${prop}']`;
            if (typeof val !== "object") consider(prop, val, `${storeName} (nested)`, accessor);
            else deep(val, `${path}['${prop}']`);
          }
        };
        deep(JSON.parse(v), "");
      } catch {}
    }
  });

  // IndexedDB (deep)
  const scanIDBRecord = (record, recordKey, dbName, storeName, path = "") => {
    if (!record || typeof record !== "object") return;
    for (const prop in record) {
      try {
        const val = record[prop];
        const currentPath = path ? `${path}.${prop}` : prop;
        if (typeof val !== "object" || val === null) {
          consider(
            prop,
            val,
            "IndexedDB",
            `/* IndexedDB '${dbName}' > store '${storeName}' > key ${JSON.stringify(recordKey)} > ${currentPath} */`
          );
        } else scanIDBRecord(val, recordKey, dbName, storeName, currentPath);
      } catch {}
    }
  };
  const scanIDB = async () => {
    if (!window.indexedDB || !indexedDB.databases) return;
    try {
      const dbs = await indexedDB.databases();
      for (const dbInfo of dbs) {
        const req = indexedDB.open(dbInfo.name);
        await new Promise((resolve) => {
          req.onsuccess = (event) => {
            const db = event.target.result;
            const stores = Array.from(db.objectStoreNames);
            if (!stores.length) return resolve();
            const tx = db.transaction(stores, "readonly");
            let done = 0;
            stores.forEach((storeName) => {
              const recs = [];
              const cur = tx.objectStore(storeName).openCursor();
              cur.onsuccess = (e) => {
                const c = e.target.result;
                if (c) {
                  recs.push({ key: c.key, value: c.value });
                  c.continue();
                } else {
                  recs.forEach(({ key, value }) => scanIDBRecord(value, key, dbInfo.name, storeName));
                  if (++done === stores.length) resolve();
                }
              };
              cur.onerror = () => {
                if (++done === stores.length) resolve();
              };
            });
          };
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      }
    } catch {}
  };

  // Window heap (bounded: depth 25, cycle guard, DOM/recursion skip-list)
  const scanHeap = () => {
    const visited = new Set();
    const SKIP = new Set([
      "innerHTML",
      "outerHTML",
      "textContent",
      "style",
      "parent",
      "top",
      "frames",
      "self",
      "window",
    ]);
    const walk = (obj, path, depth) => {
      if (depth > 25) return;
      if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return;
      if (visited.has(obj)) return;
      visited.add(obj);
      let keys = [];
      try {
        keys = Object.getOwnPropertyNames(obj);
      } catch {
        return;
      }
      for (const key of keys) {
        if (SKIP.has(key) && depth > 0) continue;
        try {
          const val = obj[key];
          const accessor = /^[a-zA-Z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}['${key}']`;
          if (val && typeof val === "object") {
            if (val instanceof Node && depth > 1) continue;
            walk(val, accessor, depth + 1);
          } else consider(key, val, "Window Heap", accessor);
        } catch {}
      }
    };
    walk(window, "window", 0);
  };

  await scanIDB();
  scanHeap();

  // ============================== ASSEMBLE ==============================
  const knownReport = known.map((k) => {
    const locs = located[k.label]
      .slice()
      .sort((a, b) => (SOURCE_RANK[b.source] || 0) - (SOURCE_RANK[a.source] || 0));
    const total = matchCount[k.label];
    if (locs.length) {
      const tooCommon = total > MAX_LOCATIONS_PER_LABEL;
      const out = {
        label: k.label,
        origin: k.origin,
        status: "located",
        value: present(locs[0].value),
        best: locs[0].accessor,
        // when a value is too common, show only the cleanest few — never dump hundreds
        locations: locs.slice(0, MAX_LOCATIONS_PER_LABEL).map((l) => ({ source: l.source, accessor: l.accessor })),
      };
      if (tooCommon) {
        out.tooCommon = true;
        out.matchCount = total;
        out.note = `value '${present(locs[0].value)}' matched ${total} places — too common to pin precisely; prefer the high-trust source above`;
      }
      return out;
    }
    // absent: distinguish the three real reasons instead of always blaming httpOnly
    let note;
    if (k.httpOnly) note = "httpOnly cookie — JS cannot read it; auto-sent with credentials:'include', no read needed";
    else if (k.origin === "cookie")
      note = "value not found — cookie likely rotated since capture (or is httpOnly); auto-sent with credentials:'include' either way";
    else note = "not in page state — likely computed at request time (page-signed) or inside a worker/closure";
    return { label: k.label, origin: k.origin, status: "absent", note };
  });

  candidates.sort((a, b) => b.score - a.score);
  // collapse many candidates sharing one key name (e.g. dozens of "token") to the top few
  const perKeyCount = {};
  const keyCapped = [];
  for (const c of candidates) {
    perKeyCount[c.key] = (perKeyCount[c.key] || 0) + 1;
    if (perKeyCount[c.key] <= MAX_DISCOVERY_PER_KEY) keyCapped.push(c);
  }
  const shownCand = keyCapped.slice(0, MAX_DISCOVERY);
  discoveryDropped = candidates.length - shownCand.length;

  const report = {
    v: "3.1",
    url: location.href,
    ts: new Date().toISOString(),
    masked: MASK,
    summary: {
      known: known.length,
      located: knownReport.filter((r) => r.status === "located").length,
      absent: knownReport.filter((r) => r.status === "absent").length,
      candidates: shownCand.length,
      candidatesDropped: discoveryDropped,
    },
    known: knownReport,
    candidates: shownCand.map((c) => ({
      key: c.key,
      value: present(c.value),
      source: c.source,
      accessor: c.accessor,
      score: c.score,
      unmatchedCandidate: true,
    })),
  };
  const payload = JSON.stringify(report, null, 2);

  // ============================== DELIVER: file → clipboard → sentinel ==============================
  const host = location.hostname.replace(/[^a-z0-9.-]/gi, "_");
  const delivered = [];
  try {
    const blob = new Blob([payload], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `harvest-${host}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    delivered.push(`downloaded harvest-${host}.json`);
  } catch (e) {
    delivered.push(`download failed (${e.message})`);
  }
  try {
    if (typeof copy === "function") {
      copy(payload);
      delivered.push("copied to clipboard");
    }
  } catch {}

  const s = report.summary;
  console.log(
    `harvest v3: KNOWN ${s.located}/${s.known} located (${s.absent} absent), ` +
      `${s.candidates} discovery candidate(s)${discoveryDropped ? ` (+${discoveryDropped} dropped)` : ""} — ${delivered.join(
        " + "
      )}`
  );
  if (!known.length)
    console.warn("harvest v3: KNOWN is empty — fill it from the target HAR, or rely on the discovery tier only.");
  console.log("===HARVEST_V3_START===");
  console.log(payload);
  console.log("===HARVEST_V3_END===");
  return report;
})();
