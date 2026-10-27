#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace fh6::youtube_oauth {

struct Playlist {
    std::string id;
    std::string title;
    std::size_t item_count = 0;
};

struct Result {
    bool ok = false;
    std::string message;
};

// OAuth client for listing the signed-in user's own YouTube playlists. Refresh
// tokens are stored as a DPAPI-protected blob in the application's data dir.
class Client {
public:
    explicit Client(std::filesystem::path token_file);

    bool connected() const;
    Result start(std::string client_id, uint16_t callback_port);
    Result complete(std::string_view query);
    std::optional<std::vector<Playlist>> list_owned_playlists(std::string_view client_id,
                                                               std::string& error) const;
    void disconnect() noexcept;

private:
    // HTTP workers may inspect/refresh OAuth state concurrently with the
    // dashboard's status poll; serialise the file and pending-flow state.
    mutable std::mutex mu_;
    std::filesystem::path token_file_;
    std::string pending_state_;
    std::string pending_verifier_;
    std::string pending_client_id_;
    uint16_t pending_port_ = 0;
};

} // namespace fh6::youtube_oauth
