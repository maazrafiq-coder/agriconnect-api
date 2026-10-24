// Minimal STATEFUL in-memory Prisma double for the negotiation / invoice specs.
// It is not Prisma: it implements just the calls the offers + invoice services
// make, with real state, so specs can assert outcomes (how many orders exist,
// which round is CURRENT) instead of only which mocks were called.
// $transaction runs callbacks one at a time (a mutex), which models the row
// lock the services take with SELECT ... FOR UPDATE.
import { randomUUID } from 'crypto';

type Row = Record<string, any>;

function matchField(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond !== 'object') return v === cond;
  if ('in' in cond) return cond.in.includes(v);
  if ('not' in cond) return !matchField(v, cond.not);
  if ('gte' in cond && !(v >= cond.gte)) return false;
  if ('gt' in cond && !(v > cond.gt)) return false;
  if ('lt' in cond && !(v instanceof Date ? v < cond.lt : v < cond.lt)) return false;
  if ('lte' in cond && !(v <= cond.lte)) return false;
  return true; // unknown operator / relation filter: treat as matching
}

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (k === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !('in' in cond) && !('not' in cond)
      && !('gte' in cond) && !('gt' in cond) && !('lt' in cond) && !('lte' in cond) && cond !== null) {
      return true; // relation filter (e.g. product: { sellerId }) - not modelled
    }
    return matchField(row[k], cond);
  });
}

// relation name -> [target table, local FK field (one) | remote FK field (many)]
const RELATIONS: Record<string, Record<string, { to: string; fk: string; many?: boolean }>> = {
  offer: { product: { to: 'product', fk: 'productId' }, buyer: { to: 'user', fk: 'buyerId' }, rounds: { to: 'offerRound', fk: 'offerId', many: true } },
  order: { offer: { to: 'offer', fk: 'offerId' }, statusHistory: { to: 'orderStatusHistory', fk: 'orderId', many: true } },
  transportRequest: {
    quoteRounds: { to: 'transportQuoteRound', fk: 'requestId', many: true },
    invoices: { to: 'transportInvoice', fk: 'requestId', many: true },
    disputes: { to: 'transportDispute', fk: 'requestId', many: true },
  },
  transportInvoice: { request: { to: 'transportRequest', fk: 'requestId' } },
  transportDispute: { request: { to: 'transportRequest', fk: 'requestId' } },
  sellerInvoice: { order: { to: 'order', fk: 'orderId' }, seller: { to: 'user', fk: 'sellerId' }, buyer: { to: 'user', fk: 'buyerId' } },
};
let DB: any = null;
function withInclude(name: string, row: Row | null, include?: Row): Row | null {
  if (!row || !include) return row;
  const out = { ...row };
  for (const [rel, spec] of Object.entries(include)) {
    const def = RELATIONS[name]?.[rel];
    if (!def || !spec) continue;
    const target = DB[def.to];
    if (def.many) {
      let list = target.rows.filter((r: Row) => r[def.fk] === row.id).map((r: Row) => ({ ...r }));
      const ob = (spec as any)?.orderBy;
      if (ob?.roundNo) list = list.sort((a: Row, b: Row) => (a.roundNo - b.roundNo) * (ob.roundNo === 'desc' ? -1 : 1));
      out[rel] = list.map((r: Row) => withInclude(def.to, r, (spec as any)?.include));
    } else {
      const t = target.rows.find((r: Row) => r.id === row[def.fk]);
      out[rel] = t ? withInclude(def.to, { ...t }, (spec as any)?.include) : null;
    }
  }
  return out;
}

