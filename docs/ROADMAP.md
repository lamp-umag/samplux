# samplux — Roadmap

Where samplux is headed: from "clean template forked per study" to the shared,
multi-tenant platform that perseg and pausa's one-off improvements should have
been landing in all along. None of this is urgent — it's a backlog to work
through opportunistically, in priority order. Written 2026-08-07.

---

## 0. Why this doc exists

perseg and pausa have been diverging from samplux independently, each picking
up fixes and features the other (and samplux) never got back:

| Capability | perseg | pausa | samplux |
|---|---|---|---|
| Own Firebase project | ✅ `perseg-8471a` | ✅ `pausa-39df2` | ❌ still on legacy `sssss-e8013` |
| `firestore.rules` committed | ✅ | ❌ (console-managed) | ❌ |
| Tabbed admin-stats dashboard + case mgmt | ✅ (origin of the pattern) | ✅ (ported from perseg) | ❌ (older layout) |
| Psychometrics compute engine (Cómputo tab) | ❌ | ✅ | ❌ |
| Extended paradata (`navBackCount`, `answerChangeCount`, events) | ? | ✅ | ✅ (already present) |
| Form authoring | hardcoded JSON | hardcoded JSON | hardcoded JSON |
| Auth model | flat `ALLOWED_EMAILS` | flat `ALLOWED_EMAILS` | flat `ALLOWED_EMAILS` |

perseg and pausa are **live studies — leave their infra exactly as it is.**
This roadmap only touches samplux. Once a capability below is generalized
here, future studies fork *from samplux*, not from whichever of perseg/pausa
happens to have the feature this month.

---

## 1. Vision

samplux becomes:
1. A **single multi-tenant Firebase project** that can host many surveys/orgs,
   not a template re-forked (and re-Firebase-projected) per study.
2. A **form builder**, not a folder of hand-edited JSON files — survey
   definitions live in Firestore, authored through an admin UI.
3. **Multi-admin with real permissions** — owner/admin/viewer roles per
   survey, not one global email allowlist.
4. Connected to a **generalized psychometrics compute engine** (the
   lamp-compute-01 job-queue pattern from pausa), extended past reliability
   into CFA/EFA/EGA/IRT.
5. Genuinely smooth on mobile — audited, not assumed.

Still zero-build, plain ES modules, GitHub Pages + Firebase — that
architecture has earned its keep and nothing here requires abandoning it.

---

## Phase 0 — Foundation: samplux's own multi-tenant Firebase project ✅ DONE (2026-08-07)

