# 🐍 samplux — Android Lab & Field App (C++17 NDK)

Self-contained Android application (`cl.umag.lamp.samplux`) for **Modo Encuestador**, **Modo Laboratorio (120Hz Kiosk)**, and **Superadmin / Admin Command**.

It keeps `samplux`'s zero-build web architecture 100% intact:
- At Gradle build time (`syncWebAssets` in [`app/build.gradle.kts`](app/build.gradle.kts)), the root `*.html`, `css/`, `js/`, and `surveys/` are copied into `app/src/main/assets/www/` (ignored by git, so there is zero file duplication).
- In regular browsers (GitHub Pages), `window.SampluxNative` is absent and `js/nativeBridge.js` is a no-op.
- Inside the Android app, `window.SampluxNative` connects the survey runner to the **C++17 NDK engine (`libsamplux_lab.so`)** and **SQLite Durable Outbox**.

---

## What the C++17 NDK & Android Layer Adds

1. **Sub-Millisecond Hardware-Clock Cognitive Tasks (`task_rt`, `task_stroop`, `task_gonogo`):**
   - Renders stimuli on a native Compose/Canvas overlay locked to the display's highest refresh rate (`60/90/120 Hz`).
   - Captures exact display VSYNC frame presentation timestamps (`Choreographer.postFrameCallback` on `CLOCK_MONOTONIC` in nanoseconds) and kernel touch interrupt timestamps (`MotionEvent.eventTime`).
   - Emits the exact `{ trials, summary }` JSON schema expected by `surveyRunner.js` and `statsCore.js`, enriched with `engine: "cpp17_ndk"`, `rt_hw_us` (microsecond hardware RT), `onset_jitter_us`, and `touch_pressure`.
2. **400 Hz Lock-Free IMU Ring Buffer (`native/core/samplux_lab.cpp`):**
   - **Tap Impulse Biomechanics (`tap_impulse_g`):** Peak linear acceleration spike ($g$) around each touch response.
   - **Inhibitory Micro-Flinch Detector (`nogo_microflinch_g`, `microflinch_detected`):** Captures sub-threshold motor twitches during `task_gonogo` Correct Rejections when the participant begins to move toward the glass and inhibits before touching it.
   - **Anti-Curbstoning Handoff Verification (`lastHandoffMotionScore`, `handoffVerifiedCount`):** Integrates 3D angular rotation ($\text{deg}$) and linear acceleration during `🤝 Entrega el dispositivo` in `encuestador.html` to verify the tablet physically changed hands.
3. **Oboe Low-Latency Ambient Noise Floor (`ambientDbMean`, `ambientDbPeak`) & Light (`ambientLux`):**
   - Computes real-time RMS/Peak dBA SPL noise floor on the C++ Oboe audio thread without storing or recording voice waveforms.
4. **Crash-Proof SQLite Outbox & Data Mule `.zip` Export (`DurableOutbox.kt`):**
   - Mirrors every queued response + raw `.webm`/`.m4a` audio file to native SQLite and app storage.
   - One-tap **`📦 Data Mule`** button bundles all pending responses and raw audio recordings into a single `.zip` and opens Android's share sheet (Nearby Share / Wi-Fi Direct / USB).

---

## Build & Test

### 1. Run the C++17 Core Unit Tests on Linux (No Android Emulator Required)
```bash
cmake -S android/native/tests -B android/native/build
cmake --build android/native/build
ctest --test-dir android/native/build --output-on-failure
```

### 2. Build the Android APK
```bash
cd android
./gradlew assembleDebug
# Output APK: android/app/build/outputs/apk/debug/app-debug.apk
```
