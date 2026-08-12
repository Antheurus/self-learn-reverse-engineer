#!/usr/bin/env python3
# ENV: local-python — Local python3 on your own machine — reads and writes files on disk. NOT a browser snippet.
"""Scaffold a playbook in <project>/docs/automation/<slug>.md.

Run from the project root. Creates docs/automation/ if missing, ensures .env exists and is
gitignored, then writes the stub and indexes it in the README.

    python3 new-playbook.py shopee-saldo-export \\
        --description "Export the saldo report as XLSX" \\
        --account storefront-a \\
        --credentials SHOPEE_PASSWORD_STOREFRONT_A \\
        --param days_back=8 --param output_dir=~/Downloads \\
        --network --dry-run

Frontmatter fields come from references/playbook-format.md; only name and description are
required there, and the rest are optional flags here for the same reason.
"""

import argparse
import os
import re
import sys
from datetime import date
from pathlib import Path

AUTOMATION = Path("docs/automation")
GITIGNORE_LINES = ["docs/automation/.env", "docs/profile/"]

ENV_HEADER = """\
# Credentials for docs/automation/ playbooks.
# Format: VAR_NAME=value (no quotes, no spaces around =)
# This file is gitignored — never commit secrets.
"""

README_HEADER = """\
# Automation Playbooks

Each `.md` file is a runnable playbook used by the `self-learn-automation` skill.
Run any of them by asking Claude: "run the <name> playbook".

## Available playbooks

"""

NETWORK_SECTION = """
## Network calls

(VERBATIM copy-as-`fetch()` blocks — URL, headers and body kept exactly as the browser sent
them, signing params included. A paraphrased endpoint is a guess and is rejected. Save the HAR
to `{capture}` and read it before ever re-capturing this flow.)

## Orchestration chain

| # | Call | Response field used | Feeds into |
|---|---|---|---|
| 1 |  |  |  |
"""


def slugify(raw: str) -> str:
    s = re.sub(r"[^a-z0-9-]", "", raw.lower().replace(" ", "-"))
    return re.sub(r"-{2,}", "-", s).strip("-")


