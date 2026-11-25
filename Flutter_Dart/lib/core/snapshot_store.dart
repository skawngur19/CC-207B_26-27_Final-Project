import 'dart:convert';
import 'outbox.dart';

/// Avoids encrypting and flushing unchanged cache content on idle heartbeats.
/// Lease/identity/audit changes remain part of the comparison, even at the same
/// revision. Only the remote clock value is excluded.
class StableSnapshotStore implements QueueStore {
  StableSnapshotStore(this.store);
  final QueueStore store;
  String? _fingerprint;
  Future<void> _tail = Future.value();
  String _content(Json value) {
    final content = {...value};
    if (value['snapshot'] is Map) {
      content['snapshot'] = {
        ...Map<String, dynamic>.from(value['snapshot'] as Map)
      }..remove('serverTime');
    }
    return jsonEncode(content);
  }

  @override
  Future<Json?> read() async {
    await _tail;
    final value = await store.read();
    _fingerprint = value == null ? null : _content(value);
    return value;
  }

  @override
  Future<void> write(Json value) {
    final fingerprint = _content(value);
    final result = _tail.then((_) async {
      if (_fingerprint == fingerprint) return;
      await store.write(value);
      _fingerprint = fingerprint;
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }
}