function table(name: string, defaults: () => Row = () => ({}), unique: string[][] = []) {
  const rows: Row[] = [];
  const api: any = {
    rows,
    seed(r: Row) { const row = { id: randomUUID(), createdAt: new Date(), ...defaults(), ...r }; rows.push(row); return row; },
    async create({ data }: any) {
      const row = { id: randomUUID(), createdAt: new Date(), ...defaults(), ...stripNested(data) };
      for (const u of unique) {
        if (u.every((f) => row[f] != null) && rows.some((r) => u.every((f) => r[f] === row[f]))) {
          const e: any = new Error('Unique constraint failed'); e.code = 'P2002'; throw e;
        }
      }
      rows.push(row);
      return { ...row };
    },
    async findUnique({ where, include }: any) { const r = rows.find((x) => matches(x, flat(where))); return r ? withInclude(name, { ...r }, include) : null; },
    async findFirst({ where, include }: any = {}) {
      const found = rows.filter((x) => matches(x, where));
      return found[0] ? withInclude(name, { ...found[0] }, include) : null;
    },
    async findMany({ where, orderBy, include }: any = {}) {
      let found = rows.filter((x) => matches(x, where));
      if (orderBy?.roundNo) found = [...found].sort((a, b) => (a.roundNo - b.roundNo) * (orderBy.roundNo === 'desc' ? -1 : 1));
      return found.map((r) => withInclude(name, { ...r }, include)!);
    },
    async update({ where, data }: any) {
      const r = rows.find((x) => matches(x, flat(where)));
      if (!r) throw new Error('Record to update not found');
      apply(r, data);
      return { ...r };
    },
    async updateMany({ where, data }: any) {
      const found = rows.filter((x) => matches(x, where));
      found.forEach((r) => apply(r, data));
      return { count: found.length };
    },
  };
  return api;
}
const flat = (w: Row) => w;
const stripNested = (d: Row) => Object.fromEntries(Object.entries(d).filter(([, v]) => !(v && typeof v === 'object' && !(v instanceof Date) && ('create' in (v as any)))));
function apply(r: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date) && ('decrement' in v)) r[k] = r[k] - (v as any).decrement;
    else if (v && typeof v === 'object' && !(v instanceof Date) && ('increment' in v)) r[k] = r[k] + (v as any).increment;
    else r[k] = v;
  }
  r.updatedAt = new Date();
}

