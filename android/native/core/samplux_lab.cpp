#include "samplux_lab.h"

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <numeric>
#include <sstream>

namespace samplux {

namespace {

constexpr float kGravity = 9.80665f;

// Deterministic SplitMix64 PRNG so trial generation is fast, portable, and reproducible.
class SplitMix64 {
public:
    explicit SplitMix64(uint64_t seed) : state_(seed ? seed : 0x9E3779B97F4A7C15ULL) {}

    uint64_t next() noexcept {
        uint64_t z = (state_ += 0x9E3779B97F4A7C15ULL);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }

    int randInt(int min_v, int max_v) noexcept {
        if (max_v <= min_v) return min_v;
        uint64_t span = static_cast<uint64_t>(max_v - min_v + 1);
        return min_v + static_cast<int>(next() % span);
    }

    template <typename T>
    void shuffle(std::vector<T>& v) noexcept {
        if (v.size() <= 1) return;
        for (size_t i = v.size() - 1; i > 0; --i) {
            size_t j = static_cast<size_t>(next() % (i + 1));
            std::swap(v[i], v[j]);
        }
    }

private:
    uint64_t state_;
};

inline float accelMag(const ImuSample& s) noexcept {
    return std::sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az);
}

inline float gyroMag(const ImuSample& s) noexcept {
    return std::sqrt(s.gx * s.gx + s.gy * s.gy + s.gz * s.gz);
}

std::string jsonEscape(const std::string& s) {
    std::ostringstream o;
    for (char c : s) {
        switch (c) {
            case '"':  o << "\\\""; break;
            case '\\': o << "\\\\"; break;
            case '\n': o << "\\n"; break;
            case '\r': o << "\\r"; break;
            case '\t': o << "\\t"; break;
            default:   o << c; break;
        }
    }
    return o.str();
}

} // namespace

// ─────────────────────────────────────────────────────────────
// ImuRingBuffer
// ─────────────────────────────────────────────────────────────

ImuRingBuffer::ImuRingBuffer() = default;

void ImuRingBuffer::push(const ImuSample& s) noexcept {
    uint64_t idx = write_idx_.fetch_add(1, std::memory_order_relaxed);
    buf_[idx % kCapacity] = s;
}

void ImuRingBuffer::clear() noexcept {
    write_idx_.store(0, std::memory_order_relaxed);
}

size_t ImuRingBuffer::size() const noexcept {
    uint64_t w = write_idx_.load(std::memory_order_relaxed);
    return static_cast<size_t>(std::min<uint64_t>(w, kCapacity));
}

std::vector<ImuSample> ImuRingBuffer::window(int64_t t_start_ns, int64_t t_end_ns) const {
    std::vector<ImuSample> out;
    uint64_t w = write_idx_.load(std::memory_order_relaxed);
    if (w == 0 || t_end_ns < t_start_ns) return out;
    uint64_t count = std::min<uint64_t>(w, kCapacity);
    uint64_t start = w - count;
    out.reserve(128);
    for (uint64_t i = start; i < w; ++i) {
        const ImuSample& s = buf_[i % kCapacity];
        if (s.timestamp_ns >= t_start_ns && s.timestamp_ns <= t_end_ns) {
            out.push_back(s);
        }
    }
    std::sort(out.begin(), out.end(), [](const ImuSample& a, const ImuSample& b) {
        return a.timestamp_ns < b.timestamp_ns;
    });
    return out;
}

BiomechMetrics ImuRingBuffer::analyzeTouchImpulse(int64_t onset_ns, int64_t touch_ns) const {
    BiomechMetrics m{};
    // Pre-stimulus baseline: [onset_ns - 150ms, onset_ns]
    auto base_samples = window(onset_ns - 150'000'000LL, onset_ns);
    float base_mag = kGravity;
    if (!base_samples.empty()) {
        double sum = 0.0;
        for (const auto& s : base_samples) sum += accelMag(s);
        base_mag = static_cast<float>(sum / base_samples.size());
    }

    // Tap impact window: [touch_ns - 25ms, touch_ns + 45ms]
    auto tap_samples = window(touch_ns - 25'000'000LL, touch_ns + 45'000'000LL);
    float peak_delta_ms2 = 0.0f;
    float peak_gyro = 0.0f;
    for (const auto& s : tap_samples) {
        float delta = std::fabs(accelMag(s) - base_mag);
        if (delta > peak_delta_ms2) peak_delta_ms2 = delta;
        float g = gyroMag(s);
        if (g > peak_gyro) peak_gyro = g;
    }
    m.tap_impulse_g = peak_delta_ms2 / kGravity;
    m.tap_gyro_rad_s = peak_gyro;
    return m;
}

