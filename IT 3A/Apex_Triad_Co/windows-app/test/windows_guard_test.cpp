#include "single_instance.h"

#include <iostream>
#include <memory>

int main() {
  auto first = std::make_unique<SingleInstanceGuard>();
  if (first->status() != SingleInstanceGuard::Status::kPrimary) {
    std::wcerr << first->error_message() << L"\n";
    return 1;
  }
  auto second = std::make_unique<SingleInstanceGuard>();
  if (second->status() != SingleInstanceGuard::Status::kAlreadyRunning) {
    std::cerr << "A second owner process could claim the same user data.\n";
    return 2;
  }
  second.reset();
  first.reset();
  const SingleInstanceGuard after_close;
  if (after_close.status() != SingleInstanceGuard::Status::kPrimary) {
    std::cerr << "The instance lock survived all handles closing.\n";
    return 3;
  }
  std::cout << "PASS Windows SID-scoped mutex: first claim, duplicate denial, automatic release\n";
  return 0;
}
