import 'outbox.dart';

Json? acceptedReceiptFor(String operationId, List<dynamic> receipts) {
  for (final value in receipts) {
    if (value is Map &&
        value['id'] == operationId &&
        value['status'] == 'accepted' &&
        value['data'] is Map) {
      return Map<String, dynamic>.from(value['data'] as Map);
    }
  }
  return null;
}