BiomechMetrics ImuRingBuffer::analyzeNoGoWindow(int64_t onset_ns, int64_t window_end_ns) const {
    BiomechMetrics m{};
    auto base_samples = window(onset_ns - 150'000'000LL, onset_ns);
    float base_mag = kGravity;
    float base_noise_ms2 = 0.15f;
    if (!base_samples.empty()) {
        double sum = 0.0;
        for (const auto& s : base_samples) sum += accelMag(s);
        base_mag = static_cast<float>(sum / base_samples.size());
        double max_dev = 0.05;
        for (const auto& s : base_samples) {
            max_dev = std::max<double>(max_dev, std::fabs(accelMag(s) - base_mag));
        }
        base_noise_ms2 = static_cast<float>(max_dev);
    }

    // Response inhibition window: [onset_ns + 120ms, window_end_ns]
    int64_t start_ns = onset_ns + 120'000'000LL;
    if (window_end_ns <= start_ns) window_end_ns = onset_ns + 850'000'000LL;
    auto inh_samples = window(start_ns, window_end_ns);
    float peak_delta_ms2 = 0.0f;
    float peak_gyro = 0.0f;
    for (const auto& s : inh_samples) {
        float delta = std::fabs(accelMag(s) - base_mag);
        if (delta > peak_delta_ms2) peak_delta_ms2 = delta;
        float g = gyroMag(s);
        if (g > peak_gyro) peak_gyro = g;
    }
    m.nogo_microflinch_g = peak_delta_ms2 / kGravity;
    m.tap_gyro_rad_s = peak_gyro;
    // A micro-flinch is flagged if peak acceleration delta exceeds 0.08g and 3.0x pre-stimulus rest noise
    m.microflinch_detected = (m.nogo_microflinch_g >= 0.08f) && (peak_delta_ms2 >= 3.0f * base_noise_ms2);
    return m;
}

HandoffVerification ImuRingBuffer::analyzeHandoff(int64_t start_ns, int64_t end_ns) const {
    HandoffVerification h{};
    if (end_ns <= start_ns) return h;
    h.duration_ms = static_cast<double>(end_ns - start_ns) / 1e6;

    auto samples = window(start_ns, end_ns);
    if (samples.size() < 2) return h;

    double rot_rad = 0.0;
    float peak_delta_g = 0.0f;
    for (size_t i = 0; i < samples.size(); ++i) {
        float delta_g = std::fabs(accelMag(samples[i]) - kGravity) / kGravity;
        if (delta_g > peak_delta_g) peak_delta_g = delta_g;
        if (i > 0) {
            double dt_s = static_cast<double>(samples[i].timestamp_ns - samples[i - 1].timestamp_ns) / 1e9;
            if (dt_s > 0.0 && dt_s < 0.25) {
                rot_rad += static_cast<double>(gyroMag(samples[i])) * dt_s;
            }
        }
    }
    h.integrated_rotation_deg = rot_rad * (180.0 / 3.14159265358979323846);
    h.peak_accel_delta_g = peak_delta_g;

    // Score combines rotation (target >= 35 deg during handoff) and translational acceleration (target >= 0.25g)
    double rot_part = std::min(1.0, h.integrated_rotation_deg / 45.0);
    double acc_part = std::min(1.0, h.peak_accel_delta_g / 0.35);
    h.score = std::round((0.65 * rot_part + 0.35 * acc_part) * 100.0) / 100.0;
    h.verified = h.score >= 0.45;
    return h;
}

// ─────────────────────────────────────────────────────────────
// AmbientNoiseMeter
// ─────────────────────────────────────────────────────────────

void AmbientNoiseMeter::reset() noexcept {
    sum_db_.store(0.0, std::memory_order_relaxed);
    peak_db_.store(30.0, std::memory_order_relaxed);
    blocks_.store(0, std::memory_order_relaxed);
}

