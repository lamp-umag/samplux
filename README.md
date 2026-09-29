# 🐍 samplux

**Survey Application for Modern Psychometrics — with a lightweight user experience.**

A mobile-first, zero-build static web app for running psychometric questionnaires
and short cognitive tasks, storing anonymous responses in Firebase Firestore.
Built for and by **LAMP** — *Laboratorio Austral de Medición Psicosocial*,
Universidad de Magallanes.

The surface is intentionally minimal — one question per screen, big tap targets,
no scrolling during tasks. Underneath it carries a real measurement toolkit:
a questionnaire **randomization engine**, a **paradata** layer that records how
participants interact (timing, back-navigation, answer changes), reusable
**option sets**, **survey inheritance**, and three built-in **cognitive tasks**
(Reaction Time, Stroop, Go/No-Go).

> samplux is the cleaned-up successor of the internal `sssss` prototype. Same
> engine, professional name, fresh repo. See [Relationship to `sssss`](#relationship-to-sssss--rollback).

---

## What's in the box

| Page | File | Audience | Purpose |
|------|------|----------|---------|
| **Survey runner** | `index.html` | Participants | Runs a survey one item at a time; injects cognitive tasks; writes responses to Firestore. |
| **Public stats** | `stats.html` | Anyone | Read-only aggregate dashboard — counts, completion, **total response-time distribution**, per-variable distributions, cognitive-task summaries. No individual answers, no PII. |
| **Admin** | `admin.html` | Lab (Google login) | Tabbed dashboard: response times, case review & exclusion flags, per-item timing, distributions with expandable open-ended answers, CSV / codebook / raw-JSON export. |
| **Builder** | `builder.html` | Lab (Google login) | Create/edit/publish surveys in Firestore; import `surveys/*.json`. |

All of them are plain HTML + ES modules (`admin-stats.html` now just redirects to `admin.html`). **No build step, no framework, no bundler.**

---

## Quick start

### Run locally
Any static file server works. From the project root:

```bash
python3 -m http.server 5175
# then open http://localhost:5175/
```

(There is a `.claude/launch.json` preconfigured for the same command.)

### Deploy
It's a static site — **GitHub Pages** serves it directly. Push to `main`,
enable Pages on the repo root, and the app is live at
`https://lamp-umag.github.io/samplux/`. The `.nojekyll` file is included so
Pages serves the `js/` modules untouched.

---

## Project structure

```
samplux/
├── index.html              # Survey runner (participant-facing)
├── stats.html              # Public aggregate dashboard
├── admin.html              # Admin dashboard: stats, open answers, cases, exports (Google auth)
├── admin-stats.html        # Redirect → admin.html (old links)
├── builder.html            # Survey builder (Google auth)
├── js/
│   ├── firebaseClient.js   # ⚙️  Firebase config — the ONE file to edit to swap projects
│   ├── main.js             # Boots the survey runner
│   ├── surveyRunner.js     # Survey engine: rendering, randomization, paradata, submit
│   ├── statsCore.js        # Shared, auth-free stats compute + chart rendering
│   ├── stats.js            # Public dashboard wiring
│   ├── adminStats.js       # Admin dashboard (admin.html)
│   ├── builder.js          # Survey builder
│   └── tasks/              # Cognitive tasks (full-screen overlay)
│       ├── helpers.js      #   shared: sleep, rand, shuffle, mean, pct
│       ├── rt.js           #   Simple Reaction Time
│       ├── stroop.js       #   Stroop colour–word
│       └── gonogo.js       #   Go / No-Go inhibition
├── surveys/
│   ├── index.json          # Registry: which surveys exist
│   ├── samplux_demo.json   # Demo survey (sections, scales, tasks)
│   ├── espacios-telares-1.json  # TELARES student survey (import via builder)
│   └── assets/             # Images referenced by surveys
├── docs/
│   └── ARCHITECTURE.md     # Deeper technical walkthrough
└── package.json
```

---

## Authoring surveys

A survey is a single JSON file in `surveys/`, listed in `surveys/index.json`.
The demo (`samplux_demo.json`) exercises every feature. The essentials:

```jsonc
{
  "id": "my_survey",
  "title": "My survey",
  "settings": { "randomizeItems": "within_section" },
  "optionSets": {
    "agree_5": [
      { "code": 1, "label": "Strongly disagree" },
      { "code": 5, "label": "Strongly agree" }
    ]
  },
  "items": [
    { "id": "intro", "type": "info", "prompt": "SECCIÓN 1 — Welcome\n\n..." },
    { "id": "q1", "type": "agree_5", "scale": "wellbeing", "prompt": "I feel good." },
    { "id": "task1", "type": "task_rt" }
  ]
}
```

- **Item types**: `info`, `text`, `email`, `url`, `number`, `phone`, `date`,
  `time`, `single_choice`, `multi_choice`, `ranking`, `likert`, `yes_no`, `slider`, `file`,
  plus any **custom type backed by an `optionSet`** (e.g. `agree_5` above).
- **Logic**: `followUp` ("Otro, ¿cuál?" boxes), `showIf` (conditional items),
  `maxSelect` / `exclusive` options for multi-choice, `section` labels — see
  `docs/ARCHITECTURE.md §2`.
- **Cognitive tasks**: `task_rt`, `task_stroop`, `task_gonogo` — drop one in as an
  item and it launches full-screen, then returns to the survey.
- **Sections**: an `info` item whose prompt starts with `SECCIÓN` renders as a
  section header (and acts as a boundary for `within_section` randomization).
- **`optionSets`**: define a response scale once, reuse it across many items.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full item schema and
the randomization / inheritance details.

---

## Engineering highlights

### 1. Questionnaire randomization engine
`settings.randomizeItems` controls per-respondent ordering, computed fresh each
session and **recorded in the response** (`presentationOrder`) so order effects
are analysable:

- `within_scale` — shuffle items sharing a `scale`, scale blocks stay put
- `within_section` — shuffle items inside each `SECCIÓN`, headers pinned
- `between_scales` — shuffle whole scale blocks
- `between_dimensions` — shuffle whole `dimension` blocks

### 2. Paradata layer
While a participant answers, the runner records interaction metadata in memory
and submits it alongside the answers (it is **not** a separate local database —
it travels with the response on submit):

- `totalTime` and per-item `itemTimes`
- `presentationOrder` (the randomized order actually shown)
- `navBackCount` (times they went back)
- `answerChangeEvents` / `answerChangeCount` (opinion changes, with from→to)
- `browserData` (UA, language, timezone, screen, referrer)

This is what powers the **response-time distributions** and **speeder detection**
in the stats pages.

### 3. Survey inheritance & item routing
Surveys can `extend` a base file and apply small `transforms`
(`removeItemIds`, `removeRutQuestions`, `contactEmailRelocation`,
`introConsentPdfReplace`), so longitudinal variants don't duplicate content.
The runner dispatches each item to the right renderer by `type`, including the
cognitive-task overlay path.

---

## Data model (Firestore)

```
responses/{surveyId}/entries/{entryId}      ← one document per submitted response
response_export_meta/{surveyId}/flags/{id}  ← exclusion flags set in admin case review
```

Responses are keyed by `surveyId`, so multiple surveys (and the demo) never
collide. Exclusion flags live in a **separate** collection because the response
documents themselves are typically write-once / locked.

---

## Firebase setup

`js/firebaseClient.js` is the single source of truth for the connection.

> ⚠️ **Current state:** it points at the legacy `sssss-e8013` project so the app
> runs immediately. Demo responses land under `responses/samplux_demo/entries`.
>
> **Before real data collection:** create a dedicated **`samplux`** Firebase
> project, paste its web config into `firebaseClient.js`, and set Firestore
> rules allowing public `create` on `responses/**` and admin-only access to
> `response_export_meta/**`. See `docs/ARCHITECTURE.md → Firebase setup`.

Admin pages gate on a Google-login allow-list (`ALLOWED_EMAILS` in
`adminStats.js` and `builder.js`, mirrored in `firestore.rules`).

---

## Relationship to `sssss` & rollback

samplux is a **fresh repository** — the original
[`lamp-umag/sssss`](https://github.com/lamp-umag/sssss) is left completely
untouched. That is the rollback plan:

- **Don't like samplux?** Keep using `sssss`; delete or archive `samplux`.
  Nothing in `sssss` changed.
- Within samplux, the initial release is tagged **`v0.1.0`** (`git checkout v0.1.0`
  to return to the first clean state).

The two share the same engine, so any later improvement can be ported either
direction with a simple file copy.

---

## License

**Not yet decided.** No license has been chosen for this project. Until a
`LICENSE` file is added, the default applies: © LAMP, Universidad de Magallanes —
all rights reserved. Pick and add a license before any public reuse.
