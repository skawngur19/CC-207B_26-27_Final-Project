import 'dart:convert';
import 'dart:io';
import 'package:clinch_owner/core/outbox.dart';
import 'package:clinch_owner/core/snapshot_store.dart';

class CountingStore implements QueueStore {
  Json? value;
  int writes = 0;
  bool fail = false;
  @override
  Future<Json?> read() async =>
      value == null ? null : jsonDecode(jsonEncode(value)) as Json;
  @override
  Future<void> write(Json next) async {
    if (fail) throw StateError('disk full');
    value = jsonDecode(jsonEncode(next)) as Json;
    writes++;
  }
}

Json envelope(
        {String clock = 'one',
        String audit = 'first',
        String expiry = '2026-11-15T16:00:00Z'}) =>
    {
      'endpoint': 'https://hub.example',
      'issuedAt': '2026-11-15T08:00:00Z',
      'expiresAt': expiry,
      'snapshot': {
        'revision': 1,
        'serverTime': clock,
        'user': {'id': 'owner', 'role': 'owner'},
        'audit': [
          {'detail': audit}
        ]
      }
    };
void check(bool value, String message) {
  if (!value) throw StateError(message);
}

Future<void> main() async {
  final disk = CountingStore();
  final cache = StableSnapshotStore(disk);
  await cache.write(envelope());
  await cache.write(envelope(clock: 'two'));
  check(disk.writes == 1,
      'Idle server clock changes must not re-encrypt a snapshot.');
  await cache
      .write(envelope(clock: 'three', audit: 'new login, same revision'));
  check(disk.writes == 2,
      'Audit changes at the same revision must be persisted.');
  await cache.write(envelope(
      audit: 'new login, same revision', expiry: '2026-11-15T17:00:00Z'));
  check(disk.writes == 3, 'A new owner lease must be persisted.');
  final restored = StableSnapshotStore(disk);
  await restored.read();
  await restored.write(envelope(
      clock: 'new clock',
      audit: 'new login, same revision',
      expiry: '2026-11-15T17:00:00Z'));
  check(
      disk.writes == 3, 'Restoring an unchanged snapshot must not rewrite it.');
  disk.fail = true;
  var failed = false;
  try {
    await restored.write(envelope(audit: 'changed'));
  } catch (_) {
    failed = true;
  }
  check(failed, 'Disk errors must propagate.');
  disk.fail = false;
  await restored.write(envelope(audit: 'changed'));
  check(disk.writes == 4, 'Failed writes must remain eligible for retry.');
  stdout.writeln(
      'PASS snapshot writes: idle clock skipped, same-revision audit retained, lease retained, restore skipped, disk retry retained');
}
