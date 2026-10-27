#include "fh6/sources/jellyfin_source.hpp"
#include "fh6/log.hpp"
#include "fh6/net/http_get.hpp"
#include "fh6/subprocess.hpp"

#include <nlohmann/json.hpp>

#include <windows.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <format>
#include <optional>
#include <random>
#include <string>
#include <utility>
#include <vector>

namespace fh6::sources {

namespace {

using subprocess::create_kill_on_close_job;
using subprocess::describe_launch_failure;
using subprocess::open_nul;
using subprocess::open_stderr_log;
using subprocess::quote;
using subprocess::spawn_in_job;
using subprocess::widen;

// PCM contract written by ffmpeg: 48000 Hz * 2 ch * 2 bytes.
constexpr std::uint64_t kPcmBytesPerSec = 48000ull * 2ull * 2ull;

bool config_complete(const JellyfinConfig& c) noexcept {
    return !c.server_url.empty() && !c.api_key.empty() && !c.user_id.empty() &&
           (!c.stations.empty());
}

bool same_saved_tracks(const std::vector<SavedTrack>& a, const std::vector<SavedTrack>& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i) {
        const auto& x = a[i];
        const auto& y = b[i];
        if (x.id != y.id || x.title != y.title || x.artist != y.artist ||
            x.album != y.album || x.image_tag != y.image_tag || x.duration_ms != y.duration_ms)
            return false;
    }
    return true;
}

// Fields that determine which playlist gets fetched. `shuffle` deliberately
// omitted -- it doesn't require a re-query.
bool same_query_target(const JellyfinConfig& a, const JellyfinConfig& b) {
    if (a.server_url != b.server_url || a.api_key != b.api_key || a.user_id != b.user_id)
        return false;
    auto get_target = [](const JellyfinConfig& c) {
        for (const auto& s : c.stations) if (s.name == c.active_station) return s;
        return c.stations.empty() ? JellyfinStation{} : c.stations.front();
    };
    auto ta = get_target(a), tb = get_target(b);
    return ta.name == tb.name && ta.playlist_id == tb.playlist_id &&
           ta.use_favorites == tb.use_favorites && same_saved_tracks(ta.tracks, tb.tracks);
}

std::optional<std::string> http_get(const JellyfinConfig& cfg, const std::string& path) {
    // Reject control characters in the API key so a malformed value cannot
    // break out of the Authorization header (header injection).
    if (cfg.api_key.find_first_of("\r\n\"") != std::string::npos) {
        log::error("[jellyfin] api_key contains invalid characters");
        return std::nullopt;
    }
    const auto auth = std::format("Authorization: MediaBrowser Token=\"{}\"", cfg.api_key);
    return net::http_get(cfg.server_url + path, auth);
}

std::optional<std::vector<JellyfinTrack>> fetch_tracks(const JellyfinConfig& cfg, const std::string& target_id, bool use_favs) {
    if (!use_favs && target_id.empty()) {
        log::warn("[jellyfin] playlist_id required when use_favorites=false");
        return std::nullopt;
    }
    std::string path;
    if (use_favs) {
        path = std::format("/Users/{}/Items?Filters=IsFavorite&IncludeItemTypes=Audio&Recursive=true", cfg.user_id);
    } else {
        path = std::format("/Users/{}/Items?ParentId={}&Filters=IsNotFolder", cfg.user_id, target_id);
    }
    auto body = http_get(cfg, path);
    if (!body) return std::nullopt;

    std::vector<JellyfinTrack> out;
    try {
        const auto root  = nlohmann::json::parse(*body);
        const auto items = root.find("Items");
        if (items == root.end() || !items->is_array()) {
            log::error("[jellyfin] response missing Items array");
            return std::nullopt;
        }
        out.reserve(items->size());
        std::size_t og_idx = 0;
        for (const auto& item : *items) {
            JellyfinTrack t;
            t.id = item.value("Id", "");
            if (t.id.empty()) continue;
            t.title = item.value("Name", "Unknown Track");
            if (auto aa = item.find("AlbumArtist"); aa != item.end() && aa->is_string()) {
                t.artist = aa->get<std::string>();
            } else if (auto ar = item.find("Artists"); ar != item.end() && ar->is_array() &&
                                                       !ar->empty() && ar->front().is_string()) {
                t.artist = ar->front().get<std::string>();
            }
            t.album = item.value("Album", "");
            if (auto it = item.find("ImageTags");
                it != item.end() && it->is_object() && it->contains("Primary"))
                t.image_tag = it->value("Primary", "");
            if (auto r = item.find("RunTimeTicks"); r != item.end() && r->is_number_unsigned())
                t.duration_ms = r->get<std::uint64_t>() / 10'000u; // 10000 ticks = 1 ms
            t.original_index = og_idx++;
            out.push_back(std::move(t));
        }
    } catch (const std::exception& e) {
        log::error("[jellyfin] JSON parse error: {}", e.what());
        return std::nullopt;
    }
    log::info("[jellyfin] fetched {} track(s)", out.size());
    return out;
}

void shuffle_range(std::vector<JellyfinTrack>& q, std::size_t from) {
    if (from >= q.size() || q.size() - from < 2) return;
    static thread_local std::mt19937 rng{std::random_device{}()};
    std::shuffle(q.begin() + (std::ptrdiff_t)from, q.end(), rng);
}

// Per-source HTTP serializer; held outside mu_ across the network round-trip.
std::mutex& fetch_serializer() {
    static std::mutex m;
    return m;
}

} // namespace

