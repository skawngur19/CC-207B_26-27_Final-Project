import 'dart:io';
import 'package:clinch_owner/core/pending_sales.dart';

void main() {
  final usage = PendingSales([
    {
      'type': 'booking',
      'payload': {'resourceId': 'A01'}
    },
    {
      'type': 'sale',
      'status': 'pending',
      'payload': {
        'bookingId': 'b1',
        'items': [
          {'productId': 'coffee', 'quantity': 2}
        ]
      }
    },
    {
      'type': 'sale',
      'status': 'conflict',
      'payload': {
        'bookingId': 'b1',
        'items': [
          {'productId': 'cookie', 'quantity': 1}
        ]
      }
    },
    {
      'type': 'sale',
      'status': 'rejected',
      'payload': {
        'items': [
          {'productId': 'coffee', 'quantity': 1}
        ]
      }
    },
  ]);
  if (usage.bookingIds.length != 1 ||
      !usage.bookingIds.contains('b1') ||
      usage.quantities['coffee'] != 3 ||
      usage.quantities['cookie'] != 1) {
    throw StateError(
        'The cash desk must reserve quantities and booking IDs for every recoverable sale intent.');
  }
  stdout.writeln(
      'PASS pending cash quantities preserve pending/conflict/rejected intents in one pass');
}
