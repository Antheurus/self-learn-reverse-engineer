#!/usr/bin/env python3
# ENV: local-python — Local python3 on your own machine — reads a .har from disk and prints a digest. NOT a browser snippet.
"""har-digest.py — read a saved HAR without opening a browser and without printing a single secret.

A HAR with embedded bodies runs to megabytes and carries every cookie and token of the session, so
it can be neither read whole into a conversation nor pasted from. This prints what a reverse-engineering
pass needs from it and nothing else: names and shapes, never values.

    python3 scripts/har-digest.py docs/automation/captures/<name>.har
    python3 scripts/har-digest.py <name>.har --host api.example.com
    python3 scripts/har-digest.py <name>.har --all          # keep documents and assets too

Sections:
  ENDPOINTS   one row per method + host + path template: hits, statuses, query keys, body keys,
              response shape. Entry indexes are listed so the verbatim call can be pulled by index.
  AUTH        which header and cookie NAMES carry credentials, and which responses set cookies.
  FLAGS       refresh/login candidates, 401/403/429s, rate-limit headers, pagination and signature
              candidates, GraphQL operation names.
  CHAIN       response fields whose value reappears in a LATER request — the raw material for the
              playbook's `## Orchestration chain` table. Paths only.

The digest locates; it does not replace the verbatim record. Every call that makes it into a playbook
is still copied literally from the entry the digest points at (references/network-flow-spec.md).
"""

import argparse
import base64
import json
import re
import sys
from collections import OrderedDict
from urllib.parse import parse_qsl, urlsplit

API_TYPES = {"xhr", "fetch", "websocket", "eventsource"}
API_MIME = re.compile(r"json|graphql|protobuf|x-www-form-urlencoded|event-stream|text/plain|xml", re.I)
ASSET = re.compile(r"\.(js|mjs|css|png|jpe?g|svg|gif|webp|avif|woff2?|ttf|ico|map|mp4|webm)(\?|$)", re.I)
CRED_NAME = re.compile(r"auth|token|csrf|xsrf|session|secret|api[-_]?key|cookie|bearer|passport|sid\b", re.I)
SIG_NAME = re.compile(r"sign|sig\b|bogus|gnarly|hmac|nonce|x-s-|sap-sec|timestamp|\bts\b|_t\b", re.I)
PAGE_NAME = re.compile(r"^(page|page_?(no|num|number|size)|per_?page|limit|offset|cursor|after|before|"
                       r"next(_?(page|cursor|token|item_cursor))?|has_?more|search_key|start|count|total)$", re.I)
REFRESH_PATH = re.compile(r"refresh|token|login|signin|sign_in|oauth|check_login|session|sso|auth", re.I)
RATE_HEADER = re.compile(r"^(retry-after|x-rate-?limit.*|ratelimit.*)$", re.I)
ID_SEGMENT = re.compile(r"^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}|[0-9a-f]{16,}|(?=.*\d)(?=.*[A-Za-z])[\w-]{20,})$", re.I)


def path_template(path):
    return "/".join("{id}" if ID_SEGMENT.match(seg) else seg for seg in path.split("/")) or "/"


def body_text(content):
    text = content.get("text") or ""
    if content.get("encoding") == "base64":
        try:
            return base64.b64decode(text).decode("utf-8", "replace")
        except ValueError:
            return ""
    return text


def parse_json(text):
    if not text or text[:1] not in "{[":
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def shape(value, depth=2):
    if isinstance(value, dict):
        if depth == 0:
            return "{…}"
        return "{" + ", ".join(f"{k}: {shape(v, depth - 1)}" for k, v in list(value.items())[:14]) + "}"
    if isinstance(value, list):
        return f"[{shape(value[0], depth - 1) if value and depth else '…'}] x{len(value)}"
    return type(value).__name__.replace("NoneType", "null")


