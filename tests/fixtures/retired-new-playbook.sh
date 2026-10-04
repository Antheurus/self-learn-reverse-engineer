#!/usr/bin/env bash
# RETIRED — do not run this, and do not restore it to scripts/.
# Frozen here as the negative control for tests/test-new-playbook.py: it interpolates the
# description into YAML frontmatter unquoted, so a description containing a colon produces
# frontmatter no parser accepts. The test drives this file to show the bug is real before
# asserting the Python replacement does not have it. A fix never shown failing beforehand is
# indistinguishable from a no-op, which is why this stays in the tree rather than in git history
# alone — history gets rewritten, and a control that silently disappears takes the proof with it.
# ENV: shell — Shell — run it directly with bash.
# Scaffold a new playbook in <project>/docs/automation/<name>.md
# Usage: ~/.claude/skills/self-learn-reverse-engineer/scripts/new-playbook.sh <playbook-name> "<one-line description>"
#
# Run from the project root. Creates docs/automation/ if missing, ensures .env exists
# and .gitignore excludes it, then writes the playbook stub.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: new-playbook.sh <playbook-name> [\"description\"]" >&2
  exit 1
fi

NAME="$1"
DESC="${2:-}"
SLUG=$(echo "$NAME" | tr '[:upper:] ' '[:lower:]-' | sed 's/[^a-z0-9-]//g; s/--*/-/g; s/^-//; s/-$//')

if [ -z "$SLUG" ]; then
  echo "error: name produced empty slug after sanitizing" >&2
  exit 1
fi

mkdir -p docs/automation

# .gitignore — make sure .env and browser profiles are excluded
if [ ! -f .gitignore ] || ! grep -q '^docs/automation/\.env$' .gitignore 2>/dev/null; then
  echo "docs/automation/.env" >> .gitignore
fi
if [ ! -f .gitignore ] || ! grep -q '^docs/profile/$' .gitignore 2>/dev/null; then
  echo "docs/profile/" >> .gitignore
fi

# .env stub
if [ ! -f docs/automation/.env ]; then
  cat > docs/automation/.env <<'EOF'
# Credentials for docs/automation/ playbooks.
# Format: VAR_NAME=value (no quotes, no spaces around =)
# This file is gitignored — never commit secrets.
#
# Example:
# SHOPEE_PASSWORD_JIERA=...
# TIKTOKSHOP_PASSWORD_MAIN=...
EOF
fi

# README index
if [ ! -f docs/automation/README.md ]; then
  cat > docs/automation/README.md <<'EOF'
# Automation Playbooks

Each `.md` file is a runnable playbook used by the `self-learn-reverse-engineer` skill.
Run any of them by asking Claude: "run the <name> playbook".

## Available playbooks

EOF
fi

# Playbook stub
TARGET="docs/automation/${SLUG}.md"
if [ -f "$TARGET" ]; then
  echo "error: $TARGET already exists" >&2
  exit 1
fi

TODAY=$(date +%Y-%m-%d)
cat > "$TARGET" <<EOF
---
name: ${SLUG}
description: ${DESC}
account:
credentials: []
params: {}
last_verified:
---

## Goal

(Describe what the user gets at the end — the artifact, the state change, the file path.)

## Steps

1. **Navigate** → \`https://...\`
   - wait: page loaded
2. ...

## Selectors

(Centralized list. Add entries as you confirm each one works.)
- Example: \`[data-testid="..."]\` (${TODAY})

## Run log

- ${TODAY} — created, not yet executed
EOF

# Append to README
echo "- [\`${SLUG}\`](./${SLUG}.md) — ${DESC}" >> docs/automation/README.md

echo "Created $TARGET"
echo ""
echo "Next:"
echo "  1. Fill in the credentials in docs/automation/.env"
echo "  2. Tell Claude: 'capture the $SLUG playbook' — it'll walk through the steps with you"
