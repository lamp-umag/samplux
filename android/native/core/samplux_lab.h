#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <array>
#include <atomic>

namespace samplux {

struct ImuSample {
    int64_t timestamp_ns = 0;
    float ax = 0.0f; // m/s^2
    float ay = 0.0f;
    float az = 0.0f;
    float gx = 0.0f; // rad/s
    float gy = 0.0f;
    float gz = 0.0f;
};

struct BiomechMetrics {
    float tap_impulse_g = 0.0f;        // Peak linear accel delta above baseline around tap (in g)
    float tap_gyro_rad_s = 0.0f;       // Peak angular velocity around tap (rad/s)
    float nogo_microflinch_g = 0.0f;   // Sub-threshold motor twitch during No-Go inhibition window (in g)
    bool microflinch_detected = false; // True if nogo_microflinch_g exceeds 3.5x baseline noise (>0.08g)
};

struct HandoffVerification {
    double duration_ms = 0.0;
    double integrated_rotation_deg = 0.0;
    double peak_accel_delta_g = 0.0;
    double score = 0.0;                // 0.0 (stationary on table) to 1.0 (clear physical handoff)
    bool verified = false;             // True if score >= 0.45
};

/**
 * Lock-free single-producer / multi-reader 400 Hz IMU ring buffer.
 * Real-time sensor callback thread pushes samples; task & handoff analyzers read windows.
 */
class ImuRingBuffer {
public:
    static constexpr size_t kCapacity = 4096; // ~10.2 seconds at 400 Hz

    ImuRingBuffer();

    void push(const ImuSample& s) noexcept;
    void clear() noexcept;
    size_t size() const noexcept;

    // Extracts samples in [t_start_ns, t_end_ns] in chronological order.
    std::vector<ImuSample> window(int64_t t_start_ns, int64_t t_end_ns) const;

    // Computes tap impulse force (g) and peak gyro (rad/s) in [touch_ns - 25ms, touch_ns + 45ms]
    // compared against pre-stimulus baseline [onset_ns - 150ms, onset_ns].
    BiomechMetrics analyzeTouchImpulse(int64_t onset_ns, int64_t touch_ns) const;

    // On a Go/No-Go trial without a touch (e.g. Correct Rejection), measures partial motor
    // activation / micro-flinch in [onset_ns + 120ms, onset_ns + 850ms].
    BiomechMetrics analyzeNoGoWindow(int64_t onset_ns, int64_t window_end_ns) const;

    // Evaluates whether the device physically changed hands between start_ns and end_ns.
    HandoffVerification analyzeHandoff(int64_t start_ns, int64_t end_ns) const;

private:
    std::array<ImuSample, kCapacity> buf_{};
    std::atomic<uint64_t> write_idx_{0};
};

/**
 * Privacy-preserving real-time acoustic noise floor meter.
 * Processes raw PCM float frames on the Oboe audio thread and retains only dBFS / estimated dBA SPL
 * summary statistics (never stores audio waveforms).
 */
class AmbientNoiseMeter {
public:
    void reset() noexcept;
    void processPcm(const float* samples, int32_t num_samples) noexcept;

    double meanDbSpl() const noexcept;
    double peakDbSpl() const noexcept;
    uint64_t frameCount() const noexcept { return blocks_.load(std::memory_order_relaxed); }

private:
    std::atomic<double> sum_db_{0.0};
    std::atomic<double> peak_db_{30.0};
    std::atomic<uint64_t> blocks_{0};
};

enum class TaskKind {
    RT,
    STROOP,
    GONOGO
};

struct TrialSpec {
    int index = 0;
    int wait_ms = 0;          // Pre-stimulus delay or fixation duration
    std::string word;         // For Stroop: "rojo"|"azul"|"verde"|"amarillo"
    std::string ink_color;    // For Stroop
    std::string condition;    // For Stroop: "congruent"|"incongruent"
    std::string gonogo_type;  // For Go/No-Go: "go"|"nogo"
};

struct TrialOutcome {
    int trial_index = 0;
    TrialSpec spec;

    int64_t scheduled_onset_ns = 0;
    int64_t vsync_present_ns = 0;   // Exact CLOCK_MONOTONIC nanosecond stimulus frame scanned out
    int64_t touch_kernel_ns = 0;    // Exact CLOCK_MONOTONIC nanosecond kernel touch interrupt

    bool responded = false;
    bool too_early = false;
    std::string response;           // Button code or "tap"
    bool correct = false;
    std::string outcome_label;      // For Go/No-Go: "hit"|"miss"|"false_alarm"|"correct_rejection"

    int64_t rt_hw_us = -1;          // Microsecond hardware reaction time
    int rt_ms = -1;                 // Rounded millisecond RT (backwards-compatible with samplux web)
    int64_t onset_jitter_us = 0;    // Display VSYNC presentation jitter in microseconds

    float touch_pressure = 0.0f;
    float touch_area = 0.0f;
    BiomechMetrics biomech{};
};

/**
 * C++17 Cognitive Task Engine for task_rt, task_stroop, and task_gonogo.
 * Guarantees deterministic trial generation, hardware-clock microsecond RT calculation,
 * biomechanical IMU integration, and 100% JSON compatibility with samplux surveyRunner.js & statsCore.js.
 */
class TaskSession {
public:
    TaskSession(TaskKind kind, uint64_t seed, int n_test_override = 0, float display_refresh_hz = 60.0f);

    TaskKind kind() const noexcept { return kind_; }
    uint64_t seed() const noexcept { return seed_; }
    const std::vector<TrialSpec>& trials() const noexcept { return specs_; }

    // Records a finished trial using hardware CLOCK_MONOTONIC timestamps and computes IMU biomechanics.
    TrialOutcome recordTrial(
        int trial_index,
        int64_t scheduled_onset_ns,
        int64_t vsync_present_ns,
        bool responded,
        int64_t touch_kernel_ns,
        const std::string& response_code,
        float touch_pressure,
        float touch_area,
        const ImuRingBuffer& imu,
        bool too_early = false
    );

    // Serializes `{ trials, summary }` in the exact schema expected by surveyRunner.js and statsCore.js,
    // enriched with `engine: "cpp17_ndk"`, `rt_hw_us`, `onset_jitter_us`, and IMU biomechanics.
    std::string toJson(double ambient_db_mean = 0.0, double ambient_lux = -1.0) const;

private:
    TaskKind kind_;
    uint64_t seed_;
    float refresh_hz_;
    std::vector<TrialSpec> specs_;
    std::vector<TrialOutcome> outcomes_;
};

} // namespace samplux
