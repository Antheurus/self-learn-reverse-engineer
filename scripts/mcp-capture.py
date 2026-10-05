#!/usr/bin/env python3
# ENV: local-python — Local python3 on your own machine — drives chrome-devtools-mcp over stdio and writes a .har to disk. NOT a browser snippet.
"""mcp-capture.py — pull a capture out of chrome-devtools-mcp without it passing through the conversation.

Called as an agent tool, `get_network_request` is the wrong shape for a capture twice over: it cuts
every response body at about 10,000 characters ("... <truncated>"), and it prints request headers
inline, `Cookie` included. On the user's real Chrome that is a live session in the transcript and a
body nobody can replay. This talks to the same server directly, has it write full bodies to disk, and
assembles a HAR 1.2. It prints counts and the output path, never a header or a body.

    # the user's own Chrome (Chrome 146+, remote debugging allowed in chrome://inspect)
    python3 scripts/mcp-capture.py --out docs/automation/captures/<name>.har --page seller.example.com

    # a throwaway headless Chrome, navigating first
    python3 scripts/mcp-capture.py --out /tmp/x.har --url https://example.com/jobs -- --headless --isolated

Everything after `--` goes to chrome-devtools-mcp; with nothing there it gets `--autoConnect`.
`--page` picks the open tab whose URL contains the text. The server only records requests it saw
after it attached, so a tab that was already open yields 0 entries: measured on a real Chrome, the
connection succeeded and the capture was empty. Use `--url` with `--new-tab` to load the page in a
tab of its own, which is closed afterwards and leaves the user's tabs untouched.

Chrome asks the user to allow EVERY debugging connection to their own profile, and nothing turns
that off. One run is one connection, so repeat `--url` to capture several pages on a single approval:

    python3 scripts/mcp-capture.py --out <name>.har --new-tab --url https://a.example/x --url https://a.example/y

Entries carry a `pageref` naming the page they came from, as the HAR format provides.
Read the result with `har-digest.py`, like any other HAR.
"""

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qsl, urlsplit


