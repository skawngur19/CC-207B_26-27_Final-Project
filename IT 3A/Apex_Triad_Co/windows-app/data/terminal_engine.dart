import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import '../core/bridge_protocol.dart';
import '../core/outbox.dart';
import 'terminal_ledger.dart';

class TerminalEngine {
  TerminalEngine(
      {required this.settings,
      required this.ledger,
      required this.endpoint,
      required this.seal,
      required this.open,
      required this.cloud,
      required this.loadKey,
      required this.canSync,
      required this.printLines,
      required this.changed,
      this.port = 8765});
  final QueueStore settings;
  final TerminalLedger ledger;
  final String endpoint;
  final Future<String> Function(String, Json) seal;
  final Future<Json> Function(String, String) open;
  final Future<Json> Function(Json) cloud;
  final Future<Json> Function() loadKey;
  final bool Function() canSync;
  final Future<void> Function(List<String>) printLines;
  final void Function() changed;
  final int port;
  Json _config = {};
  final Map<String, PairCipher> _pairs = {};
  HttpServer? _server;
  Future<void>? _starting, _draining;
  bool _printing = false, _disposed = false;
  int _active = 0;
  String? notice;
  String get terminalId => _config['terminalId'] ?? '';
  String get origin => _config['origin'] ?? '';
  bool get listening => _server != null;
  bool get autoPrint => _config['autoPrint'] == true;
  List<String> get operators => _pairs.keys.toList();
  int get pending => ledger.pendingCount;
  List<Json> get recent => ledger.recent(30);
  void _update() {
    if (!_disposed) changed();
  }

  Future<void> initialize() async {
    _config = await settings.read() ?? {};
    if (_config.isNotEmpty && _config['endpoint'] != endpoint) {
      final savedPairs = _config['pairs'];
      if (ledger.pendingCount > 0 ||
          (savedPairs is Map && savedPairs.isNotEmpty)) {
        throw StateError(
            'Restore the original terminal API address before opening paired or pending receipts.');
      }
      await _save({..._config, 'endpoint': endpoint});
    }
    if (_config.isEmpty) {
      await _save({
        'terminalId': randomTerminalId(),
        'endpoint': endpoint,
        'pairs': <String, dynamic>{}
      });
    }
    for (final e in (_config['pairs'] as Map).entries) {
      _pairs[e.key as String] = PairCipher(e.key as String, e.value as String);
    }
    if (_pairs.isNotEmpty) await listen();
  }

  Future<void> _save(Json next) async {
    await settings.write(next);
    _config = next;
  }

  Future<String> pair(String operatorId) async {
    if (!canSync()) {
      throw StateError('Sign in as the Owner to pair this terminal.');
    }
    final key = await loadKey();
    final rawOrigin = key['publicOrigin'] as String;
    final uri = Uri.parse(rawOrigin);
    if (uri.origin != rawOrigin ||
        uri.userInfo.isNotEmpty ||
        !(uri.scheme == 'https' ||
            (uri.scheme == 'http' &&
                ['localhost', '127.0.0.1'].contains(uri.host)))) {
      throw StateError(
          'The server must advertise the exact trusted POS origin.');
    }
    if (base64Url
            .decode(base64Url.normalize(key['publicKey'] as String))
            .length !=
        32) {
      throw StateError('Invalid server verification key.');
    }
    final old = Map<String, dynamic>.from(_config['pairs'] as Map);
    if (old.isNotEmpty &&
        (rawOrigin != origin || key['publicKey'] != _config['publicKey'])) {
      throw StateError(
          'Server identity changed. Remove the existing pairings before trusting a new server key.');
    }
    final rand = Random.secure();
    final secret = base64Url
        .encode(List.generate(32, (_) => rand.nextInt(256)))
        .replaceAll('=', '');
    await _save({
      ..._config,
      'origin': rawOrigin,
      'publicKey': key['publicKey'],
      'pairs': {...old, operatorId: secret}
    });
    _pairs[operatorId] = PairCipher(operatorId, secret);
    await listen();
    _update();
    return secret;
  }

  Future<void> unpair(String operatorId) async {
    final next = Map<String, dynamic>.from(_config['pairs'] as Map)
      ..remove(operatorId);
    await _save({..._config, 'pairs': next});
    _pairs.remove(operatorId);
    if (_pairs.isEmpty) {
      final server = _server;
      _server = null;
      await server?.close(force: true);
    }
    _update();
  }

  Future<void> setAutoPrint(bool value) async {
    await _save({..._config, 'autoPrint': value});
    if (value) unawaited(_autoPrint());
    _update();
  }