struct JellyfinSource::Pipe {
    // -- worker mode: worker manages child processes --
    worker::WorkerClient* worker = nullptr;
    uint32_t pipeline_id = 0;

    // -- direct mode: DLL manages child processes (fallback) --
    HANDLE job       = nullptr;
    HANDLE proc      = nullptr;

    // -- shared: data pipe handle --
    HANDLE read_pipe = nullptr;
    std::uint64_t bytes_written = 0;
    std::atomic<std::uint64_t> position_ms{0};
    bool ended                = false;
    std::size_t for_queue_idx = 0;

    ~Pipe() {
        if (read_pipe) { CloseHandle(read_pipe); read_pipe = nullptr; }
        if (worker && pipeline_id) worker->kill_pipeline(pipeline_id);

        subprocess::reap(proc); // direct-mode child (no-op in worker mode)
        if (job) CloseHandle(job);
    }
};

JellyfinSource::JellyfinSource(JellyfinConfig cfg, std::filesystem::path ffmpeg_path,
                               worker::WorkerClient* worker)
    : cfg_{std::move(cfg)}, ffmpeg_path_{std::move(ffmpeg_path)}, worker_{worker} {}

JellyfinSource::~JellyfinSource() {
    {
        std::scoped_lock lk{mu_};
        invalidate_queue_locked();
        discard_prefetch_locked();
        stop_pipe_locked();
    }
    resolver_.stop();
}

bool JellyfinSource::initialize() {
    if (!cfg_.enabled) return false;
    if (!config_complete(cfg_)) return true; // tile visible; user can fill fields later

    std::scoped_lock lk{mu_};
    if (cfg_.active_station.empty() && !cfg_.stations.empty())
        cfg_.active_station = cfg_.stations.front().name;
    // Populate the queue without blocking startup; the scan runs on the
    // resolver thread and the dashboard can already issue requests.
    ensure_queue_locked();
    return true;
}

void JellyfinSource::shutdown() noexcept {
    {
        std::scoped_lock lk{mu_};
        invalidate_queue_locked();
        discard_prefetch_locked();
        stop_pipe_locked();
    }
    resolver_.stop();
}

