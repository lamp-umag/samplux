package cl.umag.lamp.samplux

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.InputStream
import java.net.URLConnection

data class ActiveNativeTask(
    val reqId: String,
    val taskType: String,
    val configJson: String,
    val standaloneBench: Boolean = false
)

class MainActivity : ComponentActivity() {

    private lateinit var outbox: DurableOutbox
    private var webViewRef: WebView? = null

    private var activeTask by mutableStateOf<ActiveNativeTask?>(null)
    private var benchResultJson by mutableStateOf<String?>(null)
    private var showCppLabBench by mutableStateOf(false)
    private var showTabletSidebar by mutableStateOf(false)
    private var currentMode by mutableStateOf("encuestador")
    private var kioskPinned by mutableStateOf(false)
    private var respondentHandoffActive by mutableStateOf(false)
    private var outboxCount by mutableIntStateOf(0)
    private var displayRefreshHz by mutableStateOf(60f)

    private val micPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) NativeLabEngine.nativeStartAudioProbe()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestHighestDisplayRefreshRate()

        outbox = DurableOutbox(this)
        outboxCount = outbox.pendingCount()

        // Start 400Hz C++ NDK IMU & ambient light sensor pump
        NativeLabEngine.nativeStartSensors()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            NativeLabEngine.nativeStartAudioProbe()
        } else {
            micPermLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }

        setContent {
            val cfg = LocalConfiguration.current
            val isTablet = cfg.screenWidthDp >= 720

            // Live 1Hz telemetry ticker for tablet side-monitor & C++ bench
            var liveEnvJson by remember { mutableStateOf("{}") }
            var liveHandoffJson by remember { mutableStateOf("{}") }
            LaunchedEffect(showCppLabBench, showTabletSidebar, isTablet) {
                while (showCppLabBench || (isTablet && showTabletSidebar)) {
                    val (batPct, batTemp) = readBatteryStats()
                    liveEnvJson = NativeLabEngine.nativeGetEnvironmentSnapshotJson(displayRefreshHz, batPct, batTemp)
                    liveHandoffJson = NativeLabEngine.nativeGetInterviewerTelemetryJson()
                    outboxCount = outbox.pendingCount()
                    delay(1000L)
                }
            }

            Column(modifier = Modifier.fillMaxSize().background(Color.Black)) {
                // Hidden during respondent handoff (🤝) so the participant only sees the locked survey/task
                if (!respondentHandoffActive) {
                    TopCommandBar(
                        currentMode = currentMode,
                        isTablet = isTablet,
                        showCppLabBench = showCppLabBench,
                        showTabletSidebar = showTabletSidebar,
                        kioskPinned = kioskPinned,
                        outboxCount = outboxCount,
                        refreshHz = displayRefreshHz,
                        onSelectPage = { mode, page ->
                            showCppLabBench = false
                            currentMode = mode
                            loadBundledPage(page)
                        },
                        onOpenCppBench = {
                            showCppLabBench = !showCppLabBench
                        },
                        onToggleTabletSidebar = {
                            showTabletSidebar = !showTabletSidebar
                        },
                        onOpenExternalUrl = { url ->
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        },
                        onToggleKiosk = { toggleKioskLock(!kioskPinned) },
                        onExportMuleZip = { outbox.exportAndShareMuleZip() }
                    )
                }

                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    Row(modifier = Modifier.fillMaxSize()) {
                        Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                            AndroidView(
                                modifier = Modifier.fillMaxSize(),
                                factory = { ctx -> createConfiguredWebView(ctx) }
                            )
                        }

                        // Tablet Split-Screen Live Telemetry Dock (takes advantage of 10-12" tablet width!)
                        if (isTablet && showTabletSidebar && !respondentHandoffActive && !showCppLabBench) {
                            TabletTelemetrySidebar(
                                refreshHz = displayRefreshHz,
                                outboxCount = outboxCount,
                                envJson = liveEnvJson,
                                handoffJson = liveHandoffJson,
                                lastTaskJson = benchResultJson,
                                onRunQuickTask = { type, n ->
                                    activeTask = ActiveNativeTask("bench", type, "{\"nTest\":$n}", standaloneBench = true)
                                },
                                onExportMuleZip = { outbox.exportAndShareMuleZip() }
                            )
                        }
                    }

                    if (showCppLabBench && activeTask == null) {
                        CppLabBenchPanel(
                            isTablet = isTablet,
                            refreshHz = displayRefreshHz,
                            envJson = liveEnvJson,
                            handoffJson = liveHandoffJson,
                            lastTaskJson = benchResultJson,
                            onRunTask = { type, nTrials ->
                                activeTask = ActiveNativeTask(
                                    reqId = "bench",
                                    taskType = type,
                                    configJson = "{\"nTest\":$nTrials}",
                                    standaloneBench = true
                                )
                            },
                            onTestHandoffStart = { NativeLabEngine.nativeNotifyHandoffState(true) },
                            onTestHandoffEnd = {
                                NativeLabEngine.nativeNotifyHandoffState(false)
                                benchResultJson = NativeLabEngine.nativeGetInterviewerTelemetryJson()
                            },
                            onClose = { showCppLabBench = false }
                        )
                    }

                    // C++17 NDK 120Hz hardware-clock overlay when a cognitive task (`task_*`) launches
                    activeTask?.let { task ->
                        NativeTaskOverlay(
                            taskType = task.taskType,
                            configJson = task.configJson,
                            displayRefreshHz = displayRefreshHz,
                            onCompleted = { resultJson ->
                                val pretty = try {
                                    JSONObject(resultJson).toString(2)
                                } catch (_: Exception) {
                                    resultJson
                                }
                                benchResultJson = pretty
                                if (!task.standaloneBench) {
                                    deliverTaskResultToJs(task.reqId, resultJson)
                                }
                                activeTask = null
                            }
                        )
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        NativeLabEngine.nativeStopSensors()
        super.onDestroy()
    }

    private fun requestHighestDisplayRefreshRate() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val disp = display ?: windowManager.defaultDisplay
                val bestMode = disp.supportedModes.maxByOrNull { it.refreshRate }
                if (bestMode != null) {
                    val lp = window.attributes
                    lp.preferredDisplayModeId = bestMode.modeId
                    window.attributes = lp
                    displayRefreshHz = bestMode.refreshRate
                }
            } else {
                @Suppress("DEPRECATION")
                displayRefreshHz = windowManager.defaultDisplay.refreshRate
            }
        } catch (_: Exception) {
            displayRefreshHz = 60f
        }
    }

    private fun toggleKioskLock(enable: Boolean) {
        try {
            if (enable && !isInLockTaskMode()) {
                startLockTask()
                kioskPinned = true
            } else if (!enable && isInLockTaskMode()) {
                stopLockTask()
                kioskPinned = false
            }
        } catch (_: Exception) {}
    }

    private fun isInLockTaskMode(): Boolean {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    private fun loadBundledPage(page: String) {
        webViewRef?.loadUrl("https://appassets.androidplatform.net/$page")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createConfiguredWebView(ctx: Context): WebView {
        return WebView(ctx).apply {
            webViewRef = this
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                cacheMode = WebSettings.LOAD_DEFAULT
            }

            addJavascriptInterface(SampluxJsBridge(), "SampluxNative")

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread { request.grant(request.resources) }
                }
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    val url = request.url
                    // Serve bundled zero-build web assets from https://appassets.androidplatform.net/*
                    if (url.host == "appassets.androidplatform.net") {
                        val relPath = (url.path ?: "/").removePrefix("/").ifEmpty { "encuestador.html" }
                        return serveAsset("www/$relPath")
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }

            loadUrl("https://appassets.androidplatform.net/encuestador.html")
        }
    }

    private fun serveAsset(assetPath: String): WebResourceResponse? {
        return try {
            val clean = assetPath.substringBefore('?').substringBefore('#')
            val stream: InputStream = assets.open(clean)
            val mime = when {
                clean.endsWith(".html") -> "text/html"
                clean.endsWith(".js") || clean.endsWith(".mjs") -> "text/javascript"
                clean.endsWith(".css") -> "text/css"
                clean.endsWith(".json") -> "application/json"
                clean.endsWith(".svg") -> "image/svg+xml"
                else -> URLConnection.guessContentTypeFromName(clean) ?: "application/octet-stream"
            }
            val headers = mapOf(
                "Access-Control-Allow-Origin" to "*",
                "Cache-Control" to "no-cache"
            )
            WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream)
        } catch (_: Exception) {
            null
        }
    }

    private fun deliverTaskResultToJs(reqId: String, resultJson: String) {
        val escapedReq = JSONObject.quote(reqId)
        val script = """
            (function() {
              var cbs = window.__sampluxTaskCallbacks;
              if (cbs && cbs[$escapedReq]) {
                var cb = cbs[$escapedReq];
                delete cbs[$escapedReq];
                cb.resolve($resultJson);
              }
            })();
        """.trimIndent()
        webViewRef?.evaluateJavascript(script, null)
    }

    private fun readBatteryStats(): Pair<Int, Float> {
        return try {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val pct = if (level >= 0 && scale > 0) (level * 100) / scale else -1
            val tempTenths = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
            val tempC = if (tempTenths > 0) tempTenths / 10f else -1f
            pct to tempC
        } catch (_: Exception) {
            -1 to -1f
        }
    }

    /**
     * Injected into the WebView as `window.SampluxNative` (consumed by `js/nativeBridge.js`).
     */
    inner class SampluxJsBridge {

        @JavascriptInterface
        fun startNativeTask(reqId: String, taskType: String, configJson: String) {
            runOnUiThread {
                activeTask = ActiveNativeTask(reqId, taskType, configJson, standaloneBench = false)
            }
        }

        @JavascriptInterface
        fun setRespondentHandoff(active: Boolean, itemId: String) {
            // Notify C++ 400Hz IMU anti-curbstoning handoff analyzer
            NativeLabEngine.nativeNotifyHandoffState(active)
            runOnUiThread {
                respondentHandoffActive = active
                // In Lab mode or when handing device to respondent, pin screen to prevent leaving the app
                if (active && currentMode == "lab" && !kioskPinned) {
                    toggleKioskLock(true)
                }
            }
        }

        @JavascriptInterface
        fun getInterviewerTelemetryJson(): String {
            return NativeLabEngine.nativeGetInterviewerTelemetryJson()
        }

        @JavascriptInterface
        fun getEnvironmentSnapshotJson(): String {
            val (batPct, batTempC) = readBatteryStats()
            return NativeLabEngine.nativeGetEnvironmentSnapshotJson(displayRefreshHz, batPct, batTempC)
        }

        @JavascriptInterface
        fun mirrorOutboxEnqueueJson(rawJson: String) {
            try {
                outbox.enqueueFromJson(rawJson)
                runOnUiThread { outboxCount = outbox.pendingCount() }
            } catch (_: Exception) {}
        }

        @JavascriptInterface
        fun mirrorOutboxRemove(responseId: String) {
            try {
                outbox.markSynced(responseId)
                runOnUiThread { outboxCount = outbox.pendingCount() }
            } catch (_: Exception) {}
        }
    }
}

