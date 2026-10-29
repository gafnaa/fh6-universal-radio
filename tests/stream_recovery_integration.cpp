#include "fh6/audio_source_manager.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <string_view>
#include <utility>

namespace {

class SimulatedStreamSource final : public fh6::IAudioSource {
public:
    explicit SimulatedStreamSource(std::string source_name, int fail_after_pumps = 3)
        : source_name_{std::move(source_name)}, fail_after_pumps_{fail_after_pumps} {}

    std::string_view name() const noexcept override { return source_name_; }
    std::string_view display_name() const noexcept override { return source_name_; }
    bool initialize() override { return true; }
    void shutdown() noexcept override {}
    void play() override {
        ++play_count_;
        state_ = fh6::PlaybackState::playing;
    }
    void pause() override { state_ = fh6::PlaybackState::paused; }
    void stop() override { state_ = fh6::PlaybackState::stopped; }
    void pump(fh6::RingBuffer& ring) override {
        constexpr std::array<std::byte, 4> pcm{};
        ring.write(pcm.data(), pcm.size());
        ++pump_count_;
        if (pump_count_ >= fail_after_pumps_) {
            recovery_ = {false, true, 3, 3, "simulated network/FFmpeg failure"};
            state_ = fh6::PlaybackState::stopped;
        } else {
            recovery_ = {true, false, static_cast<std::uint32_t>(pump_count_), 3,
                         "simulated reconnect attempt"};
            state_ = fh6::PlaybackState::buffering;
        }
    }
    fh6::TrackInfo current_track() const override { return {}; }
    fh6::PlaybackState playback_state() const noexcept override { return state_; }
    fh6::RecoveryStatus recovery_status() const override { return recovery_; }
    fh6::AuthState auth_state() const noexcept override { return fh6::AuthState::none_required; }
    fh6::SourceCapabilities capabilities() const noexcept override { return {}; }

    int play_count() const noexcept { return play_count_; }

private:
    std::string source_name_;
    int fail_after_pumps_ = 3;
    int pump_count_ = 0;
    int play_count_ = 0;
    fh6::PlaybackState state_ = fh6::PlaybackState::stopped;
    fh6::RecoveryStatus recovery_{};
};

bool expect(bool condition, std::string_view message) {
    if (condition) return true;
    std::cerr << "FAILED: " << message << '\n';
    return false;
}

bool test_retries_then_falls_back(std::string source_name) {
    fh6::AudioSourceManager manager{8192};
    auto failing = std::make_unique<SimulatedStreamSource>(std::move(source_name));
    auto* failing_view = failing.get();
    auto fallback = std::make_unique<SimulatedStreamSource>("local_files", 99);
    auto* fallback_view = fallback.get();
    manager.register_source(std::move(failing));
    manager.register_source(std::move(fallback));
    manager.configure_auto_fallback("local_files", true);

    if (!expect(manager.switch_to(failing_view->name()), "initial source should activate")) return false;
    manager.pump_once();
    if (!expect(manager.active() == failing_view, "first retry must keep the source active"))
        return false;
    if (!expect(failing_view->recovery_status().retrying, "first failure should report retrying"))
        return false;
    if (!expect(manager.ring().readable() == 4, "retrying stream PCM should remain available"))
        return false;

    manager.pump_once();
    if (!expect(manager.active() == failing_view, "second retry must keep the source active"))
        return false;
    if (!expect(failing_view->recovery_status().attempt == 2, "second retry attempt should be reported"))
        return false;

    manager.pump_once();
    if (!expect(manager.active() == fallback_view, "exhausted recovery should activate fallback"))
        return false;
    if (!expect(manager.ring().readable() == 0, "fallback must start with a drained ring"))
        return false;
    if (!expect(fallback_view->play_count() == 1, "fallback should receive play exactly once"))
        return false;

    const auto event = manager.last_fallback_event();
    if (!expect(event.has_value(), "fallback event should be recorded")) return false;
    if (!expect(event->source == failing_view->name(), "fallback event should identify failed source"))
        return false;
    return expect(event->fallback == "local_files" && event->message ==
                      "simulated network/FFmpeg failure",
                  "fallback event should preserve target and failure reason");
}

bool test_auto_fallback_is_opt_in() {
    fh6::AudioSourceManager manager{8192};
    auto failing = std::make_unique<SimulatedStreamSource>("jellyfin", 1);
    auto* failing_view = failing.get();
    auto fallback = std::make_unique<SimulatedStreamSource>("local_files", 99);
    manager.register_source(std::move(failing));
    manager.register_source(std::move(fallback));
    manager.configure_auto_fallback("local_files", false);

    if (!expect(manager.switch_to("jellyfin"), "source should activate without auto fallback"))
        return false;
    manager.pump_once();
    if (!expect(manager.active() == failing_view, "disabled auto fallback should keep failed source"))
        return false;
    return expect(!manager.last_fallback_event().has_value(),
                  "disabled auto fallback must not emit a switch event");
}

} // namespace

int main() {
    if (!test_retries_then_falls_back("youtube_music")) return 1;
    if (!test_retries_then_falls_back("jellyfin")) return 1;
    if (!test_auto_fallback_is_opt_in()) return 1;
    std::cout << "stream recovery integration tests passed\n";
    return 0;
}
