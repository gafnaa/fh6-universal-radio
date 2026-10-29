#pragma once

#include "fh6/audio_source.hpp"
#include "fh6/background_worker.hpp"
#include "fh6/config.hpp"
#include "fh6/playback_dsp.hpp"
#include "fh6/ring_buffer.hpp"
#include "fh6/worker/worker_client.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace fh6::sources {

struct JellyfinTrack {
    std::string id;
    std::string title;
    std::string artist;
    std::string album;
    std::string image_tag; // ImageTags.Primary; empty when the item has no cover
    std::uint64_t duration_ms = 0;
     std::size_t original_index = 0;
};

// Resolves a Jellyfin playlist over HTTP, then streams each item through
// `ffmpeg -f s16le -ar 48000 -ac 2`. The PCM pipe is drained by pump() in
// non-blocking mode (PeekNamedPipe-gated) so a stalled HTTP stream can never
// freeze the AudioSourceManager pump loop.
class JellyfinSource final : public IAudioSource {
public:
    JellyfinSource(JellyfinConfig cfg, std::filesystem::path ffmpeg_path,
                   worker::WorkerClient* worker = nullptr,
                   std::filesystem::path queue_state_file = {});
    ~JellyfinSource() override;

    std::string_view name() const noexcept override { return "jellyfin"; }
    std::string_view display_name() const noexcept override { return "Jellyfin"; }

    bool initialize() override;
    bool shuffle() const { std::scoped_lock lk{mu_}; return cfg_.shuffle; }
    void shutdown() noexcept override;

    void play() override;
    void pause() override;
    void stop() override;
    void next() override;
    void previous() override;
    void pump(RingBuffer& ring) override;

    // Settings drawer hot-update; re-fetches when auth/url/playlist fields
    // change, re-shuffles in place when only `shuffle` flips.
    void set_config(JellyfinConfig cfg);
    void set_ffmpeg_path(std::filesystem::path p);

    void set_active_station(std::string name);
    void set_shuffle(bool shuffle);
    std::size_t station_count() const noexcept;
    std::string active_station_name() const;

    struct QueueEntry {
        std::size_t index = 0;
        std::string id;
        std::string title;
        std::string artist;
        std::string album;
        std::string image_tag;
        std::uint64_t duration_ms = 0;
    };
    struct QueueSnapshot {
        std::size_t cursor = 0;
        std::vector<QueueEntry> entries;
        bool scanning = false;
        std::string error;
    };
    struct QueueStatus {
        std::size_t cursor = 0;
        std::size_t size = 0;
        bool scanning = false;
        std::string error;
    };

    QueueSnapshot queue_snapshot() const;
    QueueStatus queue_status() const;
    bool jump_to(std::size_t index);
    bool move_queue_entry(std::size_t from, std::size_t to);
    bool remove_queue_entry(std::size_t index);

    // POST /api/source/jellyfin/cast: swap to a specific playlist id.
    // Returns false if the fetch fails (queue left untouched).
    bool cast(std::string playlist_id, bool use_favorites = false);

    void set_playback_options(const PlaybackConfig& opts) override;

    TrackInfo current_track() const override;
    PlaybackState playback_state() const noexcept override {
        return state_.load(std::memory_order_acquire);
    }
    RecoveryStatus recovery_status() const override;
    AuthState auth_state() const noexcept override;
    SourceCapabilities capabilities() const noexcept override { return {false, true, true}; }

private:
    struct Pipe;

    // mu_ held.
    bool ensure_queue_locked();  // true when ready; false while a background fetch runs
    std::string queue_key_locked() const;
    void invalidate_queue_locked();
    void sync_play_state_locked();
    std::unique_ptr<Pipe> spawn_pipe_locked(std::size_t for_idx);
    void start_pipe_locked();
    void stop_pipe_locked();
    void handle_stream_failure_locked(std::string message);
    void load_queue_state_locked();
    void persist_queue_state_locked() const;
    void discard_prefetch_locked() noexcept;
    bool promote_prefetch_locked(std::size_t expected_idx);
    void maybe_spawn_prefetch_locked();
    std::size_t next_queue_idx_locked() const noexcept;
    void advance_locked(std::ptrdiff_t step);

    const JellyfinStation* active_station_locked() const noexcept;

    JellyfinConfig cfg_;
    std::filesystem::path ffmpeg_path_;
    std::filesystem::path queue_state_file_;
    worker::WorkerClient* worker_;

    mutable std::mutex mu_;
    std::string target_playlist_; // one-off casting
    std::vector<JellyfinTrack> queue_;
    std::size_t current_idx_ = 0;
    std::string queue_built_for_;
    std::uint64_t queue_request_gen_ = 0;
    bool queue_scanning_             = false;
    std::string queue_error_;
    BackgroundWorker resolver_{"jellyfin-queue"};
    std::unique_ptr<Pipe> pipe_;
    std::unique_ptr<Pipe> prefetch_;
    int consecutive_failed_ = 0;
    int track_retry_attempt_ = 0;
    bool retry_pending_ = false;
    std::chrono::steady_clock::time_point retry_at_{};
    RecoveryStatus recovery_{};
    std::atomic<PlaybackState> state_{PlaybackState::stopped};

    EqualizerStage eq_;
    std::atomic<bool> volume_norm_{false};
    std::atomic<bool> prebuffer_next_{true};
};

} // namespace fh6::sources
