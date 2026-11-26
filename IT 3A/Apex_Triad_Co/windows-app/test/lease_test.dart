import 'dart:io';
import 'package:clinch_owner/core/lease.dart';

void check(bool condition, String message) {
  if (!condition) throw StateError(message);
}

void main() {
  final now = DateTime.utc(2026, 11, 14, 8);
  final long = OwnerLease.online(now, now.add(const Duration(hours: 12)));
  check(long.expiresAt == now.add(const Duration(hours: 8)),
      'Offline access must be bounded to eight hours.');
  final short = OwnerLease.online(now, now.add(const Duration(hours: 2)));
  check(short.expiresAt == now.add(const Duration(hours: 2)),
      'An earlier server expiry must be respected.');
  check(short.allows(now), 'A fresh owner session should allow access.');
  check(!short.allows(now.subtract(const Duration(milliseconds: 1))),
      'Clock rollback before issuance must lock access.');
  check(!short.allows(short.expiresAt), 'Access must stop exactly at expiry.');
  check(!short.allows(short.expiresAt.add(const Duration(hours: 1))),
      'Expired offline access must remain locked.');
  stdout.writeln('6 owner lease boundary checks passed');
}
