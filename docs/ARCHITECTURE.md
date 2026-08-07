# samplux — Architecture

A walkthrough of how the app is wired, for anyone extending it. Everything is
plain ES modules loaded directly by the browser — there is no build step, so
what you read in `js/` is exactly what runs.

---

## 1. Runtime overview

```
  builder.html ──▶ js/builder.js ──▶ Firestore surveys/{surveyId}  (write, admin-gated)
                          │
                          └─▶ previewSurvey() ──▶ js/surveyRunner.js  (same render pipeline, no write)

  index.html ──▶ js/main.js ──▶ js/surveyRunner.js ──▶ Firestore surveys/{surveyId}  (read, published only)
                                       │            ──▶ Firestore responses/{surveyId}/entries  (write)
                                       └─▶ js/tasks/{rt,stroop,gonogo}.js
                                              (full-screen overlay, returns result)

  stats.html       ──▶ js/stats.js       ─┐
  admin-stats.html ──▶ js/adminStats.js  ─┼─▶ js/statsCore.js ──▶ Firestore (read)
  admin.html       ──▶ js/admin.js       ─┘   (+ firebaseClient.js everywhere)
```

`js/firebaseClient.js` is imported by every data-touching module and is the only
place the Firebase project is configured.

---

## 2. The survey runner (`js/surveyRunner.js`)

The runner is a small state machine over a flat array of `items`.

**Lifecycle**

1. `loadSurveyIndex()` queries the `surveys` Firestore collection for docs
   where `published == true` (see §11 — survey definitions live in Firestore,
   authored via `builder.html`, not in static files).
2. The selected survey doc is fetched by id, passed through `resolveExtends()`
   (survey inheritance, §4 — still resolves its *base* from a static
   `surveys/*.json` file if used) and the **randomization engine** (§3).
3. Items render one at a time. Each item type has a renderer that draws into the
   `#question` / `#options` / `#controls` slots.
4. On submit, the answers + paradata (§5) are written to Firestore.

`createSurveyApp()` also exposes `previewSurvey(rawSurveyObject)`, which runs
an in-memory survey object through the exact same `resolveExtends` →
randomize → render pipeline without touching Firestore or the URL — this is
how `builder.html`'s live preview stays byte-for-byte identical to what
participants actually see, instead of a separate reimplementation.

**Item types** are dispatched by `item.type`:

| Category | Types |
|----------|-------|
| Display | `info` (sections start their prompt with `SECCIÓN`) |
| Free input | `text`, `email`, `url`, `number`, `phone`, `date`, `time` |
| Choice | `single_choice`, `multi_choice`, `likert`, `yes_no` |
| Scale | `slider`, or any custom type whose name is a key in `optionSets` |
| Cognitive task | `task_rt`, `task_stroop`, `task_gonogo` |

**`optionSets`** let you define a response scale once and attach it to many items
by using the set's name as the item `type`. The runner resolves the labels/codes
from `survey.optionSets[item.type]`.

---

## 3. Randomization engine

Controlled by `survey.settings.randomizeItems`. Order is computed once per
session (Fisher–Yates) and the **actual presented order is saved** on the
response as `presentationOrder`, so order effects remain analysable.

| Mode | Behaviour |
|------|-----------|
| `false` / absent | Fixed authoring order |
| `within_scale` | Shuffle items sharing the same `scale`; non-scale items and block positions stay fixed |
| `within_section` | Shuffle items inside each `SECCIÓN…` block; the `info` header stays pinned at the top |
| `between_scales` | Shuffle the order of whole scale blocks |
| `between_dimensions` | Shuffle the order of whole `dimension` blocks |

Tag items with `"scale": "wellbeing"` (or `"dimension": "..."`) to group them.
Section headers act as natural boundaries for `within_section`.

---

## 4. Survey inheritance (`extends` + `transforms`)

A survey can derive from another to avoid duplicating large instruments
(e.g. T1 vs T2 of a longitudinal study):

```jsonc
{
  "id": "study_t2",
  "extends": "study_t1.json",
  "transforms": [
    { "type": "removeItemIds", "ids": ["consent_pdf"] },
    { "type": "removeRutQuestions" }
  ]
}
```

Supported transforms: `removeItemIds`, `removeRutQuestions`,
`contactEmailRelocation`, `introConsentPdfReplace`. They run after the base file
is merged and before randomization.

---

## 5. Paradata

Collected in memory during the session and attached to the response on submit.
**It is not a persistent on-device store** — it lives for the duration of the
attempt and is sent with the answers. Fields written to each response document:

| Field | Meaning |
|-------|---------|
| `totalTime` | ms from first render to submit |
| `itemTimes` | ms spent per item id |
| `presentationOrder` | the (possibly randomized) order of item ids shown |
| `navBackCount` | number of "← back" navigations |
| `answerChangeCount` | total number of answer changes |
| `answerChangeEvents` | array of `{ itemId, from, to, t }` (capped) |
| `browserData` | userAgent, language, timezone, screen size, referrer |
| `createdAt` | Firestore server timestamp |

Per-item timing is what the stats pages turn into **response-time distributions**
and **speeder detection**.