@androidx.compose.runtime.Composable
private fun TopCommandBar(
    currentMode: String,
    isTablet: Boolean,
    showCppLabBench: Boolean,
    showTabletSidebar: Boolean,
    kioskPinned: Boolean,
    outboxCount: Int,
    refreshHz: Float,
    onSelectPage: (mode: String, page: String) -> Unit,
    onOpenCppBench: () -> Unit,
    onToggleTabletSidebar: () -> Unit,
    onOpenExternalUrl: (String) -> Unit,
    onToggleKiosk: () -> Unit,
    onExportMuleZip: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF111111))
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = if (isTablet) 16.dp else 10.dp, vertical = if (isTablet) 8.dp else 6.dp),
        horizontalArrangement = Arrangement.spacedBy(if (isTablet) 10.dp else 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = if (isTablet) "🐍 samplux Lab · Tablet" else "🐍 samplux",
            color = Color.White,
            fontSize = if (isTablet) 14.sp else 13.sp,
            fontWeight = FontWeight.ExtraBold
        )

        ModePill("Encuestador", currentMode == "encuestador" && !showCppLabBench) {
            onSelectPage("encuestador", "encuestador.html")
        }
        ModePill("Modo Lab (${refreshHz.toInt()}Hz)", currentMode == "lab" && !showCppLabBench) {
            onSelectPage("lab", "encuestador.html")
        }
        ModePill("⚡ Test C++17", showCppLabBench) {
            onOpenCppBench()
        }
        if (isTablet) {
            ModePill("📊 Panel Lateral C++", showTabletSidebar) {
                onToggleTabletSidebar()
            }
        }
        ModePill("Ajuste Tarjetas", currentMode == "lab-ui" && !showCppLabBench) {
            onSelectPage("lab-ui", "encuestador-lab.html")
        }
        ModePill(
            label = if (kioskPinned) "🔒 Kiosk ON" else "🔓 Kiosk",
            active = kioskPinned,
            onClick = onToggleKiosk
        )
        ModePill(
            label = "📦 Data Mule ($outboxCount)",
            active = outboxCount > 0,
            onClick = onExportMuleZip
        )
        ModePill("Admin ↗", false) {
            onOpenExternalUrl("https://lamp-umag.github.io/samplux/admin.html")
        }
        ModePill("Super ↗", false) {
            onOpenExternalUrl("https://lamp-umag.github.io/samplux/super.html")
        }
    }
}

