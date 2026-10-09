// src/common/utils/document-number.util.ts
//
// Human-readable, unique, never-reused reference numbers for the
// warehouse paperwork introduced in NEW_Changes item 10 (invoice, Goods
// Receipt Note, Gate Out Pass) — same pattern as
// booking-reference.util.ts's formatBookingReference: each model has its
// own native Postgres autoincrement `*Seq` column, so uniqueness is
// atomic and race-safe under concurrent requests with no extra locking.
export function formatDocumentNumber(
  prefix: 'INV' | 'GRN' | 'GOP' | 'WR',
  seq: number,
  createdAt: Date | string,
): string {
  const year = new Date(createdAt).getFullYear();
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}
