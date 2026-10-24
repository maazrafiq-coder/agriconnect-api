// Payment terms: one canonical shape used on Product (default terms),
// OfferRound (what a party proposes) and Order (immutable snapshot).
// Pure functions only - no DB, no Nest - so they are trivially testable.
import { BadRequestException } from '@nestjs/common';

export const TERM_TYPES = ['FULL_ADVANCE', 'COD', 'CREDIT', 'PARTIAL_ADVANCE', 'OTHER'] as const;
export type TermType = (typeof TERM_TYPES)[number];
export const BALANCE_EVENTS = ['ON_DELIVERY', 'ON_ACKNOWLEDGEMENT', 'CREDIT'] as const;
export type BalanceEvent = (typeof BALANCE_EVENTS)[number];
export const CREDIT_STARTS = ['DELIVERY_ACK', 'INVOICE_DATE'] as const;
export type CreditStart = (typeof CREDIT_STARTS)[number];

export interface PaymentTerms {
  type: TermType;
  creditDays?: number;            // CREDIT, or PARTIAL_ADVANCE with balanceDueEvent CREDIT (1-365; presets 30/60/90)
  creditStart?: CreditStart;      // default DELIVERY_ACK (D3); INVOICE_DATE only if the parties choose it
  advancePct?: number;            // PARTIAL_ADVANCE: 0 < pct < 100
  advanceAmount?: number;         // PARTIAL_ADVANCE alternative: fixed PKR amount (> 0, < order total at schedule time)
  balanceDueEvent?: BalanceEvent; // PARTIAL_ADVANCE only
  description?: string;           // required for OTHER (free text), optional note otherwise
}

export interface ScheduleItem {
  key: 'ADVANCE' | 'BALANCE' | 'FULL';
  label: string;
  amount: number;
  dueRule: string;      // human readable rule, always present
  dueDate: Date | null; // null while the triggering event has not happened yet
}

