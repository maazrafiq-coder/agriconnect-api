// Route-ordering guard for the transport controllers (metadata only, no DB).
// Within the module, controllers register in array order; a `:id` route must never
// precede a static sibling with the same method + depth, or the static one is unreachable.
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { TransportController } from '../testing/testing.controller';
import {
  TransportLifecycleController, TransportDisputesController, TransportAdminDisputesController, TransportInvoicesController,
} from './transport.controller';

const ORDER: any[] = [TransportController, TransportLifecycleController, TransportDisputesController, TransportAdminDisputesController, TransportInvoicesController];

function routes() {
  const out: { method: string; path: string; where: string }[] = [];
  for (const C of ORDER) {
    const base = String(Reflect.getMetadata('path', C));
    for (const k of Object.getOwnPropertyNames(C.prototype)) {
      const m = Reflect.getMetadata('method', C.prototype[k]);
      if (m === undefined) continue;
      const sub = String(Reflect.getMetadata('path', C.prototype[k]));
      out.push({ method: RequestMethod[m], path: `/${base}/${sub === '/' ? '' : sub}`.replace(/\/+/g, '/').replace(/\/$/, ''), where: `${C.name}.${k}` });
    }
  }
  return out;
}

describe('transport route ordering', () => {
  it('no parameterised route shadows a later static route', () => {
    const all = routes(); const bad: string[] = [];
    all.forEach((r, i) => {
      const seg = r.path.split('/');
      all.slice(i + 1).forEach((later) => {
        const l = later.path.split('/');
        if (later.method !== r.method || l.length !== seg.length) return;
        const shadows = seg.every((s, n) => s === l[n] || (s.startsWith(':') ));
        const laterStatic = l.some((s, n) => !s.startsWith(':') && seg[n].startsWith(':'));
        if (shadows && laterStatic) bad.push(`${r.where} ${r.path} shadows ${later.where} ${later.path}`);
      });
    });
    expect(bad).toEqual([]);
  });

  it('declares the Phase 3 routes', () => {
    const keys = routes().map((r) => `${r.method} ${r.path}`);
    for (const k of [
      'GET /transport/requests/my', 'GET /transport/requests/:id', 'PATCH /transport/requests/:id/counter', 'PATCH /transport/requests/:id/accept',
      'POST /transport/requests/:id/acknowledge', 'GET /transport/track/:id', 'POST /transport/disputes/request/:requestId',
      'POST /transport/admin/disputes/:id/resolve', 'POST /transport-invoices/request/:requestId', 'GET /transport-invoices/my',
    ]) expect(keys).toContain(k);
  });
});
