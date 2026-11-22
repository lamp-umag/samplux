# 🐍 samplux

**Survey Application for Modern Psychometrics — with a lightweight user experience.**

**→ https://lamp-umag.github.io/samplux/**

A mobile-first, zero-build static web app for running psychometric questionnaires and short cognitive
tasks. Participants get one question per screen; researchers get tidy data with its process context
(timings, order, changes of answer) ready for analysis.

Created by **Prof. Herman Elgueta** at **LAMP — Laboratorio Austral de Medición Psicosocial**,
Universidad de Magallanes. Contact: [lamp@umag.cl](mailto:lamp@umag.cl).

## Using it

1. Sign in at [`builder.html`](https://lamp-umag.github.io/samplux/builder.html) with a Google account **@umag.cl**.
2. Create, preview and publish a survey; share `…/encuesta.html?survey=<id>` (the old `…/?survey=<id>` links still work).
3. Follow the responses and export them in [`admin.html`](https://lamp-umag.github.io/samplux/admin.html).

Creating and editing surveys is currently enabled for `@umag.cl` accounts. Other institutions or large
applications: write to lamp@umag.cl so we can give the go-ahead and check service quotas first.

## Pages

| Page | Audience | Purpose |
|---|---|---|
| `index.html` | Everyone | Landing page: what samplux is, how to use it, who to contact. |
| `encuesta.html` | Participants | The survey runner (list of published surveys, or `?survey=<id>`). |
| `encuestador.html` | Interviewers | Face-to-face mode for tablet/desktop, works offline. |
| `encuestador-lab.html` | Interviewers / team | Lab to tune the look of interviewer mode and download a preferences zip. |
| `retirar.html` | Participants | Withdraw consent with the code from the receipt. |
| `builder.html` | Staff | Create, edit and publish surveys. |
| `admin.html` | Staff | Responses, case review, exports (paradata only with permission). |
| `super.html`, `retiros.html`, `viewer.html` | Administration | Oversight of all surveys and permissions, withdrawal requests, replay. |

## Documentation

- [`docs/ACCESS.md`](docs/ACCESS.md) — who can do what (staff, collaborators, paradata permission) and security notes.
- [`docs/EDITING-LIVE-SURVEYS.md`](docs/EDITING-LIVE-SURVEYS.md) — what editing or deleting a live survey does to its data.
- [`docs/CONSENT.md`](docs/CONSENT.md) — consent registry and withdrawal with a receipt code.
- [`docs/ENCUESTADOR.md`](docs/ENCUESTADOR.md) — interviewer mode and how to test locally.
- [`docs/ANDROID-LAB.md`](docs/ANDROID-LAB.md) — Android Lab & Field app (C++17 NDK 120Hz tasks, 400Hz IMU biomechanics & handoff verification, Oboe dBA probe, SQLite Data Mule `.zip`, tablet mode) + direct `.apk` download.
- [`docs/DATA-POLICY.md`](docs/DATA-POLICY.md) — ethical data collection, policies to write, ideas (location, sensors, data donation).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — item schema, randomization, internals. [`docs/ROADMAP.md`](docs/ROADMAP.md) — where it is headed.

## Run locally

```bash
npm start                # python3 -m http.server 5175
npm test                 # logic tests
npm run test:rules       # Firestore rules tests (starts the emulator)
```
Add `?emulator=8080` on localhost to point a tab at a local Firestore emulator (`npm run seed` creates a pilot survey).

## Deploy

Static site on **GitHub Pages** (push to `main`; `.nojekyll` keeps the `js/` modules untouched). Firestore rules:
`npx firebase-tools deploy --only firestore:rules --project samplux-lamp`. The Firebase project (`samplux-lamp`,
Santiago region) is configured in the single file `js/firebaseClient.js`.

---

## Authoring surveys

A survey is a single JSON file in `surveys/`, (legacy import format; surveys now live in Firestore and are built in `builder.html`).
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

---

## fabest link (desktop analysis)

fabest (Herman's statistics app) can mirror a survey locally and update it with new cases,
without opening a browser each time. Pairing happens once per computer:

1. In a terminal: `fabest samplux connect` (or `--local` to use `http://localhost:5175/admin.html`).
2. The admin page opens with `?fabest=<port>&code=<code>`. Log in with Google as usual and click
   **Conectar** in the box "Conectar fabest en este computador".
3. The page (`js/fabestLink.js`) sends the Firebase refresh token of that login to
   `http://127.0.0.1:<port>/pair`, where fabest is listening. fabest stores it (mode 0600). From then
   on it reads Firestore over REST as that user, under the same `firestore.rules`, and only reads.

After that, `fabest samplux list | pull <survey> | update --all` work from the terminal, and
`fabest samplux disconnect` forgets the pairing. Without the two URL parameters, `fabestLink.js`
does nothing.

---

---

## License

**Not yet decided.** Until a `LICENSE` file is added, © LAMP, Universidad de Magallanes — all rights reserved.
