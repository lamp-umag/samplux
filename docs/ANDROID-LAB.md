# App Android C++17 Lab & Field (`android/` · `downloads/samplux-lab.apk`)

Aplicación nativa Android + motor **C++17 NDK (`libsamplux_lab.so`)** para **Modo Encuestador en terreno**, **Modo Laboratorio (120 Hz + Kiosk)** y **monitoreo en Tablet / Teléfono**.

## 1. Descarga directa en Tablet o Teléfono

Sin pasar por Google Play, abre desde cualquier tablet o teléfono Android:

- **URL directa del APK:** `https://lamp-umag.github.io/samplux/downloads/samplux-lab.apk`
- O entra a `https://lamp-umag.github.io/samplux/encuestador.html` y toca **`📲 Descargar app Android (C++17 Lab & Terreno, .apk)`**.

---

## 2. Arquitectura: Cero duplicación y 100% compatible con GitHub Pages

1. **Sitio web intacto:** El directorio raíz sigue siendo estático, zero-build, servido directamente por GitHub Pages (`.nojekyll`).
2. **Empaquetado automático al compilar (`syncWebAssets`):** Al compilar el APK en [`android/app/build.gradle.kts`](../android/app/build.gradle.kts), Gradle copia automáticamente `../*.html`, `../css/`, `../js/` y `../surveys/` dentro de los assets internos del APK (ignorados por git). Nunca hay archivos HTML/JS duplicados en el repositorio.
3. **Puente seguro [`js/nativeBridge.js`](../js/nativeBridge.js):**
   - En cualquier navegador normal (GitHub Pages), `window.SampluxNative` no existe y todas las funciones devuelven `null`/`false` sin alterar nada.
   - Dentro de la app Android, `window.SampluxNative` conecta [`surveyRunner.js`](../js/surveyRunner.js), [`encuestador.js`](../js/encuestador.js), [`outbox.js`](../js/outbox.js) y [`deviceInfo.js`](../js/deviceInfo.js) con el motor C++17 NDK y la base SQLite nativa.

---

## 3. Todo lo que agregamos (Resumen técnico)

### A. Precisión temporal en Web (`js/tasks/*.js`)
Incluso en el navegador web normal (sin la app Android), mejoramos [`js/tasks/helpers.js`](../js/tasks/helpers.js), [`rt.js`](../js/tasks/rt.js), [`stroop.js`](../js/tasks/stroop.js) y [`gonogo.js`](../js/tasks/gonogo.js):
- **`nextPaint()` (VSYNC onset `t0`):** Espera al callback real de composición de cuadro (`requestAnimationFrame`) después de mostrar el estímulo en el DOM, eliminando el error de 8–33 ms de medir `performance.now()` antes del pintado.
- **`eventRtMs(event, t0)`:** Calcula el tiempo de reacción usando la marca de tiempo de entrada del kernel del sistema operativo (`PointerEvent.timeStamp`) sobre el mismo reloj monotónico.

### B. Motor C++17 NDK de Tareas Cognitivas a 60/90/120 Hz (`android/native/`)
Cuando una encuesta en la app Android llega a `task_rt`, `task_stroop` o `task_gonogo` (o cuando las lanzas desde el botón **`⚡ Test C++17`** de la barra superior):
- **Reloj de hardware en nanosegundos (`CLOCK_MONOTONIC`):**
  - Marca el inicio visual del estímulo (`vsync_present_ns`) en el callback exacto de barrido de pantalla (`Choreographer.postFrameCallback`) bloqueado a la tasa máxima del panel (`60 / 90 / 120 Hz`).
  - Marca la respuesta táctil (`touch_kernel_ns`) desde la interrupción del digitalizador táctil del kernel (`MotionEvent.eventTime`), junto con la presión (`touch_pressure`) y área de contacto.
  - Calcula tanto **`rt_ms`** (redondeado en ms, 100% compatible con `admin.html`, `statsCore.js` y `fabest`) como **`rt_hw_us`** (tiempo de reacción de hardware en **microsegundos**) y **`onset_jitter_us`** (jitter de presentación del cuadro en µs).

