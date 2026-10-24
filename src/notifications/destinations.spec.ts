import * as fs from 'fs';
import * as path from 'path';
import { destination, ROUTE_TABS } from './destinations';

describe('notification destinations', () => {
  it('builds a complete deep link plus structured fields', () => {
    expect(destination('/buyer', { tab: 'offers', entityType: 'offer', entityId: 'o-1' })).toEqual({
      link: '/buyer?tab=offers&type=offer&id=o-1', route: '/buyer', tab: 'offers', entityType: 'offer', entityId: 'o-1',
    });
  });

  it('omits entity fields when there is no id (no dangling ?id=undefined)', () => {
    const d = destination('/seller', { tab: 'orders', entityType: 'order', entityId: undefined });
    expect(d.link).toBe('/seller?tab=orders');
    expect(d.entityType).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('undefined');
  });

  it('works for pages without tabs', () => {
    expect(destination('/transport-portal', { entityType: 'transport', entityId: 't-1' }).link)
      .toBe('/transport-portal?type=transport&id=t-1');
  });

  // Static scan: every destination() call in the services uses a route and
  // tab that the frontend really has. Catches typos like tab: 'order'.
  it('every destination() used by a service points at a known route and tab', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('destinations.ts')) files.push(full);
      }
    };
    walk(path.join(__dirname, '..'));
    const problems: string[] = [];
    let found = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /destination\(([^;]*?)\{([^}]*)\}\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        found++;
        const routes = (m[1].match(/'(\/[a-z-]*)'/g) || []).map((x) => x.replace(/'/g, ''));
        const tabExpr = (m[2].match(/tab: [^,}]*/)?.[0] || '').replace(/===\s*'[^']*'/g, '');
        const tabs = (tabExpr.match(/'([a-z]+)'/g) || []).map((x) => x.replace(/'/g, ''));
        for (const r of routes) {
          if (!(r in ROUTE_TABS)) problems.push(`${path.basename(f)}: unknown route ${r}`);
        }
        for (const t of tabs) {
          if (!routes.some((r) => (ROUTE_TABS[r] || []).includes(t))) problems.push(`${path.basename(f)}: tab '${t}' not valid for ${routes.join('|')}`);
        }
      }
    }
    expect(found).toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });
});
