import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../core/lease.dart';
import '../core/outbox.dart';
import '../core/receipts.dart';
import '../core/snapshot_store.dart';
import 'api.dart';
import 'encrypted_store.dart';
import 'terminal_engine.dart';
import 'terminal_ledger.dart';
import 'windows_printer.dart';

class OwnerController extends ChangeNotifier {
  OwnerController(this.api);
  final Api api;
  late final Vault vault;
  TerminalEngine? terminal;
  late final Outbox outbox;
  late final QueueStore _cache;
  Json snapshot = {};
  Json? lastReceipt;
  String? _checkoutOperation;
  OwnerLease? _lease;
  Timer? _timer;
  Timer? _expiryTimer;
  bool ready = false, busy = false, online = false, locked = true;
  String? error, fatal;
  String? lastSync;
  String get endpoint => Uri.parse(api.baseUrl)
      .replace(path: '', query: null, fragment: null)
      .toString()
      .replaceAll(RegExp(r'/+$'), '');
  String get binding => '$endpoint|${snapshot['user']?['id']}';
  bool get accessible =>
      ready && !locked && (_lease?.allows(DateTime.now().toUtc()) ?? false);
  DateTime? get leaseExpiry => _lease?.expiresAt;
  List<Json> get pending => ready ? outbox.operations : [];
  int get pendingCount => ready ? outbox.count : 0;
  List<Json> records(String key) => ((snapshot[key] as List?) ?? [])
      .whereType<Map>()
      .map((v) => Map<String, dynamic>.from(v))
      .toList();

  Future<void> initialize() async {
    try {
      final uri = Uri.parse(api.baseUrl);
      if (!['http', 'https'].contains(uri.scheme) ||
          uri.host.isEmpty ||
          uri.userInfo.isNotEmpty ||
          uri.hasQuery ||
          uri.hasFragment ||
          (uri.path.isNotEmpty && uri.path != '/')) {
        throw StateError(
            'CLINCH_API_URL must be a server origin, without a path or credentials.');
      }
      if (uri.scheme != 'https' &&
          !['localhost', '127.0.0.1', '::1'].contains(uri.host)) {
        throw StateError('Use HTTPS for servers outside this device.');
      }
      var selected = await Vault.openAccounts();
      var cache = StableSnapshotStore(selected.store('snapshot'));
      var cached = await cache.read();
      if (selected.namespace.isEmpty && cached?['snapshot']?['demo'] == true) {
        selected = Vault(namespace: 'accounts');
        await selected.initialize();
        cache = StableSnapshotStore(selected.store('snapshot'));
        cached = await cache.read();
      }
      vault = selected;
      outbox = Outbox(vault.store('outbox'), newId: uniqueId);
      _cache = cache;
      await outbox.restore();
      if ((cached != null && cached['endpoint'] != endpoint) ||
          (outbox.ownerId != null &&
              !outbox.ownerId!.startsWith('$endpoint|'))) {
        throw StateError(
            'Saved work belongs to another API origin. Restore the original CLINCH_API_URL to recover it. No files were removed.');
      }
      if (cached != null) {
        snapshot = Map<String, dynamic>.from(cached['snapshot'] as Map);
        _lease = OwnerLease(DateTime.parse(cached['issuedAt'] as String),
            DateTime.parse(cached['expiresAt'] as String));
        locked = !(_lease!.allows(DateTime.now().toUtc()));
      }
      api.token = await vault.readToken();
      if (api.token == null) locked = true;
      if (Platform.isWindows) {
        terminal = TerminalEngine(
            settings: vault.store('terminal-settings'),
            ledger: TerminalLedger.open(vault.terminalDatabasePath),
            endpoint: endpoint,
            seal: vault.sealRecord,
            open: vault.openRecord,
            loadKey: () => api.call('/terminal/key'),
            canSync: () => accessible,
            cloud: _sendTerminalReceipt,
            printLines: spoolReceipt,
            changed: notifyListeners);
        await terminal!.initialize();
      }
      ready = true;
      _scheduleExpiry();
      _timer = Timer.periodic(const Duration(seconds: 45), (_) {
        if (!accessible) {
          locked = true;
          notifyListeners();
          return;
        }
        if (!busy) {
          unawaited(run(synchronize, quiet: true));
        }
      });
      if (accessible) {
        await run(synchronize, quiet: true);
      }
    } catch (e) {
      fatal = e.toString();
    }
    notifyListeners();
  }

