import 'dart:ffi';
import 'dart:io';
import 'package:ffi/ffi.dart';
import '../core/outbox.dart' show Json;

// The Windows SDK supplies winsqlite3. Receipt contents reach this layer only
// after the caller seals them with the vault key.
final class _Handle extends Opaque {}

final class _Statement extends Opaque {}

typedef _Db = Pointer<_Handle>;
typedef _Stmt = Pointer<_Statement>;
typedef _Destructor = NativeFunction<Void Function(Pointer<Void>)>;

class _Sqlite {
  final lib = DynamicLibrary.open(
      '${Platform.environment['SystemRoot'] ?? r'C:\Windows'}\\System32\\winsqlite3.dll');
  late final open = lib.lookupFunction<
      Int32 Function(Pointer<Utf8>, Pointer<_Db>, Int32, Pointer<Utf8>),
      int Function(
          Pointer<Utf8>, Pointer<_Db>, int, Pointer<Utf8>)>('sqlite3_open_v2');
  late final close = lib
      .lookupFunction<Int32 Function(_Db), int Function(_Db)>('sqlite3_close');
  late final prepare = lib.lookupFunction<
      Int32 Function(
          _Db, Pointer<Utf8>, Int32, Pointer<_Stmt>, Pointer<Pointer<Utf8>>),
      int Function(_Db, Pointer<Utf8>, int, Pointer<_Stmt>,
          Pointer<Pointer<Utf8>>)>('sqlite3_prepare_v2');
  late final bind = lib.lookupFunction<
      Int32 Function(_Stmt, Int32, Pointer<Utf8>, Int32, Pointer<_Destructor>),
      int Function(_Stmt, int, Pointer<Utf8>, int,
          Pointer<_Destructor>)>('sqlite3_bind_text');
  late final step =
      lib.lookupFunction<Int32 Function(_Stmt), int Function(_Stmt)>(
          'sqlite3_step');
  late final finish =
      lib.lookupFunction<Int32 Function(_Stmt), int Function(_Stmt)>(
          'sqlite3_finalize');
  late final columns =
      lib.lookupFunction<Int32 Function(_Stmt), int Function(_Stmt)>(
          'sqlite3_column_count');
  late final name = lib.lookupFunction<Pointer<Utf8> Function(_Stmt, Int32),
      Pointer<Utf8> Function(_Stmt, int)>('sqlite3_column_name');
  late final value = lib.lookupFunction<Pointer<Utf8> Function(_Stmt, Int32),
      Pointer<Utf8> Function(_Stmt, int)>('sqlite3_column_text');
}

class TerminalLedger {
  TerminalLedger._(this._db);
  static final _sql = _Sqlite();
  _Db _db;
  static const _fields = 'id,digest,envelope,status,result,printing';

  factory TerminalLedger.open(String dbPath) {
    if (!Platform.isWindows) {
      throw UnsupportedError('The POS ledger requires Windows.');
    }
    return using((arena) {
      final out = arena<_Db>();
      final code =
          _sql.open(dbPath.toNativeUtf8(allocator: arena), out, 6, nullptr);
      if (code != 0) {
        if (out.value != nullptr) _sql.close(out.value);
        throw FileSystemException(
            'Cannot open terminal ledger (SQLite $code).', dbPath);
      }
      final ledger = TerminalLedger._(out.value);
      try {
        ledger._run('PRAGMA journal_mode=WAL');
        ledger._run('PRAGMA synchronous=FULL');
        ledger._run('''CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL, envelope TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', result TEXT,
          printing TEXT NOT NULL DEFAULT 'waiting')''');
        ledger._run(
            'CREATE INDEX IF NOT EXISTS receipts_status ON receipts(status)');
        return ledger;
      } catch (_) {
        ledger.close();
        rethrow;
      }
    });
  }

  List<Json> _run(String sql, [List<String> values = const []]) {
    if (_db == nullptr) throw StateError('Terminal ledger is closed.');
    return using((arena) {
      final out = arena<_Stmt>();
      void check(int code) {
        if (code != 0) {
          throw StateError('Terminal ledger operation failed (SQLite $code).');
        }
      }

      check(_sql.prepare(
          _db, sql.toNativeUtf8(allocator: arena), -1, out, nullptr));
      final stmt = out.value;
      try {
        for (var i = 0; i < values.length; i++) {
          // SQLITE_STATIC is safe because the arena outlives finalize.
          check(_sql.bind(stmt, i + 1, values[i].toNativeUtf8(allocator: arena),
              -1, nullptr));
        }
        final rows = <Json>[];
        for (var code = _sql.step(stmt); code != 101; code = _sql.step(stmt)) {
          if (code != 100) check(code);
          final row = <String, dynamic>{};
          for (var i = 0; i < _sql.columns(stmt); i++) {
            final value = _sql.value(stmt, i);
            row[_sql.name(stmt, i).toDartString()] =
                value == nullptr ? null : value.toDartString();
          }
          rows.add(row);
        }
        return rows;
      } finally {
        _sql.finish(stmt);
      }
    });
  }

  Json? find(String id) =>
      _run('SELECT $_fields FROM receipts WHERE id=?', [id]).firstOrNull;
  List<Json> nextPending(int limit) => _run(
      "SELECT $_fields FROM receipts WHERE status='pending' ORDER BY rowid LIMIT ?",
      [limit.clamp(0, 200).toString()]);
  List<Json> recent(int limit) => _run(
      "SELECT $_fields FROM receipts ORDER BY (status='accepted'), rowid DESC LIMIT ?",
      [limit.clamp(0, 200).toString()]);
  List<Json> nextWaiting(int limit) => _run(
      "SELECT $_fields FROM receipts WHERE printing='waiting' AND status IN ('pending','accepted') ORDER BY rowid LIMIT ?",
      [limit.clamp(0, 200).toString()]);
  int get pendingCount => int.parse(
      _run("SELECT COUNT(*) AS n FROM receipts WHERE status='pending'")
          .single['n'] as String);

  void insert(String id, String digest, String sealedEnvelope) {
    // The row itself is the replay queue entry. Both become durable together.
    _run('INSERT INTO receipts(id,digest,envelope) VALUES(?,?,?)',
        [id, digest, sealedEnvelope]);
  }

  void mark(String id, String status, String sealedResult) {
    _run('UPDATE receipts SET status=?,result=? WHERE id=?',
        [status, sealedResult, id]);
  }

  void printState(String id, String value) {
    _run('UPDATE receipts SET printing=? WHERE id=?', [value, id]);
  }

  void close() {
    if (_db != nullptr) {
      _sql.close(_db);
      _db = nullptr;
    }
  }
}
