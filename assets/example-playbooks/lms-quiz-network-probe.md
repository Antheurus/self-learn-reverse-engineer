---
name: lms-quiz-network-probe
description: Network discovery pattern for a wire-encrypted LMS response — wire vs axios decrypt, bulk compare two URLs
last_verified: 2026-06-01
playwright_session: lms-quiz-probe
browser_profile: docs/profile/playwright-cli/
extension_path: extensions/lms-quiz-probe/
ext_tier: M
---

> Sanitized example. Hostnames and paths are placeholders. It is kept here for one reason only:
> it is the smallest worked example of **"the response on the wire is encrypted, but the page's
> own axios instance hands you the decrypted object"** — the discovery pattern, not the target.

## Goal

Document which POST carries the field of interest and how to probe any such review URL with playwright-cli.

**Full contract:** `$PROJECT_REPO/docs/automation/lms-quiz-fetch-field.md`
**Probe scripts:** `$PROJECT_REPO/extensions/lms-quiz-probe/scripts/probe-quiz-*.js`

## API contracts

```yaml
api_contracts:
  - method: POST
    path_pattern: "/api/v1.4/quiz/{quizUuid}/{quizMemberUuid}"
    body: null
    wire_encrypted: true
    decrypt_via: "page $axios"
    payload_paths:
      - data.member.quiz.questions[].answers[].<field>
      - data.questions[].answers[].<field>
  - method: POST
    path_pattern: "/api/v1.4/quiz/done/{quizUuid}/{quizMemberUuid}"
    note: lastSubmittedAt only — not the field source
```

## Steps

1. **Navigate** login shell — `playwright-cli goto https://lms.kampus.example/classes` (session in `docs/profile/playwright-cli/`)
2. **Probe** — `playwright-cli run-code --filename=extensions/lms-quiz-probe/scripts/probe-quiz-network-run.js`
3. **Replay decrypt** — `probe-quiz-axios-decrypted.js` for verbatim `res.data` shape
4. **Extensify** — `sla-extensify` → `extensions/lms-quiz-probe/`

## Run log

- 2026-06-01 — network probe verified quiz-a (20 soal) + quiz-b (5 soal), OK.
