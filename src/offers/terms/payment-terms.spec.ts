import { BadRequestException } from '@nestjs/common';
import { normalizePaymentTerms, computeSchedule, describeTerms, finalDueDate, addDays, contextFromOrder } from './payment-terms';

const d = (s: string) => new Date(s);

describe('normalizePaymentTerms', () => {
  it('accepts the five term types', () => {
    expect(normalizePaymentTerms({ type: 'FULL_ADVANCE' })).toEqual({ type: 'FULL_ADVANCE' });
    expect(normalizePaymentTerms({ type: 'COD' })).toEqual({ type: 'COD' });
    expect(normalizePaymentTerms({ type: 'CREDIT', creditDays: 30 })).toEqual({ type: 'CREDIT', creditDays: 30, creditStart: 'DELIVERY_ACK' });
    expect(normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advancePct: 25, balanceDueEvent: 'ON_DELIVERY' }))
      .toEqual({ type: 'PARTIAL_ADVANCE', advancePct: 25, balanceDueEvent: 'ON_DELIVERY' });
    expect(normalizePaymentTerms({ type: 'OTHER', description: 'Letter of credit at sight' }).type).toBe('OTHER');
  });

  it.each([0, 366, 1.5, -5, 'abc', undefined])('rejects credit days %p', (creditDays) => {
    expect(() => normalizePaymentTerms({ type: 'CREDIT', creditDays })).toThrow(BadRequestException);
  });

  it.each([1, 45, 60, 90, 365])('accepts custom credit of %p days', (creditDays) => {
    expect(normalizePaymentTerms({ type: 'CREDIT', creditDays }).creditDays).toBe(creditDays);
  });

  it('partial advance needs exactly one of pct / amount, in range, and a balance event', () => {
    expect(() => normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', balanceDueEvent: 'ON_DELIVERY' })).toThrow(/either/);
    expect(() => normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advancePct: 10, advanceAmount: 500, balanceDueEvent: 'ON_DELIVERY' })).toThrow(/either/);
    expect(() => normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advancePct: 0, balanceDueEvent: 'ON_DELIVERY' })).toThrow(/above 0/);
    expect(() => normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advancePct: 100, balanceDueEvent: 'ON_DELIVERY' })).toThrow(/below 100/);
    expect(() => normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advanceAmount: -1, balanceDueEvent: 'ON_DELIVERY' })).toThrow(BadRequestException);
    expect(() => normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advancePct: 30 })).toThrow(/Balance due event/);
    expect(() => normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advancePct: 30, balanceDueEvent: 'CREDIT' })).toThrow(/Credit period/);
    expect(normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advanceAmount: 5000, balanceDueEvent: 'CREDIT', creditDays: 60, creditStart: 'INVOICE_DATE' }))
      .toMatchObject({ advanceAmount: 5000, creditDays: 60, creditStart: 'INVOICE_DATE' });
  });

  it('OTHER needs a real description; junk input is rejected; unknown fields are dropped', () => {
    expect(() => normalizePaymentTerms({ type: 'OTHER', description: 'x' })).toThrow(BadRequestException);
    expect(() => normalizePaymentTerms({ type: 'BARTER' })).toThrow(BadRequestException);
    expect(() => normalizePaymentTerms(null)).toThrow(BadRequestException);
    expect(normalizePaymentTerms({ type: 'COD', evil: 'x', creditDays: 30 })).toEqual({ type: 'COD' });
  });

  it('rejects an invalid creditStart', () => {
    expect(() => normalizePaymentTerms({ type: 'CREDIT', creditDays: 30, creditStart: 'NEVER' })).toThrow(BadRequestException);
  });
});

