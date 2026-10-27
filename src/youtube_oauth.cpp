#include "fh6/youtube_oauth.hpp"

#include "fh6/subprocess.hpp"

#include <nlohmann/json.hpp>

#include <windows.h>
#include <wincrypt.h>
#include <winhttp.h>
#include <shellapi.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <iterator>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace fh6::youtube_oauth {

namespace {

using json = nlohmann::json;

struct InternetHandle {
    HINTERNET value = nullptr;
    ~InternetHandle() { if (value) WinHttpCloseHandle(value); }
    InternetHandle(const InternetHandle&) = delete;
    InternetHandle& operator=(const InternetHandle&) = delete;
    explicit InternetHandle(HINTERNET h) : value(h) {}
};

struct HttpResponse {
    DWORD status = 0;
    std::string body;
};

std::optional<HttpResponse> https_request(std::string_view method, std::string_view url,
                                          std::string_view headers = {},
                                          std::string_view body = {}) {
    const auto wide_url = subprocess::widen(url);
    URL_COMPONENTS components{};
    components.dwStructSize = sizeof(components);
    components.dwHostNameLength = static_cast<DWORD>(-1);
    components.dwUrlPathLength = static_cast<DWORD>(-1);
    components.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(wide_url.c_str(), 0, 0, &components) ||
        components.nScheme != INTERNET_SCHEME_HTTPS) return std::nullopt;

    std::wstring host{components.lpszHostName, components.dwHostNameLength};
    std::wstring target;
    if (components.dwUrlPathLength)
        target.assign(components.lpszUrlPath, components.dwUrlPathLength);
    else
        target = L"/";
    if (components.dwExtraInfoLength)
        target.append(components.lpszExtraInfo, components.dwExtraInfoLength);

    InternetHandle session{WinHttpOpen(L"FH6 Universal Radio/1.0",
                                        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    if (!session.value) return std::nullopt;
    WinHttpSetTimeouts(session.value, 5000, 10000, 10000, 20000);

    InternetHandle connection{WinHttpConnect(session.value, host.c_str(), components.nPort, 0)};
    if (!connection.value) return std::nullopt;
    const auto wide_method = subprocess::widen(method);
    InternetHandle request{WinHttpOpenRequest(connection.value, wide_method.c_str(), target.c_str(),
                                               nullptr, WINHTTP_NO_REFERER,
                                               WINHTTP_DEFAULT_ACCEPT_TYPES,
                                               WINHTTP_FLAG_SECURE)};
    if (!request.value) return std::nullopt;

    const auto wide_headers = subprocess::widen(headers);
    const auto body_size = static_cast<DWORD>(body.size());
    if (!WinHttpSendRequest(request.value,
                            wide_headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : wide_headers.c_str(),
                            wide_headers.empty() ? 0 : static_cast<DWORD>(wide_headers.size()),
                            body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
                            body_size, body_size, 0) ||
        !WinHttpReceiveResponse(request.value, nullptr)) return std::nullopt;

    HttpResponse response;
    DWORD status_size = sizeof(response.status);
    if (!WinHttpQueryHeaders(request.value,
                             WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &response.status, &status_size,
                             WINHTTP_NO_HEADER_INDEX)) return std::nullopt;

    constexpr size_t max_body_size = 4 * 1024 * 1024;
    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request.value, &available)) return std::nullopt;
        if (!available) break;
        if (available > max_body_size - response.body.size()) return std::nullopt;
        std::vector<char> chunk(available);
        DWORD received = 0;
        if (!WinHttpReadData(request.value, chunk.data(), available, &received))
            return std::nullopt;
        response.body.append(chunk.data(), received);
        if (!received) break;
    }
    return response;
}