export function makeFakePrisma() {
  const db: any = {
    user: table('user', () => ({ kycStatus: 'APPROVED', profile: { fullName: 'Test User' } })),
    product: table('product', () => ({ status: 'ACTIVE', minOrderQty: 1, unit: 'kg', quantity: 1000, name: 'Basmati', paymentTerms: null })),
    offer: table('offer', () => ({ status: 'PENDING', counterPrice: null })),
    offerRound: table('offerRound', () => ({ status: 'CURRENT' }), [['offerId', 'roundNo'], ['offerId', 'clientRequestId']]),
    order: table('order'),
    orderStatusHistory: table('orderStatusHistory'),
    sellerInvoice: table('sellerInvoice', () => ({ status: 'ISSUED', version: 1 })),
    transportRequest: table('transportRequest', () => ({ status: 'REQUESTED', providerId: null, agreedPrice: null, quotedPrice: null, driverName: null, driverPhone: null, vehicleRegNo: null }), [['requesterId', 'clientRequestId']]),
    transportQuoteRound: table('transportQuoteRound', () => ({ status: 'CURRENT' }), [['requestId', 'roundNo'], ['requestId', 'clientRequestId']]),
    transportInvoice: table('transportInvoice', () => ({ status: 'ISSUED', version: 1 })),
    transportDispute: table('transportDispute', () => ({ status: 'OPEN' }), [['requestId', 'clientRequestId']]),
    testingAgencyProfile: table('testingAgencyProfile'),
    testingRequest: table('testingRequest', () => ({ status: 'REQUESTED' }), [['requesterId', 'clientRequestId']]),
    profile: table('profile'),
    auditLog: table('auditLog'),
    transaction: table('transaction'),
  };
  DB = db;
  let invSeq = 0;
  const origInvCreate = db.sellerInvoice.create;
  db.sellerInvoice.create = async (args: any) => {
    // emulate the partial unique index: one non-VOID invoice per order
    const status = args.data.status ?? 'ISSUED';
    if (status !== 'VOID' && db.sellerInvoice.rows.some((r: Row) => r.orderId === args.data.orderId && r.status !== 'VOID')) {
      const e: any = new Error('Unique constraint failed'); e.code = 'P2002'; throw e;
    }
    return origInvCreate({ data: { invoiceSeq: ++invSeq, issuedAt: new Date(), ...args.data } });
  };
  // emulate the partial unique index: one CURRENT round per offer
  const origRoundCreate = db.offerRound.create;
  db.offerRound.create = async (args: any) => {
    const status = args.data.status ?? 'CURRENT';
    if (status === 'CURRENT' && db.offerRound.rows.some((r: Row) => r.offerId === args.data.offerId && r.status === 'CURRENT')) {
      const e: any = new Error('Unique constraint failed (one CURRENT round per offer)'); e.code = 'P2002'; throw e;
    }
    return origRoundCreate(args);
  };
  // Phase 3 partial unique indexes + sequences
  const conflict = (m: string) => { const e: any = new Error(m); e.code = 'P2002'; return e; };
  let reqSeq = 0, tinvSeq = 0, dspSeq = 0, tstSeq = 0;
  const oTst = db.testingRequest.create;
  db.testingRequest.create = (args: any) => oTst({ data: { requestSeq: ++tstSeq, createdAt: new Date(), ...args.data } });
  const oRq = db.transportRequest.create;
  db.transportRequest.create = (args: any) => oRq({ data: { requestSeq: ++reqSeq, ...args.data } });
  const oQr = db.transportQuoteRound.create;
  db.transportQuoteRound.create = async (args: any) => {
    if ((args.data.status ?? 'CURRENT') === 'CURRENT' && db.transportQuoteRound.rows.some((r: Row) => r.requestId === args.data.requestId && r.status === 'CURRENT')) throw conflict('one CURRENT round per request');
    return oQr(args);
  };
  const oTi = db.transportInvoice.create;
  db.transportInvoice.create = async (args: any) => {
    if ((args.data.status ?? 'ISSUED') !== 'VOID' && db.transportInvoice.rows.some((r: Row) => r.requestId === args.data.requestId && r.status !== 'VOID')) throw conflict('one live invoice per request');
    return oTi({ data: { invoiceSeq: ++tinvSeq, issuedAt: new Date(), ...args.data } });
  };
  const oTd = db.transportDispute.create;
  db.transportDispute.create = async (args: any) => {
    if (db.transportDispute.rows.some((r: Row) => r.requestId === args.data.requestId && ['OPEN', 'RESPONDED'].includes(r.status))) throw conflict('one open dispute per request');
    return oTd({ data: { disputeSeq: ++dspSeq, ...args.data } });
  };
  // order.create understands the nested statusHistory the service sends
  const origOrderCreate = db.order.create;
  db.order.create = async (args: any) => {
    const o = await origOrderCreate(args);
    const sh = args.data.statusHistory?.create;
    if (sh) await db.orderStatusHistory.create({ data: { orderId: o.id, ...sh } });
    return { ...o, offer: db.offer.rows.find((x: Row) => x.id === o.offerId) };
  };

  let tail: Promise<any> = Promise.resolve();
  // On a throw the tables are restored, like a real rollback.
  const tables = () => Object.values(db).filter((t: any) => t && Array.isArray(t.rows)) as any[];
  db.$transaction = (fn: any) => {
    const run = tail.then(async () => {
      const snap = tables().map((t) => t.rows.map((r: Row) => ({ ...r })));
      try { return await fn(db); } catch (e) {
        tables().forEach((t, i) => { t.rows.length = 0; t.rows.push(...snap[i]); });
        throw e;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  };
  db.$executeRaw = async () => 0;
  let transportOrderSeq = 0;
  db.$queryRaw = async (strings?: any) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings ?? '');
    if (text.includes('transport_order_seq')) return [{ n: ++transportOrderSeq }];
    return [];
  };
  return db;
}
