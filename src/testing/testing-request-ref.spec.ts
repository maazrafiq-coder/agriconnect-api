import { BadRequestException } from '@nestjs/common';
import { makeFakePrisma } from '../offers/__testing__/fake-prisma';
import { TestingService, TransportService } from './testing.service';

// Brief §2/§10: every lab request gets a TST- reference, creation is idempotent, the fee is server-side.
describe('lab request reference + idempotency', () => {
  const setup = () => {
    const db: any = makeFakePrisma();
    db.user.seed({ id: 'buyer' }); db.user.seed({ id: 'lab' });
    db.testingAgencyProfile.seed({ id: 'ag1', userId: 'lab', services: ['MOISTURE', 'PURITY'], basePrice: 1000 });
    const svc = new TestingService(db, { notify: jest.fn().mockResolvedValue(undefined) } as any, {} as any);
    return { db, svc };
  };

  it('issues TST-YYYY-NNNNNN, computes the fee server-side', async () => {
    const { svc } = setup();
    const r: any = await svc.createRequest('buyer', { agencyId: 'lab', servicesRequested: ['MOISTURE', 'PURITY'] } as any);
    expect(r.requestNumber).toMatch(/^TST-\d{4}-\d{6}$/);
    expect(Number(r.fee)).toBe(1350);
  });

  it('numbers are unique per request', async () => {
    const { svc } = setup();
    const a: any = await svc.createRequest('buyer', { agencyId: 'lab', servicesRequested: ['MOISTURE'] } as any);
    const b: any = await svc.createRequest('buyer', { agencyId: 'lab', servicesRequested: ['MOISTURE'] } as any);
    expect(a.requestNumber).not.toBe(b.requestNumber);
  });

  it('a double submit with the same Idempotency-Key returns the same request, one row', async () => {
    const { svc, db } = setup();
    const dto: any = { agencyId: 'lab', servicesRequested: ['MOISTURE'], clientRequestId: 'k-1' };
    const [a, b]: any[] = await Promise.all([svc.createRequest('buyer', { ...dto }), svc.createRequest('buyer', { ...dto })]);
    expect(a.id).toBe(b.id);
    expect(db.testingRequest.rows).toHaveLength(1);
  });

  it('still rejects services the lab does not offer', async () => {
    const { svc } = setup();
    await expect(svc.createRequest('buyer', { agencyId: 'lab', servicesRequested: ['AFLATOXIN'] } as any)).rejects.toThrow(BadRequestException);
  });
});

describe('transport request fields', () => {
  it('contact defaults to the requester profile; deadline cannot precede pickup', async () => {
    const db: any = makeFakePrisma();
  db.user.seed({
  id: 'buyer',
  phoneNumber: '+923001112223',
  profile: { fullName: 'Bilal Ahmed' },
});
    const svc = new TransportService(db, { notify: jest.fn().mockResolvedValue(undefined) } as any);
    const base: any = { pickupLocation: 'Mill', pickupCity: 'Lahore', deliveryLocation: 'Port', deliveryCity: 'Karachi', commodity: 'Rice', cargoType: 'Bagged' };
    const r: any = await svc.createRequest('buyer', { ...base });
    expect(r).toMatchObject({ contactName: 'Bilal Ahmed', contactPhone: '+923001112223', commodity: 'Rice', cargoType: 'Bagged' });
    await expect(svc.createRequest('buyer', { ...base, requiredDate: '2026-11-10', deliveryDeadline: '2026-11-09' })).rejects.toThrow(/deadline/);
    const own: any = await svc.createRequest('buyer', { ...base, contactName: 'Site Mgr', contactPhone: '0300 5556667' });
    expect(own).toMatchObject({ contactName: 'Site Mgr', contactPhone: '0300 5556667' });
  });
});