std::string base64url(const unsigned char* bytes, size_t size) {
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    out.reserve((size * 4 + 2) / 3);
    for (size_t i = 0; i < size; i += 3) {
        const unsigned int a = bytes[i];
        const unsigned int b = i + 1 < size ? bytes[i + 1] : 0;
        const unsigned int c = i + 2 < size ? bytes[i + 2] : 0;
        const unsigned int value = (a << 16) | (b << 8) | c;
        out.push_back(alphabet[(value >> 18) & 0x3f]);
        out.push_back(alphabet[(value >> 12) & 0x3f]);
        if (i + 1 < size) out.push_back(alphabet[(value >> 6) & 0x3f]);
        if (i + 2 < size) out.push_back(alphabet[value & 0x3f]);
    }
    return out;
}

std::optional<std::string> random_token(size_t size) {
    std::vector<unsigned char> bytes(size);
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) return std::nullopt;
    return base64url(bytes.data(), bytes.size());
}

std::optional<std::string> sha256_base64url(std::string_view value) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0)
        return std::nullopt;
    DWORD object_size = 0;
    DWORD returned = 0;
    if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                          reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size),
                          &returned, 0) != 0) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return std::nullopt;
    }
    std::vector<unsigned char> object(object_size);
    std::array<unsigned char, 32> digest{};
    BCRYPT_HASH_HANDLE hash = nullptr;
    bool ok = BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) == 0;
    if (ok) ok = BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())),
                                static_cast<ULONG>(value.size()), 0) == 0;
    if (ok) ok = BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0;
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!ok) return std::nullopt;
    return base64url(digest.data(), digest.size());
}

std::string url_encode(std::string_view value) {
    static constexpr char hex[] = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : value) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 0x0f]);
        }
    }
    return out;
}

std::string url_decode(std::string_view value) {
    auto hex_value = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    std::string out;
    out.reserve(value.size());
    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '+' ) {
            out.push_back(' ');
        } else if (value[i] == '%' && i + 2 < value.size()) {
            const int hi = hex_value(value[i + 1]);
            const int lo = hex_value(value[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
            } else {
                out.push_back(value[i]);
            }
        } else {
            out.push_back(value[i]);
        }
    }
    return out;
}

std::unordered_map<std::string, std::string> parse_query(std::string_view query) {
    std::unordered_map<std::string, std::string> values;
    if (const auto q = query.find('?'); q != std::string_view::npos) query.remove_prefix(q + 1);
    while (!query.empty()) {
        const auto amp = query.find('&');
        const auto pair = query.substr(0, amp);
        const auto equal = pair.find('=');
        values[url_decode(pair.substr(0, equal))] =
            equal == std::string_view::npos ? std::string{} : url_decode(pair.substr(equal + 1));
        if (amp == std::string_view::npos) break;
        query.remove_prefix(amp + 1);
    }
    return values;
}

std::optional<std::string> load_refresh_token(const std::filesystem::path& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) return std::nullopt;
    std::vector<unsigned char> encrypted{std::istreambuf_iterator<char>{in},
                                         std::istreambuf_iterator<char>{}};
    if (encrypted.empty() || encrypted.size() > 64 * 1024) return std::nullopt;
    DATA_BLOB input{static_cast<DWORD>(encrypted.size()), encrypted.data()};
    DATA_BLOB output{};
    if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                            CRYPTPROTECT_UI_FORBIDDEN, &output)) return std::nullopt;
    std::string token(reinterpret_cast<char*>(output.pbData), output.cbData);
    SecureZeroMemory(output.pbData, output.cbData);
    LocalFree(output.pbData);
    if (token.empty()) return std::nullopt;
    return token;
}

bool save_refresh_token(const std::filesystem::path& file, std::string_view token) {
    DATA_BLOB input{static_cast<DWORD>(token.size()),
                    reinterpret_cast<BYTE*>(const_cast<char*>(token.data()))};
    DATA_BLOB output{};
    if (!CryptProtectData(&input, L"FH6 YouTube OAuth refresh token", nullptr, nullptr,
                          nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) return false;
    std::error_code ec;
    std::filesystem::create_directories(file.parent_path(), ec);
    const auto temp = file.wstring() + L".tmp";
    HANDLE handle = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                FILE_ATTRIBUTE_HIDDEN, nullptr);
    bool ok = handle != INVALID_HANDLE_VALUE;
    if (ok) {
        DWORD written = 0;
        ok = WriteFile(handle, output.pbData, output.cbData, &written, nullptr) &&
             written == output.cbData;
        FlushFileBuffers(handle);
        CloseHandle(handle);
    }
    if (ok) ok = MoveFileExW(temp.c_str(), file.c_str(),
                             MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
    if (!ok) DeleteFileW(temp.c_str());
    SecureZeroMemory(output.pbData, output.cbData);
    LocalFree(output.pbData);
    return ok;
}

std::string google_error(const json& payload, std::string fallback) {
    try {
        if (payload.contains("error")) {
            const auto& e = payload.at("error");
            if (e.is_object() && e.contains("message")) return e.at("message").get<std::string>();
            if (e.is_string()) return e.get<std::string>();
        }
    } catch (...) {}
    return fallback;
}

} // namespace

