// Dependency-free behavioral runner: dart test/outbox_test.dart
// ignore_for_file: avoid_print, avoid_relative_lib_imports
import 'dart:convert';
import '../lib/core/outbox.dart';

class MemoryStore implements QueueStore {
  Json? value;
  bool failWrites = false;
  @override
  Future<Json?> read() async =>
      value == null ? null : jsonDecode(jsonEncode(value)) as Json;
  @override
  Future<void> write(Json next) async {
    if (failWrites) throw StateError('disk full');
    value = jsonDecode(jsonEncode(next)) as Json;
  }
}

void expect(bool value, String reason) {
  if (!value) throw StateError(reason);
}

Future<void> main() async {
  var passed = 0;
  Future<void> test(String name, Future<void> Function() run) async {
    await run();
    passed++;
    print('PASS $name');
  }

  await test('operation is durably persisted before network sees it', () async {
    final store = MemoryStore();
    final queue = Outbox(store, newId: () => 'immutable-1');
    await queue.bindOwner('owner-1');
    final payload = <String, dynamic>{
      'tendered': 5000,
      'items': [
        {'productId': 'tea', 'quantity': 1}
      ]
    };
    await queue.enqueue('sale', payload);
    payload['tendered'] = 0;
    await queue.sync((batch) async {
      expect(store.value!['operations'][0]['id'] == 'immutable-1',
          'not persisted before send');
      expect(batch[0]['payload']['tendered'] == 5000,
          'caller mutation changed durable intent');
      return {
        'results': [
          {'id': 'immutable-1', 'status': 'accepted'}
        ]
      };
    });
    expect(queue.operations.isEmpty, 'accepted operation remained queued');
  });

  await test('lost response retries the same ID after restart', () async {
    final store = MemoryStore();
    final first = Outbox(store, newId: () => 'retry-1');
    await first.bindOwner('owner-1');
    await first.enqueue('booking', {'resourceId': 'A01'});
    try {
      await first.sync((_) async => throw StateError('response lost'));
    } catch (_) {}
    final restored = Outbox(store, newId: () => 'WRONG-NEW-ID');
    await restored.restore();
    await restored.sync((batch) async {
      expect(batch.single['id'] == 'retry-1', 'retry minted a different ID');
      return {
        'results': [
          {'id': 'retry-1', 'status': 'accepted'}
        ]
      };
    });
    expect(restored.operations.isEmpty, 'receipt did not clear pending');
  });

  await test('conflict and rejected receipts retain intent and server reason',
      () async {
    final store = MemoryStore();
    var id = 0;
    final queue = Outbox(store, newId: () => 'op-${++id}');
    await queue.bindOwner('owner-1');
    await queue.enqueue('booking', {'resourceId': 'A01'});
    await queue.enqueue('sale', {'tendered': 1000});
    await queue.sync((_) async => {
          'results': [
            {
              'id': 'op-1',
              'status': 'conflict',
              'error': 'Seat is occupied',
              'code': 'overlap'
            },
            {
              'id': 'op-2',
              'status': 'rejected',
              'error': 'Stock unavailable',
              'code': 'stock'
            },
          ]
        });
    expect(queue.operations.length == 2, 'server error lost an operation');
    expect(queue.operations.first['error'] == 'Seat is occupied',
        'conflict reason not stored');
    final restored = Outbox(store, newId: () => 'unused');
    await restored.restore();
    expect(restored.operations.last['status'] == 'rejected',
        'restart lost review state');
  });

  await test('failed disk write prevents network and in-memory admission',
      () async {
    final store = MemoryStore();
    final queue = Outbox(store, newId: () => 'op-1');
    await queue.bindOwner('owner-1');
    store.failWrites = true;
    var threw = false;
    try {
      await queue.enqueue('sale', {'tendered': 100});
    } catch (_) {
      threw = true;
    }
    expect(threw, 'failed durability was ignored');
    expect(queue.operations.isEmpty, 'unpersisted operation admitted');
  });

  await test('queue cannot be claimed by a different owner', () async {
    final queue = Outbox(MemoryStore(), newId: () => 'op-1');
    await queue.bindOwner('owner-1');
    await queue.enqueue('booking', {'resourceId': 'A01'});
    var blocked = false;
    try {
      await queue.bindOwner('owner-2');
    } catch (_) {
      blocked = true;
    }
    expect(blocked && queue.ownerId == 'owner-1',
        'another owner claimed pending intent');
  });

  await test(
      'sync sends at most fifty operations and preserves missing receipts',
      () async {
    var id = 0;
    final queue = Outbox(MemoryStore(), newId: () => 'op-${++id}');
    await queue.bindOwner('owner-1');
    for (var i = 0; i < 51; i++) {
      await queue.enqueue('booking', {'resourceId': 'A01'});
    }
    await queue.sync((batch) async {
      expect(batch.length == 50, 'API batch exceeds fifty');
      return {
        'results': [
          {'id': 'op-1', 'status': 'accepted'}
        ]
      };
    });
    expect(queue.operations.length == 50,
        'missing receipt silently cleared intent');
  });
  print('$passed outbox behavioral tests passed');
}