def leaves(value, prefix="", out=None, cap=400):
    out = [] if out is None else out
    if len(out) >= cap:
        return out
    if isinstance(value, dict):
        for k, v in value.items():
            leaves(v, f"{prefix}.{k}" if prefix else k, out, cap)
    elif isinstance(value, list):
        for v in value[:3]:
            leaves(v, f"{prefix}[]", out, cap)
    elif isinstance(value, (str, int)) and not isinstance(value, bool):
        text = str(value)
        if 8 <= len(text) <= 200 and not prefix.endswith("__typename"):
            out.append((prefix, text))
    return out


def request_body_keys(post):
    if not post:
        return [], None
    text = post.get("text") or ""
    data = parse_json(text)
    if isinstance(data, dict):
        return list(data.keys()), data
    if "urlencoded" in (post.get("mimeType") or ""):
        return [k for k, _ in parse_qsl(text, keep_blank_values=True)], None
    return (["<non-JSON body>"] if text else []), None


def is_api(entry, keep_all):
    if keep_all:
        return True
    url = entry["request"]["url"]
    if ASSET.search(url):
        return False
    kind = (entry.get("_resourceType") or "").lower()
    if kind:
        return kind in API_TYPES
    mime = (entry["response"].get("content") or {}).get("mimeType") or ""
    return bool(API_MIME.search(mime)) or entry["request"]["method"] != "GET"