  Future<bool> run(Future<void> Function() action, {bool quiet = false}) async {
    if (busy) return false;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await action();
      return true;
    } catch (e) {
      if (e is ApiFailure) {
        online = true;
        if (e.status == 401 || e.status == 403) locked = true;
      } else if (e is SocketException ||
          e is TimeoutException ||
          e is http.ClientException) {
        online = false;
      }
      if (!quiet || e is! SocketException) error = e.toString();
      return false;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<Json> _sendTerminalReceipt(Json envelope) async {
    try {
      return await api.call('/terminal/receipts', body: envelope);
    } on ApiFailure catch (e) {
      if (['INVALID_GRANT', 'INVALID_RECEIPT', 'FORBIDDEN'].contains(e.code) &&
          [400, 403].contains(e.status)) {
        // Preserve this cash record for review while allowing other valid
        // sales to progress. Transport and owner-session failures still retry.
        return {
          'id': envelope['receipt']['operationId'],
          'status': 'conflict',
          'code': e.code,
          'error': e.message
        };
      }
      rethrow;
    }
  }

  Future<void> login(String email, String password) async {
    final address = email.trim();
    final localDemoLogin = kDebugMode &&
        address == '1234' &&
        password == '1234' &&
        const ['localhost', '127.0.0.1', '::1']
            .contains(Uri.parse(api.baseUrl).host);
    if (!localDemoLogin &&
        (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(address) ||
            address.length > 254)) {
      throw const FormatException('Enter your Owner email address.');
    }
    if (password.isEmpty) throw const FormatException('Enter your password.');
    final response = await api.call('/login', body: {
      'role': 'owner',
      'email': address,
      'password': password,
      'client': 'native'
    });
    online = true;
    final user = response['user'] as Json;
    if (user['role'] != 'owner' || response['token'] is! String) {
      throw StateError('Only an online Owner session can open this app.');
    }
    final ownerBinding = '$endpoint|${user['id']}';
    if (outbox.ownerId != null &&
        outbox.ownerId != ownerBinding &&
        pendingCount > 0) {
      throw StateError(
          'Sign in as the original owner to recover the encrypted queue.');
    }
    api.token = response['token'] as String;
    try {
      final fresh = await api.call('/snapshot');
      final lease = OwnerLease.online(DateTime.now().toUtc(),
          DateTime.parse(response['expiresAt'] as String));
      await outbox.bindOwner(ownerBinding);
      await _cache.write({
        'endpoint': endpoint,
        'snapshot': fresh,
        'issuedAt': lease.issuedAt.toIso8601String(),
        'expiresAt': lease.expiresAt.toIso8601String()
      });
      await vault.writeToken(api.token!);
      snapshot = fresh;
      _lease = lease;
      locked = false;
      _scheduleExpiry();
    } catch (_) {
      api.token = null;
      locked = true;
      rethrow;
    }
    await synchronize();
  }

  void requireLease() {
    if (!accessible) {
      locked = true;
      throw StateError(
          'Your cached owner lease expired. Sign in online as the same owner; queued changes are preserved.');
    }
  }

  void enforceAccess() {
    if (_lease?.allows(DateTime.now().toUtc()) != true) locked = true;
    notifyListeners();
  }

  void _scheduleExpiry() {
    _expiryTimer?.cancel();
    if (_lease == null || locked) return;
    final delay = _lease!.expiresAt.difference(DateTime.now().toUtc());
    _expiryTimer =
        Timer(delay.isNegative ? Duration.zero : delay, enforceAccess);
  }

  Future<void> refresh() async {
    requireLease();
    final fresh = await api.call('/snapshot');
    online = true;
    if (fresh['user']?['role'] != 'owner' ||
        '$endpoint|${fresh['user']?['id']}' != outbox.ownerId) {
      locked = true;
      throw StateError(
          'Owner identity changed. Queued work remains encrypted for recovery.');
    }
    await _cache.write({
      'endpoint': endpoint,
      'snapshot': fresh,
      'issuedAt': _lease!.issuedAt.toIso8601String(),
      'expiresAt': _lease!.expiresAt.toIso8601String()
    });
    snapshot = fresh;
  }

  Future<void> synchronize() async {
    requireLease();
    final engine = terminal;
    if (engine != null) unawaited(engine.tick());
    // One batch per attempt; errors never cause an unbounded retry loop.
    final session = await api.call('/session');
    online = true;
    if (session['user']?['role'] != 'owner' ||
        '$endpoint|${session['user']?['id']}' != outbox.ownerId) {
      locked = true;
      throw StateError('Reauthenticate as the original owner.');
    }
    await outbox.sync((batch) async {
      final response = await api.call('/sync', body: {'operations': batch});
      if (_checkoutOperation != null) {
        lastReceipt = acceptedReceiptFor(
            _checkoutOperation!, response['results'] as List);
      }
      return response;
    });
    await refresh();
    lastSync = DateTime.now().toLocal().toString().substring(0, 19);
  }

  Future<void> submit(String type, Json payload) async {
    requireLease();
    final operation = await outbox.enqueue(type, payload);
    _checkoutOperation = type == 'sale' ? operation['id'] as String : null;
    lastReceipt = null;
    if (online) {
      try {
        await synchronize();
      } catch (e) {
        if (e is ApiFailure) {
          online = true;
          if (e.status == 401 || e.status == 403) locked = true;
        } else if (e is SocketException ||
            e is TimeoutException ||
            e is http.ClientException) {
          online = false;
        }
        error = 'Saved in the encrypted queue. Sync needs attention: $e';
      }
    }
  }

  Future<void> changeStatus(Json booking, String status) async {
    requireLease();
    await api.call('/bookings/${booking['id']}/status',
        body: {'status': status, 'version': booking['version']});
    online = true;
    await refresh();
  }

  Future<void> createEmployee(
      String name, String email, String password) async {
    requireLease();
    await api.call('/employees',
        body: {'name': name, 'email': email, 'password': password});
    online = true;
    await refresh();
  }

  Future<void> employeeStatus(String id, bool active) async {
    requireLease();
    await api.call('/employees/$id/status', body: {'active': active});
    await refresh();
  }

  Future<void> logout() async {
    if (pendingCount > 0) {
      throw StateError(
          'Resolve or explicitly discard each queued change before logging out.');
    }
    await api.call('/logout', body: {});
    await vault.clearToken();
    api.token = null;
    locked = true;
    online = false;
    // Invalidate cached access while keeping snapshot and key intact.
    _lease = OwnerLease(DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        DateTime.fromMillisecondsSinceEpoch(0, isUtc: true));
    await _cache.write({
      'endpoint': endpoint,
      'snapshot': snapshot,
      'issuedAt': _lease!.issuedAt.toIso8601String(),
      'expiresAt': _lease!.expiresAt.toIso8601String()
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _expiryTimer?.cancel();
    terminal?.dispose();
    api.dispose();
    super.dispose();
  }
}