  Future<void> listen() =>
      _starting ??= _bind().whenComplete(() => _starting = null);
  Future<void> _bind() async {
    if (_disposed || listening || _pairs.isEmpty) return;
    try {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port,
          shared: false);
      if (_disposed || _pairs.isEmpty) {
        await server.close(force: true);
        return;
      }
      server.idleTimeout = const Duration(seconds: 6);
      server.autoCompress = false;
      _server = server;
      notice = null;
      server.listen((r) => unawaited(_handle(r)), onError: (Object _) {
        notice = 'Connection interrupted. Reconnect the terminal.';
        _update();
      }, onDone: () {
        if (identical(_server, server)) {
          _server = null;
          _update();
        }
      });
    } on SocketException {
      notice =
          'Local port $port is unavailable. Close the conflicting application and retry.';
    }
    _update();
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    res.headers.set('Cache-Control', 'no-store');
    Json? reply;
    _active++;
    try {
      if (req.headers.value('host') != '127.0.0.1:$port' ||
          req.headers.value('origin') != origin ||
          origin.isEmpty) {
        throw const _BridgeError(403, 'Unpaired origin.');
      }
      res.headers.set('Access-Control-Allow-Origin', origin);
      res.headers.set('Vary', 'Origin');
      if (_active > 16) throw const _BridgeError(429, 'Terminal busy.');
      if (!['/v1/hello', '/v1/receipts'].contains(req.uri.path)) {
        throw const _BridgeError(404, 'Unknown bridge route.');
      }
      if (req.method == 'OPTIONS') {
        res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
        res.headers.set('Access-Control-Max-Age', '600');
        res.statusCode = 204;
      } else if (req.method == 'GET' && req.uri.path == '/v1/hello') {
        final operator = req.uri.queryParameters['operatorId'];
        final nonce = req.uri.queryParameters['nonce'] ?? '';
        final cipher = _pairs[operator];
        if (cipher == null ||
            !RegExp(r'^[a-zA-Z0-9_-]{32,128}$').hasMatch(nonce)) {
          throw const _BridgeError(
              403, 'Pair this operator in the Windows app.');
        }
        reply = {
          'terminalId': terminalId,
          'operatorId': operator,
          'mode': 'connected',
          'proof': await cipher.hello(nonce, terminalId)
        };
      } else if (req.method == 'POST' && req.uri.path == '/v1/receipts') {
        if (req.headers.contentType?.mimeType != 'application/json') {
          throw const _BridgeError(415, 'JSON required.');
        }
        const cap = 96 * 1024;
        if (req.contentLength > cap) {
          throw const _BridgeError(413, 'Receipt too large.');
        }
        final bytes = <int>[];
        await for (final chunk in req.timeout(const Duration(seconds: 5))) {
          if (bytes.length + chunk.length > cap) {
            throw const _BridgeError(413, 'Receipt too large.');
          }
          bytes.addAll(chunk);
        }
        final box = jsonDecode(utf8.decode(bytes)) as Json;
        final cipher = _pairs[box['operatorId']];
        if (cipher == null) {
          throw const _BridgeError(
              403, 'Pair this operator in the Windows app.');
        }
        final envelope = await cipher.decrypt(box);
        final ack = await _admit(envelope, cipher);
        reply = await cipher.encrypt({...ack, 'nonce': box['iv']});
      } else {
        throw const _BridgeError(405, 'Method not supported.');
      }
    } on _BridgeError catch (e) {
      res.statusCode = e.status;
      reply = {'error': e.message};
    } on FileSystemException {
      res.statusCode = 507;
      reply = {
        'error': 'Terminal storage is unavailable. Keep the browser copy.'
      };
    } catch (_) {
      res.statusCode = 400;
      reply = {
        'error':
            'Receipt could not be authenticated or saved. Keep the browser copy.'
      };
    } finally {
      _active--;
      try {
        if (reply != null) {
          res.headers.contentType = ContentType.json;
          res.write(jsonEncode(reply));
        }
        await res.close();
      } catch (_) {/* Browser will retry with the same ID. */}
    }
  }

  Future<Json> _admit(Json envelope, PairCipher cipher) async {
    await validateGrant(envelope,
        operatorId: cipher.operatorId,
        terminalId: terminalId,
        origin: origin,
        publicKey: _config['publicKey']);
    final receipt = envelope['receipt'] as Json;
    final id = receipt['operationId'] as String;
    final digest = await receiptDigest(receipt);
    final encrypted = await seal('receipt:$id', envelope);
    if (_disposed || !identical(cipher, _pairs[cipher.operatorId])) {
      throw const _BridgeError(403, 'Pairing changed.');
    }
    // No await between lookup and insert. A second request can safely arrive
    // while the first is encrypting, including from a second browser tab.
    final prior = ledger.find(id);
    if (prior != null && prior['digest'] != digest) {
      throw const _BridgeError(409,
          'Receipt ID already has different details. Owner review required.');
    }
    if (prior == null) {
      ledger.insert(id, digest, encrypted);
      _update();
      unawaited(drain());
      if (autoPrint) unawaited(_autoPrint());
    }
    return {
      'durable': true,
      'receiptId': id,
      'status': prior?['status'] ?? 'pending'
    };
  }

  Future<void> drain() =>
      _draining ??= _sync().whenComplete(() => _draining = null);
  Future<void> _sync() async {
    if (_disposed || !canSync()) return;
    try {
      for (final row in ledger.nextPending(50)) {
        if (_disposed || !canSync()) break;
        final id = row['id'] as String;
        final envelope = await open('receipt:$id', row['envelope']);
        final result = await cloud(envelope);
        if (result['id'] != id ||
            !['accepted', 'conflict'].contains(result['status'])) {
          throw StateError('Cloud confirmation did not match the receipt.');
        }
        final encoded = await seal('result:$id', result);
        if (_disposed) return;
        ledger.mark(id, result['status'], encoded);
      }
    } catch (_) {
      notice =
          'Pending browser receipts are stored on this terminal. Cloud reconciliation will retry.';
    }
    _update();
  }

  Future<Json> details(String id) async {
    final row = ledger.find(id)!;
    final envelope = await open('receipt:$id', row['envelope']);
    return {
      ...row,
      'receipt': envelope['receipt'],
      if (row['result'] != null)
        'cloudResult': await open('result:$id', row['result'])
    };
  }

  Future<void> printReceipt(String id, {required bool reprint}) async {
    if (_disposed || !canSync()) {
      throw StateError('Unlock this terminal to print.');
    }
    final row = ledger.find(id);
    if (row == null ||
        (row['printing'] != 'waiting' && !reprint) ||
        _printing) {
      throw StateError('Check the previous print status first.');
    }
    _printing = true;
    try {
      ledger.printState(id, 'printing');
      final data = await details(id);
      final receipt = data['receipt'] as Json;
      final lines = (receipt['items'] as List).cast<Json>();
      int total =
          receipt['bookingId'] == null ? 0 : receipt['bookingTotal'] as int;
      for (final entry in lines) {
        total += (entry['quantity'] as int) * (entry['unitPrice'] as int);
      }
      String pesos(int cents) => 'PHP ${(cents / 100).toStringAsFixed(2)}';
      await printLines([
        'CLINCH STUDY HUB',
        if (reprint) 'REPRINT',
        data['status'] == 'accepted'
            ? 'Cash receipt'
            : 'Local cash record (${data['status']})',
        id,
        'Sale time: ${receipt['occurredAt']}',
        'Shift: ${receipt['shiftId']}',
        '',
        for (final entry in lines)
          "${entry['quantity']} x ${entry['productId']} @ ${pesos(entry['unitPrice'])}",
        if (receipt['bookingId'] != null)
          "Booking: ${receipt['bookingId']}  ${pesos(receipt['bookingTotal'] ?? 0)}",
        'Total: ${pesos(total)}',
        'Cash: ${pesos(receipt['tendered'])}',
        'Change: ${pesos(receipt['tendered'] - total)}'
      ]);
      if (!_disposed) ledger.printState(id, 'spooled');
    } catch (_) {
      if (!_disposed) ledger.printState(id, 'uncertain');
      rethrow;
    } finally {
      _printing = false;
      _update();
    }
  }

  Future<void> _autoPrint() async {
    if (_disposed || _printing || !canSync() || !autoPrint) return;
    for (final row in ledger.nextWaiting(10)) {
      if (_disposed || !canSync() || !autoPrint) break;
      try {
        await printReceipt(row['id'], reprint: false);
      } catch (_) {
        notice = 'Check the printer and the previous job before reprinting.';
        _update();
        break;
      }
    }
  }

  Future<void> tick() async {
    await listen();
    await drain();
    await _autoPrint();
  }

  void dispose() {
    _disposed = true;
    unawaited(_server?.close(force: true));
    ledger.close();
  }
}

class _BridgeError implements Exception {
  const _BridgeError(this.status, this.message);
  final int status;
  final String message;
}
