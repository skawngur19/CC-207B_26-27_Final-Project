#ifndef RUNNER_SINGLE_INSTANCE_H_
#define RUNNER_SINGLE_INSTANCE_H_

#include <windows.h>

#include <string>

inline constexpr wchar_t kClinchOwnerWindowTitle[] = L"Clinch Owner";

class SingleInstanceGuard {
 public:
  enum class Status { kPrimary, kAlreadyRunning, kError };

  SingleInstanceGuard();
  ~SingleInstanceGuard();

  SingleInstanceGuard(const SingleInstanceGuard&) = delete;
  SingleInstanceGuard& operator=(const SingleInstanceGuard&) = delete;

  Status status() const { return status_; }
  const std::wstring& error_message() const { return error_message_; }

  static void ActivateExistingWindow();

 private:
  void SetError(const wchar_t* operation, DWORD error);

  HANDLE mutex_ = nullptr;
  Status status_ = Status::kError;
  std::wstring error_message_;
};

#endif  // RUNNER_SINGLE_INSTANCE_H_
