#pragma once

// Small single-thread job runner used by sources that need to resolve a
// playlist (network / yt-dlp) without blocking the HTTP workers or the audio
// pump. At most one job runs at a time; submitting a new job replaces one that
// has not started yet. Callers compare their own generation counter inside the
// job to discard results that a newer request superseded.

#include "fh6/log.hpp"

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

namespace fh6 {

class BackgroundWorker {
public:
    explicit BackgroundWorker(std::string name) : name_{std::move(name)} {
        thread_ = std::thread([this] { run(); });
    }

    ~BackgroundWorker() { stop(); }

    BackgroundWorker(const BackgroundWorker&)            = delete;
    BackgroundWorker& operator=(const BackgroundWorker&) = delete;

    // Replaces any job that has not started yet. Returns the new generation;
    // jobs are not passed the generation automatically (the caller captures
    // its own request id).
    std::uint64_t submit(std::function<void()> job) {
        std::scoped_lock lk{mu_};
        pending_job_ = std::move(job);
        pending_     = true;
        const auto gen = ++generation_;
        cv_.notify_one();
        return gen;
    }

    // Drop the queued job (the running one, if any, is left to finish and must
    // discard its own result via the caller's generation check).
    void cancel_pending() {
        std::scoped_lock lk{mu_};
        pending_job_ = nullptr;
        pending_     = false;
        ++generation_;
        cv_.notify_all();
    }

    bool busy() const {
        std::scoped_lock lk{mu_};
        return pending_ || running_;
    }

    // Stops the worker and waits for a running job to finish. Idempotent.
    void stop() noexcept {
        {
            std::scoped_lock lk{mu_};
            if (stopping_) return;
            stopping_    = true;
            pending_job_ = nullptr;
            pending_     = false;
        }
        cv_.notify_all();
        if (thread_.joinable() && std::this_thread::get_id() != thread_.get_id())
            thread_.join();
    }

private:
    void run() {
        for (;;) {
            std::function<void()> job;
            {
                std::unique_lock lk{mu_};
                cv_.wait(lk, [&] { return stopping_ || pending_; });
                if (stopping_) return;
                job          = std::move(pending_job_);
                pending_job_ = nullptr;
                pending_     = false;
                running_     = true;
            }

            try {
                if (job) job();
            } catch (const std::exception& e) {
                log::warn("[{}] background job failed: {}", name_, e.what());
            } catch (...) {
                log::warn("[{}] background job failed", name_);
            }

            {
                std::scoped_lock lk{mu_};
                running_ = false;
            }
            cv_.notify_all();
        }
    }

    std::string name_;
    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::function<void()> pending_job_;
    std::thread thread_;
    std::uint64_t generation_ = 0;
    bool pending_             = false;
    bool running_             = false;
    bool stopping_            = false;
};

} // namespace fh6
