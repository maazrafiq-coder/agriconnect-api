// src/common/utils/booking-reference.util.ts
//
// A warehouse booking reference (e.g. "WHB-2026-000001") is a
// human-readable, unique, never-reused identifier shown to the buyer, the
// warehouse operator, and admins wherever a booking is listed or reviewed.
//
// Same pattern as AgriConnect IDs (see agri-connect-id.util.ts):
// StorageBooking.bookingSeq is a plain Postgres-native autoincrement
// integer, so uniqueness is atomic and race-safe under concurrent
// bookings with no extra locking required. The year segment is the
// booking's creation year; the numeric segment is the raw sequence value
// (global, not reset per year — a global sequence is what makes the
// uniqueness guarantee free, and re-deriving a per-year counter safely
// under concurrency would need its own locking scheme for no real
// benefit here).
export function formatBookingReference(
  seq: number | null | undefined,
  createdAt: Date | string | null | undefined,
): string | null {
  if (seq === null || seq === undefined || !createdAt) return null;
  const year = new Date(createdAt).getFullYear();
  return `WHB-${year}-${String(seq).padStart(6, '0')}`;
}

// Convenience: takes any object containing `bookingSeq` and `createdAt`
// fields (must have been included in the Prisma select/query) and returns
// a shallow copy with `bookingReference` added alongside them.
export function withBookingReference<T extends { bookingSeq?: number | null; createdAt?: Date | string | null }>(
  entity: T,
): T & { bookingReference: string | null } {
  return { ...entity, bookingReference: formatBookingReference(entity.bookingSeq, entity.createdAt) };
}

export function withBookingReferences<T extends { bookingSeq?: number | null; createdAt?: Date | string | null }>(
  entities: T[],
): (T & { bookingReference: string | null })[] {
  return entities.map(withBookingReference);
}
