#!/usr/bin/env python3
"""Drive scripts/new-playbook.py in a throwaway project and assert what it writes.

Every case asserts in both directions where a direction exists. The YAML case additionally
runs the same input through the retired bash version, because a fix that is not shown failing
beforehand is indistinguishable from a no-op.

    python3 tests/test-new-playbook.py
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "new-playbook.py"

passed = failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"ok    {name}{'  — ' + detail if detail else ''}")
    else:
        failed += 1
        print(f"FAIL  {name}{'  — ' + detail if detail else ''}")


def run(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd,
                          capture_output=True, text=True)


def frontmatter(path: Path) -> dict:
    text = path.read_text()
    _, _, rest = text.partition("---\n")
    block, _, _ = rest.partition("\n---")
    return yaml.safe_load(block)


def project() -> Path:
    d = Path(tempfile.mkdtemp(prefix="sla-playbook-test-"))
    (d / ".gitignore").write_text("node_modules/\n")
    return d


# --- 1. minimal invocation -------------------------------------------------------------
d = project()
r = run(d, "Shopee Saldo Export")
check("minimal run exits 0", r.returncode == 0, r.stderr.strip()[:80])
pb = d / "docs/automation/shopee-saldo-export.md"
check("slugifies the name", pb.exists(), str(pb.relative_to(d)))
fm = frontmatter(pb)
check("frontmatter parses as YAML", isinstance(fm, dict))
check("name matches the filename", fm.get("name") == "shopee-saldo-export", str(fm.get("name")))
check("last_verified empty until proven", fm.get("last_verified") in (None, ""), repr(fm.get("last_verified")))
check(".env created", (d / "docs/automation/.env").exists())
mode = oct(os.stat(d / "docs/automation/.env").st_mode)[-3:]
check(".env is chmod 600, not world-readable", mode == "600", mode)
gi = (d / ".gitignore").read_text()
check("gitignore gained both lines", "docs/automation/.env" in gi and "docs/profile/" in gi)
check("pre-existing gitignore content kept", "node_modules/" in gi)
check("README indexes the playbook", "shopee-saldo-export.md" in (d / "docs/automation/README.md").read_text())
shutil.rmtree(d)

# --- 2. the YAML bug, proved in both directions ------------------------------------------
BAD = "Export: saldo report, 8 days back"
d = project()
run(d, "colon-case", "--description", BAD)
pb = d / "docs/automation/colon-case.md"
try:
    fm = frontmatter(pb)
    ok = fm.get("description") == BAD
    detail = f"description round-trips exactly: {fm.get('description')!r}"
except yaml.YAMLError as e:
    ok, detail = False, f"YAML error: {e}"
check("colon in description still parses (python)", ok, detail)

# The retired bash version, same input. Frozen in tests/fixtures rather than read from git
# history, because history can be rewritten and a control that vanishes takes the proof with it.
RETIRED = ROOT / "tests" / "fixtures" / "retired-new-playbook.sh"
if RETIRED.exists():
    d2 = project()
    sh = d2 / "old.sh"
    sh.write_text(RETIRED.read_text())
    sh.chmod(0o755)
    subprocess.run(["bash", str(sh), "colon-case", BAD], cwd=d2, capture_output=True, text=True)
    old_pb = d2 / "docs/automation/colon-case.md"
    if old_pb.exists():
        try:
            frontmatter(old_pb)
            bash_broke = False
        except yaml.YAMLError:
            bash_broke = True
        check("the bash version DID break on it (control)", bash_broke,
              "bash produced unparseable frontmatter" if bash_broke else "bash parsed fine — fix proves nothing")
    else:
        check("bash control produced a file", False, "no file written")
    shutil.rmtree(d2)
else:
    check("bash control fixture present", False, f"missing {RETIRED}")
shutil.rmtree(d)

# --- 3. full argument surface -------------------------------------------------------------
d = project()
r = run(d, "full-case", "--description", "Full surface", "--account", "storefront-a",
        "--credentials", "SHOPEE_PW,TIKTOK_PW", "--credentials", "EXTRA_PW",
        "--param", "days_back=8", "--param", "output_dir=~/Downloads",
        "--requires", "shopee-login", "--session", "sla-probe",
        "--profile", "docs/profile/playwright-cli/", "--network", "--verified")
check("full run exits 0", r.returncode == 0, r.stderr.strip()[:80])
fm = frontmatter(d / "docs/automation/full-case.md")
check("credentials merge repeated + comma flags",
      fm.get("credentials") == ["SHOPEE_PW", "TIKTOK_PW", "EXTRA_PW"], str(fm.get("credentials")))
check("params become a real mapping",
      fm.get("params") == {"days_back": 8, "output_dir": "~/Downloads"}, str(fm.get("params")))
check("requires captured", fm.get("requires") == ["shopee-login"], str(fm.get("requires")))
check("session and profile captured",
      fm.get("playwright_session") == "sla-probe" and fm.get("browser_profile") == "docs/profile/playwright-cli/")
check("--network implies a capture artifact",
      fm.get("capture_artifacts") == ["docs/automation/captures/full-case.har"], str(fm.get("capture_artifacts")))
check("--verified stamps a date", bool(fm.get("last_verified")), str(fm.get("last_verified")))
body = (d / "docs/automation/full-case.md").read_text()
check("--network adds the verbatim sections",
      "## Network calls" in body and "## Orchestration chain" in body)
env = (d / "docs/automation/.env").read_text()
check("credentials stubbed into .env", all(f"{c}=" in env for c in ("SHOPEE_PW", "TIKTOK_PW", "EXTRA_PW")))
shutil.rmtree(d)

# --- 4. dry run writes nothing --------------------------------------------------------------
d = project()
before = sorted(p.name for p in d.iterdir())
r = run(d, "dry-case", "--description", "nope", "--dry-run")
after = sorted(p.name for p in d.iterdir())
check("--dry-run exits 0", r.returncode == 0)
check("--dry-run creates no files", before == after, f"{before} -> {after}")
check("--dry-run still shows the plan and content",
      "create" in r.stdout and "name: dry-case" in r.stdout)
check("--dry-run leaves .gitignore untouched", (d / ".gitignore").read_text() == "node_modules/\n")
shutil.rmtree(d)

# --- 5. overwrite protection ----------------------------------------------------------------
d = project()
run(d, "dupe", "--description", "first")
r = run(d, "dupe", "--description", "second")
check("refuses to clobber an existing playbook", r.returncode == 1 and "already exists" in r.stderr)
check("original content survives the refusal", "first" in (d / "docs/automation/dupe.md").read_text())
r = run(d, "dupe", "--description", "second", "--force")
check("--force overwrites", r.returncode == 0 and "second" in (d / "docs/automation/dupe.md").read_text())
shutil.rmtree(d)

# --- 6. idempotence ---------------------------------------------------------------------------
d = project()
run(d, "one", "--description", "a", "--credentials", "SHARED_PW")
run(d, "two", "--description", "b", "--credentials", "SHARED_PW")
gi = (d / ".gitignore").read_text()
check("gitignore lines are not duplicated", gi.count("docs/automation/.env") == 1, gi.replace("\n", "|"))
env = (d / "docs/automation/.env").read_text()
check("a shared credential is stubbed once", env.count("SHARED_PW=") == 1, str(env.count("SHARED_PW=")))
readme = (d / "docs/automation/README.md").read_text()
check("both playbooks indexed", readme.count("](./") == 2, str(readme.count("](./")))
run(d, "one", "--description", "a", "--force")
check("re-running does not duplicate the index entry",
      (d / "docs/automation/README.md").read_text().count("(./one.md)") == 1)
shutil.rmtree(d)

# --- 7. bad input -------------------------------------------------------------------------------
d = project()
r = run(d, "!!!@@@")
check("rejects a name that slugifies to nothing", r.returncode == 1 and "empty slug" in r.stderr, r.stderr.strip()[:60])
r = run(d, "badparam", "--param", "noequals")
check("rejects --param without =", r.returncode == 2 and "key=value" in r.stderr, r.stderr.strip()[-60:])
shutil.rmtree(d)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
