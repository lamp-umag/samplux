#include "samplux_lab.h"

#include <cassert>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

using namespace samplux;

static void test_rt_hardware_clock_and_json() {
    ImuRingBuffer imu;
    // Populate 400 Hz baseline around t = 1.0s (resting on table: az = 9.81 m/s^2)
    for (int i = 0; i < 100; ++i) {
        int64_t t_ns = 800'000'000LL + i * 2'500'000LL; // every 2.5ms (400 Hz)
        imu.push({t_ns, 0.0f, 0.0f, 9.80665f, 0.0f, 0.0f, 0.0f});
    }
    // Simulate finger tap mechanical impulse at t = 1,218,420,000 ns (+0.55g spike on Z)
    int64_t vsync_ns = 1'000'120'000LL;
    int64_t touch_ns = 1'218'540'000LL; // exact diff = 218,420,000 ns = 218,420 us -> 218 ms
    imu.push({touch_ns, 0.1f, 0.0f, 9.80665f + 0.55f * 9.80665f, 0.0f, 0.18f, 0.0f});

    TaskSession session(TaskKind::RT, 42ULL, 3, 120.0f);
    assert(session.trials().size() == 3);

    auto out0 = session.recordTrial(0, 1'000'000'000LL, vsync_ns, true, touch_ns, "tap", 0.65f, 0.22f, imu);
    assert(out0.rt_hw_us == 218420);
    assert(out0.rt_ms == 218);
    assert(out0.onset_jitter_us == 120);
    assert(out0.biomech.tap_impulse_g > 0.50f && out0.biomech.tap_impulse_g < 0.60f);

    session.recordTrial(1, 2'000'000'000LL, 2'000'050'000LL, true, 2'250'050'000LL, "tap", 0.50f, 0.20f, imu);
    session.recordTrial(2, 3'000'000'000LL, 3'000'080'000LL, true, 3'234'080'000LL, "tap", 0.55f, 0.21f, imu);

    std::string json = session.toJson(42.5, 320.0);
    assert(json.find("\"engine\":\"cpp17_ndk\"") != std::string::npos);
    assert(json.find("\"mean_rt_ms\":234") != std::string::npos);
    assert(json.find("\"rt_hw_us\":218420") != std::string::npos);
    assert(json.find("\"display_refresh_hz\":120.00") != std::string::npos);
}

static void test_gonogo_microflinch_detector() {
    ImuRingBuffer imu;
    int64_t onset_ns = 5'000'000'000LL;
    // Pre-stimulus quiet baseline
    for (int i = 0; i < 60; ++i) {
        imu.push({onset_ns - 150'000'000LL + i * 2'500'000LL, 0.0f, 0.0f, 9.80665f, 0.0f, 0.0f, 0.0f});
    }
    // At onset + 210 ms, participant starts to flinch toward the screen (+0.18g) then inhibits!
    imu.push({onset_ns + 210'000'000LL, 0.0f, 0.0f, 9.80665f + 0.18f * 9.80665f, 0.25f, 0.0f, 0.0f});

    auto bio = imu.analyzeNoGoWindow(onset_ns, onset_ns + 900'000'000LL);
    assert(bio.microflinch_detected == true);
    assert(bio.nogo_microflinch_g > 0.15f);
}

static void test_handoff_anti_curbstoning() {
    ImuRingBuffer imu;
    int64_t t0 = 10'000'000'000LL;

    // Case A: Tablet stays flat on the desk (curbstoning interviewer who didn't hand over the tablet)
    for (int i = 0; i < 400; ++i) {
        imu.push({t0 + i * 2'500'000LL, 0.0f, 0.0f, 9.80665f, 0.01f, 0.0f, 0.0f});
    }
    auto curb = imu.analyzeHandoff(t0, t0 + 1'000'000'000LL);
    assert(curb.verified == false);
    assert(curb.score < 0.20);

    // Case B: Physical handoff across table (1.2 rad/s rotation + 0.35g translation over 1 second)
    int64_t t1 = 15'000'000'000LL;
    for (int i = 0; i < 400; ++i) {
        imu.push({t1 + i * 2'500'000LL, 1.5f, 1.2f, 9.80665f + 3.2f, 0.9f, 0.8f, 0.4f});
    }
    auto real_handoff = imu.analyzeHandoff(t1, t1 + 1'000'000'000LL);
    assert(real_handoff.verified == true);
    assert(real_handoff.score >= 0.70);
}

static void test_ambient_noise_meter() {
    AmbientNoiseMeter meter;
    meter.reset();
    std::vector<float> quiet(512, 0.001f); // -60 dBFS -> ~40 dB SPL
    meter.processPcm(quiet.data(), static_cast<int32_t>(quiet.size()));
    assert(meter.meanDbSpl() >= 38.0 && meter.meanDbSpl() <= 42.0);
}

int main() {
    test_rt_hardware_clock_and_json();
    test_gonogo_microflinch_detector();
    test_handoff_anti_curbstoning();
    test_ambient_noise_meter();
    std::cout << "[samplux-lab C++17] All core hardware timing, IMU biomechanics, handoff, and DSP tests passed.\n";
    return 0;
}
