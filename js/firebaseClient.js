// ─────────────────────────────────────────────────────────────
// samplux — Firebase client
// ─────────────────────────────────────────────────────────────
// Single place where the Firestore connection is configured. Every
// other module imports { db } from here, so swapping projects is a
// one-file change.
//
// Dedicated project: samplux-lamp (Firestore region: southamerica-west1).
// See docs/ARCHITECTURE.md → "Firebase setup" and docs/ROADMAP.md → Phase 0.
// ─────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDwnLBVq7GwRryxf_Dim_ModxGLV_Wr31A",
  authDomain: "samplux-lamp.firebaseapp.com",
  projectId: "samplux-lamp",
  storageBucket: "samplux-lamp.firebasestorage.app",
  messagingSenderId: "751865313309",
  appId: "1:751865313309:web:3c880046044df41d1e2ef4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Local development only: http://localhost:5175/?emulator=8080 points this tab at a
// Firestore emulator (`firebase emulators:start --only firestore`) instead of production.
// Remembered for the tab, so links between pages keep using it.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  const port = new URLSearchParams(location.search).get('emulator') || sessionStorage.getItem('samplux.emulator');
  if (port && /^\d+$/.test(port)) {
    sessionStorage.setItem('samplux.emulator', port);
    connectFirestoreEmulator(db, '127.0.0.1', Number(port));
    console.info(`[samplux] usando el emulador de Firestore en el puerto ${port}`);
  }
}

export { app, db };
