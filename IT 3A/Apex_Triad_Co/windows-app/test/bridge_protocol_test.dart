import 'dart:convert';
import 'dart:io';
import 'package:cryptography/cryptography.dart';
import 'package:clinch_owner/core/bridge_protocol.dart';
import 'package:clinch_owner/core/outbox.dart';

Future<void> rejected(Future<void> Function() op) async {
  try {
    await op();
  } catch (_) {
    return;
  }
  throw StateError('Invalid terminal record was accepted.');
}

Future<void> formatRejected(Future<void> Function() op) async {
  try {
    await op();
  } on FormatException {
    return;
  }
  throw StateError(
      'Malformed terminal data was not rejected as a format error.');
}

Future<void> main() async {
  final algorithm = Ed25519(), key = await Ed25519().newKeyPair();
  final public = base64Url.encode((await key.extractPublicKey()).bytes);
  const origin = 'https://study.example',
      operator = 'employee',
      terminal = 'terminal-1';
  final encoded = base64Url
      .encode(utf8.encode(jsonEncode({
        'v': 1,
        'publicOrigin': origin,
        'role': 'employee',
        'userId': operator,
        'terminalId': terminal,
        'issuedAt': '2026-11-22T02:00:00Z',
        'expiresAt': '2026-11-22T10:00:00Z'
      })))
      .replaceAll('=', '');
  final signature = await algorithm.sign(ascii.encode(encoded), keyPair: key);
  final grant =
      '$encoded.${base64Url.encode(signature.bytes).replaceAll('=', '')}';
  final item = {'productId': 'coffee', 'quantity': 1, 'unitPrice': 3000};
  final receipt = <String, dynamic>{
    'method': 'cash',
    'operationId': 'sale-1',
    'operatorId': operator,
    'terminalId': terminal,
    'occurredAt': '2026-11-22T02:01:00Z',
    'sequence': 1,
    'shiftId': 'first-shift',
    'catalogVersion': 1,
    'items': [item],
    'tendered': 10000
  };
  Future<void> validate(Json r, {String trusted = origin}) =>
      validateGrant({'grant': grant, 'receipt': r},
          operatorId: operator,
          terminalId: terminal,
          origin: trusted,
          publicKey: public);
  await validate(receipt);
  await validate({
    ...receipt,
    'items': [],
    'bookingId': 'visit-1',
    'bookingTotal': 2000,
    'bookingVersion': 3
  });
  await rejected(() => validate(receipt, trusted: 'https://other.example'));
  await formatRejected(() => validate({...receipt, 'occurredAt': 1732240800}));
  for (final patch in [
    {'operatorId': 'other'},
    {'terminalId': 'other'},
    {'occurredAt': '2026-11-22T01:00:00Z'},
    {'sequence': 0},
    {'shiftId': '\n'},
    {
      'items': [item, item]
    },
    {'items': []},
    {
      'items': [item],
      'bookingId': 'visit-1'
    },
    {'tendered': 2999},
    {'tendered': 100000001},
    {
      'items': [
        {...item, 'quantity': 101}
      ]
    }
  ]) {
    await rejected(() => validate({...receipt, ...patch}));
  }
  final first = PairCipher(operator, 'test-key'),
      other = PairCipher(operator, 'another-key');
  final envelope = await first.encrypt({'grant': grant, 'receipt': receipt});
  if ((await first.decrypt(envelope))['receipt']['operationId'] != 'sale-1') {
    throw StateError('Sealed receipt could not be opened.');
  }
  await rejected(() => other.decrypt(envelope));
  await formatRejected(() => first.decrypt({'operatorId': operator}));
  await rejected(() => PairCipher('other', 'test-key')
      .decrypt({...envelope, 'operatorId': 'other'}));
  final box = base64Decode(envelope['box']);
  box[0] ^= 1;
  await rejected(() => first.decrypt({...envelope, 'box': base64Encode(box)}));
  if (await receiptDigest({'a': 1, 'b': 2}) !=
      await receiptDigest({'b': 2, 'a': 1})) {
    throw StateError('Reordered keys changed receipt identity.');
  }
  stdout.writeln(
      'Bridge protocol: grant binding, sale bounds, authenticated encryption and canonical replay passed.');
}
