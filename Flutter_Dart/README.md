# Clinch Owner

This is the **separate Flutter native Owner app**, with Android and Windows runners. The website lives in `../web/`. In connected mode, both clients use the shared Node API; the website is never embedded in this app.

## Try the Windows demo

Extract **[Clinch-Owner-Windows.zip](../artifacts/Clinch-Owner-Windows.zip)** and run `clinch_owner.exe`. Use **1234** for both email and password. No server, Flutter SDK, or development tools are needed. Keep every DLL and the `data` folder with the executable.

This Windows x64 release defaults to `CLINCH_DEMO_MODE=true`, with encrypted sample records on this device. Local demo records are separate from both connected-mode data and the website's browser demo. No iOS build was produced. See the [build and review record](../docs/windows-build-2026-11-15.md).

The black and warm-gold Material 3 interface adapts to phones, tablets and desktop. It includes an overview with collections/occupancy, reservations and walk-ins, online check-in/completion, product cash checkout with optional reservation collection, accepted receipts, transaction history, employee provisioning/deactivation, profile and audit activity.

## Development setup

Install Flutter stable and the relevant Android/Windows toolchain. The default demo needs no API. Start the API only for connected mode. From this directory:

Source analysis was verified with Flutter **3.47.7** and Dart **3.13.5**. The resolved lockfile requires Dart 3.13 or newer. Keep the lockfile when reproducing this setup.

```powershell
flutter pub get
flutter analyze
dart test/outbox_test.dart
dart test/lease_test.dart
dart test/receipts_test.dart
dart test/money_test.dart
dart test/demo_service_test.dart
dart test/demo_api_test.dart
dart test/snapshot_store_test.dart
dart test/pending_sales_test.dart
```

The packaged Windows executable accepts `--connected --api-origin=http://127.0.0.1:8787` at startup. Close the running demo first. Builds can also set defaults with `--dart-define=CLINCH_DEMO_MODE=false` and `--dart-define=CLINCH_API_URL=...`. Use an origin without a path, credentials, query or fragment. Non-loopback servers require HTTPS. Pair a cashier through **Sync center** and the website's **Profile → Pair Windows terminal**. See the [local terminal walkthrough](../README.md#try-the-connected-terminal-locally).

For an Android emulator connected to the host API, first use:

```powershell
adb reverse tcp:8787 tcp:8787
```

Keep `CLINCH_API_URL=http://127.0.0.1:8787` with this reverse tunnel. `10.0.2.2` does not satisfy the demo server's loopback Host restriction. Windows uses the default loopback URL directly. For a shared local website + debug app, start **Start Clinch Shared Demo.cmd** in this folder and run this app with `flutter run -d windows --dart-define=CLINCH_API_URL=http://127.0.0.1:8788`. The backend, website, and connected-demo data are all under this folder's `backend` subfolder. Use **View Connected Demo Login.cmd**, also in this folder, to retrieve the same generated credentials for both clients. The standalone browser demo's `1234` / `1234` credentials and `owner@clinch.local` account are not credentials for the connected API. Native login always sends `role: owner` and `client: native`, and server authorization remains mandatory.

## Offline and sync behavior in connected mode

- A first online owner login is mandatory. Passwords are never cached. An owner lease lasts at most eight hours from online login, capped by server session expiry. Reopening the app does not renew the lease. Expiry requires online reauthentication as the same owner; encrypted queued changes survive it.
- Reachability is verified against the API rather than Wi-Fi status. One automatic attempt runs every 45 seconds while unlocked. Each attempt checks the session, sends at most 50 pending operations once, and refreshes the snapshot. Manual sync is also available; no unbounded retry loop runs.
- The snapshot is the last authoritative server state. Queued bookings/sales remain visibly separate and pending. Local cash totals/change and inventory are estimates; the server validates prices, stock, versions, overlap and collection status before acceptance.
- A cryptographically random, immutable operation ID and payload are encrypted and flushed to disk before sending. A lost response retries the same ID after app restart. Durable enqueue completes the local cart workflow even if the immediate network request fails, preventing accidental second admission from that cart.
- Only accepted server receipts remove pending operations. Missing receipts, transport errors, conflicts and rejections preserve them. Retry reuses the original payload/ID. Booking conflicts support editing as a new operation; the old conflict remains until the owner explicitly discards it. Discard requires confirmation and never reverses a server sale; inspect server history first after an uncertain response.
- Queued intent is bound to both API origin and Owner identity. A different configuration or owner cannot claim it. Restore the original configuration and sign in as the original owner for recovery. A new database at the identical origin is an operational restore concern: preserve the server's idempotency database and do not reuse an origin for an unrelated business.
- Logout is blocked while any pending change exists. Offline account creation, employee management and booking status changes are unavailable. An expired or revoked session does not erase snapshot, outbox or encryption key.

## Local data security

`cryptography` uses AES-256-GCM with a fresh nonce and filename-specific authenticated data for each write. A random 256-bit key and bearer token live in OS storage through `flutter_secure_storage` (Android Keystore-backed encrypted preferences / Windows secure credential storage). The app saves the encrypted snapshot and outbox under the platform's application support directory. It writes a complete ciphertext into the same directory, flushes it, and renames it over the previous file. It does not delete the old snapshot first. Failed writes prevent admission or retain the existing in-memory queue.

Android backup is disabled and backup rules exclude secure preferences and encrypted app files. Local HTTP is enabled only by the debug manifest; the release manifest has no permissive cleartext setting. Release use requires HTTPS, platform release signing and operational server backups. Generated platform files are source scaffolding, not device verification.

The Android source includes Internet permission, a gold Clinch vector launcher mark, a dark splash, backup exclusions, and a debug-only cleartext exception for `localhost`/`127.0.0.1`. Release cleartext is disabled and release signing is deliberately unconfigured rather than using the debug key.

Do not clear app data, uninstall, remove OS credentials or delete encrypted files while pending operations exist. If the secure key is unavailable but encrypted files remain, the app stops and preserves them rather than generating a replacement key. An authenticated-encryption error also stops initialization instead of silently resetting data. OS credential loss cannot be repaired without that original key.

## Verification scope

The Windows release compiled successfully with Flutter 3.47.7 / Dart 3.13.5 and Visual Studio 2022 Build Tools. Final `dart analyze` reported **No issues found**, and all eight standalone Dart test runners passed. They cover durable queue behavior, leases, exact-operation receipts, bounded money parsing, local demo service/adapter rules, snapshot persistence and pending-sale aggregation. A console-only test also checked mutex acquisition, duplicate rejection and reacquisition after release using the actual Windows guard source.

One explicitly approved GUI-control session verified a local cash checkout: one ₱30 coffee, ₱100 tendered, ₱70 change, stock decreased by one and an accepted demo receipt displayed. This does not establish power-loss recovery, full accessibility, or behavior on every Windows device. Android remains source-only.

The packaged ZIP includes the Flutter/plugin DLLs and app-local Microsoft C++ runtime. All 24 manifested files passed SHA-256 verification against ZIP contents. Three temporary workspace plugin junctions were removed after compilation; their dependency targets and the required compiled DLLs remain. Windows Developer Mode was not changed. Regenerating Flutter plugin links on this host may still require an approved development setup. Ordinary testing of the packaged app needs no plugin links.
