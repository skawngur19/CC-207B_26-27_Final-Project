import 'outbox.dart';

/// One pass over recoverable intents, including conflicts awaiting review.
class PendingSales {
  PendingSales(Iterable<Json> operations) {
    for (final op in operations) {
      if (op['type'] != 'sale') continue;
      final payload = op['payload'] as Json;
      if (payload['bookingId'] is String) {
        bookingIds.add(payload['bookingId'] as String);
      }
      for (final item in payload['items'] as List) {
        final id = item['productId'] as String;
        quantities[id] = (quantities[id] ?? 0) + (item['quantity'] as int);
      }
    }
  }
  final bookingIds = <String>{};
  final quantities = <String, int>{};
}
