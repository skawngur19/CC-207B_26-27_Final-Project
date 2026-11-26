import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import '../core/outbox.dart';

String uniqueId() {
  final random = Random.secure();
  return base64UrlEncode(List<int>.generate(24, (_) => random.nextInt(256)))
      .replaceAll('=', '');
}

class Vault {
  Vault({this.namespace = ''});
  final String namespace;
  String _storageKey(String type) =>
      namespace.isEmpty ? 'clinch.$type.v1' : 'clinch.$namespace.$type.v1';
  static const _secure = FlutterSecureStorage(
      aOptions: AndroidOptions(encryptedSharedPreferences: true));
  final AesGcm _cipher = AesGcm.with256bits();
  late Directory _directory;
  late SecretKey _key;

  Directory _location(Directory support) => Directory(
      '${support.path}${Platform.pathSeparator}clinch-owner${namespace.isEmpty ? '' : '-$namespace'}');

  // A past local test API could have used the original connected directory.
  // Once separated, always reopen the account workspace, even if its predecessor is moved.
  static Future<Vault> openAccounts() async {
    final support = await getApplicationSupportDirectory();
    final accounts = Vault(namespace: 'accounts');
    final chosen =
        await accounts._location(support).exists() ? accounts : Vault();
    await chosen.initialize(support);
    return chosen;
  }

  Future<void> initialize([Directory? support]) async {
    _directory = _location(support ?? await getApplicationSupportDirectory());
    await _directory.create(recursive: true);
    var encoded = await _secure.read(key: _storageKey('encryption-key'));
    if (encoded == null) {
      // Never replace a lost key while encrypted files exist.
      if (await _directory.list().any((entry) =>
          entry.path.endsWith('.enc') || entry.path.endsWith('.sqlite'))) {
        throw StateError(
            'The OS encryption key is unavailable. Keep cache files for recovery; do not reset storage.');
      }
      final bytes = List<int>.generate(32, (_) => Random.secure().nextInt(256));
      encoded = base64Encode(bytes);
      await _secure.write(key: _storageKey('encryption-key'), value: encoded);
    }
    _key = SecretKey(base64Decode(encoded));
  }

  QueueStore store(String name) => _EncryptedStore(this, name);
  String get terminalDatabasePath =>
      '${_directory.path}${Platform.pathSeparator}terminal.sqlite';

  Future<String> sealRecord(String label, Json record) async {
    final box = await _cipher.encrypt(utf8.encode(jsonEncode(record)),
        secretKey: _key, aad: utf8.encode('clinch-terminal-v1:$label'));
    return base64Encode(box.concatenation());
  }

  Future<Json> openRecord(String label, String encrypted) async {
    final box = SecretBox.fromConcatenation(base64Decode(encrypted),
        nonceLength: 12, macLength: 16);
    final clear = await _cipher.decrypt(box,
        secretKey: _key, aad: utf8.encode('clinch-terminal-v1:$label'));
    return jsonDecode(utf8.decode(clear)) as Json;
  }

  Future<String?> readToken() => _secure.read(key: _storageKey('bearer'));
  Future<void> writeToken(String value) =>
      _secure.write(key: _storageKey('bearer'), value: value);
  Future<void> clearToken() => _secure.delete(key: _storageKey('bearer'));

  Future<Json?> _read(String name) async {
    final target = File('${_directory.path}${Platform.pathSeparator}$name.enc');
    if (!await target.exists()) return null;
    final box = jsonDecode(await target.readAsString()) as Json;
    final clear = await _cipher.decrypt(
        SecretBox(base64Decode(box['ciphertext'] as String),
            nonce: base64Decode(box['nonce'] as String),
            mac: Mac(base64Decode(box['mac'] as String))),
        secretKey: _key,
        aad: utf8.encode('clinch-v1:$name'));
    return jsonDecode(utf8.decode(clear)) as Json;
  }

  Future<void> _write(String name, Json value) async {
    final box = await _cipher.encrypt(utf8.encode(jsonEncode(value)),
        secretKey: _key, aad: utf8.encode('clinch-v1:$name'));
    final encoded = jsonEncode({
      'version': 1,
      'nonce': base64Encode(box.nonce),
      'ciphertext': base64Encode(box.cipherText),
      'mac': base64Encode(box.mac.bytes)
    });
    final path = '${_directory.path}${Platform.pathSeparator}$name.enc';
    // Flush a complete ciphertext then rename in the same directory. Dart's
    // File.rename replaces an existing regular file on supported Android/Windows.
    final temporary = File('$path.${uniqueId()}.tmp');
    await temporary.writeAsString(encoded, flush: true);
    await temporary.rename(path);
  }
}

class _EncryptedStore implements QueueStore {
  _EncryptedStore(this.vault, this.name);
  final Vault vault;
  final String name;
  @override
  Future<Json?> read() => vault._read(name);
  @override
  Future<void> write(Json value) => vault._write(name, value);
}
