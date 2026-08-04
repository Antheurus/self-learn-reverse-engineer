---
name: lms-cleanup-duplicate-comments
description: Audit all commentable materials across a student's 8 LMS classes, find duplicate own-comments, delete the newer ones (keep oldest), verify clean
account: student-a
credentials: []                       # LMS uses Google SSO — no password needed if browser session is live
params:
  user_id: 1000001                    # the acting student's userId on the LMS (constant)
  classes:                            # all 8 classes with their classId + max sesi to audit
    - { name: APB, id: 2000001, max_sesi: 6 }
    - { name: TPO, id: 2000002, max_sesi: 6 }
    - { name: SO,  id: 2000003, max_sesi: 6 }
    - { name: AL,  id: 2000004, max_sesi: 5 }
    - { name: EST, id: 2000005, max_sesi: 6 }
    - { name: OAK, id: 2000006, max_sesi: 5 }
    - { name: MD,  id: 2000007, max_sesi: 5 }
    - { name: PNC, id: 2000008, max_sesi: 5 }
last_verified: 2026-05-21
---

> Sanitized example. Account name, user id, class ids and hostnames are placeholders — the
> technique, the endpoint shapes and the lessons are verbatim from a real run.

## Goal

For every commentable material in every class (8 classes, ~117 materials), there should be **exactly one** comment from the acting account — the oldest one. Any newer duplicates (especially the "Terima kasih pak/bu" botted comments from the bad 01:23 WIB run) get deleted via `POST /comment/delete/{id}`. End state: zero duplicates remaining.

## Why this playbook exists

A previous bulk-comment script ran without dedup checking AND with a wrong "pak/bu" salutation placeholder, creating 2-3 duplicate comments per material across all 8 classes. This playbook cleans up that mess and is the reference for any future cleanup if the same thing happens again.

The hardest discovery this captured: **the LMS's documented DELETE endpoint is a silent no-op.** The real endpoint is `POST /comment/delete/{id}` — found by intercepting `axios.post` while calling the Vue component's `removeComment()` method.

## Steps

1. **Verify browser session is live**
   - Navigate to `https://lms.kampus.example/panel/classes/` — if redirected to `/login`, click Google SSO button and wait for redirect back. Otherwise proceed.

2. **For each class** in `params.classes`, run the **audit-and-delete loop** (steps 3–7 per class):

3. **Navigate** → `https://lms.kampus.example/panel/classes/{id}/sections/`
   - wait: `store.state.section.sections[0].group.id === {id}` (verify Vuex actually loaded THIS class, not stale data from previous class)
   - Be aware: there may be queued "Anda yakin ingin menghapus komentar?" confirm dialogs from previous runs — dismiss all of them (accept: false) before doing anything else
   - There's also a "beforeunload" dialog that pops up between navigations — accept it to proceed

4. **Build the material list** from `store.state.section.sections`:
   ```javascript
   const materials = sections.flatMap(s =>
     (s.materials || [])
       .filter(m => !['Z', 'E'].includes(m.type))   // skip quizzes (Z) and exams (E) — no comment box
       .map(m => ({ sesi: s.meet, sectionId: s.id, materialId: m.id, title: m.title.slice(0,30) }))
   );
   ```

