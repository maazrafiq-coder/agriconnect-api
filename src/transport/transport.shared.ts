// src/transport/transport.shared.ts
//
// Shared rules + response shaping for the Phase 3 transport lifecycle.
//
//   REQUESTED --quote--> QUOTED <--counter / re-quote--> QUOTED --accept--> BOOKED
//   BOOKED -> PICKED_UP -> IN_TRANSIT -> DELIVERED --requester acknowledges--> COMPLETED
//   DELIVERED | COMPLETED --dispute--> DISPUTED --resolved/withdrawn--> (previous status)
//
// D4: the PUBLIC tracking link never exposes the driver's phone (or plate); the
// driver's name is reduced to "first name + initial". Full driver details go only
// to the authenticated requester (buyer), the assigned provider and admins.
export type Party = 'REQUESTER' | 'PROVIDER';
export type Viewer = Party | 'ADMIN';

export const QUOTE_TTL_MS = 72 * 60 * 60 * 1000;            // a round stays open 72 h (same as offers)
export const INVOICE_DUE_DAYS = 7;                          // transport invoices fall due 7 days after issue
export const DISPUTE_WINDOW_DAYS = 7;                       // after acknowledgement a delivery can still be disputed for 7 days

export const OPEN_REQUEST_STATES = ['REQUESTED', 'QUOTED'] as const;
export const LIVE_SHIPMENT_STATES = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT'] as const;
export const DELIVERED_STATES = ['DELIVERED', 'COMPLETED'] as const;

export const num = (v: unknown): number | null => (v == null ? null : Number(v as any));
export const money = (n: number) => `₨${Number(n).toLocaleString()}`;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const orderRef = (orderId?: string | null) => (orderId ? orderId.slice(0, 8).toUpperCase() : null);
// shipment label used in notifications: the confirmed order number when there is one, plus the request ref
export const refLabel = (r: { requestNumber: string; orderNumber?: string | null }) => (r.orderNumber ? `${r.orderNumber} (${r.requestNumber})` : r.requestNumber);
export const IDEM = /^[A-Za-z0-9_-]{1,100}$/;
export const PHONE = /^\+?[0-9][0-9\s-]{6,17}$/;

export function partyOf(req: { requesterId: string; providerId?: string | null }, userId: string): Party | null {
  if (req.requesterId === userId) return 'REQUESTER';
  if (req.providerId && req.providerId === userId) return 'PROVIDER';
  return null;
}