/**
 * Side-by-side live C++17 NDK telemetry dock for Tablets (>= 720dp width).
 * Lets an interviewer or lab researcher monitor ambient noise (dBA), light (lux),
 * 400Hz IMU handoff verification, and SQLite outbox while running the survey on the left!
 */
@androidx.compose.runtime.Composable
private fun TabletTelemetrySidebar(
    refreshHz: Float,
    outboxCount: Int,
    envJson: String,
    handoffJson: String,
    lastTaskJson: String?,
    onRunQuickTask: (String, Int) -> Unit,
    onExportMuleZip: () -> Unit
) {
    Column(
        modifier = Modifier
            .width(330.dp)
            .fillMaxHeight()
            .background(Color(0xFF121212))
            .verticalScroll(rememberScrollState())
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(
            "📊 Monitor C++17 NDK (Tablet)",
            color = Color.White,
            fontSize = 15.sp,
            fontWeight = FontWeight.ExtraBold
        )
        Text(
            "VSYNC ${refreshHz.toInt()} Hz · IMU 400 Hz · Oboe dBA · SQLite Outbox ($outboxCount)",
            color = Color(0xFF22C55E),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold
        )

        Text("Sensores Ambientales & Hardware:", color = Color(0xFF94A3B8), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Text(
            text = envJson,
            color = Color(0xFFE2E8F0),
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF1C1C1C), RoundedCornerShape(8.dp))
                .padding(8.dp)
        )

        Text("Traspaso IMU (🤝 Anti-Curbstoning):", color = Color(0xFF94A3B8), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Text(
            text = handoffJson,
            color = Color(0xFFE2E8F0),
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF1C1C1C), RoundedCornerShape(8.dp))
                .padding(8.dp)
        )

        Text("Lanzar tarea C++17 rápida:", color = Color(0xFF94A3B8), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
            Button(
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFF59E0B), contentColor = Color.Black),
                onClick = { onRunQuickTask("task_rt", 5) }
            ) { Text("RT", fontSize = 11.sp, fontWeight = FontWeight.Bold) }
            Button(
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF6366F1), contentColor = Color.White),
                onClick = { onRunQuickTask("task_stroop", 6) }
            ) { Text("Stroop", fontSize = 11.sp, fontWeight = FontWeight.Bold) }
            Button(
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF22C55E), contentColor = Color.Black),
                onClick = { onRunQuickTask("task_gonogo", 8) }
            ) { Text("GoNoGo", fontSize = 11.sp, fontWeight = FontWeight.Bold) }
        }

        Button(
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF262626), contentColor = Color.White),
            onClick = onExportMuleZip
        ) {
            Text("📦 Exportar Data Mule (.zip + audios)", fontSize = 12.sp)
        }

        if (lastTaskJson != null) {
            Text("Última Tarea C++17 (µs):", color = Color(0xFFF59E0B), fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text(
                text = lastTaskJson,
                color = Color(0xFF38BDF8),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF1C1C1C), RoundedCornerShape(8.dp))
                    .padding(8.dp)
            )
        }
    }
}

