import 'dart:convert';
import 'dart:math';
import 'package:cryptography/cryptography.dart';
import 'outbox.dart';

String randomTerminalId() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  final hex = b.map((n) => n.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

String _hex(List<int> bytes) =>
    bytes.map((n) => n.toRadixString(16).padLeft(2, '0')).join();
List<int> _url(String value) => base64Url.decode(base64Url.normalize(value));

class PairCipher {
  PairCipher(this.operatorId, String secret)
      : _secret = SecretKey(utf8.encode(secret));
  final String operatorId;
  final SecretKey _secret;
  final _aes = AesGcm.with256bits();
  late final Future<SecretKey> _aesKey = _secret
      .extractBytes()
      .then((bytes) async => SecretKey((await Sha256().hash(bytes)).bytes));
  List<int> get _aad => utf8.encode('clinch-bridge-v1:$operatorId');

  Future<String> hello(String nonce, String terminalId) async {
    final mac = await Hmac.sha256().calculateMac(
        utf8.encode(
            'clinch-bridge-v1:$nonce:$terminalId:$operatorId:connected'),
        secretKey: _secret);
    return _hex(mac.bytes);
  }

  Future<Json> encrypt(Json body) async {
    final encrypted = await _aes.encrypt(utf8.encode(jsonEncode(body)),
        secretKey: await _aesKey, aad: _aad);
    return {
      'operatorId': operatorId,
      'iv': base64Encode(encrypted.nonce),
      'box': base64Encode(encrypted.concatenation(nonce: false))
    };
  }

  Future<Json> decrypt(Json wrapper) async {
    if (wrapper['operatorId'] != operatorId) {
      throw const FormatException('Invalid operator.');
    }
    final ivValue = wrapper['iv'];
    final boxValue = wrapper['box'];
    if (ivValue is! String || boxValue is! String) {
      throw const FormatException('Invalid sealed receipt.');
    }
    final iv = base64Decode(ivValue);
    final bytes = base64Decode(boxValue);
    if (iv.length != 12 || bytes.length <= 16) {
      throw const FormatException('Invalid sealed receipt.');
    }
    final box = SecretBox(bytes.sublist(0, bytes.length - 16),
        nonce: iv, mac: Mac(bytes.sublist(bytes.length - 16)));
    final data = await _aes.decrypt(box, secretKey: await _aesKey, aad: _aad);
    final decoded = jsonDecode(utf8.decode(data));
    if (decoded is! Json) {
      throw const FormatException('Invalid sealed receipt.');
    }
    return decoded;
  }
}

Future<void> validateGrant(Json envelope,
    {required String operatorId,
    required String terminalId,
    required String origin,
    required String publicKey}) async {
  final grant = envelope['grant'];
  final receipt = envelope['receipt'];
  if (receipt is! Json || grant is! String || grant.length > 8000) {
    throw const FormatException('Missing sale grant.');
  }
  final parts = grant.split('.');
  if (parts.length != 2) throw const FormatException('Invalid sale grant.');
  final valid = await Ed25519().verify(ascii.encode(parts.first),
      signature: Signature(_url(parts.last),
          publicKey:
              SimplePublicKey(_url(publicKey), type: KeyPairType.ed25519)));
  if (!valid) {
    throw const FormatException(
        'The server did not authorize this sale grant.');
  }
  final decodedClaims = jsonDecode(utf8.decode(_url(parts.first)));
  if (decodedClaims is! Json) {
    throw const FormatException('Invalid sale grant.');
  }
  final claims = decodedClaims;
  final occurredAt = receipt['occurredAt'];
  if (occurredAt is! String || !occurredAt.endsWith('Z')) {
    throw const FormatException('Invalid cash receipt.');
  }
  final time = DateTime.tryParse(occurredAt)?.toUtc();
  final issuedAt = claims['issuedAt'];
  final expiresAt = claims['expiresAt'];
  final issued =
      issuedAt is String ? DateTime.tryParse(issuedAt)?.toUtc() : null;
  final expires =
      expiresAt is String ? DateTime.tryParse(expiresAt)?.toUtc() : null;
  if (claims['v'] != 1 ||
      !['owner', 'employee'].contains(claims['role']) ||
      claims['userId'] != operatorId ||
      receipt['operatorId'] != operatorId ||
      claims['terminalId'] != terminalId ||
      receipt['terminalId'] != terminalId ||
      claims['publicOrigin'] != origin ||
      time == null ||
      issued == null ||
      expires == null ||
      time.isBefore(issued) ||
      !time.isBefore(expires)) {
    throw const FormatException(
        'Grant does not cover this operator, terminal, origin or sale time.');
  }
  bool id(dynamic s) =>
      s is String && RegExp(r'^[a-zA-Z0-9_.:-]{1,128}$').hasMatch(s);
  bool between(dynamic n, int lo, int hi) => n is int && n >= lo && n <= hi;
  const maxCash = 100000000, maxSafe = 9007199254740991;
  if (receipt['method'] != 'cash' ||
      !id(receipt['operationId']) ||
      !id(receipt['shiftId']) ||
      !id(receipt['operatorId']) ||
      !id(receipt['terminalId']) ||
      receipt['items'] is! List ||
      (receipt['items'] as List).length > 30 ||
      ((receipt['items'] as List).isEmpty && receipt['bookingId'] == null) ||
      !between(receipt['tendered'], 0, maxCash) ||
      !between(receipt['sequence'], 1, maxSafe) ||
      !between(receipt['catalogVersion'], 1, maxSafe)) {
    throw const FormatException('Invalid cash receipt.');
  }
  var total = 0;
  final seen = <String>{};
  for (final item in receipt['items'] as List) {
    if (item is! Json ||
        !id(item['productId']) ||
        !seen.add(item['productId']) ||
        !between(item['quantity'], 1, 100) ||
        !between(item['unitPrice'], 0, maxCash)) {
      throw const FormatException('Invalid cash receipt line.');
    }
    total += (item['quantity'] as int) * (item['unitPrice'] as int);
  }
  if (receipt['bookingId'] != null) {
    if (!id(receipt['bookingId']) ||
        !between(receipt['bookingTotal'], 0, maxCash) ||
        !between(receipt['bookingVersion'], 1, 2147483647)) {
      throw const FormatException('Invalid reservation payment.');
    }
    total += receipt['bookingTotal'] as int;
  }
  if (receipt['tendered'] < total) {
    throw const FormatException('Cash tendered does not cover this sale.');
  }
}

dynamic _sorted(dynamic value) {
  if (value is List) return value.map(_sorted).toList();
  if (value is Json) {
    return {
      for (final key in value.keys.toList()..sort()) key: _sorted(value[key])
    };
  }
  return value;
}

Future<String> receiptDigest(Json receipt) async => _hex(
    (await Sha256().hash(utf8.encode(jsonEncode(_sorted(receipt))))).bytes);