Client::Client(std::filesystem::path token_file) : token_file_{std::move(token_file)} {}

bool Client::connected() const {
    std::scoped_lock lk{mu_};
    return load_refresh_token(token_file_).has_value();
}

Result Client::start(std::string client_id, uint16_t callback_port) {
    std::scoped_lock lk{mu_};
    if (client_id.empty()) return {false, "Enter a Google OAuth Desktop client ID first."};
    if (callback_port == 0) return {false, "The local HTTP server is not ready."};
    auto state = random_token(32);
    auto verifier = random_token(32);
    if (!state || !verifier) return {false, "Could not create secure OAuth values."};
    auto challenge = sha256_base64url(*verifier);
    if (!challenge) return {false, "Could not prepare secure OAuth verification."};

    pending_state_ = *state;
    pending_verifier_ = *verifier;
    pending_client_id_ = std::move(client_id);
    pending_port_ = callback_port;
    const auto redirect = "http://127.0.0.1:" + std::to_string(callback_port) + "/";
    const auto authorize_url =
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=" +
        url_encode(pending_client_id_) + "&redirect_uri=" + url_encode(redirect) +
        "&scope=" + url_encode("https://www.googleapis.com/auth/youtube.readonly") +
        "&access_type=offline&prompt=consent&state=" + url_encode(pending_state_) +
        "&code_challenge=" + url_encode(*challenge) + "&code_challenge_method=S256";
    const auto wide_url = subprocess::widen(authorize_url);
    const auto opened = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", wide_url.c_str(),
                                                                 nullptr, nullptr, SW_SHOWNORMAL));
    if (opened <= 32) {
        pending_state_.clear();
        pending_verifier_.clear();
        pending_client_id_.clear();
        return {false, "Could not open the system browser for Google sign-in."};
    }
    return {true, "Google sign-in opened in the browser on the game PC."};
}

Result Client::complete(std::string_view query) {
    std::scoped_lock lk{mu_};
    auto params = parse_query(query);
    const auto state = params.find("state");
    if (pending_state_.empty() || state == params.end() || state->second != pending_state_) {
        return {false, "This Google sign-in request expired or failed its security check."};
    }
    if (auto e = params.find("error"); e != params.end()) {
        pending_state_.clear();
        pending_verifier_.clear();
        pending_client_id_.clear();
        return {false, e->second == "access_denied" ? "Google sign-in was cancelled."
                                                     : "Google sign-in did not complete."};
    }
    const auto code = params.find("code");
    if (code == params.end() || code->second.empty()) return {false, "Google did not return an authorization code."};
    const auto redirect = "http://127.0.0.1:" + std::to_string(pending_port_) + "/";
    const auto fields = "code=" + url_encode(code->second) +
                        "&client_id=" + url_encode(pending_client_id_) +
                        "&code_verifier=" + url_encode(pending_verifier_) +
                        "&grant_type=authorization_code&redirect_uri=" + url_encode(redirect);
    auto response = https_request("POST", "https://oauth2.googleapis.com/token",
                                  "Content-Type: application/x-www-form-urlencoded\r\n", fields);
    std::string message;
    if (!response) {
        message = "Could not reach Google OAuth. Check the network connection and try again.";
    } else {
        json payload;
        try { payload = json::parse(response->body); }
        catch (...) { payload = json::object(); }
        if (response->status < 200 || response->status >= 300) {
            message = payload.value("error_description", payload.value("error", "Google sign-in failed."));
        } else {
            const auto refresh = payload.value("refresh_token", std::string{});
            if (refresh.empty()) {
                message = "Google did not return a refresh token. Revoke this app in your Google account and try again.";
            } else if (!save_refresh_token(token_file_, refresh)) {
                message = "Sign-in worked, but the encrypted refresh token could not be saved.";
            } else {
                message = "YouTube account connected. You can close this browser tab.";
            }
        }
    }
    pending_state_.clear();
    pending_verifier_.clear();
    pending_client_id_.clear();
    return {message == "YouTube account connected. You can close this browser tab.", std::move(message)};
}