5. **Audit each material** by router-pushing to its page and reading `comp.$data.comments` from the Vue component tree (do NOT use any POST endpoint to read — there's no GET endpoint, and POST creates new comments):
   ```javascript
   // Find the comment component (depth ~9 in the Vue tree)
   const findCC = (c, d=0) => {
     if (d > 15) return null;
     if (c.$data && Array.isArray(c.$data.comments) && c.$data.comments.length > 0) return c;
     for (const ch of (c.$children || [])) { const f = findCC(ch, d+1); if (f) return f; }
     return null;
   };
   // Wait until the component's comments belong to the target material (router transitions are async)
   const waitFor = (mId, timeoutMs=8000) => new Promise(resolve => {
     const deadline = Date.now() + timeoutMs;
     const check = () => {
       const c = findCC(document.querySelector('#__nuxt').__vue__);
       if (c && c.$data.comments.some(x => x.postId === mId)) { resolve(c); return; }
       if (Date.now() > deadline) { resolve(null); return; }
       setTimeout(check, 400);
     };
     check();
   });

   const router = document.querySelector('#__nuxt').__vue__.$router;
   for (const mat of materials) {
     await router.push(`/panel/classes/${classId}/sections/${mat.sectionId}/${mat.materialId}`);
     const comp = await waitFor(mat.materialId);
     const mine = comp.$data.comments.filter(c => c.userId === params.user_id);
     if (mine.length > 1) {
       const sorted = [...mine].sort((a,b) => a.id - b.id);
       toDelete.push(...sorted.slice(1).map(c => c.id));  // keep [0], delete the rest
     }
   }
   ```

6. **Delete each duplicate** via the correct endpoint:
   ```javascript
   for (const id of toDelete) {
     const res = await axios.post(`https://api.kelasku.example/api/v1.4/comment/delete/${id}`);
     // res.data.applicationSystem.code === 0 → success
     // code === 3 ("Data tidak ditemukan") → already deleted, fine
     await new Promise(r => setTimeout(r, 70));  // gentle pacing, avoid rate-limit
   }
   ```

7. **Re-audit the class** (same loop as step 5). If `dupes > 0` remain, run delete again on the new findings (see "Pagination gotcha" below). Repeat until dupes = 0 for this class.

8. **After all 8 classes**: do one full final verification pass, navigating fresh to each class's sections page first (do NOT trust intra-loop iteration — Vuex staleness can mis-attribute materials). Report final summary.

9. **Update `attendance-semester.md`** with the cleanup timestamp and "151 comments deleted, all classes now have exactly 1 own-comment per material".

## Critical lessons embedded in this playbook

### Lesson 1: The DELETE endpoint is a lie

```javascript
// ❌ DOES NOTHING — returns 200 with code:3 "Data tidak ditemukan" but server keeps the comment
await axios.delete(`https://api.kelasku.example/api/v1.4/comment/${commentId}`);

// ✅ ACTUALLY DELETES — returns 200 with code:0
await axios.post(`https://api.kelasku.example/api/v1.4/comment/delete/${commentId}`);
```

Discovered by patching `axios.post` temporarily and triggering `comp.removeComment(commentId)` (after `window.confirm = () => true`) — then inspecting which URL the Vue method actually hits.

### Lesson 2: Pagination hides older comments

`comp.$data.comments` only loads the first page (~10 most recent). The account's older legit comment from weeks ago may be on page 2+ and invisible during the first audit. After deleting the visible duplicates, the formerly-hidden older comment surfaces — and may now form a NEW duplicate with whatever you "kept". Iterate the audit-then-delete loop per class until zero duplicates remain.

### Lesson 3: Vuex doesn't refresh atomically between classes

After `router.push('/panel/classes/X/sections/')`, `store.state.section.sections` lags. A naïve loop iterating all 8 classes back-to-back will read stale materials for the wrong class. Fix: either use full `playwright-cli goto` (page reload) between classes, OR verify `sections[0].group.id === expectedClassId` AND material count before iterating that class's materials.

### Lesson 4: Don't use `/comment/create` to read comments

This LMS has no GET endpoint for comments. `POST /comment/create/{materialId}` returns the full comment list as a side effect — but it also creates a new comment. Using it for audit is exactly how the duplicates got created in the first place. **Always read from `comp.$data.comments`** (the Vue component state) via `playwright-cli eval` or `run-code`.

### Lesson 5: Confirm dialog hygiene

If a previous session left "Anda yakin ingin menghapus komentar?" dialogs queued (from clicking delete-comment in the UI), they re-show on next navigation. Dismiss all with `playwright-cli dialog-dismiss` before any other tool call — `eval` / `run-code` fail while modal dialogs are open.

## Selectors (verified 2026-05-21)

- Vue root: `document.querySelector('#__nuxt').__vue__`
- Vuex store: `vm.$store`
- Vue router: `vm.$router`
- Axios (pre-authed): `vm.$axios`
- Comment component: found via tree-walk for `$data.comments` array — typically at depth 9, component name `comment-box`
- Sections list: `store.state.section.sections`
- My userId comparison: `comment.userId === params.user_id`

## Run log

- 2026-05-21 09:50–10:10 WIB — Full cleanup run. Deleted 151 duplicates across 8 classes (APB:21, TPO:33, SO:14, AL:34, EST:11, OAK:18, MD:11, PNC:9). First DELETE attempt with `DELETE /comment/{id}` returned 200 for all 147 but server kept everything → discovered real endpoint is `POST /comment/delete/{id}` → re-ran with correct endpoint, all succeeded. Required 3 audit-iterations to catch comments hidden behind pagination + Vuex-stale-between-classes drift. Final state: 116/116 materials with exactly 1 own-comment each.
