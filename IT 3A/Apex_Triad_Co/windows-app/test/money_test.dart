// ignore_for_file: avoid_print, avoid_relative_lib_imports
import '../lib/core/money.dart';

void main() {
  for (final input in [
    '9999999999999999999999999999999999',
    '1000000.01',
    '-1',
    '1.001',
    'no'
  ]) {
    if (centavos(input) != null) {
      throw StateError('Invalid/oversized cash was accepted: $input');
    }
  }
  if (centavos('1000000.00') != 100000000 ||
      centavos('50.5') != 5050 ||
      centavos('0.01') != 1) {
    throw StateError('Cash was not parsed as bounded integer centavos.');
  }
  print('PASS cash input uses bounded integer centavos without overflow');
}