Completed. Project `samplux-lamp`, Firestore Native mode in `southamerica-west1`
(Santiago — locked in, can't be changed later), Google auth enabled,
`lamp-umag.github.io` authorized, `firestore.rules` deployed and verified
(valid `samplux_demo` submissions accepted, unknown surveyId + anonymous reads
correctly rejected — tested directly against the REST API). `.firebaserc`,
`firebase.json`, `firestore.indexes.json`, `firestore.rules` committed as IaC.
`js/firebaseClient.js` swapped off the legacy `sssss-e8013` config and live on
GitHub Pages with zero console errors.

**Not done yet, deliberately deferred:** the multi-tenant `surveys/{surveyId}`
Firestore shape (`ownerId`/`adminIds`) — that's real Phase 1 work, once the
form builder exists to actually populate it; no sense guessing the shape with
no consumer yet. **Optional hardening, not blocking:** Delete Protection and
Point-in-Time Recovery are both off on the new database by default — worth
enabling once real study data lives there.

<details>
<summary>Original step-by-step checklist (kept for reference)</summary>

### Step-by-step (console work — do this by hand, in order)

**A. Project creation**
- [ ] console.firebase.google.com → Add project → name it `samplux` (project ID
      will auto-suggest something like `samplux-xxxxx` since `samplux` itself
      is likely taken globally — that's fine, the ID is internal, nothing
      user-facing shows it).
- [ ] Decline Google Analytics for this project (not needed, and it's one less
      third-party data flow to justify under Ley 21.719 later).

**B. Firestore — ⚠️ the one truly irreversible decision in this whole phase**
- [ ] Build a database → **Firestore, Native mode** (not Datastore mode).
- [ ] **Region: pick `southamerica-west1` (Santiago) deliberately, right now.**
      Firestore location **cannot be changed later** without exporting all
      data and recreating the database from scratch. This is your one shot at
      the region decision — get it right before any real data lands in it.
      (Reminder from the compliance note below: this alone doesn't satisfy
      Ley 21.719, but it's the correct infra default and can't be fixed after
      the fact, so lock it in now regardless.)
- [ ] Start in **production mode** for security rules (locked down by
      default) — we'll deploy real rules from the repo in step D, not write
      them by hand in the console.

**C. Authentication**
- [ ] Build → Authentication → Get started → enable **Google** sign-in
      provider (this is what `admin.js`/`adminStats.js` use for admin login).
- [ ] Authentication → Settings → **Authorized domains** → add
      `lamp-umag.github.io`. Easy to forget, and without it Google sign-in
      fails with an `unauthorized-domain` error on the live site (localhost
      is usually already whitelisted by default for local testing).

**D. Web app + config**
- [ ] Project settings (gear icon) → Add app → **Web** (`</>`) → register it
      (nickname `samplux-web` or similar, no Firebase Hosting needed — hosting
      stays on GitHub Pages).
- [ ] Copy the resulting `firebaseConfig` object (`apiKey`, `authDomain`,
      `projectId`, `storageBucket`, `messagingSenderId`, `appId`).
- [ ] Paste it into `js/firebaseClient.js`, replacing the `sssss-e8013` config
      and removing the TODO comment. (This key is meant to be public — Firebase
      web API keys aren't secrets; real access control is the rules in step E.)

**E. Firestore rules + local CLI wiring (back in the repo, not the console)**
- [ ] `firebase login`, then `firebase init firestore` inside the samplux repo
      → select the new project → this generates `.firebaserc` + `firebase.json`
      → **commit these** (perseg only commits `firestore.rules`; go further
      here and check in the full CLI config as IaC, per the goal above).
- [ ] Write `firestore.rules` starting from the shape in
      `docs/ARCHITECTURE.md` §9, then add the multi-tenant piece: a top-level
      `surveys/{surveyId}` document carrying `ownerId` and `adminIds: []` —
      this is the seam Phase 1 (form builder) and Phase 2 (multi-admin) both
      hang off of. Responses stay nested per survey exactly as today
      (`responses/{surveyId}/entries`); don't restructure those yet.
- [ ] `firebase deploy --only firestore:rules` to publish.
- [ ] Leave `firestore.indexes.json` minimal/empty for now — composite indexes
      get added on demand when the CLI/console prompts for one on a failing
      query, no need to guess them upfront.

**F. Hardening (do before any real study points at this, not urgent today)**
- [ ] Consider **Firebase App Check** (reCAPTCHA v3) once this goes
      multi-tenant/production-facing — the runner's `allow create: if true`
      rule means anyone can currently write junk responses, and that gets
      riskier as more real studies rely on data quality here.
- [ ] Consider the **Blaze** (pay-as-you-go) plan over the free Spark plan if
      multiple concurrent studies are expected — Spark's quotas are easy to
      hit with several tenants; set a billing budget alert if you switch.

**G. Verify end-to-end before calling Phase 0 done**
- [ ] Submit a test response anonymously on the live site → confirm it lands
      in the new project's Firestore console.
- [ ] Sign in via the admin panel with Google → confirm stats load.
- [ ] Add real admin email(s) to `ALLOWED_EMAILS` in `js/admin.js` and
      `js/adminStats.js` (still the flat-list model for now — Phase 2 replaces
      it with real roles).
- [ ] Decide response data isolation going forward: same project, scoped by
      security rules (simplest, recommended to start) vs. physically separate
      collections/DBs per org (only revisit this if a future compliance pass
      demands stronger isolation than rules alone provide).

</details>

## Phase 1 — Form builder / configurator (keystone)

The thing you've been avoiding, and the highest-leverage piece: it's also
what makes multi-tenant real, since a Firestore-backed survey document can
carry the `ownerId`/`adminIds` fields Phase 0 needs, where a static JSON file
in the repo never could.

- [ ] Move survey definitions from `surveys/*.json` files into Firestore
      documents, editable through a new admin UI (not raw JSON editing).
- [ ] Preserve every authoring feature the current JSON format supports —
      don't regress: item types (§2 of ARCHITECTURE.md), `optionSets`,
      `randomizeItems` modes (§3), `extends`/`transforms` inheritance (§4).
      These are genuinely good primitives; the builder should be a UI over
      them, not a redesign of them.
- [ ] Migration path: keep `surveys/*.json` as an **import format** — a
      "load from JSON" button in the builder — so perseg/pausa surveys (and
      samplux's own demo) can be brought in without hand-retyping.
- [ ] Versioning/draft-vs-published state per survey, since edits will now
      happen live against a real backend instead of a git commit.

## Phase 2 — Multi-admin & permissions

Straightforward once Phase 0's `ownerId`/`adminIds` fields exist.

- [ ] Replace the flat `ALLOWED_EMAILS` set (`js/admin.js`, `js/adminStats.js`)
      with Firestore-backed roles: org-level admin, per-survey owner,
      per-survey viewer (read-only stats, no export/case-review rights).
- [ ] Firestore rules enforce role checks server-side, not just UI hiding.
- [ ] Audit trail for who excluded/flagged a case (admin.js §8 already has
      exclusion flags in a separate collection — extend that doc shape with
      `flaggedBy`).

## Phase 3 — Generalized psychometrics compute engine

Port pausa's cleanest piece of infra. `js/computeClient.js` talks to
`lamp-compute-01` (a Tailscale-exposed R backend) via a simple async job
queue: `POST /v1/jobs {job_type, payload, result_key}` → poll → cached
`GET /v1/latest/:result_key`, keyed by per-app API key. Pausa currently only
runs one `job_type` (`reliability_report` — Cronbach's alpha/omega, one job
per scale using each item's existing `scale` tag). Nothing about the design
is pausa-specific.

- [ ] Copy `computeClient.js` into samplux as-is; issue samplux its own API
      key against lamp-compute-01.
- [ ] Port the Cómputo tab UI/wiring from pausa's `adminStats.js` into
      samplux's admin-stats dashboard.
- [ ] Extend beyond `reliability_report`: CFA, EFA, network analysis (EGA),
      IRT — same job-queue pattern, new `job_type` values. This is the
      natural home for "better and more developed" psychometrics.
- [ ] Since payloads are already numeric-codes-only (no PII sent to the
      compute box), this generalizes cleanly across multiple tenants/orgs
      without a data-minimization redesign.

## Phase 4 — Mobile polish pass

Deferred until the above stabilizes the DOM/CSS structure — no point
polishing layouts about to be rebuilt for the form builder. When it's time:
audit `index.html` (survey runner) and the admin/stats pages on real
touch devices, not just responsive breakpoints in a desktop browser.

---

## Compliance note — Chile Ley 21.719

You're very likely thinking of **Ley 21.719** (new personal data protection
law); its general compliance deadline is **December 1, 2026**, not this
December — worth double-checking that's the date you had in mind.

Scope asked for here: hosting-region sanity check only (not a full
compliance pass). Short answer: **Firestore region alone does not resolve
this.** Region (e.g. `southamerica-west1`, Santiago) addresses *data
residency*, which is one input to compliance, but survey responses here are
plausibly "sensitive personal data" (health/psychological categories get
extra protection under 21.719) which triggers obligations independent of
where the bytes sit — consent basis, breach notification, data-subject
rights, and treatment-registration duties in some cases. Physically hosting
in Santiago is a reasonable, cheap step (lower latency too) but should not be
treated as the compliance answer by itself. Flagging this as a **parking-lot
item for a real legal/compliance pass before December 2026**, separate from
this technical roadmap.

---

## Explicitly parked

- **"revip"** — searched local disk, `lamp-umag`, and your personal GitHub;
  it doesn't exist anywhere. Two similarly-named repos surfaced
  (`lamp-umag/siftlux`, `heelgueta/sss` — "Smart Simple Surveys") in case the
  name comes back to you later. Dropped for now per your call.
- **Full Ley 21.719 compliance checklist** — deferred; see above.
