int? centavos(String text) {
  if (!RegExp(r'^\d+(\.\d{1,2})?$').hasMatch(text.trim())) return null;
  final parts = text.trim().split('.');
  final whole = int.tryParse(parts[0]);
  if (whole == null || whole > 1000000) return null;
  final value = whole * 100 +
      (parts.length == 1 ? 0 : int.parse(parts[1].padRight(2, '0')));
  return value <= 100000000 ? value : null;
}
