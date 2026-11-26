#include "single_instance.h"

#include <sddl.h>

#include <iterator>
#include <memory>
#include <vector>

namespace {

class ScopedHandle {
 public:
  explicit ScopedHandle(HANDLE handle) : handle_(handle) {}
  ~ScopedHandle() {
    if (handle_ != nullptr) {
      ::CloseHandle(handle_);
    }
  }

  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  HANDLE get() const { return handle_; }

 private:
  HANDLE handle_;
};

struct LocalFreeDeleter {
  void operator()(void* memory) const { ::LocalFree(memory); }
};

}  // namespace

SingleInstanceGuard::SingleInstanceGuard() {
  HANDLE raw_token = nullptr;
  if (!::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &raw_token)) {
    SetError(L"Read the Windows user token", ::GetLastError());
    return;
  }
  const ScopedHandle token(raw_token);

  DWORD token_size = 0;
  ::GetTokenInformation(token.get(), TokenUser, nullptr, 0, &token_size);
  const DWORD token_size_error = ::GetLastError();
  if (token_size_error != ERROR_INSUFFICIENT_BUFFER || token_size == 0) {
    SetError(L"Read the Windows user identity",
             token_size_error == ERROR_SUCCESS ? ERROR_INVALID_DATA
                                              : token_size_error);
    return;
  }

  std::vector<BYTE> token_data(token_size);
  if (!::GetTokenInformation(token.get(), TokenUser, token_data.data(),
                             token_size, &token_size)) {
    SetError(L"Read the Windows user identity", ::GetLastError());
    return;
  }
  const auto* token_user =
      reinterpret_cast<const TOKEN_USER*>(token_data.data());
  LPWSTR raw_sid = nullptr;
  if (!::ConvertSidToStringSidW(token_user->User.Sid, &raw_sid)) {
    SetError(L"Identify the Windows user", ::GetLastError());
    return;
  }
  const std::unique_ptr<wchar_t, LocalFreeDeleter> sid(raw_sid);

  // Snapshots and outboxes are cached in memory: concurrent app processes can
  // overwrite each other's encrypted files. Hold this user-specific kernel
  // object before Flutter opens the vault, across Windows sessions. Windows
  // removes it when the last handle closes, including after a process crash.
  const std::wstring mutex_name =
      std::wstring(L"Global\\ClinchOwner.SingleInstance.") + sid.get();
  mutex_ = ::CreateMutexW(nullptr, FALSE, mutex_name.c_str());
  const DWORD mutex_error = ::GetLastError();
  if (mutex_ == nullptr) {
    SetError(L"Create the single-instance guard", mutex_error);
    return;
  }
  status_ = mutex_error == ERROR_ALREADY_EXISTS ? Status::kAlreadyRunning
                                               : Status::kPrimary;
}

SingleInstanceGuard::~SingleInstanceGuard() {
  if (mutex_ != nullptr) {
    ::CloseHandle(mutex_);
  }
}

void SingleInstanceGuard::ActivateExistingWindow() {
  const HWND window = ::FindWindowW(L"FLUTTER_RUNNER_WIN32_WINDOW",
                                    kClinchOwnerWindowTitle);
  // A concurrent first launch may still be initializing its window. It already
  // holds the guard, so the second launch must exit without opening the vault.
  if (window == nullptr || !::IsWindowVisible(window)) {
    return;
  }
  if (::IsIconic(window)) {
    ::ShowWindowAsync(window, SW_RESTORE);
  }
  ::SetForegroundWindow(window);
}

void SingleInstanceGuard::SetError(const wchar_t* operation, DWORD error) {
  error_message_ =
      L"Clinch Owner could not establish its single-instance guard, so it "
      L"did not open your data.\n\n";
  error_message_ += operation;
  error_message_ += L". Windows error ";
  error_message_ += std::to_wstring(error);
  wchar_t system_message[512] = {};
  if (::FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                       nullptr, error, 0, system_message,
                       static_cast<DWORD>(std::size(system_message)),
                       nullptr) != 0) {
    error_message_ += L": ";
    error_message_ += system_message;
  }
}
