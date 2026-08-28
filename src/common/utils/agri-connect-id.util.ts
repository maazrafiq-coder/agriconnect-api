// src/common/utils/agri-connect-id.util.ts
//
// The AgriConnect ID (e.g. "AGC-000001") is a human-readable, unique,
// immutable identifier shown to users in their profile and to admins
// everywhere a user is listed or reviewed.
//
// Implementation note: rather than storing the formatted string itself,
// User.agriConnectSeq is a plain Postgres-native autoincrement integer
// (see schema.prisma). That guarantees atomic, race-safe uniqueness for
// free — concurrent registrations can never collide or skip — with no
// extra query needed at creation time (a hand-rolled "read max, add one,
// write" counter would need explicit locking to be safe under concurrent
// signups; a DB sequence does not). The human-readable "AGC-000001" form
// is derived from that integer on the way out, via this one shared
// function, wherever a user is serialized for a response.
export function formatAgriConnectId(seq: number | null | undefined): string | null {
  if (seq === null || seq === undefined) return null;
  return `AGC-${String(seq).padStart(6, '0')}`;
}

// Convenience: takes any object containing an `agriConnectSeq` field
// (must have been included in the Prisma `select`/query) and returns a
// shallow copy with `agriConnectId` added alongside it. Leaves
// `agriConnectSeq` in place too — harmless internal detail, and some
// callers may still want the raw number (e.g. for sorting).
export function withAgriConnectId<T extends { agriConnectSeq?: number | null }>(
  entity: T,
): T & { agriConnectId: string | null } {
  return { ...entity, agriConnectId: formatAgriConnectId(entity.agriConnectSeq) };
}