std::unique_ptr<JellyfinSource::Pipe> JellyfinSource::spawn_pipe_locked(std::size_t for_idx) {
    if (queue_.empty() || for_idx >= queue_.size()) return nullptr;

    auto pipe           = std::make_unique<Pipe>();
    pipe->for_queue_idx = for_idx;
    const std::wstring auth_header = widen(std::format(
        "Authorization: MediaBrowser Token=\"{}\"\r\n", cfg_.api_key));

    const std::wstring ff = ffmpeg_path_.empty() ? std::wstring{L"ffmpeg"}
                                                 : ffmpeg_path_.wstring();
    const std::string stream_url = std::format("{}/Audio/{}/stream?static=true",
                                                cfg_.server_url, queue_[for_idx].id);

    std::wstring cmd = quote(ff) +
        L" -loglevel error -headers " + quote(auth_header) +
        L" -i " + quote(widen(stream_url)) + L" -f s16le ";
    if (volume_norm_.load(std::memory_order_acquire))
        cmd += L"-af loudnorm=I=-14:TP=-2:LRA=11 ";
    cmd += L"-acodec pcm_s16le -ar 48000 -ac 2 pipe:1";

    if (worker_ && worker_->alive()) {
        if (auto result = worker_->spawn_single(cmd); result.ok) {
            pipe->worker      = worker_;
            pipe->pipeline_id = result.pipeline_id;
            pipe->read_pipe   = result.pcm_pipe;
            return pipe;
        }
        log::warn("[jellyfin] worker spawn failed for {} -- falling back to direct spawn",
                  queue_[for_idx].id);
    }

    pipe->job = create_kill_on_close_job();
    if (!pipe->job) {
        log::warn("[jellyfin] CreateJobObject failed ({})", GetLastError());
        return nullptr;
    }

    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE out_r = nullptr, out_w = nullptr;
    if (!CreatePipe(&out_r, &out_w, &sa, 1 << 20)) return nullptr;
    SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);

    HANDLE nul_in  = open_nul(GENERIC_READ);
    HANDLE err_log = open_stderr_log();

    pipe->proc = spawn_in_job(pipe->job, cmd, nul_in, out_w, err_log);
    const DWORD ec = pipe->proc ? 0u : GetLastError();
    CloseHandle(out_w);
    if (nul_in) CloseHandle(nul_in);
    if (err_log) CloseHandle(err_log);
    if (!pipe->proc) {
        CloseHandle(out_r);
        log::warn("[jellyfin] failed to launch ffmpeg -- {}",
                  describe_launch_failure(ff, ec, !ffmpeg_path_.empty()));
        return nullptr; // ~Pipe reaps the job
    }

    pipe->read_pipe = out_r;
    return pipe;
}

std::string JellyfinSource::queue_key_locked() const {
    if (!target_playlist_.empty()) {
        if (target_playlist_ == "FAVORITES") return "\x01cast:favorites";
        return "\x01cast:" + target_playlist_;
    }
    const JellyfinStation* st = active_station_locked();
    if (!st) return {};
    if (st->playlist_id.empty() && !st->use_favorites && !st->tracks.empty())
        return "\x01saved:" + st->name;
    if (st->use_favorites) return "\x01station:favorites:" + st->name;
    if (st->playlist_id.empty()) return {};
    return "\x01station:" + st->name + ":" + st->playlist_id;
}

void JellyfinSource::invalidate_queue_locked() {
    ++queue_request_gen_;
    queue_scanning_ = false;
    queue_error_.clear();
    queue_.clear();
    current_idx_ = 0;
    queue_built_for_.clear();
    resolver_.cancel_pending();
}

