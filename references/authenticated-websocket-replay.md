# Authenticated-WebSocket Replay (protobuf-frame send)

Technique for automating **sends on a site whose write path is a WebSocket frame, not an HTTP call** — chat/IM, presence, live-ops, collab editors, trading. Read when the network capture shows the action (send message, place order) producing **no HTTP request**, only a WS frame, and the goal is to reproduce that send without DOM.

Named by the mechanism, not the platform: any "authenticated long-lived socket carrying length-delimited binary frames" fits, regardless of vendor.

Worked example referenced throughout: a TikTok-IMCloud (Pigeon) creator-message send on a Tokopedia-affiliate page. Full platform-specific contract lives in that project's `docs/automation/affiliate-im-blast.CONTRACTS.md`.

---

## The core insight — reuse the socket, do not re-sign

A bot-protected site signs its HTTP requests per-call (`X-Bogus`, `X-Gnarly`, `msToken`, HMAC). The instinct is to reproduce that signing — almost always infeasible (it lives in obfuscated wasm/JS).

But a **long-lived WebSocket is authenticated once, at open-time**, via a token/access_key in the connect URL or handshake. After that, individual frames are accepted on the strength of the open connection plus any **message-level token carried inside the frame body**. Per-frame anti-bot signatures, when present, are frequently **not validated** server-side.

Consequence: do not open your own socket and do not re-sign. **Capture a reference to the page's already-open socket and call `.send()` on it** with a frame you build. The page did the expensive auth; ride it.

Verify this assumption with one experiment before building anything: build a frame from scratch (no signature header) and send it over the captured socket. If it lands, the whole automation is a frame-builder + `ws.send`.

---

## Capture the live socket

The socket reference is module-scoped inside the page bundle — not on `window`. Get it by hooking the constructor **before the page opens it**:

```js
// MUST run before the app's socket opens. In an extension: a MAIN-world content
// script at run_at: document_start. In playwright capture: page.addInitScript.
const OrigWS = window.WebSocket;
let liveWS = null;
function Wrapped(url, protocols) {
  const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
  if (/frontier|wss-?gateway|realtime/i.test(String(url))) liveWS = ws; // match the target socket
  return ws;
}
Wrapped.prototype = OrigWS.prototype;
Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSING = 2; Wrapped.CLOSED = 3;
window.WebSocket = Wrapped;
```

Gotchas:
- **Timing is everything.** If the hook installs after the socket opens, `liveWS` stays null (no API enumerates open sockets). Extension: `document_start`. Capture session: `addInitScript` then reload.
- **`.readyState === 1`** before sending. The socket may exist but still be CONNECTING, or have reconnected — keep the latest matching instance.
- The connect URL itself is the credential — log it once; it reveals the open-time `token`/`access_key`/`device_id` that prove the socket is the auth boundary.

---

## Build the frame (minimal protobuf writer)

Most binary frames are protobuf. Decode captured frames with `protoc --decode_raw` (see `network-discovery.md`), map the fields, then encode with a tiny writer. No protobuf library needed.

```js
function Writer(){ this.b=[]; }
Writer.prototype.varint=function(v){ let n=typeof v==='bigint'?v:BigInt(Math.trunc(v));
  while(true){ const b=Number(n&0x7fn); n>>=7n; if(n){this.b.push(b|0x80);}else{this.b.push(b);break;} } };
Writer.prototype.tag=function(f,wt){ this.varint((f<<3)|wt); };
Writer.prototype.vfield=function(f,v){ this.tag(f,0); this.varint(v); };                 // varint
Writer.prototype.sfield=function(f,s){ this.tag(f,2); const u=new TextEncoder().encode(s);
  this.varint(u.length); for(const x of u) this.b.push(x); };                            // string
Writer.prototype.mfield=function(f,sub){ this.tag(f,2); const u=sub.bytes();
  this.varint(u.length); for(const x of u) this.b.push(x); };                            // nested msg
Writer.prototype.bytes=function(){ return Uint8Array.from(this.b); };
```

Critical encoding rules:
- **int64 ids overflow JS Number** (conversation/order/user ids are commonly >2^53). Encode them with **BigInt** varints; carry them as strings everywhere else.
- **Repeated fields** = emit the same field number N times (e.g. an ext/metadata map of `{key,value}` sub-messages).
- **Nested message** = encode the sub-writer fully, then length-prefix it.
- Send `writer.bytes().buffer` (an ArrayBuffer) to `ws.send`.

Frame shape is usually two layers: an **outer transport frame** (seqid, timestamp, service id, headers) wrapping an **inner application envelope** (command id, sdk version, token, payload). Copy field numbers verbatim from the `--decode_raw` of a real captured send; only swap the dynamic bits (text/payload, a fresh client-message UUID, the seqid/timestamp).

---

## Resolve the target id

A send needs the conversation/room/thread id. Resolution chain, by feasibility:
1. **Already-open context** (the id is in the URL or the last read response) — free.
2. **A read API** authenticated by **in-body token** (see `credential-harvest.md`) — replayable cold.
3. **A create/resolve API** authenticated by **session cookie** — works only where those cookies are in scope (real browser, correct domain).

Idempotent "create" endpoints double as resolvers (return the existing id). Prefer them when cookie scope is available.

---

## Where this runs in production

This technique lands as an **`sla-extensify` MV3 extension**, not an `sla-codify` HTTP service — the socket and its signer live in the page, so the code must run in the page (MAIN world). Split:
- **MAIN-world content script (`document_start`)** — hooks the socket, holds the protobuf writer + frame builder, exposes a send handler over `CustomEvent` + `window.postMessage`.
- **Isolated-world content script** — orchestration (resolve targets, pace, stop, progress), talks to the bridge by event.
- **Token/search reads** that are cookie+signed go through a MAIN-world `fetch` bridge (the page auto-signs — see `credential-harvest.md`).

See `sla-extensify` for the extension skeleton.

---

## Pre-build verification checklist

1. Hook installed before socket open; `liveWS.readyState === 1`. ✓
2. From-scratch frame (no per-frame signature) sent over `liveWS` **delivers** (confirm in the UI / via a follow-up read). ✓ — this single test validates the whole approach.
3. int64 ids round-trip (decode your own built frame with `protoc --decode_raw`, compare to a real one). ✓
4. Target-id resolution path works in the *deployment* environment (real browser cookies), not just the capture session. ✓ or flagged.
