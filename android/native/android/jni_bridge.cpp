#include "samplux_lab.h"

#include <jni.h>
#include <android/log.h>
#include <android/sensor.h>
#include <oboe/Oboe.h>

#include <atomic>
#include <ctime>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_map>

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "SampluxNDK", __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, "SampluxNDK", __VA_ARGS__)

namespace {

using namespace samplux;

ImuRingBuffer g_imu_ring;
AmbientNoiseMeter g_noise_meter;

std::atomic<float> g_latest_ax{0.0f}, g_latest_ay{0.0f}, g_latest_az{9.80665f};
std::atomic<float> g_latest_gx{0.0f}, g_latest_gy{0.0f}, g_latest_gz{0.0f};
std::atomic<float> g_latest_lux{-1.0f};

std::atomic<int64_t> g_handoff_start_ns{0};
std::atomic<int> g_handoff_count{0};
std::atomic<int> g_handoff_verified_count{0};
std::atomic<double> g_last_handoff_score{0.0};
std::atomic<double> g_last_handoff_rot_deg{0.0};

std::mutex g_session_mu;
int64_t g_next_handle = 1;
std::unordered_map<int64_t, std::unique_ptr<TaskSession>> g_sessions;

int64_t monotonicNowNs() noexcept {
    struct timespec ts {};
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return static_cast<int64_t>(ts.tv_sec) * 1'000'000'000LL + static_cast<int64_t>(ts.tv_nsec);
}

// ── NDK ASensorManager 400Hz Sensor Loop ──────────────────────
class NdkSensorPump {
public:
    void start() {
        bool expected = false;
        if (!running_.compare_exchange_strong(expected, true)) return;
        worker_ = std::thread([this]() { this->loop(); });
    }

    void stop() {
        bool expected = true;
        if (!running_.compare_exchange_strong(expected, false)) return;
        if (worker_.joinable()) worker_.join();
    }

private:
    void loop() {
        ALooper* looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
        ASensorManager* mgr = ASensorManager_getInstanceForPackage("cl.umag.lamp.samplux");
        if (!mgr) {
            running_.store(false);
            return;
        }
        const ASensor* accel = ASensorManager_getDefaultSensor(mgr, ASENSOR_TYPE_ACCELEROMETER);
        const ASensor* gyro  = ASensorManager_getDefaultSensor(mgr, ASENSOR_TYPE_GYROSCOPE);
        const ASensor* light = ASensorManager_getDefaultSensor(mgr, ASENSOR_TYPE_LIGHT);

        ASensorEventQueue* queue = ASensorManager_createEventQueue(mgr, looper, 1, nullptr, nullptr);
        if (!queue) {
            running_.store(false);
            return;
        }
        // Request 2500 us (400 Hz) on IMU sensors where hardware supports it
        if (accel) {
            ASensorEventQueue_enableSensor(queue, accel);
            ASensorEventQueue_setEventRate(queue, accel, 2500);
        }
        if (gyro) {
            ASensorEventQueue_enableSensor(queue, gyro);
            ASensorEventQueue_setEventRate(queue, gyro, 2500);
        }
        if (light) {
            ASensorEventQueue_enableSensor(queue, light);
            ASensorEventQueue_setEventRate(queue, light, 100'000);
        }

        LOGI("NDK 400Hz ASensorEventQueue started (accel=%d, gyro=%d, light=%d)",
             accel != nullptr, gyro != nullptr, light != nullptr);

        while (running_.load(std::memory_order_relaxed)) {
            ALooper_pollOnce(20, nullptr, nullptr, nullptr);
            ASensorEvent ev;
            while (ASensorEventQueue_getEvents(queue, &ev, 1) > 0) {
                if (ev.type == ASENSOR_TYPE_ACCELEROMETER) {
                    g_latest_ax.store(ev.acceleration.x, std::memory_order_relaxed);
                    g_latest_ay.store(ev.acceleration.y, std::memory_order_relaxed);
                    g_latest_az.store(ev.acceleration.z, std::memory_order_relaxed);
                    ImuSample s{};
                    s.timestamp_ns = ev.timestamp > 0 ? ev.timestamp : monotonicNowNs();
                    s.ax = ev.acceleration.x;
                    s.ay = ev.acceleration.y;
                    s.az = ev.acceleration.z;
                    s.gx = g_latest_gx.load(std::memory_order_relaxed);
                    s.gy = g_latest_gy.load(std::memory_order_relaxed);
                    s.gz = g_latest_gz.load(std::memory_order_relaxed);
                    g_imu_ring.push(s);
                } else if (ev.type == ASENSOR_TYPE_GYROSCOPE) {
                    g_latest_gx.store(ev.vector.x, std::memory_order_relaxed);
                    g_latest_gy.store(ev.vector.y, std::memory_order_relaxed);
                    g_latest_gz.store(ev.vector.z, std::memory_order_relaxed);
                } else if (ev.type == ASENSOR_TYPE_LIGHT) {
                    g_latest_lux.store(ev.light, std::memory_order_relaxed);
                }
            }
        }

        if (accel) ASensorEventQueue_disableSensor(queue, accel);
        if (gyro)  ASensorEventQueue_disableSensor(queue, gyro);
        if (light) ASensorEventQueue_disableSensor(queue, light);
        ASensorManager_destroyEventQueue(mgr, queue);
    }

    std::atomic<bool> running_{false};
    std::thread worker_;
};

NdkSensorPump g_sensor_pump;

// ── Oboe Low-Latency Ambient Noise Probe (No Audio Stored) ────
class OboeNoiseProbe : public oboe::AudioStreamDataCallback {
public:
    void start() {
        std::lock_guard<std::mutex> lock(mu_);
        if (stream_) return;
        g_noise_meter.reset();
        oboe::AudioStreamBuilder b;
        b.setDirection(oboe::Direction::Input)
         ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
         ->setSharingMode(oboe::SharingMode::Shared)
         ->setFormat(oboe::AudioFormat::Float)
         ->setChannelCount(oboe::ChannelCount::Mono)
         ->setInputPreset(oboe::InputPreset::VoiceRecognition)
         ->setDataCallback(this);
        oboe::Result r = b.openStream(stream_);
        if (r == oboe::Result::OK && stream_) {
            stream_->requestStart();
            LOGI("Oboe ambient dB probe active at %d Hz", stream_->getSampleRate());
        } else {
            stream_.reset();
        }
    }