@androidx.compose.runtime.Composable
private fun CppLabBenchPanel(
    isTablet: Boolean,
    refreshHz: Float,
    envJson: String,
    handoffJson: String,
    lastTaskJson: String?,
    onRunTask: (String, Int) -> Unit,
    onTestHandoffStart: () -> Unit,
    onTestHandoffEnd: () -> Unit,
    onClose: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0A0A))
            .verticalScroll(rememberScrollState())
            .padding(if (isTablet) 28.dp else 20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "⚡ Banco de Pruebas C++17 NDK (${refreshHz.toInt()} Hz${if (isTablet) " · Vista Tablet 2 Columnas" else ""})",
                color = Color.White,
                fontSize = if (isTablet) 22.sp else 19.sp,
                fontWeight = FontWeight.ExtraBold
            )
            Button(
                onClick = onClose,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF262626), contentColor = Color.White)
            ) {
                Text("Volver a encuesta")
            }
        }

        if (isTablet) {
            // 2-Column spacious layout for Tablet screens
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
                verticalAlignment = Alignment.Top
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    BenchControlsSection(
                        envJson = envJson,
                        handoffJson = handoffJson,
                        onRunTask = onRunTask,
                        onTestHandoffStart = onTestHandoffStart,
                        onTestHandoffEnd = onTestHandoffEnd
                    )
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Text(
                        "Resultado C++17 (`rt_hw_us`, `onset_jitter_us`, `tap_impulse_g`, `nogo_microflinch_g`):",
                        color = Color(0xFFF59E0B),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = lastTaskJson ?: "Ejecuta una tarea a la izquierda para inspeccionar los tiempos de hardware en microsegundos y la biomecánica IMU a 400 Hz.",
                        color = if (lastTaskJson != null) Color(0xFF38BDF8) else Color(0xFF64748B),
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF171717), RoundedCornerShape(10.dp))
                            .padding(14.dp)
                    )
                }
            }
        } else {
            // Phone single-column layout
            BenchControlsSection(
                envJson = envJson,
                handoffJson = handoffJson,
                onRunTask = onRunTask,
                onTestHandoffStart = onTestHandoffStart,
                onTestHandoffEnd = onTestHandoffEnd
            )
            if (lastTaskJson != null) {
                Text(
                    "Último resultado C++17 (`rt_hw_us`, `onset_jitter_us`, `tap_impulse_g`, `nogo_microflinch_g`):",
                    color = Color(0xFFF59E0B),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = lastTaskJson,
                    color = Color(0xFF38BDF8),
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF171717), RoundedCornerShape(8.dp))
                        .padding(10.dp)
                )
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

