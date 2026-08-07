// ─────────────────────────────────────────────────────────────
// samplux — Firebase client
// ─────────────────────────────────────────────────────────────
// Single place where the Firestore connection is configured. Every
// other module imports { db } from here, so swapping projects is a
// one-file change.
//
// ⚠️  TEMPORARY: this currently points at the legacy "sssss-e8013"
//     Firebase project so the app runs out-of-the-box. Demo responses
//     are written under  responses/samplux_demo/entries  and are
//     isolated from any other survey by their surveyId.
//
//     TODO (before real data collection): create a dedicated
//     "samplux" Firebase project, paste its config below, and update
//     the Firestore security rules (see docs/ARCHITECTURE.md →
//     "Firebase setup"). Nothing else needs to change.
// ─────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCq05NElKm-01Xyraj6qdF31IgOLf8gQbA",
  authDomain: "sssss-e8013.firebaseapp.com",
  projectId: "sssss-e8013",
  storageBucket: "sssss-e8013.firebasestorage.app",
  messagingSenderId: "765571239773",
  appId: "1:765571239773:web:39ea76d035d314cdd4a2b4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { app, db };