describe('computeSchedule (due-date calculator)', () => {
  it('full advance is due at order confirmation', () => {
    const [s] = computeSchedule({ type: 'FULL_ADVANCE' }, 100000, { confirmedAt: d('2026-10-01') });
    expect(s).toMatchObject({ amount: 100000, dueDate: d('2026-10-01') });
  });

  it('COD is open until delivery, then due that day', () => {
    expect(computeSchedule({ type: 'COD' }, 500)[0].dueDate).toBeNull();
    expect(computeSchedule({ type: 'COD' }, 500, { deliveredAt: d('2026-10-09') })[0].dueDate).toEqual(d('2026-10-09'));
  });

  it('credit counts from delivery acknowledgement by default (D3), open-ended until then', () => {
    const t = normalizePaymentTerms({ type: 'CREDIT', creditDays: 30 });
    expect(computeSchedule(t, 1000, { invoiceDate: d('2026-10-01') })[0].dueDate).toBeNull();
    expect(computeSchedule(t, 1000, { invoiceDate: d('2026-10-01'), acknowledgedAt: d('2026-10-10') })[0].dueDate).toEqual(d('2026-11-09'));
  });

  it('credit counts from the invoice date when the parties chose that', () => {
    const t = normalizePaymentTerms({ type: 'CREDIT', creditDays: 60, creditStart: 'INVOICE_DATE' });
    expect(computeSchedule(t, 1000, { invoiceDate: d('2026-10-01') })[0].dueDate).toEqual(d('2026-11-30'));
  });

  it('adds days across month and leap-year boundaries', () => {
    expect(addDays(d('2028-02-15T00:00:00Z'), 30)).toEqual(d('2028-03-16T00:00:00Z'));
    expect(addDays(d('2026-12-20T00:00:00Z'), 90)).toEqual(d('2027-03-20T00:00:00Z'));
  });

  it('partial advance by percentage splits the total exactly', () => {
    const t = normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advancePct: 33.33, balanceDueEvent: 'ON_ACKNOWLEDGEMENT' });
    const s = computeSchedule(t, 100000, { confirmedAt: d('2026-10-01') });
    expect(s.map((x) => x.amount)).toEqual([33330, 66670]);
    expect(s[0].amount + s[1].amount).toBe(100000);
    expect(s[1].dueDate).toBeNull();
  });

  it('partial advance by amount with credit balance', () => {
    const t = normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advanceAmount: 20000, balanceDueEvent: 'CREDIT', creditDays: 30 });
    const s = computeSchedule(t, 100000, { confirmedAt: d('2026-10-01'), acknowledgedAt: d('2026-10-05') });
    expect(s[0]).toMatchObject({ amount: 20000, dueDate: d('2026-10-01') });
    expect(s[1]).toMatchObject({ amount: 80000, dueDate: d('2026-11-04') });
    expect(finalDueDate(s)).toEqual(d('2026-11-04'));
  });

  it('an advance amount that is not below the total is refused at schedule time', () => {
    const t = normalizePaymentTerms({ type: 'PARTIAL_ADVANCE', advanceAmount: 100000, balanceDueEvent: 'ON_DELIVERY' });
    expect(() => computeSchedule(t, 100000)).toThrow(/less than the order total/);
  });

  it('missing terms (legacy) give one undated payment', () => {
    expect(computeSchedule(null, 250)).toEqual([expect.objectContaining({ amount: 250, dueDate: null })]);
  });

  it('finalDueDate is null while any instalment is open-ended', () => {
    expect(finalDueDate(computeSchedule({ type: 'COD' }, 10))).toBeNull();
  });

  it('contextFromOrder treats the buyer\'s DELIVERED transition as the acknowledgement', () => {
    const ctx = contextFromOrder({ createdAt: d('2026-10-01'), statusHistory: [{ status: 'CONFIRMED', createdAt: d('2026-10-01') }, { status: 'DELIVERED', createdAt: d('2026-10-08') }] });
    expect(ctx.acknowledgedAt).toEqual(d('2026-10-08'));
    expect(ctx.confirmedAt).toEqual(d('2026-10-01'));
  });
});

describe('describeTerms', () => {
  it('writes plain language for every type', () => {
    expect(describeTerms(null)).toMatch(/Not specified/);
    expect(describeTerms({ type: 'FULL_ADVANCE' })).toMatch(/100%/);
    expect(describeTerms({ type: 'COD' })).toMatch(/on delivery/);
    expect(describeTerms({ type: 'CREDIT', creditDays: 60, creditStart: 'DELIVERY_ACK' })).toMatch(/60 days after delivery acknowledgement/);
    expect(describeTerms({ type: 'CREDIT', creditDays: 30, creditStart: 'INVOICE_DATE' })).toMatch(/invoice date/);
    expect(describeTerms({ type: 'PARTIAL_ADVANCE', advancePct: 25, balanceDueEvent: 'ON_DELIVERY' })).toMatch(/25%.*balance on delivery/);
    expect(describeTerms({ type: 'OTHER', description: 'Letter of credit' })).toMatch(/Letter of credit/);
  });
});
