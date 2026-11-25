// Console fixture for transport integration. All state is temporary and the
// only supported upstream is a loopback test server.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:cryptography/cryptography.dart';
import 'package:clinch_owner/core/outbox.dart';
import 'package:clinch_owner/data/terminal_engine.dart';
import 'package:clinch_owner/data/terminal_ledger.dart';

class _Settings implements QueueStore {
  _Settings(this.value);
  Json value;
  @override
  Future<Json?> read() async => value;
  @override
  Future<void> write(Json next) async {
    value = next;
  }
}

Future<void> main() async {
  final input = StreamIterator(
      stdin.transform(utf8.decoder).transform(const LineSplitter()));
  if (!await input.moveNext()) return;
  final config = jsonDecode(input.current) as Json;
  final uri = Uri.parse(config['apiOrigin']);
  if (uri.scheme != 'http' || uri.host != '127.0.0.1') {
    throw StateError('Loopback test API required.');
  }
  final temp = await Directory.systemTemp.createTemp('clinch-bridge-test-');
  final aes = AesGcm.with256bits();
  final key = await aes.newSecretKey();
  final client = HttpClient();
  var online = false;
  final settings = _Settings({
    'endpoint': uri.origin,
    'terminalId': config['terminalId'],
    'origin': config['origin'],
    'publicKey': config['publicKey'],
    'pairs': {config['operatorId']: config['secret']}
  });
  final engine = TerminalEngine(
      settings: settings,
      ledger: TerminalLedger.open('${temp.path}/ledger.sqlite'),
      endpoint: uri.origin,
      canSync: () => online,
      port: config['port'] ?? 8765,
      changed: () {},
      printLines: (_) => throw StateError('Fixture has no printer.'),
      loadKey: () async => config,
      seal: (label, data) async => base64.encode((await aes.encrypt(
              utf8.encode(jsonEncode(data)),
              secretKey: key,
              aad: utf8.encode(label)))
          .concatenation()),
      open: (label, str) async => jsonDecode(utf8.decode(await aes.decrypt(
          SecretBox.fromConcatenation(base64.decode(str),
              nonceLength: 12, macLength: 16),
          secretKey: key,
          aad: utf8.encode(label)))) as Json,
      cloud: (envelope) async {
        final request =
            await client.postUrl(uri.resolve('/api/terminal/receipts'));
        request.headers.contentType = ContentType.json;
        request.headers.set('Authorization', 'Bearer ${config['ownerToken']}');
        request.write(jsonEncode(envelope));
        final response = await request.close();
        final body =
            jsonDecode(await utf8.decoder.bind(response).join()) as Json;
        if (response.statusCode != 200) {
          throw StateError('Upstream status ${response.statusCode}');
        }
        return body;
      });
  try {
    await engine.initialize();
    stdout.writeln(
        jsonEncode({'listening': engine.listening, 'notice': engine.notice}));
    while (await input.moveNext()) {
      final command = jsonDecode(input.current) as Json;
      if (command['cmd'] == 'stop') break;
      if (command['cmd'] == 'sync') {
        online = true;
        await engine.drain();
      }
      stdout.writeln(jsonEncode({
        'pending': engine.pending,
        'rows': [
          for (final row in engine.recent)
            {'id': row['id'], 'status': row['status']}
        ]
      }));
    }
  } finally {
    engine.dispose();
    client.close(force: true);
    await input.cancel();
    await temp.delete(recursive: true);
  }
}