### C. Buffer Circular Lock-Free IMU a 400 Hz (`ImuRingBuffer` en C++17)
Un hilo nativo en C++ (`ASensorEventQueue` en [`jni_bridge.cpp`](../android/native/android/jni_bridge.cpp)) muestrea acelerómetro y giroscopio a **400 Hz** (cada 2.5 ms) en un buffer circular sin bloqueos:
1. **Fuerza de impacto táctil (`tap_impulse_g`):** Mide el pico de aceleración lineal en $g$ ($\pm 35\text{ ms}$ alrededor del toque, descontando la línea base pre-estímulo) en cada ensayo.
2. **Detector de micro-impulso inhibitorio en Go/No-Go (`nogo_microflinch_g`, `microflinch_detected`):** En los ensayos `nogo` donde la persona logra inhibirse (`correct_rejection`), analiza la ventana $[120\text{ ms}, 850\text{ ms}]$ buscando contracciones motoras sub-umbral ($\ge 0.08g$ y $\ge 3\times$ ruido basal) cuando la persona amaga tocar la pantalla y frena a tiempo.
3. **Verificación física de traspaso Anti-Curbstoning (`🤝 Entrega el dispositivo`):**
   - Cuando `encuestador.html` entra o sale de `respondentView` (ítems privados o tareas cognitivas), C++ integra la rotación angular 3D ($\int |\omega|\,dt$ en grados) y la aceleración traslacional durante la transición.
   - Guarda en `paradata.interviewer.nativeTelemetry`:
     - `handoffCount`: número de traspasos en el caso
     - `handoffVerifiedCount`: cuántos tuvieron movimiento físico real de entrega ($\text{score} \ge 0.45$)
     - `lastHandoffMotionScore` ($0.0$ = tablet quieta en la mesa / posible fraude, $1.0$ = rotación y entrega clara)
     - `lastHandoffRotationDeg`: grados rotados durante el traspaso

### D. Sonda Acústica Oboe C++ (`AmbientNoiseMeter`) y Luz Ambiental (`ambientLux`)
- Mediante **Google Oboe** en modo `LowLatency`, procesa bloques PCM en tiempo real en C++ para estimar el piso de ruido ambiental en decibeles (**`ambientDbMean`**, **`ambientDbPeak`** en dBA SPL aproximados) **sin grabar ni guardar jamás la voz o el audio ambiente**.
- Registra además la iluminancia de la sala o terreno en lux (**`ambientLux`**) mediante `ASENSOR_TYPE_LIGHT`, la tasa de refresco real de la pantalla (**`displayRefreshHz`**) y la temperatura de batería (**`batteryTempC`**) dentro de `paradata.deviceInfo.nativeEnv`.

### E. Outbox Nativo SQLite + Exportador `📦 Data Mule (.zip)` con Audios
- En [`DurableOutbox.kt`](../android/app/src/main/java/cl/umag/lamp/samplux/DurableOutbox.kt), cada caso guardado en modo encuestador (incluyendo los clips de voz decodificados a archivos `.webm`/`.m4a` reales en disco) se replica inmediatamente en SQLite nativo (`samplux_durable_outbox.db`) y en `files/outbox_backups/`.
- El botón **`📦 Data Mule (N)`** empaqueta todos los casos pendientes + las grabaciones de audio crudas en un solo archivo `.zip` (`submissions.json` + carpeta `audio/`) y abre el menú de compartir de Android (**Nearby Share / Quick Share / Wi-Fi Direct / USB / Drive**) para respaldar los datos al teléfono de supervisión en terreno sin depender de internet.

### F. Modo Tablet (Pantallas $\ge 720\text{ dp}$) vs. Teléfono
La interfaz detecta automáticamente si corre en una **Tablet** o en un **Teléfono**:
- **En Tablet:**
  - Habilita el botón **`📊 Panel Lateral C++`** en la barra superior: divide la pantalla mostrando la encuesta/carrusel a la izquierda y un **panel de telemetría C++17 en vivo (330 dp)** a la derecha (ruido dBA, lux, verificación IMU de traspasos `🤝`, cola SQLite Data Mule y lanzador rápido de tareas).
  - El **`⚡ Banco de Pruebas C++17`** se despliega en **2 columnas** (controles y sensores en vivo a la izquierda, inspector JSON de microsegundos a la derecha).
  - En **Stroop / RT / Go-NoGo**, la botonera de colores limita su ancho máximo a `680 dp` centrados para que la distancia motora entre dedos sea ergonómica y equivalente entre una tablet de 11" y un teléfono, manteniendo ángulo visual controlado.
- **Modo Kiosk (`🔒 Kiosk`):** Activa `startLockTask()` (fijación de pantalla de Android) automáticamente durante el traspaso al participante en `Modo Lab` o manualmente desde la barra superior para evitar que salgan de la encuesta.

---

## 4. Cómo compilar y correr los tests

```bash
# 1. Tests unitarios JS (incluye VSYNC nextPaint, eventRtMs y nativeBridge)
npm test

# 2. Tests unitarios C++17 en Linux (reloj µs, IMU 400Hz, micro-flinch, anti-curbstoning, Oboe dBA)
cmake -S android/native/tests -B android/native/build
cmake --build android/native/build
ctest --test-dir android/native/build --output-on-failure

# 3. Compilar el APK y actualizar downloads/samplux-lab.apk
cd android
JAVA_HOME=$HOME/.local/share/mise/installs/java/temurin-21.0.13+9.0.LTS ./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk ../downloads/samplux-lab.apk
```
