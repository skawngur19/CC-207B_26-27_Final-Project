import 'dart:convert';

typedef Json = Map<String, dynamic>;

abstract interface class QueueStore {
  Future<Json?> read();
  Future<void> write(Json value);
}

class Outbox {
  Outbox(this.store, {required this.newId});
  final QueueStore store;
  final String Function() newId;
  Json _state = {'ownerId': null, 'operations': <Json>[]};
  Future<void> _tail = Future.value();
  Json _clone(Json value) => jsonDecode(jsonEncode(value)) as Json;
  List<Json> get operations =>
      (_clone(_state)['operations'] as List).cast<Json>();
  String? get ownerId => _state['ownerId'] as String?;
  int get count => (_state['operations'] as List).length;

  Future<T> _locked<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  Future<void> _commit(Json next) async {
    await store.write(next);
    _state = _clone(next);
  }

  Future<void> restore() => _locked(() async {
        final saved = await store.read();
        if (saved == null) return;
        if (saved['operations'] is! List ||
            (saved['ownerId'] != null && saved['ownerId'] is! String)) {
          throw const FormatException(
              'Invalid encrypted queue. Preserve the file for recovery.');
        }
        for (final op in saved['operations'] as List) {
          if (op is! Map ||
              op['id'] is! String ||
              op['payload'] is! Map ||
              !['booking', 'sale'].contains(op['type'])) {
            throw const FormatException(
                'Invalid queued operation. Preserve the file for recovery.');
          }
        }
        _state = _clone(saved);
      });

  Future<void> bindOwner(String owner) => _locked(() async {
        if (owner.isEmpty) throw ArgumentError('Owner ID is required.');
        if (ownerId != null && ownerId != owner && count > 0) {
          throw StateError(
              'Reauthenticate as the original owner to recover queued changes.');
        }
        await _commit({..._state, 'ownerId': owner});
      });

  Future<Json> enqueue(String type, Json payload) => _locked(() async {
        if (ownerId == null) {
          throw StateError('Online owner login is required first.');
        }
        if (!['booking', 'sale'].contains(type)) {
          throw ArgumentError('Unsupported operation.');
        }
        final op = <String, dynamic>{
          'id': newId(),
          'type': type,
          'payload': _clone(payload),
          'status': 'pending',
          'createdAt': DateTime.now().toUtc().toIso8601String()
        };
        final current = (_state['operations'] as List).cast<Json>();
        if (op['id'] == '' ||
            current.any((existing) => existing['id'] == op['id'])) {
          throw StateError('Operation ID must be unique.');
        }
        await _commit({
          ..._state,
          'operations': [...current, op]
        });
        return _clone(op);
      });

  Future<void> sync(Future<Json> Function(List<Json>) send) =>
      _locked(() async {
        final batch = operations
            .where((op) => op['status'] == 'pending')
            .take(50)
            .toList();
        if (batch.isEmpty) return;
        final reply = await send(batch
            .map((op) => <String, dynamic>{
                  'id': op['id'],
                  'type': op['type'],
                  'payload': op['payload']
                })
            .toList());
        if (reply['results'] is! List) {
          throw const FormatException('Missing sync receipts.');
        }
        final sentIds = batch.map((op) => op['id']).toSet();
        final receipts = <String, Json>{};
        for (final value in reply['results'] as List) {
          if (value is Map<String, dynamic> &&
              sentIds.contains(value['id']) &&
              ['accepted', 'conflict', 'rejected'].contains(value['status'])) {
            receipts[value['id'] as String] = value;
          }
        }
        final kept = <Json>[];
        for (final op in operations) {
          final receipt = receipts[op['id']];
          if (receipt?['status'] == 'accepted') continue;
          kept.add(receipt == null
              ? op
              : {
                  ...op,
                  'status': receipt['status'],
                  'error': receipt['error'] ?? 'Server requires review.',
                  'code': receipt['code']
                });
        }
        await _commit({..._state, 'operations': kept});
      });

  Future<void> retry(String id) => _locked(() async {
        await _commit({
          ..._state,
          'operations': operations
              .map((op) => op['id'] == id
                  ? {...op, 'status': 'pending', 'error': null, 'code': null}
                  : op)
              .toList()
        });
      });

  Future<void> discard(String id) => _locked(() async {
        await _commit({
          ..._state,
          'operations': operations.where((op) => op['id'] != id).toList()
        });
      });
}