class Mcp:
    def __init__(self, argv, root):
        self.root = root
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.inbox = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()
        self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {"roots": {}},
                                    "clientInfo": {"name": "mcp-capture", "version": "1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def _read(self):
        for line in self.proc.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("method") == "roots/list":
                self._send({"jsonrpc": "2.0", "id": message["id"],
                            "result": {"roots": [{"uri": "file://" + self.root, "name": "captures"}]}})
            else:
                self.inbox.put(message)

    def request(self, method, params, timeout=180):
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        while True:
            message = self.inbox.get(timeout=timeout)
            if message.get("id") == self.next_id:
                return message

    def tool(self, name, arguments):
        reply = self.request("tools/call", {"name": name, "arguments": arguments})
        if "error" in reply:
            raise RuntimeError(f"{name}: {reply['error'].get('message')}")
        text = "\n".join(c.get("text", "") for c in reply["result"].get("content", []))
        if reply["result"].get("isError") or text.startswith("Error:"):
            raise RuntimeError(f"{name}: {text[:300]}")
        return text

    def close(self):
        self.proc.terminate()


def section(text, title):
    match = re.search(rf"^### {re.escape(title)}\n(.*?)(?=^### |\Z)", text, re.S | re.M)
    return match.group(1) if match else ""


def headers(block):
    out = []
    for line in block.splitlines():
        match = re.match(r"^- ([^:\s][^:]*|:[^:]+):\s?(.*)$", line)
        if match:
            out.append({"name": match.group(1), "value": match.group(2)})
    return out


def read_part(path):
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def tabs(mcp, call="list_pages", arguments=None):
    return re.findall(r"^(\d+): (.*)$", mcp.tool(call, arguments or {}), re.M)


def collect(mcp, page_id, types, parts, pageref):
    rows, seen, index, page_count = [], set(), 0, 1
    while index < page_count:
        text = mcp.tool("list_network_requests", {"pageId": page_id, "resourceTypes": types, "pageSize": 100, "pageIdx": index})
        pages = re.search(r"\(Page \d+ of (\d+)\)", text)
        page_count = int(pages.group(1)) if pages else 1
        for row in re.findall(r"^reqid=(\d+) (\S+) (\S+) \[([^\]]*)\]", text, re.M):
            if row[0] not in seen:
                seen.add(row[0])
                rows.append(row)
        index += 1

    entries, pending, truncated = [], 0, 0
    for reqid, method, url, status in rows:
        if not status.isdigit():
            pending += 1
            continue
        req_path = os.path.join(parts, f"{pageref}-{reqid}.network-request")
        res_path = os.path.join(parts, f"{pageref}-{reqid}.network-response")
        text = mcp.tool("get_network_request", {"pageId": page_id, "reqid": int(reqid),
                                                "requestFilePath": req_path, "responseFilePath": res_path})
        request_body, response_body = read_part(req_path), read_part(res_path)
        if response_body.endswith("<truncated>"):
            truncated += 1
        request_headers = headers(section(text, "Request Headers"))
        response_headers = headers(section(text, "Response Headers"))
        content_type = next((h["value"] for h in response_headers if h["name"].lower() == "content-type"), "")
        entry = {
            "pageref": pageref, "startedDateTime": "", "time": 0, "_resourceType": "fetch",
            "request": {"method": method, "url": url, "httpVersion": "", "headers": request_headers,
                        "queryString": [{"name": k, "value": v} for k, v in parse_qsl(urlsplit(url).query, keep_blank_values=True)],
                        "cookies": [], "headersSize": -1, "bodySize": len(request_body)},
            "response": {"status": int(status), "statusText": "", "httpVersion": "", "headers": response_headers,
                         "content": {"size": len(response_body), "mimeType": content_type, "text": response_body},
                         "cookies": [], "redirectURL": "", "headersSize": -1, "bodySize": len(response_body)},
            "cache": {}, "timings": {"send": 0, "wait": 0, "receive": 0},
        }
        if request_body:
            req_type = next((h["value"] for h in request_headers if h["name"].lower() == "content-type"), "application/json")
            entry["request"]["postData"] = {"mimeType": req_type, "text": request_body}
        entries.append(entry)
    return entries, pending, truncated


def main():
    argv = sys.argv[1:]
    server_args = ["--autoConnect"]
    if "--" in argv:
        cut = argv.index("--")
        argv, server_args = argv[:cut], argv[cut + 1:]
    ap = argparse.ArgumentParser(description="Capture network requests through chrome-devtools-mcp into a HAR, without printing headers or bodies.")
    ap.add_argument("--out", required=True, help="path of the .har to write")
    ap.add_argument("--page", help="pick the open tab whose URL contains this")
    ap.add_argument("--url", action="append", default=[], help="page to load; repeat it to capture several pages over ONE connection (needs --new-tab)")
    ap.add_argument("--new-tab", action="store_true", help="open each --url in a tab of its own and close it afterwards, leaving the user's tabs alone")
    ap.add_argument("--types", default="xhr,fetch", help="resource types to keep (default xhr,fetch)")
    ap.add_argument("--settle", type=float, default=6, help="seconds to wait after a page load before listing")
    ap.add_argument("--package", default="chrome-devtools-mcp@latest")
    a = ap.parse_args(argv)
    if a.new_tab and not a.url:
        sys.exit("--new-tab needs at least one --url")
    if len(a.url) > 1 and not a.new_tab:
        sys.exit("several --url need --new-tab: one tab cannot hold more than one page's requests")

    out = os.path.realpath(a.out)
    root = os.path.dirname(out)
    os.makedirs(root, exist_ok=True)
    parts = os.path.join(root, "." + os.path.basename(out) + ".parts")
    os.makedirs(parts, exist_ok=True)
    types = [t for t in a.types.split(",") if t]

    pages, entries, pending, truncated, left_open = [], [], 0, 0, 0
    mcp = Mcp(["npx", "-y", a.package, *server_args], root)
    try:
        if a.new_tab:
            before = {n for n, _ in tabs(mcp)}
            for number, url in enumerate(a.url, 1):
                known = {n for n, _ in tabs(mcp)}
                fresh = [n for n, _ in tabs(mcp, "new_page", {"url": url}) if n not in known]
                if len(fresh) != 1:
                    sys.exit(f"could not identify the new tab for {url} ({len(fresh)} candidates)")
                time.sleep(a.settle)
                pageref = f"page_{number}"
                found = collect(mcp, int(fresh[0]), types, parts, pageref)
                mcp.tool("close_page", {"pageId": int(fresh[0])})
                pages.append({"id": pageref, "title": url, "startedDateTime": "", "pageTimings": {}})
                entries += found[0]
                pending += found[1]
                truncated += found[2]
            left_open = len({n for n, _ in tabs(mcp)} - before)
        else:
            listed = tabs(mcp)
            if not listed:
                sys.exit("no open page reported by chrome-devtools-mcp")
            chosen = [n for n, rest in listed if a.page and a.page in rest] if a.page else [n for n, rest in listed if "[selected]" in rest]
            if not chosen:
                sys.exit(f"no open tab matches --page {a.page!r}; {len(listed)} tab(s) open")
            page_id = int(chosen[0])
            if a.url:
                mcp.tool("navigate_page", {"pageId": page_id, "type": "url", "url": a.url[0]})
                time.sleep(a.settle)
            pages.append({"id": "page_1", "title": a.url[0] if a.url else (a.page or "selected tab"), "startedDateTime": "", "pageTimings": {}})
            entries, pending, truncated = collect(mcp, page_id, types, parts, "page_1")
    finally:
        mcp.close()
        shutil.rmtree(parts, ignore_errors=True)

    with open(out, "w", encoding="utf-8") as f:
        json.dump({"log": {"version": "1.2", "creator": {"name": "mcp-capture", "version": "1"}, "pages": pages, "entries": entries}}, f)
    os.chmod(out, 0o600)
    print(f"{out}: {len(pages)} page(s), {len(entries)} entries, {os.path.getsize(out):,} bytes"
          f"{f', {pending} still pending and skipped' if pending else ''}"
          f"{f', {truncated} response bodies arrived truncated' if truncated else ''}"
          f"{f', {left_open} temporary tab(s) LEFT OPEN' if left_open else ''}")
    print(f"next: python3 {os.path.join(os.path.dirname(os.path.abspath(__file__)), 'har-digest.py')} {out}")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        hint = ""
        if "DevToolsActivePort" in str(error) or "Could not connect to Chrome" in str(error):
            hint = ("\nThe user's Chrome is not accepting connections: they open chrome://inspect/#remote-debugging, "
                    "allow remote debugging, and approve the prompt. Or pass `-- --headless --isolated` for a throwaway Chrome.")
        sys.exit(f"mcp-capture: {str(error).splitlines()[0]}{hint}")