void AmbientNoiseMeter::processPcm(const float* samples, int32_t num_samples) noexcept {
    if (!samples || num_samples <= 0) return;
    double sum_sq = 0.0;
    for (int32_t i = 0; i < num_samples; ++i) {
        double v = static_cast<double>(samples[i]);
        sum_sq += v * v;
    }
    double rms = std::sqrt(sum_sq / static_cast<double>(num_samples));
    // Map normalized float PCM RMS to approximate SPL dBA (calibrated with 94 dB SPL @ -6 dBFS reference)
    double db_spl = 30.0;
    if (rms > 1e-6) {
        double dbfs = 20.0 * std::log10(rms);
        db_spl = std::clamp(100.0 + dbfs, 28.0, 110.0);
    }

    double cur_sum = sum_db_.load(std::memory_order_relaxed);
    while (!sum_db_.compare_exchange_weak(cur_sum, cur_sum + db_spl, std::memory_order_relaxed)) {}

    double cur_peak = peak_db_.load(std::memory_order_relaxed);
    while (db_spl > cur_peak && !peak_db_.compare_exchange_weak(cur_peak, db_spl, std::memory_order_relaxed)) {}

    blocks_.fetch_add(1, std::memory_order_relaxed);
}

double AmbientNoiseMeter::meanDbSpl() const noexcept {
    uint64_t n = blocks_.load(std::memory_order_relaxed);
    if (n == 0) return 0.0;
    return std::round((sum_db_.load(std::memory_order_relaxed) / static_cast<double>(n)) * 10.0) / 10.0;
}

double AmbientNoiseMeter::peakDbSpl() const noexcept {
    uint64_t n = blocks_.load(std::memory_order_relaxed);
    if (n == 0) return 0.0;
    return std::round(peak_db_.load(std::memory_order_relaxed) * 10.0) / 10.0;
}

// ─────────────────────────────────────────────────────────────
// TaskSession
// ─────────────────────────────────────────────────────────────

TaskSession::TaskSession(TaskKind kind, uint64_t seed, int n_test_override, float display_refresh_hz)
    : kind_(kind), seed_(seed), refresh_hz_(display_refresh_hz) {
    SplitMix64 rng(seed_);

    if (kind_ == TaskKind::RT) {
        int n = n_test_override > 0 ? n_test_override : 20;
        specs_.reserve(n);
        for (int i = 0; i < n; ++i) {
            TrialSpec s{};
            s.index = i;
            s.wait_ms = rng.randInt(1000, 3500);
            specs_.push_back(s);
        }
    } else if (kind_ == TaskKind::STROOP) {
        static const std::array<std::string, 4> kColors = {"rojo", "azul", "verde", "amarillo"};
        int n = n_test_override > 0 ? n_test_override : 36;
        std::vector<TrialSpec> pool;
        for (const auto& ink : kColors) {
            for (const auto& word : kColors) {
                TrialSpec s{};
                s.word = word;
                s.ink_color = ink;
                s.condition = (word == ink) ? "congruent" : "incongruent";
                s.wait_ms = 500;
                pool.push_back(s);
            }
        }
        while (static_cast<int>(specs_.size()) < n) {
            auto copy = pool;
            rng.shuffle(copy);
            for (const auto& item : copy) {
                if (static_cast<int>(specs_.size()) >= n) break;
                specs_.push_back(item);
            }
        }
        rng.shuffle(specs_);
        for (size_t i = 0; i < specs_.size(); ++i) specs_[i].index = static_cast<int>(i);
    } else if (kind_ == TaskKind::GONOGO) {
        int n = n_test_override > 0 ? n_test_override : 40;
        int n_go = static_cast<int>(std::lround(n * 0.70));
        specs_.reserve(n);
        for (int i = 0; i < n; ++i) {
            TrialSpec s{};
            s.wait_ms = 400;
            s.gonogo_type = (i < n_go) ? "go" : "nogo";
            specs_.push_back(s);
        }
        rng.shuffle(specs_);
        for (size_t i = 0; i < specs_.size(); ++i) specs_[i].index = static_cast<int>(i);
    }
}