    void stop() {
        std::lock_guard<std::mutex> lock(mu_);
        if (stream_) {
            stream_->requestStop();
            stream_->close();
            stream_.reset();
        }
    }

    oboe::DataCallbackResult onAudioReady(
        oboe::AudioStream* /*audioStream*/,
        void* audioData,
        int32_t numFrames
    ) override {
        const auto* pcm = static_cast<const float*>(audioData);
        g_noise_meter.processPcm(pcm, numFrames);
        return oboe::DataCallbackResult::Continue;
    }

private:
    std::mutex mu_;
    std::shared_ptr<oboe::AudioStream> stream_;
};

OboeNoiseProbe g_audio_probe;

} // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeStartSensors(JNIEnv* /*env*/, jobject /*thiz*/) {
    g_sensor_pump.start();
}

JNIEXPORT void JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeStopSensors(JNIEnv* /*env*/, jobject /*thiz*/) {
    g_sensor_pump.stop();
    g_audio_probe.stop();
}

JNIEXPORT void JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeStartAudioProbe(JNIEnv* /*env*/, jobject /*thiz*/) {
    g_audio_probe.start();
}

JNIEXPORT void JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeStopAudioProbe(JNIEnv* /*env*/, jobject /*thiz*/) {
    g_audio_probe.stop();
}

JNIEXPORT jlong JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeMonotonicNowNs(JNIEnv* /*env*/, jobject /*thiz*/) {
    return static_cast<jlong>(monotonicNowNs());
}

