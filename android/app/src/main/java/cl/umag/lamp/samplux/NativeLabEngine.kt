package cl.umag.lamp.samplux

object NativeLabEngine {
    init {
        System.loadLibrary("samplux_lab")
    }

    external fun nativeStartSensors()
    external fun nativeStopSensors()
    external fun nativeStartAudioProbe()
    external fun nativeStopAudioProbe()
    external fun nativeMonotonicNowNs(): Long
    external fun nativeNotifyHandoffState(enteringRespondentView: Boolean)
    external fun nativeGetInterviewerTelemetryJson(): String
    external fun nativeGetEnvironmentSnapshotJson(
        displayRefreshHz: Float,
        batteryPct: Int,
        batteryTempC: Float
    ): String

    external fun nativeCreateTaskSession(
        kindCode: Int,
        seed: Long,
        nTestOverride: Int,
        refreshHz: Float
    ): Long

    external fun nativeGetTaskSpecsJson(handle: Long): String

    external fun nativeRecordTrial(
        handle: Long,
        trialIndex: Int,
        scheduledOnsetNs: Long,
        vsyncPresentNs: Long,
        responded: Boolean,
        touchKernelNs: Long,
        responseCode: String,
        touchPressure: Float,
        touchArea: Float,
        tooEarly: Boolean
    ): Int

    external fun nativeFinishTaskSession(handle: Long): String
}