bool JellyfinSource::ensure_queue_locked() {
    if (queue_scanning_) return false;

    const JellyfinStation* station = nullptr;
    std::string target_id;
    bool use_favs = false;

    if (!target_playlist_.empty()) {
        use_favs  = target_playlist_ == "FAVORITES";
        target_id = use_favs ? std::string{} : target_playlist_;
    } else if ((station = active_station_locked()) != nullptr) {
        // A saved-queue station carries its own frozen list.
        if (station->playlist_id.empty() && !station->use_favorites &&
            !station->tracks.empty()) {
            const std::string key = "\x01saved:" + station->name;
            if (queue_built_for_ == key) return true;
            queue_.clear();
            current_idx_ = 0;
            queue_error_.clear();
            queue_scanning_ = false;
            queue_.reserve(station->tracks.size());
            for (std::size_t i = 0; i < station->tracks.size(); ++i) {
                const auto& t = station->tracks[i];
                queue_.push_back({t.id, t.title, t.artist, t.album, t.image_tag,
                                  t.duration_ms, i});
            }
            queue_built_for_ = key;
            return true;
        }
        target_id = station->playlist_id;
        use_favs  = station->use_favorites;
    }

    if (!use_favs && target_id.empty()) {
        queue_.clear();
        current_idx_ = 0;
        queue_built_for_.clear();
        queue_error_.clear();
        queue_scanning_ = false;
        return true;
    }

    const std::string key = queue_key_locked();
    if (queue_built_for_ == key) return true;

    // Kick a background HTTP fetch. HTTP workers and the audio pump stay
    // responsive; the queue becomes available on a later tick.
    queue_.clear();
    current_idx_ = 0;
    queue_built_for_.clear();
    queue_error_.clear();
    discard_prefetch_locked();

    const auto gen = ++queue_request_gen_;
    queue_scanning_ = true;
    JellyfinConfig cfg = cfg_;
    resolver_.submit([this, gen, key, cfg = std::move(cfg), target_id,
                      use_favs]() mutable {
        std::optional<std::vector<JellyfinTrack>> tracks;
        {
            std::scoped_lock fetch_lk{fetch_serializer()};
            tracks = fetch_tracks(cfg, target_id, use_favs);
        }

        std::scoped_lock lk{mu_};
        if (gen != queue_request_gen_) return; // superseded by a newer target/config

        queue_scanning_ = false;
        if (!tracks) {
            queue_error_ =
                "Could not load the Jellyfin queue. Check the server URL, API key, and station.";
            queue_built_for_ = key; // don't retry on every tick
            queue_.clear();
            current_idx_ = 0;
            if (state_.load(std::memory_order_acquire) == PlaybackState::buffering)
                state_.store(PlaybackState::stopped, std::memory_order_release);
            return;
        }

        queue_ = std::move(*tracks);
        current_idx_ = 0;
        if (cfg_.shuffle && queue_.size() > 1) {
            static thread_local std::mt19937 rng{std::random_device{}()};
            std::shuffle(queue_.begin(), queue_.end(), rng);
        }
        queue_built_for_ = key;
        queue_error_.clear();
        const auto st = state_.load(std::memory_order_acquire);
        if ((st == PlaybackState::buffering || st == PlaybackState::playing) &&
            !queue_.empty()) {
            start_pipe_locked();
            if (pipe_) state_.store(PlaybackState::playing, std::memory_order_release);
        }
    });
    return false;
}

void JellyfinSource::sync_play_state_locked() {
    if (pipe_)
        state_.store(PlaybackState::playing, std::memory_order_release);
    else if (queue_scanning_)
        state_.store(PlaybackState::buffering, std::memory_order_release);
}

void JellyfinSource::start_pipe_locked() {
    stop_pipe_locked();
    if (!ensure_queue_locked()) return; // scan running; state is set by the caller
    if (queue_.empty()) return;
    if (current_idx_ >= queue_.size()) current_idx_ = 0;
    pipe_ = spawn_pipe_locked(current_idx_);
    if (pipe_) state_.store(PlaybackState::buffering, std::memory_order_release);
}

void JellyfinSource::stop_pipe_locked() {
    // Symmetric with YT: prefetch is preserved across stop_pipe_locked() so a
    // pending promotion isn't dropped on re-spawn. stop()/shutdown() drop it
    // explicitly.
    pipe_.reset();
    state_.store(PlaybackState::stopped, std::memory_order_release);
}

void JellyfinSource::discard_prefetch_locked() noexcept { prefetch_.reset(); }

std::size_t JellyfinSource::next_queue_idx_locked() const noexcept {
    if (queue_.empty()) return 0;
    return (current_idx_ + 1) % queue_.size();
}