JNIEXPORT void JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeNotifyHandoffState(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jboolean entering_respondent_view
) {
    int64_t now_ns = monotonicNowNs();
    if (entering_respondent_view) {
        g_handoff_start_ns.store(now_ns, std::memory_order_relaxed);
    } else {
        int64_t start_ns = g_handoff_start_ns.exchange(0, std::memory_order_relaxed);
        if (start_ns > 0) {
            // Evaluate the first 3.5 seconds of the handoff transition (when the device is passed across)
            int64_t eval_end = std::min<int64_t>(now_ns, start_ns + 3'500'000'000LL);
            auto h = g_imu_ring.analyzeHandoff(start_ns, eval_end);
            g_handoff_count.fetch_add(1, std::memory_order_relaxed);
            if (h.verified) g_handoff_verified_count.fetch_add(1, std::memory_order_relaxed);
            g_last_handoff_score.store(h.score, std::memory_order_relaxed);
            g_last_handoff_rot_deg.store(h.integrated_rotation_deg, std::memory_order_relaxed);
        }
    }
}

JNIEXPORT jstring JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeGetInterviewerTelemetryJson(JNIEnv* env, jobject /*thiz*/) {
    // If currently in respondent view, also check ongoing handoff window
    int64_t active_start = g_handoff_start_ns.load(std::memory_order_relaxed);
    double score = g_last_handoff_score.load(std::memory_order_relaxed);
    double rot = g_last_handoff_rot_deg.load(std::memory_order_relaxed);
    int total = g_handoff_count.load(std::memory_order_relaxed);
    int verified = g_handoff_verified_count.load(std::memory_order_relaxed);

    if (active_start > 0 && total == 0) {
        int64_t now_ns = monotonicNowNs();
        auto h = g_imu_ring.analyzeHandoff(active_start, std::min<int64_t>(now_ns, active_start + 3'500'000'000LL));
        score = h.score;
        rot = h.integrated_rotation_deg;
        total = 1;
        verified = h.verified ? 1 : 0;
    }

    std::ostringstream o;
    o << std::fixed << std::setprecision(2)
      << "{\"engine\":\"cpp17_ndk\""
      << ",\"handoffCount\":" << total
      << ",\"handoffVerifiedCount\":" << verified
      << ",\"lastHandoffMotionScore\":" << score
      << ",\"lastHandoffRotationDeg\":" << rot
      << ",\"ambientDbMean\":" << g_noise_meter.meanDbSpl()
      << ",\"ambientLux\":" << g_latest_lux.load(std::memory_order_relaxed)
      << "}";
    return env->NewStringUTF(o.str().c_str());
}

JNIEXPORT jstring JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeGetEnvironmentSnapshotJson(
    JNIEnv* env,
    jobject /*thiz*/,
    jfloat display_refresh_hz,
    jint battery_pct,
    jfloat battery_temp_c
) {
    std::ostringstream o;
    o << std::fixed << std::setprecision(2)
      << "{\"engine\":\"cpp17_ndk\""
      << ",\"displayRefreshHz\":" << display_refresh_hz
      << ",\"ambientDbMean\":" << g_noise_meter.meanDbSpl()
      << ",\"ambientDbPeak\":" << g_noise_meter.peakDbSpl()
      << ",\"ambientLux\":" << g_latest_lux.load(std::memory_order_relaxed)
      << ",\"imuSamplesBuffered\":" << g_imu_ring.size()
      << ",\"batteryPct\":" << battery_pct
      << ",\"batteryTempC\":" << battery_temp_c
      << "}";
    return env->NewStringUTF(o.str().c_str());
}

JNIEXPORT jlong JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeCreateTaskSession(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jint kind_code,
    jlong seed,
    jint n_test_override,
    jfloat refresh_hz
) {
    TaskKind kind = TaskKind::RT;
    if (kind_code == 1) kind = TaskKind::STROOP;
    else if (kind_code == 2) kind = TaskKind::GONOGO;

    uint64_t actual_seed = seed != 0 ? static_cast<uint64_t>(seed) : static_cast<uint64_t>(monotonicNowNs());
    auto session = std::make_unique<TaskSession>(kind, actual_seed, n_test_override, refresh_hz);

    std::lock_guard<std::mutex> lock(g_session_mu);
    int64_t handle = g_next_handle++;
    g_sessions[handle] = std::move(session);
    return static_cast<jlong>(handle);
}

JNIEXPORT jstring JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeGetTaskSpecsJson(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle
) {
    std::lock_guard<std::mutex> lock(g_session_mu);
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) return env->NewStringUTF("[]");

    const auto& specs = it->second->trials();
    std::ostringstream o;
    o << "[";
    for (size_t i = 0; i < specs.size(); ++i) {
        if (i > 0) o << ",";
        const auto& s = specs[i];
        o << "{\"index\":" << s.index
          << ",\"wait_ms\":" << s.wait_ms
          << ",\"word\":\"" << s.word << "\""
          << ",\"ink_color\":\"" << s.ink_color << "\""
          << ",\"condition\":\"" << s.condition << "\""
          << ",\"gonogo_type\":\"" << s.gonogo_type << "\"}";
    }
    o << "]";
    return env->NewStringUTF(o.str().c_str());
}

JNIEXPORT jint JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeRecordTrial(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jint trial_index,
    jlong scheduled_onset_ns,
    jlong vsync_present_ns,
    jboolean responded,
    jlong touch_kernel_ns,
    jstring response_code_j,
    jfloat touch_pressure,
    jfloat touch_area,
    jboolean too_early
) {
    std::string resp;
    if (response_code_j) {
        const char* chars = env->GetStringUTFChars(response_code_j, nullptr);
        if (chars) {
            resp = chars;
            env->ReleaseStringUTFChars(response_code_j, chars);
        }
    }
    std::lock_guard<std::mutex> lock(g_session_mu);
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) return -1;

    auto out = it->second->recordTrial(
        trial_index,
        scheduled_onset_ns,
        vsync_present_ns,
        responded,
        touch_kernel_ns,
        resp,
        touch_pressure,
        touch_area,
        g_imu_ring,
        too_early
    );
    return out.rt_ms;
}

JNIEXPORT jstring JNICALL
Java_cl_umag_lamp_samplux_NativeLabEngine_nativeFinishTaskSession(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle
) {
    std::lock_guard<std::mutex> lock(g_session_mu);
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) return env->NewStringUTF("{}");

    std::string json = it->second->toJson(
        g_noise_meter.meanDbSpl(),
        static_cast<double>(g_latest_lux.load(std::memory_order_relaxed))
    );
    g_sessions.erase(it);
    return env->NewStringUTF(json.c_str());
}

} // extern "C"