export interface TermsContext {
  confirmedAt?: Date | null;       // order confirmation
  deliveredAt?: Date | null;       // marked delivered
  acknowledgedAt?: Date | null;    // buyer delivery acknowledgement
  invoiceDate?: Date | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const bad = (m: string) => new BadRequestException(m);

export function normalizePaymentTerms(input: any): PaymentTerms {
  if (!input || typeof input !== 'object') throw bad('Payment terms are required');
  const type = input.type;
  if (!TERM_TYPES.includes(type)) throw bad(`Payment terms type must be one of ${TERM_TYPES.join(', ')}`);
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '';
  const out: PaymentTerms = { type };
  if (description) out.description = description;

  const creditDays = () => {
    const d = Number(input.creditDays);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw bad('Credit period must be a whole number of days between 1 and 365');
    return d;
  };
  const creditStart = (): CreditStart => {
    const s = input.creditStart ?? 'DELIVERY_ACK';
    if (!CREDIT_STARTS.includes(s)) throw bad('Credit period must start from DELIVERY_ACK or INVOICE_DATE');
    return s;
  };

  switch (type) {
    case 'FULL_ADVANCE':
    case 'COD':
      break;
    case 'CREDIT':
      out.creditDays = creditDays();
      out.creditStart = creditStart();
      break;
    case 'PARTIAL_ADVANCE': {
      const hasPct = input.advancePct !== undefined && input.advancePct !== null && input.advancePct !== '';
      const hasAmt = input.advanceAmount !== undefined && input.advanceAmount !== null && input.advanceAmount !== '';
      if (hasPct === hasAmt) throw bad('Give either an advance percentage or an advance amount (not both)');
      if (hasPct) {
        const p = Number(input.advancePct);
        if (!Number.isFinite(p) || p <= 0 || p >= 100) throw bad('Advance percentage must be above 0 and below 100');
        out.advancePct = round2(p);
      } else {
        const a = Number(input.advanceAmount);
        if (!Number.isFinite(a) || a <= 0) throw bad('Advance amount must be greater than zero');
        out.advanceAmount = round2(a);
      }
      const ev = input.balanceDueEvent;
      if (!BALANCE_EVENTS.includes(ev)) throw bad(`Balance due event must be one of ${BALANCE_EVENTS.join(', ')}`);
      out.balanceDueEvent = ev;
      if (ev === 'CREDIT') { out.creditDays = creditDays(); out.creditStart = creditStart(); }
      break;
    }
    case 'OTHER':
      if (description.length < 10) throw bad('Describe the payment arrangement (at least 10 characters)');
      break;
  }
  return out;
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function creditAnchor(t: PaymentTerms, ctx: TermsContext): Date | null {
  return (t.creditStart ?? 'DELIVERY_ACK') === 'INVOICE_DATE' ? ctx.invoiceDate ?? null : ctx.acknowledgedAt ?? null;
}

export function describeTerms(t: PaymentTerms | null | undefined): string {
  if (!t) return 'Not specified';
  const start = (t.creditStart ?? 'DELIVERY_ACK') === 'INVOICE_DATE' ? 'invoice date' : 'delivery acknowledgement';
  switch (t.type) {
    case 'FULL_ADVANCE': return 'Full advance - 100% paid on order confirmation';
    case 'COD': return 'Cash on delivery - 100% paid on delivery';
    case 'CREDIT': return `Credit - 100% due ${t.creditDays} days after ${start}`;
    case 'PARTIAL_ADVANCE': {
      const adv = t.advancePct != null ? `${t.advancePct}%` : `PKR ${t.advanceAmount}`;
      const bal = t.balanceDueEvent === 'ON_DELIVERY' ? 'on delivery'
        : t.balanceDueEvent === 'ON_ACKNOWLEDGEMENT' ? 'on delivery acknowledgement'
        : `${t.creditDays} days after ${start}`;
      return `Partial advance - ${adv} on confirmation, balance ${bal}`;
    }
    default: return `Other - ${t.description ?? ''}`.trim();
  }
}

// Instalments for an order total. A due date is null until its trigger
// event exists in ctx (e.g. credit from delivery acknowledgement stays
// open-ended until the buyer acknowledges delivery).
export function computeSchedule(t: PaymentTerms | null | undefined, totalAmount: number, ctx: TermsContext = {}): ScheduleItem[] {
  const total = round2(totalAmount);
  if (!t) return [{ key: 'FULL', label: 'Payment', amount: total, dueRule: 'Terms not specified', dueDate: null }];
  const credit = (amount: number, key: ScheduleItem['key'], label: string): ScheduleItem => {
    const anchor = creditAnchor(t, ctx);
    const start = (t.creditStart ?? 'DELIVERY_ACK') === 'INVOICE_DATE' ? 'invoice date' : 'delivery acknowledgement';
    return { key, label, amount, dueRule: `${t.creditDays} days after ${start}`, dueDate: anchor ? addDays(anchor, t.creditDays!) : null };
  };
  switch (t.type) {
    case 'FULL_ADVANCE':
      return [{ key: 'FULL', label: 'Full advance', amount: total, dueRule: 'On order confirmation', dueDate: ctx.confirmedAt ?? null }];
    case 'COD':
      return [{ key: 'FULL', label: 'Cash on delivery', amount: total, dueRule: 'On delivery', dueDate: ctx.deliveredAt ?? null }];
    case 'CREDIT':
      return [credit(total, 'FULL', 'Credit payment')];
    case 'PARTIAL_ADVANCE': {
      const adv = t.advancePct != null ? round2((total * t.advancePct) / 100) : round2(t.advanceAmount!);
      if (adv >= total) throw bad('The advance must be less than the order total');
      const balance = round2(total - adv);
      const items: ScheduleItem[] = [{ key: 'ADVANCE', label: 'Advance', amount: adv, dueRule: 'On order confirmation', dueDate: ctx.confirmedAt ?? null }];
      if (t.balanceDueEvent === 'ON_DELIVERY') items.push({ key: 'BALANCE', label: 'Balance', amount: balance, dueRule: 'On delivery', dueDate: ctx.deliveredAt ?? null });
      else if (t.balanceDueEvent === 'ON_ACKNOWLEDGEMENT') items.push({ key: 'BALANCE', label: 'Balance', amount: balance, dueRule: 'On delivery acknowledgement', dueDate: ctx.acknowledgedAt ?? null });
      else items.push(credit(balance, 'BALANCE', 'Balance on credit'));
      return items;
    }
    default:
      return [{ key: 'FULL', label: 'Payment', amount: total, dueRule: t.description ?? 'As agreed', dueDate: null }];
  }
}

// Final due date of the whole invoice (latest instalment), or null if open-ended.
export function finalDueDate(schedule: ScheduleItem[]): Date | null {
  const dates = schedule.map((s) => s.dueDate);
  if (dates.some((d) => d === null)) return null;
  return dates.reduce((a, b) => (a! > b! ? a : b), dates[0]);
}

// Order -> TermsContext. In this app only the BUYER can move an order
// IN_TRANSIT -> DELIVERED, so that transition IS the delivery acknowledgement (D3).
export function contextFromOrder(order: {
  createdAt: Date;
  statusHistory?: { status: string; createdAt: Date }[];
}, invoiceDate?: Date | null): TermsContext {
  const delivered = (order.statusHistory ?? []).find((h) => h.status === 'DELIVERED');
  return {
    confirmedAt: order.createdAt,
    deliveredAt: delivered?.createdAt ?? null,
    acknowledgedAt: delivered?.createdAt ?? null,
    invoiceDate: invoiceDate ?? null,
  };
}
