#!/usr/bin/env python3
"""Verify every script carries an ENV banner and still parses in the form it is consumed in.

scripts/ holds three incompatible execution environments behind two file extensions, so the
extension is not the signal — the banner is, and this is what keeps it honest.

The parse check is the part that earns its keep: run-code splices a file into
`await (<file>)(page)`, so a snippet labelled browser-run-code has to be a single expression.
The first run of this gate caught poll-async-export.js labelled run-code while declaring
top-level functions, which run-code would have rejected at call time with a SyntaxError that
names a line rather than the mislabel.

    python3 tests/check-env-banners.py
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "scripts")

CONSOLE, RUNCODE, LOCAL = "browser-console", "browser-run-code", "local-python"

ENV = {
    "anonymize-export.py": LOCAL,
    "capture-har.js": RUNCODE,
    "capture-on-trigger.js": RUNCODE,
    "comprehensive-search-harvest.js": CONSOLE,
    "find-fields-recursive.js": RUNCODE,
    "new-playbook.py": LOCAL,
    "poll-async-export.js": CONSOLE,
    "probe-field-levels.js": RUNCODE,
    "probe-signature-enforcement.js": RUNCODE,
    "replay-with-fresh-fields.js": RUNCODE,
    "route-intercept-capture.js": RUNCODE,
    "solve-shape-match-captcha.js": RUNCODE,
    "walk-react-fiber.js": CONSOLE,
    "walk-vue-tree.js": CONSOLE,
}


def parse_check(path, env):
    if path.endswith(".py"):
        # compile() rather than py_compile, which would litter scripts/ with __pycache__ and
        # then trip this gate's own unclassified-entry check on the next run.
        return subprocess.run(
            [sys.executable, "-c", "import sys;compile(open(sys.argv[1]).read(),sys.argv[1],'exec')", path],
            capture_output=True, text=True)
    body = open(path).read()
    # The wrapped form IS the contract for run-code; a plain module parse would pass a file
    # that run-code cannot accept, which is the exact mislabel this gate exists to catch.
    text = f"const _ = ({body});\n" if env == RUNCODE else body
    return subprocess.run(["node", "--input-type=module", "--check"], input=text, capture_output=True, text=True)


def main():
    on_disk = {f for f in os.listdir(D) if not f.startswith(".") and os.path.isfile(os.path.join(D, f))}
    fails = []

    for extra in sorted(on_disk - set(ENV)):
        fails.append(f"{extra}: present in scripts/ but not classified in this gate — add it to ENV")
    for missing in sorted(set(ENV) - on_disk):
        fails.append(f"{missing}: classified here but absent from scripts/")

    for name in sorted(ENV):
        if name not in on_disk:
            continue
        path = os.path.join(D, name)
        env = ENV[name]
        head = open(path).read().split("\n\n")[0]
        banner = next((l for l in head.split("\n") if "ENV:" in l), None)
        if not banner:
            fails.append(f"{name}: no ENV banner in the file header")
        elif env not in banner:
            fails.append(f"{name}: banner says something other than {env} — {banner[:70]}")

        r = parse_check(path, env)
        if r.returncode != 0:
            first = (r.stderr.strip().splitlines() or ["(no stderr)"])[-1][:100]
            fails.append(f"{name}: does not parse as {env} — {first}")
        else:
            print(f"ok    {name:38} {env}")

    if fails:
        print("\n" + "\n".join(f"FAIL  {f}" for f in fails))
    print(f"\n{len(ENV) - len(fails)}/{len(ENV)} clean")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
