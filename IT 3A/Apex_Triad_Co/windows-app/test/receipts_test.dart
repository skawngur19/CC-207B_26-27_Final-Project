// ignore_for_file: avoid_print, avoid_relative_lib_imports
import '../lib/core/receipts.dart';

void main() {
  final unrelated = acceptedReceiptFor('new-sale', [
    {
      'id': 'old-sale',
      'status': 'accepted',
      'data': {'reference': 'OLD'}
    },
    {'id': 'new-sale', 'status': 'conflict', 'error': 'stock changed'},
  ]);
  if (unrelated != null) {
    throw StateError(
        'An old sale receipt was shown for a conflicting checkout.');
  }
  final matching = acceptedReceiptFor('new-sale', [
    {
      'id': 'old-sale',
      'status': 'accepted',
      'data': {'reference': 'OLD'}
    },
    {
      'id': 'new-sale',
      'status': 'accepted',
      'data': {'reference': 'NEW'}
    },
  ]);
  if (matching?['reference'] != 'NEW') {
    throw StateError('Current checkout lost its matching accepted receipt.');
  }
  if (acceptedReceiptFor('beyond-batch', [
        {
          'id': 'old-sale',
          'status': 'accepted',
          'data': {'reference': 'OLD'}
        }
      ]) !=
      null) {
    throw StateError(
        'A checkout outside the batch was shown an unrelated receipt.');
  }
  print('PASS receipt matches only the submitted operation ID');
}