bool JellyfinSource::promote_prefetch_locked(std::size_t expected_idx) {
    if (!prefetch_ || prefetch_->for_queue_idx != expected_idx) {
        discard_prefetch_locked();
        return false;
    }
    pipe_ = std::move(prefetch_);
    return true;
}

void JellyfinSource::maybe_spawn_prefetch_locked() {
    if (!prebuffer_next_.load(std::memory_order_acquire)) return;
    if (prefetch_ || !pipe_ || queue_.size() < 2) return;
    // Match YT's threshold: ~0.5 s of PCM proves the current pipe is viable
    // before we commit a second ffmpeg.
    constexpr std::uint64_t kViableBytes = 96 * 1024;
    if (pipe_->bytes_written < kViableBytes) return;
    prefetch_ = spawn_pipe_locked(next_queue_idx_locked());
}

void JellyfinSource::advance_locked(std::ptrdiff_t step) {
    if (queue_.empty()) return;
    const auto n = (std::ptrdiff_t)queue_.size();
    auto i       = (std::ptrdiff_t)current_idx_ + step;
    current_idx_ = (std::size_t)(((i % n) + n) % n);
    if (step == 1 && promote_prefetch_locked(current_idx_)) {
        // Promoted: pipe_ is the pre-warmed pipeline, no fresh spawn needed.
    } else {
        discard_prefetch_locked(); // backwards step invalidates the prefetch
        start_pipe_locked();
    }
    if (pipe_) state_.store(PlaybackState::playing, std::memory_order_release);
}

void JellyfinSource::play() {
    std::scoped_lock lk{mu_};
    if (!pipe_) start_pipe_locked();
    sync_play_state_locked();
}

void JellyfinSource::pause() { state_.store(PlaybackState::paused, std::memory_order_release); }

void JellyfinSource::stop() {
    std::scoped_lock lk{mu_};
    ++queue_request_gen_;
    queue_scanning_ = false;
    resolver_.cancel_pending();
    discard_prefetch_locked();
    stop_pipe_locked();
    current_idx_ = 0;
}

void JellyfinSource::next() {
    std::scoped_lock lk{mu_};
    advance_locked(+1);
}
void JellyfinSource::previous() {
    std::scoped_lock lk{mu_};
    advance_locked(-1);
}

bool JellyfinSource::cast(std::string playlist_id, bool use_favorites) {
    std::scoped_lock lk{mu_};
    // Casting only requires the auth fields; the target is the playlist id.
    if (cfg_.server_url.empty() || cfg_.api_key.empty() || cfg_.user_id.empty())
        return false;

    target_playlist_ = use_favorites ? "FAVORITES" : std::move(playlist_id);
    invalidate_queue_locked();
    discard_prefetch_locked();
    stop_pipe_locked();
    start_pipe_locked(); // kicks the background fetch and buffers
    sync_play_state_locked();
    return true;
}

void JellyfinSource::set_config(JellyfinConfig cfg) {
    std::scoped_lock lk{mu_};

    const bool requery      = !same_query_target(cfg_, cfg);
    const bool shuffle_flip = cfg_.shuffle != cfg.shuffle;

    if (requery) {
        const auto st       = state_.load(std::memory_order_acquire);
        const bool resume   = st == PlaybackState::playing || st == PlaybackState::buffering;
        cfg_                = std::move(cfg);
        target_playlist_.clear();
        invalidate_queue_locked();
        discard_prefetch_locked();
        stop_pipe_locked();
        if (resume) {
            start_pipe_locked();
            sync_play_state_locked();
        }
        return;
    }

    cfg_ = std::move(cfg);
    if (!shuffle_flip) return;

    discard_prefetch_locked();
    if (cfg_.shuffle) {
        shuffle_range(queue_, current_idx_ + 1); // preserve the currently-playing track
    } else if (!queue_.empty()) {
        const std::size_t from =
            (current_idx_ >= queue_.size()) ? queue_.size() : (current_idx_ + 1);
        auto start = queue_.begin() + static_cast<std::ptrdiff_t>(from);
        if (start < queue_.end()) {
            std::sort(start, queue_.end(), [](const auto& a, const auto& b) {
                return a.original_index < b.original_index;
            });
        }
    }
}