def main():
    ap = argparse.ArgumentParser(description="Digest a HAR into endpoints, auth surface, flags and chain hints. Prints names and shapes, never values.")
    ap.add_argument("har")
    ap.add_argument("--host", help="keep only requests whose host contains this")
    ap.add_argument("--all", action="store_true", help="keep documents and static assets too")
    ap.add_argument("--chain-max", type=int, default=30)
    a = ap.parse_args()

    with open(a.har, encoding="utf-8-sig") as f:
        entries = json.load(f).get("log", {}).get("entries", [])
    if not entries:
        sys.exit(f"{a.har}: no log.entries — not a HAR, or an empty capture")

    kept = []
    for index, entry in enumerate(entries):
        host = urlsplit(entry["request"]["url"]).netloc
        if a.host and a.host not in host:
            continue
        if is_api(entry, a.all):
            kept.append((index, entry))
    print(f"{a.har}: {len(entries)} entries, {len(kept)} kept, {len(entries) - len(kept)} dropped as assets/documents/other hosts")
    if not kept:
        sys.exit("nothing kept — retry with --all, or check --host")

    endpoints = OrderedDict()
    cred_headers, cookies_sent, cookies_set, flags = OrderedDict(), OrderedDict(), OrderedDict(), []
    parsed = []

    for index, entry in kept:
        req, res = entry["request"], entry["response"]
        parts = urlsplit(req["url"])
        key = f'{req["method"]} {parts.netloc}{path_template(parts.path)}'
        route = key
        query_keys = [k for k, _ in parse_qsl(parts.query, keep_blank_values=True)]
        body_keys, body_json = request_body_keys(req.get("postData"))
        operation = body_json.get("operationName") if isinstance(body_json, dict) else None
        if operation:
            key += f" [{operation}]"
        res_text = body_text(res.get("content") or {})
        res_json = parse_json(res_text)
        ep = endpoints.setdefault(key, {"idx": [], "status": [], "query": [], "body": [], "shape": None, "ctype": ""})
        ep["idx"].append(index)
        ep["status"].append(res.get("status"))
        ep["query"] += [k for k in query_keys if k not in ep["query"]]
        ep["body"] += [k for k in body_keys if k not in ep["body"]]
        ep["ctype"] = (req.get("postData") or {}).get("mimeType") or ep["ctype"]
        if ep["shape"] is None:
            if res_json is not None:
                ep["shape"] = shape(res_json)
            elif res_text:
                ep["shape"] = "unparseable — truncated at capture, encrypted, or not JSON"

        for h in req.get("headers", []):
            name = h["name"].lower()
            if name.startswith(":"):
                continue
            if name == "cookie":
                for pair in h["value"].split(";"):
                    cookies_sent.setdefault(pair.split("=", 1)[0].strip(), key)
            elif CRED_NAME.search(name):
                cred_headers.setdefault(name, (len(h["value"]), key))
            if SIG_NAME.search(name):
                flags.append(f"signature candidate (header) {name} on {route}")
        for h in res.get("headers", []):
            name = h["name"].lower()
            if name == "set-cookie":
                cookies_set.setdefault(h["value"].split("=", 1)[0].strip(), key)
            elif RATE_HEADER.match(name):
                flags.append(f"rate-limit header {name} on {key}")

        if res.get("status") in (401, 403, 429):
            flags.append(f'{res["status"]} at entry {index}: {key}')
        if REFRESH_PATH.search(parts.path):
            flags.append(f"refresh/login candidate: {key} (entries {index})")
        for name in query_keys + body_keys:
            if SIG_NAME.search(name):
                flags.append(f"signature candidate (param) {name} on {key}")
            if PAGE_NAME.match(name):
                flags.append(f"pagination param {name} on {key}")
        if operation:
            flags.append(f"GraphQL — one endpoint, many operations; each operation is its own contract: {route}")
        if isinstance(res_json, dict):
            for path, _ in [(p, v) for p, v in leaves(res_json, cap=4000) if PAGE_NAME.match(p.split(".")[-1])][:3]:
                flags.append(f"pagination field in response {path} on {key}")

        places = [("url", req["url"]), ("body", (req.get("postData") or {}).get("text") or "")]
        places += [(f'header {h["name"].lower()}', h["value"]) for h in req.get("headers", [])
                   if h["name"].lower() not in ("cookie", "referer", "origin") and not h["name"].startswith(":")]
        parsed.append((index, key, res_json, places))

    print("\n== ENDPOINTS ==")
    for key, ep in endpoints.items():
        statuses = ",".join(str(s) for s in sorted(set(ep["status"]), key=str))
        print(f"\n{key}\n  hits {len(ep['idx'])} | status {statuses} | entries {ep['idx'][:8]}{' …' if len(ep['idx']) > 8 else ''}")
        if ep["query"]:
            print(f"  query keys: {', '.join(ep['query'])}")
        if ep["body"]:
            print(f"  body keys ({ep['ctype'] or 'unknown type'}): {', '.join(ep['body'])}")
        if ep["shape"]:
            print(f"  response: {ep['shape'][:400]}")

    print("\n== AUTH (names only — values never printed) ==")
    for name, (length, key) in cred_headers.items():
        print(f"  header {name} ({length} chars) first seen on {key}")
    print(f"  cookies sent ({len(cookies_sent)}): {', '.join(list(cookies_sent)[:40])}" if cookies_sent else "  cookies sent: none")
    for name, key in cookies_set.items():
        print(f"  set-cookie {name} by {key}")
    if not cred_headers and not cookies_sent:
        print("  no credential-carrying header or cookie — the API is open, or the capture began after auth moved elsewhere")

    print("\n== FLAGS ==")
    for line in list(OrderedDict.fromkeys(flags)) or ["  none"]:
        print(f"  {line.strip()}")

    print("\n== CHAIN (response field → later request; paths only) ==")
    hits, seen = 0, set()
    for pos, (index, key, res_json, _) in enumerate(parsed):
        if res_json is None:
            continue
        for path, value in leaves(res_json):
            for later_index, later_key, _, places in parsed[pos + 1:]:
                pair = (key, path, later_key)
                if pair in seen or later_key == key and len(value) < 16:
                    continue
                where = next((name for name, text in places if value in text), None)
                if where:
                    seen.add(pair)
                    hits += 1
                    print(f"  [{index}] {key} :: {path}  →  [{later_index}] {later_key} :: {where}")
                    break
            if hits >= a.chain_max:
                break
        if hits >= a.chain_max:
            print(f"  … stopped at --chain-max {a.chain_max}")
            break
    if not hits:
        print("  none found — independent calls, or the linking value is transformed in between")


if __name__ == "__main__":
    main()
