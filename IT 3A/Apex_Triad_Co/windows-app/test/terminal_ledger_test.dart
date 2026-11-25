import 'dart:io';
import 'package:clinch_owner/data/terminal_ledger.dart';

void expect(bool condition, String message) {
  if (!condition) throw StateError(message);
}

void main() {
  final workspace = Directory.systemTemp.createTempSync('clinch-ledger-');
  final path = '${workspace.path}/receipts.sqlite';
  try {
    var ledger = TerminalLedger.open(path);
    try {
      ledger.insert('r1', 'hash1', 'sealed-1');
      ledger.insert('r2', 'hash2', 'sealed-2');
      var rejected = false;
      try {
        ledger.insert('r1', 'changed', 'changed');
      } on StateError {
        rejected = true;
      }
      expect(rejected && ledger.pendingCount == 2,
          'Duplicate must preserve original work.');
      expect(ledger.nextPending(1).single['envelope'] == 'sealed-1',
          'Retry oldest first.');
      ledger.mark('r1', 'accepted', 'sealed-result');
      ledger.printState('r1', 'uncertain');
    } finally {
      ledger.close();
    }
    ledger = TerminalLedger.open(path);
    try {
      expect(
          ledger.pendingCount == 1 &&
              ledger.nextPending(4).single['id'] == 'r2',
          'Restart should restore only unconfirmed receipts to the queue.');
      expect(
          ledger.find('r1')?['result'] == 'sealed-result' &&
              ledger.find('r1')?['printing'] == 'uncertain',
          'Acceptance and print state must survive.');
      expect(ledger.recent(1).single['id'] == 'r2',
          'Pending work remains visible.');
    } finally {
      ledger.close();
    }
  } finally {
    workspace.deleteSync(recursive: true);
  }
  stdout.writeln(
      'Windows SQLite ledger: duplicate, durable handoff, restart and print recovery passed.');
}