std::optional<std::vector<Playlist>> Client::list_owned_playlists(std::string_view client_id,
                                                                   std::string& error) const {
    std::scoped_lock lk{mu_};
    auto refresh = load_refresh_token(token_file_);
    if (!refresh) {
        error = "Connect your YouTube account first.";
        return std::nullopt;
    }
    const auto fields = "client_id=" + url_encode(client_id) + "&grant_type=refresh_token&refresh_token=" +
                        url_encode(*refresh);
    auto response = https_request("POST", "https://oauth2.googleapis.com/token",
                                  "Content-Type: application/x-www-form-urlencoded\r\n", fields);
    SecureZeroMemory(refresh->data(), refresh->size());
    if (!response) {
        error = "Could not reach Google OAuth. Check the network connection and try again.";
        return std::nullopt;
    }
    json token_payload;
    try { token_payload = json::parse(response->body); }
    catch (...) {
        error = "Google returned an unreadable OAuth response.";
        return std::nullopt;
    }
    if (response->status < 200 || response->status >= 300) {
        error = token_payload.value("error_description", token_payload.value("error", "YouTube sign-in expired. Connect the account again."));
        return std::nullopt;
    }
    const auto access = token_payload.value("access_token", std::string{});
    if (access.empty()) {
        error = "Google did not return an access token.";
        return std::nullopt;
    }

    std::vector<Playlist> playlists;
    std::string page_token;
    for (size_t page = 0; page < 200; ++page) {
        std::string url = "https://youtube.googleapis.com/youtube/v3/playlists?part=snippet%2CcontentDetails&mine=true&maxResults=50";
        if (!page_token.empty()) url += "&pageToken=" + url_encode(page_token);
        const auto headers = "Authorization: Bearer " + access + "\r\nAccept: application/json\r\n";
        auto page_response = https_request("GET", url, headers);
        if (!page_response) {
            error = "Could not reach the YouTube Data API.";
            return std::nullopt;
        }
        json payload;
        try { payload = json::parse(page_response->body); }
        catch (...) {
            error = "YouTube returned an unreadable playlist response.";
            return std::nullopt;
        }
        if (page_response->status < 200 || page_response->status >= 300) {
            error = google_error(payload, "Could not list YouTube playlists. Check that YouTube Data API v3 is enabled for this Google project.");
            return std::nullopt;
        }
        try {
            for (const auto& item : payload.value("items", json::array())) {
                Playlist playlist;
                playlist.id = item.value("id", std::string{});
                playlist.title = item.value("snippet", json::object()).value("title", std::string{});
                playlist.item_count = item.value("contentDetails", json::object()).value("itemCount", size_t{});
                if (!playlist.id.empty()) playlists.push_back(std::move(playlist));
            }
            page_token = payload.value("nextPageToken", std::string{});
        } catch (...) {
            error = "YouTube returned an invalid playlist response.";
            return std::nullopt;
        }
        if (page_token.empty()) return playlists;
    }
    error = "This account has more than 10,000 playlists; the result was stopped at the API page limit.";
    return std::nullopt;
}

void Client::disconnect() noexcept {
    std::scoped_lock lk{mu_};
    DeleteFileW(token_file_.c_str());
    pending_state_.clear();
    pending_verifier_.clear();
    pending_client_id_.clear();
}

} // namespace fh6::youtube_oauth
