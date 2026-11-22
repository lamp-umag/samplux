package cl.umag.lamp.samplux

import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.MotionEvent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInteropFilter
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject

data class NativeTrialSpec(
    val index: Int,
    val waitMs: Int,
    val word: String,
    val inkColor: String,
    val condition: String,
    val gonogoType: String
)

private enum class Stage {
    INTRO,
    WAIT_OR_FIXATION,
    STIMULUS_ACTIVE,
    TOO_EARLY,
    ITI,
    DONE
}

private val STROOP_COLORS = mapOf(
    "rojo" to Color(0xFFEF4444),
    "azul" to Color(0xFF3B82F6),
    "verde" to Color(0xFF22C55E),
    "amarillo" to Color(0xFFEAB308)
)

/**
 * Hardware-clock 120Hz cognitive task surface backed by C++17 NDK (`NativeLabEngine`).
 *
 * - Adapts ergonomically to both phones and large tablets (`widthIn(max = 680.dp)` for response pads
 *   so thumb/finger travel distance stays standardized across 6" phones and 11" tablets).
 * - Captures exact VSYNC frame presentation timestamp via `Choreographer.postFrameCallback` (`CLOCK_MONOTONIC` ns).
 * - Captures exact kernel touch interrupt timestamp (`MotionEvent.eventTime * 1_000_000L` on `CLOCK_MONOTONIC`),
 *   plus hardware touch pressure & contact area.
 * - Samples the 400 Hz C++ IMU ring buffer on every trial for tap impulse force (G) and Go/No-Go inhibitory micro-flinches.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun NativeTaskOverlay(
    taskType: String,
    configJson: String,
    displayRefreshHz: Float,
    onCompleted: (String) -> Unit
) {
    val cfg = LocalConfiguration.current
    val isTablet = cfg.screenWidthDp >= 720

    val kindCode = when (taskType) {
        "task_stroop" -> 1
        "task_gonogo" -> 2
        else -> 0
    }
    val nTestOverride = remember(configJson) {
        try {
            JSONObject(configJson).optInt("nTest", 0)
        } catch (_: Exception) {
            0
        }
    }

    val handle = remember(taskType, configJson) {
        NativeLabEngine.nativeCreateTaskSession(kindCode, 0L, nTestOverride, displayRefreshHz)
    }

    val specs = remember(handle) {
        val arr = JSONArray(NativeLabEngine.nativeGetTaskSpecsJson(handle))
        List(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            NativeTrialSpec(
                index = o.optInt("index", i),
                waitMs = o.optInt("wait_ms", 1000),
                word = o.optString("word", ""),
                inkColor = o.optString("ink_color", ""),
                condition = o.optString("condition", ""),
                gonogoType = o.optString("gonogo_type", "go")
            )
        }
    }

    val mainHandler = remember { Handler(Looper.getMainLooper()) }
    var stage by remember { mutableStateOf(Stage.INTRO) }
    var currentIdx by remember { mutableIntStateOf(0) }
    var scheduledOnsetNs by remember { mutableLongStateOf(0L) }
    var vsyncPresentNs by remember { mutableLongStateOf(0L) }
    var trialLocked by remember { mutableStateOf(false) }
    var lastRtMs by remember { mutableIntStateOf(-1) }

    fun advanceOrFinish(nextIdx: Int) {
        mainHandler.removeCallbacksAndMessages(null)
        if (nextIdx >= specs.size) {
            stage = Stage.DONE
            val resultJson = NativeLabEngine.nativeFinishTaskSession(handle)
            onCompleted(resultJson)
        } else {
            currentIdx = nextIdx
            trialLocked = false
            vsyncPresentNs = 0L
            stage = Stage.WAIT_OR_FIXATION
            val waitMs = specs[nextIdx].waitMs.toLong()
            mainHandler.postDelayed({
                if (stage == Stage.WAIT_OR_FIXATION) {
                    scheduledOnsetNs = NativeLabEngine.nativeMonotonicNowNs()
                    stage = Stage.STIMULUS_ACTIVE
                    // Capture exact hardware VSYNC scanout timestamp on the very next frame callback
                    Choreographer.getInstance().postFrameCallback { frameTimeNanos ->
                        vsyncPresentNs = if (frameTimeNanos > 0L) frameTimeNanos else NativeLabEngine.nativeMonotonicNowNs()
                    }
                    // Timeout for trial
                    val maxRtMs = when (kindCode) {
                        1 -> 3000L
                        2 -> 1000L
                        else -> 1500L
                    }
                    mainHandler.postDelayed({
                        if (stage == Stage.STIMULUS_ACTIVE && !trialLocked) {
                            trialLocked = true
                            val onset = if (vsyncPresentNs > 0L) vsyncPresentNs else scheduledOnsetNs
                            NativeLabEngine.nativeRecordTrial(
                                handle,
                                currentIdx,
                                scheduledOnsetNs,
                                onset,
                                false,
                                0L,
                                "",
                                0f,
                                0f,
                                false
                            )
                            stage = Stage.ITI
                            mainHandler.postDelayed({ advanceOrFinish(currentIdx + 1) }, 350L)
                        }
                    }, maxRtMs)
                }
            }, waitMs)
        }
    }

    fun handleHardwareTouch(ev: MotionEvent, responseCode: String) {
        if (ev.actionMasked != MotionEvent.ACTION_DOWN) return
        val touchKernelNs = ev.eventTime * 1_000_000L
        val pressure = ev.pressure
        val area = ev.size

        if (kindCode == 0 && stage == Stage.WAIT_OR_FIXATION && !trialLocked) {
            // Early tap in Simple RT: show warning and retry same trial
            trialLocked = true
            mainHandler.removeCallbacksAndMessages(null)
            stage = Stage.TOO_EARLY
            mainHandler.postDelayed({ advanceOrFinish(currentIdx) }, 1100L)
            return
        }

        if (stage == Stage.STIMULUS_ACTIVE && !trialLocked) {
            trialLocked = true
            mainHandler.removeCallbacksAndMessages(null)
            val onset = if (vsyncPresentNs > 0L) vsyncPresentNs else scheduledOnsetNs
            val alignedTouchNs = maxOf(touchKernelNs, onset + 1_000_000L)
            lastRtMs = NativeLabEngine.nativeRecordTrial(
                handle,
                currentIdx,
                scheduledOnsetNs,
                onset,
                true,
                alignedTouchNs,
                responseCode,
                pressure,
                area,
                false
            )
            stage = Stage.ITI
            mainHandler.postDelayed({ advanceOrFinish(currentIdx + 1) }, 360L)
        }
    }

    DisposableEffect(Unit) {
        onDispose { mainHandler.removeCallbacksAndMessages(null) }
    }

    val trial = specs.getOrNull(currentIdx)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0A0A))
            .padding(if (isTablet) 32.dp else 20.dp),
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // Header bar with C++17 NDK + Refresh Rate telemetry badge
        Row(
            modifier = Modifier.fillMaxWidth().widthIn(max = 820.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "C++17 NDK · ${displayRefreshHz.toInt()} Hz VSYNC · IMU 400 Hz${if (isTablet) " · Modo Tablet" else ""}",
                color = Color(0xFF22C55E),
                fontSize = if (isTablet) 14.sp else 12.sp,
                fontWeight = FontWeight.Bold
            )
            if (stage != Stage.INTRO && specs.isNotEmpty()) {
                Text(
                    text = "Ensayo ${currentIdx + 1} / ${specs.size}",
                    color = Color(0xFF94A3B8),
                    fontSize = if (isTablet) 16.sp else 14.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }

        when (stage) {
            Stage.INTRO -> {
                Column(
                    modifier = Modifier.widthIn(max = 600.dp).padding(horizontal = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    val title = when (kindCode) {
                        1 -> "Test de Stroop (Motor C++17 Lab)"
                        2 -> "Go / No-Go (Motor C++17 Lab)"
                        else -> "Tiempo de Reacción (Motor C++17 Lab)"
                    }
                    val instructions = when (kindCode) {
                        1 -> "Toca el botón con el color de la TINTA de la palabra lo más rápido posible."
                        2 -> "Toca la pantalla cuando aparezca el círculo VERDE. No toques cuando veas la X ROJA."
                        else -> "Espera la señal y toca el círculo VERDE apenas aparezca en pantalla."
                    }
                    Text(
                        title,
                        color = Color.White,
                        fontSize = if (isTablet) 30.sp else 24.sp,
                        fontWeight = FontWeight.ExtraBold,
                        textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(16.dp))
                    Text(
                        instructions,
                        color = Color(0xFFCBD5E1),
                        fontSize = if (isTablet) 18.sp else 16.sp,
                        textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(32.dp))
                    Button(
                        onClick = { advanceOrFinish(0) },
                        colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color.Black),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Text(
                            "Iniciar (${specs.size} ensayos) →",
                            fontSize = if (isTablet) 18.sp else 16.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)
                        )
                    }
                }
            }

            else -> {
                // Main stimulus zone with direct kernel MotionEvent interceptor for RT & Go/No-Go
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .pointerInteropFilter { ev ->
                            if (kindCode == 0 || kindCode == 2) {
                                handleHardwareTouch(ev, "tap")
                                true
                            } else {
                                false
                            }
                        },
                    contentAlignment = Alignment.Center
                ) {
                    when (stage) {
                        Stage.WAIT_OR_FIXATION -> {
                            Text(
                                text = if (kindCode == 0) "Espera…" else "+",
                                color = Color(0xFF94A3B8),
                                fontSize = if (kindCode == 0) (if (isTablet) 30.sp else 24.sp) else (if (isTablet) 72.sp else 56.sp),
                                fontWeight = FontWeight.Bold
                            )
                        }

                        Stage.TOO_EARLY -> {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("¡Muy pronto!", color = Color(0xFFEF4444), fontSize = if (isTablet) 34.sp else 28.sp, fontWeight = FontWeight.ExtraBold)
                                Spacer(Modifier.height(6.dp))
                                Text("Espera el círculo verde.", color = Color(0xFF94A3B8), fontSize = if (isTablet) 18.sp else 15.sp)
                            }
                        }

                        Stage.STIMULUS_ACTIVE -> {
                            // Cap circle radius on large tablets so visual angle remains consistent
                            val maxRadiusRatio = if (isTablet) 0.17f else 0.23f
                            if (kindCode == 0) {
                                Canvas(modifier = Modifier.fillMaxSize()) {
                                    drawCircle(
                                        color = Color(0xFF22C55E),
                                        radius = size.minDimension * maxRadiusRatio,
                                        center = Offset(size.width / 2f, size.height / 2f)
                                    )
                                }
                                Text("¡TOCA!", color = Color.Black, fontSize = if (isTablet) 28.sp else 24.sp, fontWeight = FontWeight.ExtraBold)
                            } else if (kindCode == 1 && trial != null) {
                                val ink = STROOP_COLORS[trial.inkColor] ?: Color.White
                                Text(
                                    text = trial.word.uppercase(),
                                    color = ink,
                                    fontSize = if (isTablet) 72.sp else 54.sp,
                                    fontWeight = FontWeight.Black
                                )
                            } else if (kindCode == 2 && trial != null) {
                                if (trial.gonogoType == "go") {
                                    Canvas(modifier = Modifier.fillMaxSize()) {
                                        drawCircle(
                                            color = Color(0xFF22C55E),
                                            radius = size.minDimension * maxRadiusRatio,
                                            center = Offset(size.width / 2f, size.height / 2f)
                                        )
                                    }
                                } else {
                                    Text("✕", color = Color(0xFFEF4444), fontSize = if (isTablet) 112.sp else 92.sp, fontWeight = FontWeight.Black)
                                }
                            }
                        }

                        Stage.ITI, Stage.DONE -> {
                            if (lastRtMs > 0 && kindCode == 0) {
                                Text("✓", color = Color(0xFF22C55E), fontSize = 36.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                        else -> {}
                    }
                }

                // Stroop 4-color hardware-timestamped response buttons (ergonomically bounded to 680.dp on tablets)
                if (kindCode == 1) {
                    Row(
                        modifier = Modifier
                            .widthIn(max = 680.dp)
                            .fillMaxWidth()
                            .padding(bottom = if (isTablet) 20.dp else 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(if (isTablet) 16.dp else 10.dp)
                    ) {
                        listOf("rojo" to "Rojo", "azul" to "Azul", "verde" to "Verde", "amarillo" to "Amarillo").forEach { (code, label) ->
                            val btnColor = STROOP_COLORS[code] ?: Color.Gray
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .height(if (isTablet) 84.dp else 68.dp)
                                    .background(btnColor, RoundedCornerShape(14.dp))
                                    .pointerInteropFilter { ev ->
                                        handleHardwareTouch(ev, code)
                                        true
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Text(label, color = Color.Black, fontSize = if (isTablet) 19.sp else 16.sp, fontWeight = FontWeight.ExtraBold)
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(4.dp))
    }
}