TrialOutcome TaskSession::recordTrial(
    int trial_index,
    int64_t scheduled_onset_ns,
    int64_t vsync_present_ns,
    bool responded,
    int64_t touch_kernel_ns,
    const std::string& response_code,
    float touch_pressure,
    float touch_area,
    const ImuRingBuffer& imu,
    bool too_early
) {
    TrialOutcome out{};
    out.trial_index = trial_index;
    if (trial_index >= 0 && static_cast<size_t>(trial_index) < specs_.size()) {
        out.spec = specs_[trial_index];
    } else {
        out.spec.index = trial_index;
    }

    out.scheduled_onset_ns = scheduled_onset_ns;
    out.vsync_present_ns = vsync_present_ns;
    out.touch_kernel_ns = touch_kernel_ns;
    out.responded = responded;
    out.too_early = too_early;
    out.response = response_code;
    out.touch_pressure = touch_pressure;
    out.touch_area = touch_area;

    if (scheduled_onset_ns > 0 && vsync_present_ns >= scheduled_onset_ns) {
        out.onset_jitter_us = (vsync_present_ns - scheduled_onset_ns) / 1000LL;
    }

    if (responded && !too_early && touch_kernel_ns > vsync_present_ns) {
        out.rt_hw_us = (touch_kernel_ns - vsync_present_ns) / 1000LL;
        out.rt_ms = std::max(1, static_cast<int>(std::lround(static_cast<double>(out.rt_hw_us) / 1000.0)));
        out.biomech = imu.analyzeTouchImpulse(vsync_present_ns, touch_kernel_ns);
    }

    if (kind_ == TaskKind::RT) {
        out.correct = responded && !too_early && out.rt_ms > 0;
    } else if (kind_ == TaskKind::STROOP) {
        out.correct = responded && (response_code == out.spec.ink_color);
    } else if (kind_ == TaskKind::GONOGO) {
        if (out.spec.gonogo_type == "go") {
            out.outcome_label = responded ? "hit" : "miss";
            out.correct = responded;
        } else {
            out.outcome_label = responded ? "false_alarm" : "correct_rejection";
            out.correct = !responded;
            if (!responded) {
                out.biomech = imu.analyzeNoGoWindow(vsync_present_ns, vsync_present_ns + 1'000'000'000LL);
            }
        }
    }

    outcomes_.push_back(out);
    return out;
}

std::string TaskSession::toJson(double ambient_db_mean, double ambient_lux) const {
    std::ostringstream j;
    j << std::fixed << std::setprecision(2);
    j << "{\"engine\":\"cpp17_ndk\",\"trials\":[";

    for (size_t i = 0; i < outcomes_.size(); ++i) {
        const auto& t = outcomes_[i];
        if (i > 0) j << ",";
        j << "{\"trial_index\":" << t.trial_index;
        if (kind_ == TaskKind::STROOP) {
            j << ",\"word\":\"" << jsonEscape(t.spec.word) << "\""
              << ",\"ink_color\":\"" << jsonEscape(t.spec.ink_color) << "\""
              << ",\"condition\":\"" << jsonEscape(t.spec.condition) << "\"";
            if (t.responded) j << ",\"response\":\"" << jsonEscape(t.response) << "\"";
            else j << ",\"response\":null";
            j << ",\"correct\":" << (t.correct ? "true" : "false");
        } else if (kind_ == TaskKind::GONOGO) {
            j << ",\"type\":\"" << jsonEscape(t.spec.gonogo_type) << "\""
              << ",\"outcome\":\"" << jsonEscape(t.outcome_label) << "\""
              << ",\"correct\":" << (t.correct ? "true" : "false")
              << ",\"nogo_microflinch_g\":" << t.biomech.nogo_microflinch_g
              << ",\"microflinch_detected\":" << (t.biomech.microflinch_detected ? "true" : "false");
        }
        if (t.rt_ms > 0) {
            j << ",\"rt_ms\":" << t.rt_ms
              << ",\"rt_hw_us\":" << t.rt_hw_us;
        } else {
            j << ",\"rt_ms\":null,\"rt_hw_us\":null";
        }
        j << ",\"onset_jitter_us\":" << t.onset_jitter_us
          << ",\"tap_impulse_g\":" << t.biomech.tap_impulse_g
          << ",\"touch_pressure\":" << t.touch_pressure
          << "}";
    }
    j << "],\"summary\":{";

    auto meanInt = [](const std::vector<int>& vals) -> int {
        if (vals.empty()) return -1;
        double s = std::accumulate(vals.begin(), vals.end(), 0.0);
        return static_cast<int>(std::lround(s / vals.size()));
    };

    if (kind_ == TaskKind::RT) {
        std::vector<int> rts;
        std::vector<int64_t> us_rts;
        int failed = 0;
        for (const auto& t : outcomes_) {
            if (t.rt_ms > 0 && !t.too_early) {
                rts.push_back(t.rt_ms);
                us_rts.push_back(t.rt_hw_us);
            } else {
                failed++;
            }
        }
        int m_rt = meanInt(rts);
        int min_rt = rts.empty() ? -1 : *std::min_element(rts.begin(), rts.end());
        int max_rt = rts.empty() ? -1 : *std::max_element(rts.begin(), rts.end());
        int sd_rt = -1;
        if (rts.size() > 1) {
            double raw_mean = std::accumulate(rts.begin(), rts.end(), 0.0) / rts.size();
            double sq = 0.0;
            for (int v : rts) sq += (v - raw_mean) * (v - raw_mean);
            sd_rt = static_cast<int>(std::lround(std::sqrt(sq / (rts.size() - 1))));
        }
        int64_t mean_us = us_rts.empty() ? -1 : std::accumulate(us_rts.begin(), us_rts.end(), 0LL) / static_cast<int64_t>(us_rts.size());

        j << "\"n_trials\":" << rts.size()
          << ",\"n_failed\":" << failed
          << ",\"ended_early\":false"
          << ",\"mean_rt_ms\":" << (m_rt >= 0 ? std::to_string(m_rt) : "null")
          << ",\"min_rt_ms\":" << (min_rt >= 0 ? std::to_string(min_rt) : "null")
          << ",\"max_rt_ms\":" << (max_rt >= 0 ? std::to_string(max_rt) : "null")
          << ",\"sd_rt_ms\":" << (sd_rt >= 0 ? std::to_string(sd_rt) : "null")
          << ",\"mean_rt_hw_us\":" << (mean_us >= 0 ? std::to_string(mean_us) : "null");
    } else if (kind_ == TaskKind::STROOP) {
        std::vector<int> cong_rts, incong_rts;
        int cong_total = 0, cong_ok = 0, incong_total = 0, incong_ok = 0;
        for (const auto& t : outcomes_) {
            if (t.spec.condition == "congruent") {
                cong_total++;
                if (t.correct) cong_ok++;
                if (t.rt_ms > 0) cong_rts.push_back(t.rt_ms);
            } else {
                incong_total++;
                if (t.correct) incong_ok++;
                if (t.rt_ms > 0) incong_rts.push_back(t.rt_ms);
            }
        }
        int rt_c = meanInt(cong_rts);
        int rt_i = meanInt(incong_rts);
        int effect = (rt_c >= 0 && rt_i >= 0) ? (rt_i - rt_c) : -999999;
        int acc_c = cong_total ? static_cast<int>(std::lround((cong_ok * 100.0) / cong_total)) : -1;
        int acc_i = incong_total ? static_cast<int>(std::lround((incong_ok * 100.0) / incong_total)) : -1;

        j << "\"n_trials\":" << outcomes_.size()
          << ",\"mean_rt_congruent\":" << (rt_c >= 0 ? std::to_string(rt_c) : "null")
          << ",\"mean_rt_incongruent\":" << (rt_i >= 0 ? std::to_string(rt_i) : "null")
          << ",\"stroop_effect_ms\":" << (effect != -999999 ? std::to_string(effect) : "null")
          << ",\"accuracy_congruent\":" << (acc_c >= 0 ? std::to_string(acc_c) : "null")
          << ",\"accuracy_incongruent\":" << (acc_i >= 0 ? std::to_string(acc_i) : "null");
    } else if (kind_ == TaskKind::GONOGO) {
        int hits = 0, misses = 0, fas = 0, crs = 0, microflinches = 0;
        std::vector<int> hit_rts;
        for (const auto& t : outcomes_) {
            if (t.outcome_label == "hit") {
                hits++;
                if (t.rt_ms > 0) hit_rts.push_back(t.rt_ms);
            } else if (t.outcome_label == "miss") {
                misses++;
            } else if (t.outcome_label == "false_alarm") {
                fas++;
            } else if (t.outcome_label == "correct_rejection") {
                crs++;
                if (t.biomech.microflinch_detected) microflinches++;
            }
        }
        int hit_rate = (hits + misses) ? static_cast<int>(std::lround((hits * 100.0) / (hits + misses))) : -1;
        int fa_rate = (fas + crs) ? static_cast<int>(std::lround((fas * 100.0) / (fas + crs))) : -1;
        int m_hit_rt = meanInt(hit_rts);

        j << "\"n_trials\":" << outcomes_.size()
          << ",\"hits\":" << hits
          << ",\"misses\":" << misses
          << ",\"false_alarms\":" << fas
          << ",\"correct_rejections\":" << crs
          << ",\"hit_rate\":" << (hit_rate >= 0 ? std::to_string(hit_rate) : "null")
          << ",\"false_alarm_rate\":" << (fa_rate >= 0 ? std::to_string(fa_rate) : "null")
          << ",\"mean_rt_hits\":" << (m_hit_rt >= 0 ? std::to_string(m_hit_rt) : "null")
          << ",\"nogo_microflinches\":" << microflinches;
    }

    j << ",\"display_refresh_hz\":" << refresh_hz_
      << ",\"ambient_db_mean\":" << ambient_db_mean
      << ",\"ambient_lux\":" << ambient_lux
      << ",\"rng_seed\":" << seed_
      << "}}";
    return j.str();
}

} // namespace samplux