void JellyfinSource::set_ffmpeg_path(std::filesystem::path p) {
    std::scoped_lock lk{mu_};
    ffmpeg_path_ = std::move(p);
}

void JellyfinSource::set_playback_options(const PlaybackConfig& opts) {
    {
        std::scoped_lock lk{mu_};
        eq_.set_options(opts.equalizer_enabled, opts.equalizer_bands, 48000.0f);
    }
    // loudnorm is in the ffmpeg argv; new state takes effect on the next track.
    volume_norm_.store(opts.volume_normalization, std::memory_order_release);
    const bool prev =
        prebuffer_next_.exchange(opts.prebuffer_next_track, std::memory_order_acq_rel);
    if (prev && !opts.prebuffer_next_track) {
        std::scoped_lock lk{mu_};
        discard_prefetch_locked();
    }
}

TrackInfo JellyfinSource::current_track() const {
    std::scoped_lock lk{mu_};
    TrackInfo info;
    if (queue_.empty() || current_idx_ >= queue_.size()) return info;
    const auto& t    = queue_[current_idx_];
    info.title       = t.title;
    info.artist      = t.artist;
    info.album       = t.album;
    info.duration_ms = t.duration_ms;
    // Public image endpoint; the tag scopes caching and proves a cover exists.
    if (!t.image_tag.empty() && !cfg_.server_url.empty()) {
        info.artwork_url = std::format("{}/Items/{}/Images/Primary?tag={}&fillWidth=480&quality=90",
                                       cfg_.server_url, t.id, t.image_tag);
    }
    if (pipe_) info.position_ms = pipe_->position_ms.load(std::memory_order_acquire);
    return info;
}

AuthState JellyfinSource::auth_state() const noexcept {
    std::scoped_lock lk{mu_};
    return config_complete(cfg_) ? AuthState::authenticated : AuthState::needs_auth;
}

void JellyfinSource::pump(RingBuffer& ring) {
    {
        const auto st = state_.load(std::memory_order_acquire);
        if (st != PlaybackState::playing && st != PlaybackState::buffering) return;
    }

    std::scoped_lock lk{mu_};
    Pipe* p = pipe_.get();
    if (!p) return;

    auto update_position = [&] {
        const std::size_t r        = ring.readable();
        const std::uint64_t played = p->bytes_written > r ? p->bytes_written - r : 0;
        p->position_ms.store(played * 1000ull / kPcmBytesPerSec, std::memory_order_release);
    };
    auto on_eof = [&] {
        if (p->read_pipe) {
            CloseHandle(p->read_pipe);
            p->read_pipe = nullptr;
        }
        p->ended = true;
    };

    if (p->ended) {
        update_position();
        if (ring.readable() == 0) advance_locked(+1);
        return;
    }
    if (!p->read_pipe) return;

    DWORD avail = 0;
    if (!PeekNamedPipe(p->read_pipe, nullptr, 0, nullptr, &avail, nullptr)) {
        on_eof();
        return;
    }
    while (avail > 0) {
        const std::size_t writable = ring.writable();
        if (writable < 4) break;
        std::size_t want = std::min<std::size_t>(writable, avail);
        if (want > 4096) want = 4096;
        want &= ~std::size_t{3}; // whole stereo s16 frames -- EQ never sees half a sample
        if (!want) break;

        std::byte buf[4096];
        DWORD got = 0;
        if (!ReadFile(p->read_pipe, buf, (DWORD)want, &got, nullptr) || got == 0) {
            on_eof();
            break;
        }
        const DWORD aligned = (got / 4u) * 4u;
        if (aligned) eq_.process(reinterpret_cast<int16_t*>(buf), aligned / 4u);
        ring.write(buf, aligned);
        p->bytes_written += aligned;
        avail             = avail > got ? avail - got : 0;
    }
    update_position();
    maybe_spawn_prefetch_locked();
}