def yaml_scalar(value: str) -> str:
    """Quote only when the raw form would not survive a YAML parse.

    The bash original interpolated the description unquoted, so a single colon in it
    ("Export: saldo") produced frontmatter that no parser accepts — and nothing reported it,
    because the file is only ever read by eye until something tries to parse it.
    """
    if value == "":
        return ""
    if re.search(r'[:#\[\]{}&*!|>%@`"\']|^[-?]|^\s|\s$', value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def parse_param(raw: str) -> tuple[str, str]:
    if "=" not in raw:
        raise argparse.ArgumentTypeError(f"--param expects key=value, got {raw!r}")
    key, _, val = raw.partition("=")
    key = key.strip()
    if not key:
        raise argparse.ArgumentTypeError(f"--param has an empty key: {raw!r}")
    return key, val.strip()


def split_list(values: list[str]) -> list[str]:
    """Accept both repeated flags and one comma-separated value."""
    out: list[str] = []
    for v in values:
        out.extend(p.strip() for p in v.split(",") if p.strip())
    return out


def build_frontmatter(a: argparse.Namespace, slug: str, today: str) -> str:
    lines = [f"name: {slug}", f"description: {yaml_scalar(a.description)}"]
    lines.append(f"account: {yaml_scalar(a.account)}" if a.account else "account:")

    creds = split_list(a.credentials)
    lines.append("credentials:" if creds else "credentials: []")
    lines.extend(f"  - {c}" for c in creds)

    if a.param:
        lines.append("params:")
        lines.extend(f"  {k}: {yaml_scalar(v)}" for k, v in a.param)
    else:
        lines.append("params: {}")

    requires = split_list(a.requires)
    if requires:
        lines.append("requires:")
        lines.extend(f"  - {r}" for r in requires)

    lines.append(f"last_verified: {today if a.verified else ''}".rstrip())

    if a.session:
        lines.append(f"playwright_session: {a.session}")
    if a.profile:
        lines.append(f"browser_profile: {a.profile}")

    captures = split_list(a.capture) or ([f"docs/automation/captures/{slug}.har"] if a.network else [])
    if captures:
        lines.append("capture_artifacts:")
        lines.extend(f"  - {c}" for c in captures)
    return "\n".join(lines)


def build_body(a: argparse.Namespace, slug: str, today: str) -> str:
    body = f"""
## Goal

{a.description or "(Describe what the user gets at the end — the artifact, the state change, the file path.)"}

## Steps

1. **Navigate** → `https://...`
   - wait: page loaded
2. ...

## Selectors

(Centralized list, every entry READ off a live snapshot — never written from memory. When a
role+name match misses, run probe-page.mjs rather than guessing a second time.)
- Example: `[data-testid="..."]` ({today})
"""
    if a.network:
        body += NETWORK_SECTION.format(capture=f"docs/automation/captures/{slug}.har")
    body += f"""
## Run log

- {today} — created, not yet executed
"""
    return body


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("name", help="Playbook name — describes the outcome, not the site")
    p.add_argument("-d", "--description", default="", help="One-line summary (frontmatter + README index)")
    p.add_argument("--account", default="", help="Which account this is for, when a site has several")
    p.add_argument("--credentials", action="append", default=[],
                   help="Required .env var name; repeatable or comma-separated. Stubbed into docs/automation/.env")
    p.add_argument("--param", action="append", type=parse_param, default=[],
                   help="Default runtime parameter as key=value; repeatable")
    p.add_argument("--requires", action="append", default=[],
                   help="Playbook that must run first; repeatable or comma-separated")
    p.add_argument("--session", default="", help="playwright-cli -s= session name")
    p.add_argument("--profile", default="", help="Persistent browser profile dir, project-relative")
    p.add_argument("--capture", action="append", default=[],
                   help="HAR/JSON capture artifact path; repeatable. Implied by --network")
    p.add_argument("--network", action="store_true",
                   help="Flow touches an API: adds the Network calls + Orchestration chain sections and a default capture path")
    p.add_argument("--verified", action="store_true",
                   help="Stamp last_verified with today. Only pass this once the flow has actually been driven end to end")
    p.add_argument("--force", action="store_true", help="Overwrite an existing playbook")
    p.add_argument("--dry-run", action="store_true",
                   help="Print every file that would be created or appended to, and write nothing")
    a = p.parse_args()

    slug = slugify(a.name)
    if not slug:
        print(f"error: {a.name!r} produced an empty slug after sanitizing", file=sys.stderr)
        return 1

    target = AUTOMATION / f"{slug}.md"
    if target.exists() and not a.force:
        print(f"error: {target} already exists — pass --force to overwrite", file=sys.stderr)
        return 1

    today = date.today().isoformat()
    content = f"---\n{build_frontmatter(a, slug, today)}\n---\n{build_body(a, slug, today)}"
    index_line = f"- [`{slug}`](./{slug}.md) — {a.description}"

    # Everything is decided before anything is written, so --dry-run describes the real plan
    # rather than a guess at it.
    plan: list[tuple[str, str]] = []
    if not AUTOMATION.exists():
        plan.append(("mkdir", str(AUTOMATION)))

    gitignore = Path(".gitignore")
    existing_ignores = gitignore.read_text().splitlines() if gitignore.exists() else []
    missing_ignores = [l for l in GITIGNORE_LINES if l not in existing_ignores]
    if missing_ignores:
        plan.append(("append" if gitignore.exists() else "create", f".gitignore ({', '.join(missing_ignores)})"))

    env_path = AUTOMATION / ".env"
    creds = split_list(a.credentials)
    env_existing = env_path.read_text() if env_path.exists() else ""
    new_creds = [c for c in creds if not re.search(rf"^{re.escape(c)}=", env_existing, re.M)]
    if not env_path.exists():
        plan.append(("create", f"{env_path} (chmod 600)"))
    if new_creds:
        plan.append(("append", f"{env_path} ({', '.join(new_creds)})"))

    readme = AUTOMATION / "README.md"
    readme_existing = readme.read_text() if readme.exists() else ""
    if not readme.exists():
        plan.append(("create", str(readme)))
    if index_line not in readme_existing:
        plan.append(("append", f"{readme} (index entry)"))
    plan.append(("overwrite" if target.exists() else "create", str(target)))

    if a.dry_run:
        print("dry run — nothing written\n")
        for action, what in plan:
            print(f"  {action:9} {what}")
        print(f"\n--- {target} would contain:\n")
        print(content)
        return 0

    AUTOMATION.mkdir(parents=True, exist_ok=True)
    if missing_ignores:
        with gitignore.open("a") as fh:
            if existing_ignores and not gitignore.read_text().endswith("\n"):
                fh.write("\n")
            fh.write("\n".join(missing_ignores) + "\n")

    if not env_path.exists():
        env_path.write_text(ENV_HEADER)
        # The bash original left this at the default umask, i.e. world-readable.
        os.chmod(env_path, 0o600)
    if new_creds:
        with env_path.open("a") as fh:
            fh.write("".join(f"{c}=\n" for c in new_creds))

    if not readme.exists():
        readme.write_text(README_HEADER)
    if index_line not in readme.read_text():
        with readme.open("a") as fh:
            fh.write(index_line + "\n")

    target.write_text(content)

    print(f"Created {target}")
    print("\nNext:")
    if creds:
        print(f"  1. Fill in {', '.join(creds)} in {env_path}")
    else:
        print(f"  1. Add any credentials to {env_path}")
    print(f"  2. Tell Claude: 'capture the {slug} playbook' — it will walk the steps with you")
    return 0


if __name__ == "__main__":
    sys.exit(main())