---

## 6. Cognitive tasks (`js/tasks/`)

Each task exports `async run(container)` and is launched by the runner into a
full-screen overlay (`.task-overlay`) layered above the survey. The overlay sets
`overflow:hidden`, disables text selection, and centres a single stimulus so
there is **no scrolling and no stray text** mid-trial.

- `rt.js` — simple reaction time; tap when the circle turns green. Returns
  `{ trials, summary:{ mean_rt_ms, sd_rt_ms, ... } }`.
- `stroop.js` — colour–word interference; returns congruent/incongruent RTs and
  the Stroop effect.
- `gonogo.js` — response inhibition; returns hit rate, false-alarm rate, RTs.

The summary object is stored as that item's answer, so task metrics export and
chart exactly like any other variable.

`helpers.js` holds shared primitives (`sleep`, `rand`, `shuffle`, `mean`, `pct`).

---

## 7. Stats pages

`statsCore.js` is intentionally **auth-free and theme-agnostic** so both the
public and admin dashboards share one compute/render core: Firestore fetch,
distribution + histogram + summary helpers, duration/number formatters, and
dependency-free SVG/HTML chart renderers.

- **`stats.js` / `stats.html`** — public. Aggregates only: KPIs, submissions
  timeline, total response-time distribution, per-variable distributions,
  cognitive-task summaries. No individual rows, no PII.
- **`adminStats.js` / `admin-stats.html`** — Google-auth gated. Adds per-item
  timing, quantiles, speeder flags, exclusion-flag awareness, and codebook/CSV
  export.

---

## 8. Admin & exclusion flags (`js/admin.js`)

Google login gated by `ALLOWED_EMAILS`. Per survey it offers response counts and
CSV exports (raw / deduplicated / with paradata). **Case review** lets a
reviewer mark a response as excluded; that flag is written to a *separate*
collection so the response document stays untouched:

```
response_export_meta/{surveyId}/flags/{responseId}  →  { excluded: true, reason, ts }
```

Exports and stats read these flags and can drop excluded cases.

---

## 9. Firebase setup

`js/firebaseClient.js` exports `{ app, db }`, pointing at the dedicated
`samplux-lamp` project (Firestore in `southamerica-west1`). The full CLI
config is checked into the repo as IaC: `.firebaserc`, `firebase.json`,
`firestore.rules`, `firestore.indexes.json`. Deploy rule changes with
`firebase deploy --only firestore:rules`. Admin emails live in
`ALLOWED_EMAILS` in `admin.js`, `adminStats.js`, and `builder.js` — keep all
three in sync with the email list inside `firestore.rules`' `isAdmin()`.

---

## 11. Survey authoring (`builder.html` / `js/builder.js`)

Survey definitions live in Firestore (`surveys/{surveyId}` docs), authored
through `builder.html` instead of hand-edited JSON files. A survey doc has
exactly the same shape as the old static JSON files (`id` is the doc key,
plus `title`, `description`, `published`, `settings`, `optionSets`, `items`)
— nothing about the item/optionSet/randomization model from §2–§4 changed,
only *where the definition lives and how it's edited*.

**Editor layout:** three tabs per survey — **Detalles** (title, description,
published toggle, randomization mode, splash config), **Escalas** (named
`optionSets`, reusable across items via the item type dropdown), **Preguntas**
(ordered item list; each card expands into a type-driven form — the visible
fields change based on the selected item type, e.g. a `slider` gets
min/max/step, a `single_choice` gets an inline options editor or a shared-scale
picker, an `info` item gets an "es encabezado de sección" checkbox that splits
into separate title/body fields and composes the `SECCIÓN` prefix from §2 for
you instead of requiring it to be typed by hand).

**Live preview** calls `previewSurvey()` (§2) directly on the in-memory,
unsaved survey object — what you see in the preview overlay is pixel-for-pixel
what `index.html` will render once published, because it *is* the same
runner instance.

**Import from JSON:** the old `surveys/*.json` files still work as a seed
format — "Importar JSON" in the survey list reads one in, marks it
unpublished, and drops you into the editor to review before it goes live.
Existing `extends`-based surveys (§4) still resolve their base from a static
JSON file even though the *derived* survey itself now lives in Firestore —
that mechanism wasn't changed, since it isn't exposed in the builder UI yet.

**Dynamic response validation:** `firestore.rules`' `responses/{surveyId}/entries`
create rule no longer hardcodes a survey id allowlist — it checks
`exists()` + `published == true` against the matching `surveys/{surveyId}`
doc instead. A new survey works the moment it's published, with no rules
redeploy needed.

**Deliberately out of scope for now:** per-survey ownership/permissions
(`ownerId`/`adminIds`) — every admin in `ALLOWED_EMAILS` can edit every
survey. See `docs/ROADMAP.md` Phase 2.

---

## 12. Rollback

samplux is a standalone repo; the original `sssss` is untouched and remains the
ultimate fallback. The first clean release is tagged `v0.1.0`
(`git checkout v0.1.0`). Because both apps share the same engine, fixes port
across with a file copy.
