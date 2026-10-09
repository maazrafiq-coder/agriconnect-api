// Best-effort audit trail for staff actions (KYC decisions, suspensions,
// listing approvals, price/fee changes, loan decisions…). Never throws: an
// audit failure must not undo or block the action it records.
export async function recordAudit(
  prisma: any,
  userId: string | null | undefined,
  action: string,
  entityType?: string,
  entityId?: string,
  details?: Record<string, any>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { userId: userId || undefined, action, entityType, entityId, details: details as any },
    });
  } catch {
    /* intentionally swallowed */
  }
}
