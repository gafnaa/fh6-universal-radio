#include "fh6/audio_source_manager.hpp"
#include "fh6/log.hpp"

namespace fh6 {

AudioSourceManager::AudioSourceManager(std::size_t ring_bytes) : ring_{ring_bytes} {}

void AudioSourceManager::register_source(std::unique_ptr<IAudioSource> src) {
    if (!src) return;
    std::scoped_lock lk{swap_mutex_};
    auto key = std::string{src->name()};
    log::info("[mgr] registered source '{}' ({})", key, src->display_name());
    sources_.insert_or_assign(std::move(key), std::move(src));
}

std::unique_ptr<IAudioSource> AudioSourceManager::unregister_source(std::string_view name) {
    std::scoped_lock lk{swap_mutex_};
    auto it = sources_.find(std::string{name});
    if (it == sources_.end()) return nullptr;

    auto removed = std::move(it->second);
    sources_.erase(it);

    if (active_.load(std::memory_order_acquire) == removed.get()) {
        removed->pause();
        ring_.drain();
        active_.store(nullptr, std::memory_order_release);
    }
    log::info("[mgr] unregistered source '{}'", removed->name());
    return removed;
}

bool AudioSourceManager::switch_to(std::string_view name) {
    std::scoped_lock lk{swap_mutex_};
    auto it = sources_.find(std::string{name});
    if (it == sources_.end()) {
        log::warn("[mgr] switch_to('{}'): unknown source", name);
        return false;
    }
    auto* next = it->second.get();
    auto* prev = active_.load(std::memory_order_acquire);
    if (prev == next) return true;

    if (prev) {
        prev->stop();
    }
    ring_.drain();
    next->play();
    active_.store(next, std::memory_order_release);
    log::info("[mgr] active source = '{}'", next->name());
    return true;
}

IAudioSource* AudioSourceManager::find(std::string_view name) const {
    std::scoped_lock lk{swap_mutex_};
    auto it = sources_.find(std::string{name});
    return it == sources_.end() ? nullptr : it->second.get();
}

std::vector<IAudioSource*> AudioSourceManager::sources_snapshot() const {
    std::scoped_lock lk{swap_mutex_};
    std::vector<IAudioSource*> out;
    out.reserve(sources_.size());
    for (const auto& [_, s] : sources_) out.push_back(s.get());
    return out;
}

void AudioSourceManager::pump_once() {
    // Lock so an unregister can't free the source mid-pump.
    std::scoped_lock lk{swap_mutex_};
    auto* a = active_.load(std::memory_order_acquire);
    if (!a) return;
    a->pump(ring_);

    const auto recovery = a->recovery_status();
    if (!auto_fallback_on_failure_ || !recovery.failed || fallback_source_.empty()) return;
    const auto it = sources_.find(fallback_source_);
    if (it == sources_.end() || it->second.get() == a) return;

    auto* fallback = it->second.get();
    last_fallback_event_ = FallbackEvent{++fallback_event_sequence_, std::string{a->name()},
                                         fallback_source_, recovery.message};
    a->stop();
    ring_.drain();
    fallback->play();
    active_.store(fallback, std::memory_order_release);
    log::warn("[mgr] source '{}' failed; switched to '{}': {}", a->name(), fallback_source_,
              recovery.message);
}

void AudioSourceManager::configure_auto_fallback(std::string source, bool enabled) {
    std::scoped_lock lk{swap_mutex_};
    fallback_source_ = std::move(source);
    auto_fallback_on_failure_ = enabled;
}

std::optional<AudioSourceManager::FallbackEvent> AudioSourceManager::last_fallback_event() const {
    std::scoped_lock lk{swap_mutex_};
    return last_fallback_event_;
}

void AudioSourceManager::shutdown() noexcept {
    std::scoped_lock lk{swap_mutex_};
    active_.store(nullptr, std::memory_order_release);
    for (auto& [_, s] : sources_) {
        try {
            s->shutdown();
        } catch (...) {}
    }
    sources_.clear();
}

} // namespace fh6
