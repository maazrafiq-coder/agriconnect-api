// src/notifications/destinations.ts
//
// One place that builds the `data` payload of a notification so every
// notification carries a STRUCTURED, valid destination instead of a loose
// string.
//
//   route       the frontend page            e.g. '/buyer'
//   tab         the tab on that page         e.g. 'offers'
//   entityType  what the id refers to        e.g. 'offer'
//   entityId    the record id                e.g. '3f2a…'
//   link        route + ?tab=&type=&id=      a complete deep link
//
// `link` is kept (and now includes the query string) so any older client
// that only does `navigate(data.link)` still lands on the right tab.
// The frontend resolver (NotificationBell) uses the structured fields and
// falls back to `link`, so a notification keeps working after a page
// refresh: the destination lives in the URL, not in component state.
//
// Route + tab names MUST match the frontend (App.jsx routes and each
// dashboard's tab ids) - destinations.spec.ts pins them.

export type EntityType =
  | 'offer' | 'order' | 'transport' | 'testing' | 'booking' | 'invoice'
  | 'grn' | 'receipt' | 'gateout' | 'lien' | 'listing' | 'kyc' | 'clarification' | 'message';

export interface Destination {
  link: string;
  route: string;
  tab?: string;
  entityType?: EntityType;
  entityId?: string;
}

// Known frontend routes and the tabs each dashboard understands.
export const ROUTE_TABS: Record<string, string[]> = {
  '/buyer': ['overview', 'saved', 'offers', 'orders', 'messages', 'testing', 'transport', 'warehouse'],
  '/seller': ['overview', 'listings', 'offers', 'orders', 'messages', 'warehouse'],
  '/warehouse': ['browse', 'bookings', 'receipts'],
  '/warehouse-portal': ['overview', 'invoices', 'gateout', 'listing', 'review'],
  '/account': ['profile', 'edit', 'password', 'documents', 'activity'],
  '/admin': ['dashboard', 'users', 'marketplace', 'payments', 'logistics', 'liens', 'settings', 'security'],
  '/testing-portal': [],
  '/transport-portal': [],
};

export function destination(
  route: string,
  opts: { tab?: string; entityType?: EntityType; entityId?: string | null } = {},
): Destination {
  const { tab, entityType } = opts;
  const entityId = opts.entityId || undefined;
  const qs = new URLSearchParams();
  if (tab) qs.set('tab', tab);
  if (entityType && entityId) {
    qs.set('type', entityType);
    qs.set('id', entityId);
  }
  const q = qs.toString();
  return { link: q ? `${route}?${q}` : route, route, tab, entityType: entityId ? entityType : undefined, entityId };
}
