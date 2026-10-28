#pragma once

#include "fh6/audio_source.hpp"
#include "fh6/config.hpp"
#include "fh6/playback_dsp.hpp"
#include "fh6/worker/worker_client.hpp"

#include <atomic>
#include <chrono>
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace fh6::sources {

class OnlineRadioSource final : public IAudioSource {
public:
    OnlineRadioSource(OnlineRadioConfig cfg, std::filesystem::path ffmpeg_path, worker::WorkerClient* worker = nullptr);
    ~OnlineRadioSource() override;

    std::string_view name() const noexcept override { return "online_radio"; }
    std::string_view display_name() const noexcept override { return "Online Radio"; }

    bool initialize() override;
    void shutdown() noexcept override;

    void play() override;
    void pause() override;
    void stop() override;
    void next() override;
    void previous() override;
    bool skip_next() override { next(); return true; }

    void pump(RingBuffer& ring) override;
    void set_playback_options(const PlaybackConfig& opts) override;

    TrackInfo current_track() const override;
    PlaybackState playback_state() const noexcept override {
        return state_.load(std::memory_order_acquire);
    }
    RecoveryStatus recovery_status() const override;
    AuthState auth_state() const noexcept override { return AuthState::none_required; }

    // capabilities: no seeking, but can go next/prev through the station list
    SourceCapabilities capabilities() const noexcept override { return {false, true, true}; }

    void set_config(const OnlineRadioConfig& c);
    void set_ffmpeg_path(std::filesystem::path p);
    void set_target(std::string url, std::string name = {}, std::string logo = {},
                    std::vector<std::string> alternate_urls = {});

    // single source of truth for what may be handed to ffmpeg -i (guards every
    // playback path against file:/concat:/etc. injection from config or the API).
    static bool is_streamable_url(std::string_view url) noexcept;

    // recent ICY song titles for the current stream (newest first), surfaced in
    // /api/state details as the dashboard's track-history list.
    std::vector<std::string> song_history() const;

private:
    struct Pipe;
    void start_pipe_locked();
    void stop_pipe_locked();
    void reset_recovery_locked();
    void schedule_retry_locked(std::string message);
    std::vector<std::string> stream_urls_locked() const;

    OnlineRadioConfig cfg_;
    std::filesystem::path ffmpeg_path_;
    std::unique_ptr<Pipe> pipe_;

    mutable std::mutex mu_;
    size_t current_station_idx_ = 0;
    std::string target_url_;
    std::string target_name_;
    std::string target_logo_;
    std::vector<std::string> target_alternate_urls_;
    std::size_t active_url_index_ = 0;
    uint32_t recovery_attempt_ = 0;
    uint32_t max_recovery_attempts_ = 5;
    bool retry_pending_ = false;
    std::chrono::steady_clock::time_point retry_at_{};
    std::chrono::steady_clock::time_point healthy_since_{};
    RecoveryStatus recovery_;

    // dynamic metadata state
    std::string current_title_;
    std::string current_artist_;
    std::string current_logo_;             // station favicon, reported as artwork_url
    std::deque<std::string> song_history_; // newest first, capped

    std::atomic<PlaybackState> state_{PlaybackState::stopped};
    EqualizerStage eq_;
    std::atomic<bool> volume_norm_{true};
    std::atomic<uint64_t> position_ms_{0};

    worker::WorkerClient* worker_ = nullptr;
};

} // namespace fh6::sources