const JellyfinStation* JellyfinSource::active_station_locked() const noexcept {
    if (cfg_.stations.empty()) return nullptr;
    for (const auto& s : cfg_.stations)
        if (s.name == cfg_.active_station) return &s;
    return &cfg_.stations.front();
}

void JellyfinSource::set_active_station(std::string name) {
    std::scoped_lock lk{mu_};
    if (cfg_.active_station == name && target_playlist_.empty()) return;

    const auto st     = state_.load(std::memory_order_acquire);
    const bool resume = st == PlaybackState::playing || st == PlaybackState::buffering;

    cfg_.active_station = std::move(name);
    target_playlist_.clear();
    invalidate_queue_locked();
    discard_prefetch_locked();
    stop_pipe_locked();
    if (resume) {
        start_pipe_locked();
        sync_play_state_locked();
    }
}

std::size_t JellyfinSource::station_count() const noexcept {
    std::scoped_lock lk{mu_};
    return cfg_.stations.size();
}

std::string JellyfinSource::active_station_name() const {
    std::scoped_lock lk{mu_};
    const JellyfinStation* st = active_station_locked();
    return st ? st->name : std::string{};
}

JellyfinSource::QueueSnapshot JellyfinSource::queue_snapshot() const {
    std::scoped_lock lk{mu_};
    QueueSnapshot snap;
    snap.cursor   = current_idx_;
    snap.scanning = queue_scanning_;
    snap.error    = queue_error_;
    snap.entries.reserve(queue_.size());
    for (std::size_t i = 0; i < queue_.size(); ++i) {
        QueueEntry e;
        e.index       = i;
        e.id          = queue_[i].id;
        e.title       = queue_[i].title;
        e.artist      = queue_[i].artist;
        e.album       = queue_[i].album;
        e.image_tag   = queue_[i].image_tag;
        e.duration_ms = queue_[i].duration_ms;
        snap.entries.push_back(std::move(e));
    }
    return snap;
}

JellyfinSource::QueueStatus JellyfinSource::queue_status() const {
    std::scoped_lock lk{mu_};
    return {current_idx_, queue_.size(), queue_scanning_, queue_error_};
}

bool JellyfinSource::jump_to(std::size_t index) {
    std::scoped_lock lk{mu_};
    if (index >= queue_.size()) return false;
    current_idx_ = index;
    if (!promote_prefetch_locked(current_idx_)) start_pipe_locked();
    sync_play_state_locked();
    return true;
}

bool JellyfinSource::move_queue_entry(std::size_t from, std::size_t to) {
    std::scoped_lock lk{mu_};
    if (from >= queue_.size() || to >= queue_.size()) return false;
    // Only the upcoming part is editable; the current track stays put.
    if (from <= current_idx_ || to <= current_idx_) return false;
    if (from == to) return true;
    auto entry = std::move(queue_[from]);
    queue_.erase(queue_.begin() + static_cast<std::ptrdiff_t>(from));
    queue_.insert(queue_.begin() + static_cast<std::ptrdiff_t>(to), std::move(entry));
    discard_prefetch_locked();
    return true;
}

bool JellyfinSource::remove_queue_entry(std::size_t index) {
    std::scoped_lock lk{mu_};
    if (index >= queue_.size() || index <= current_idx_) return false;
    queue_.erase(queue_.begin() + static_cast<std::ptrdiff_t>(index));
    discard_prefetch_locked();
    return true;
}

void JellyfinSource::set_shuffle(bool shuffle) {
    std::scoped_lock lk{mu_};
    cfg_.shuffle = shuffle;
    discard_prefetch_locked();

    const std::size_t from = std::min(current_idx_ + 1, queue_.size());
    if (shuffle) {
        shuffle_range(queue_, from);
    } else if (from < queue_.size()) {
        auto start = queue_.begin() + static_cast<std::ptrdiff_t>(from);
        std::sort(start, queue_.end(), [](const auto& a, const auto& b) {
            return a.original_index < b.original_index;
        });
    }
}

} // namespace fh6::sources