// "Ali Khan" -> "Ali K."  (public tracking only)
export function maskDriverName(name?: string | null): string | null {
  const n = (name || '').trim();
  if (!n) return null;
  const [first, ...rest] = n.split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0].toUpperCase()}.` : first;
}

// Whose move is it on the table right now? (null = nothing to answer)
export function turnOf(r: { status: string; currentRound?: { proposerRole: string } | null }): Party | null {
  if (!['REQUESTED', 'QUOTED'].includes(r.status)) return null;
  if (!r.currentRound) return r.status === 'REQUESTED' ? 'PROVIDER' : null;
  return r.currentRound.proposerRole === 'PROVIDER' ? 'REQUESTER' : 'PROVIDER';
}

export interface Charge { label: string; amount: number }

// Server-side money: base freight + extra charges -> all-in total (never trust a client total).
export function computeTotal(price: number, charges: Charge[] | null | undefined): number {
  return round2(Number(price) + (charges || []).reduce((s, c) => s + Number(c.amount), 0));
}

export function shapeRound(q: any) {
  return {
    id: q.id, roundNo: q.roundNo, proposerRole: q.proposerRole,
    price: num(q.price), additionalCharges: (q.additionalCharges as Charge[] | null) ?? [], totalPrice: num(q.totalPrice ?? q.price),
    estimatedPickup: q.estimatedPickup ?? null, estimatedArrival: q.estimatedArrival ?? null,
    vehicleDetails: q.vehicleDetails ?? null, paymentTerms: q.paymentTerms ?? null, conditions: q.conditions ?? null,
    message: q.message ?? null, status: q.status,
    expiresAt: q.expiresAt ?? null, respondedAt: q.respondedAt ?? null, createdAt: q.createdAt,
  };
}

export function shapeDispute(d: any, viewer: Viewer) {
  return {
    id: d.id, disputeNumber: d.disputeNumber, requestId: d.requestId, raisedByRole: d.raisedByRole,
    category: d.category, description: d.description, claimAmount: num(d.claimAmount),
    status: d.status, response: d.response ?? null, respondedAt: d.respondedAt ?? null,
    resolutionOutcome: d.resolutionOutcome ?? null, resolutionNote: d.resolutionNote ?? null,
    resolvedAt: d.resolvedAt ?? null, createdAt: d.createdAt,
    // the party who may answer it
    awaiting: d.status === 'OPEN' ? (d.raisedByRole === 'REQUESTER' ? 'PROVIDER' : 'REQUESTER') : d.status === 'RESPONDED' ? 'ADMIN' : null,
    viewer,
  };
}

// Full (authenticated) view of a request for one of its parties / an admin.
export function shapeRequest(r: any, viewer: Viewer) {
  const rounds = (r.quoteRounds || []).slice().sort((a: any, b: any) => a.roundNo - b.roundNo);
  const currentRaw = rounds.find((q: any) => q.status === 'CURRENT') || null;
  const live = (r.invoices || []).find((i: any) => i.status !== 'VOID') || null;
  const openDispute = (r.disputes || []).find((d: any) => ['OPEN', 'RESPONDED'].includes(d.status)) || null;
  const {
    quoteRounds, invoices, disputes, order, requester, provider, ...rest
  } = r;
  // Contact person + number: only the requester, the ASSIGNED provider and admins (never anyone else).
  return {
    ...rest,
    quotedPrice: num(r.quotedPrice), agreedPrice: num(r.agreedPrice),
    requestRef: r.requestNumber,
    transportOrderRef: r.orderNumber ?? null,
    orderRef: orderRef(r.orderId), // the linked MARKETPLACE order (if any); transportOrderRef is this shipment's own TRO- number
    order: order ? { id: order.id, ref: orderRef(order.id), productName: order.offer?.product?.name ?? null } : null,
    requesterName: requester?.profile?.fullName ?? null,
    requesterCity: requester?.profile?.city ?? null,
    requesterBusiness: requester?.profile?.businessName ?? null,
    provider: provider ? { companyName: provider.companyName, name: provider.user?.profile?.fullName ?? null } : null,
    rounds: rounds.map(shapeRound),
    currentRound: currentRaw ? shapeRound(currentRaw) : null,
    turn: turnOf({ status: r.status, currentRound: currentRaw }),
    invoice: live ? {
      id: live.id, invoiceNumber: live.invoiceNumber, status: live.status, amount: num(live.amount), dueDate: live.dueDate, version: live.version, orderNumber: live.orderNumber ?? r.orderNumber ?? null,
    } : null,
    dispute: openDispute ? shapeDispute(openDispute, viewer) : null,
    disputes: (disputes || []).map((d: any) => shapeDispute(d, viewer)),
    canAcknowledge: viewer === 'REQUESTER' && r.status === 'DELIVERED',
  };
}

// Public tracking view (D4). Coarse status: the public never learns about a dispute
// or the acknowledgement. No price, no phone, no plate, driver name masked.
export function shapePublicTracking(r: any) {
  const status = r.status === 'DISPUTED' ? (r.statusBeforeDispute || 'DELIVERED') : r.status === 'COMPLETED' ? 'DELIVERED' : r.status;
  return {
    id: r.id, requestRef: r.requestNumber, transportOrderRef: r.orderNumber ?? null, status,
    pickupCity: r.pickupCity, deliveryCity: r.deliveryCity,
    currentLocation: r.currentLocation ?? null, estimatedArrival: r.estimatedArrival ?? null,
    pickedUpAt: r.pickedUpAt ?? null, deliveredAt: r.deliveredAt ?? null,
    driverName: maskDriverName(r.driverName),
    vehicleType: r.vehicleType ?? null,
    trackingUrl: r.trackingUrl ?? null,
  };
}