@androidx.compose.runtime.Composable
private fun BenchControlsSection(
    envJson: String,
    handoffJson: String,
    onRunTask: (String, Int) -> Unit,
    onTestHandoffStart: () -> Unit,
    onTestHandoffEnd: () -> Unit
) {
    Text(
        "Prueba directamente las tareas cognitivas en C++17 (VSYNC CLOCK_MONOTONIC + kernel touch interrupt + IMU 400 Hz + Oboe dBA) sin necesidad de abrir una encuesta completa.",
        color = Color(0xFF94A3B8),
        fontSize = 13.sp
    )

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Button(
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFF59E0B), contentColor = Color.Black),
            onClick = { onRunTask("task_rt", 5) }
        ) {
            Text("⚡ RT (5)", fontWeight = FontWeight.Bold)
        }
        Button(
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF6366F1), contentColor = Color.White),
            onClick = { onRunTask("task_stroop", 8) }
        ) {
            Text("🎨 Stroop (8)", fontWeight = FontWeight.Bold)
        }
        Button(
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF22C55E), contentColor = Color.Black),
            onClick = { onRunTask("task_gonogo", 10) }
        ) {
            Text("🚦 Go/NoGo (10)", fontWeight = FontWeight.Bold)
        }
    }

    Text(
        "Probar detector IMU Anti-Curbstoning (🤝 Traspaso del dispositivo):",
        color = Color.White,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Button(
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1E293B), contentColor = Color.White),
            onClick = onTestHandoffStart
        ) {
            Text("1. Iniciar traspaso 🤝")
        }
        Button(
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1E293B), contentColor = Color.White),
            onClick = onTestHandoffEnd
        ) {
            Text("2. Terminar y medir IMU")
        }
    }

    Text("Sensores C++ NDK en vivo (Oboe dBA · Lux · IMU 400Hz):", color = Color(0xFF22C55E), fontSize = 13.sp, fontWeight = FontWeight.Bold)
    Text(
        text = "Env: $envJson\nHandoff: $handoffJson",
        color = Color(0xFFE2E8F0),
        fontSize = 12.sp,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF171717), RoundedCornerShape(8.dp))
            .padding(10.dp)
    )
}

@androidx.compose.runtime.Composable
private fun ModePill(label: String, active: Boolean, onClick: () -> Unit) {
    val bg = if (active) Color.White else Color(0xFF262626)
    val fg = if (active) Color.Black else Color(0xFFE2E8F0)
    Box(
        modifier = Modifier
            .background(bg, RoundedCornerShape(999.dp))
            .clickable { onClick() }
            .padding(horizontal = 11.dp, vertical = 5.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(label, color = fg, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}
