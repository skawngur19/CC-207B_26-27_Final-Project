class OwnerLease {
  OwnerLease(this.issuedAt, this.expiresAt);
  final DateTime issuedAt;
  final DateTime expiresAt;
  factory OwnerLease.online(DateTime now, DateTime serverExpiry) {
    final limit = now.add(const Duration(hours: 8));
    return OwnerLease(now, serverExpiry.isBefore(limit) ? serverExpiry : limit);
  }
  bool allows(DateTime now) =>
      !now.isBefore(issuedAt) && now.isBefore(expiresAt);
}
