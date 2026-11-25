import 'dart:convert';
import 'dart:io';
import 'package:clinch_owner/core/outbox.dart';
import 'package:clinch_owner/data/terminal_engine.dart';
import 'package:clinch_owner/data/terminal_ledger.dart';

class MemoryStore implements QueueStore {
  MemoryStore(this.value);
  Json? value;

  @override
  Future<Json?> read() async =>
      value == null ? null : jsonDecode(jsonEncode(value)) as Json;

  @override
  Future<void> write(Json next) async {
    value = jsonDecode(jsonEncode(next)) as Json;
  }
}

TerminalEngine engine(MemoryStore settings, TerminalLedger ledger) =>
    TerminalEngine(
      settings: settings,
      ledger: ledger,
      endpoint: 'http://127.0.0.1:8788',
      seal: (_, __) async => '',
      open: (_, __) async => {},
      cloud: (_) async => {},
      loadKey: () async => {},
      canSync: () => false,
      printLines: (_) async {},
      changed: () {},
    );

Future<void> main() async {
  final directory = Directory.systemTemp.createTempSync('clinch-engine-');
  try {
    final settings = MemoryStore({
      'terminalId': 'terminal-1',
      'endpoint': 'http://127.0.0.1:8787',
      'pairs': <String, dynamic>{}
    });
    final ledger = TerminalLedger.open('${directory.path}\\empty.sqlite');
    final terminal = engine(settings, ledger);
    try {
      await terminal.initialize();
      if (settings.value?['endpoint'] != 'http://127.0.0.1:8788') {
        throw StateError(
            'An unpaired empty terminal did not adopt the API URL.');
      }
    } finally {
      terminal.dispose();
    }

    final pendingLedger =
        TerminalLedger.open('${directory.path}\\pending.sqlite')
          ..insert('sale-1', 'digest', 'sealed');
    final pendingSettings = MemoryStore({
      'terminalId': 'terminal-1',
      'endpoint': 'http://127.0.0.1:8787',
      'pairs': <String, dynamic>{}
    });
    final pendingTerminal = engine(pendingSettings, pendingLedger);
    try {
      try {
        await pendingTerminal.initialize();
        throw StateError('A terminal with a pending receipt changed API URL.');
      } on StateError catch (error) {
        if (!error.message.contains('paired or pending receipts')) rethrow;
      }
      if (pendingSettings.value?['endpoint'] != 'http://127.0.0.1:8787' ||
          pendingLedger.pendingCount != 1) {
        throw StateError(
            'Endpoint migration altered pending receipt recovery.');
      }
    } finally {
      pendingTerminal.dispose();
    }

    final pairedLedger =
        TerminalLedger.open('${directory.path}\\paired.sqlite');
    final pairedSettings = MemoryStore({
      'terminalId': 'terminal-1',
      'endpoint': 'http://127.0.0.1:8787',
      'pairs': {'employee': 'pairing-secret'}
    });
    final pairedTerminal = engine(pairedSettings, pairedLedger);
    try {
      try {
        await pairedTerminal.initialize();
        throw StateError('A paired terminal changed API URL.');
      } on StateError catch (error) {
        if (!error.message.contains('paired or pending receipts')) rethrow;
      }
      if (pairedSettings.value?['endpoint'] != 'http://127.0.0.1:8787') {
        throw StateError('Endpoint migration removed the saved pairing.');
      }
    } finally {
      pairedTerminal.dispose();
    }
  } finally {
    directory.deleteSync(recursive: true);
  }
  stdout.writeln(
      'Terminal endpoint migration preserves pairing and pending work.');
}
