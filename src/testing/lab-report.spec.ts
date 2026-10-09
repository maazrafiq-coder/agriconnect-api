import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TestingService } from './testing.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../common/storage/storage.service';

describe('TestingService — permanent lab report files', () => {
  let service: TestingService;
  let prisma: any;
  let storage: any;
  let row: any;

  beforeEach(async () => {
    row = { id: 't1', requesterId: 'buyer-1', agencyId: 'lab-1', status: 'IN_PROGRESS', reportFileKey: null };
    prisma = { testingRequest: { findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)), update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...row, ...data })) } };
    storage = { getPresignedUrl: jest.fn().mockResolvedValue('https://signed/x'), putObject: jest.fn(), deleteObject: jest.fn() };
    const ref = await Test.createTestingModule({
      providers: [TestingService, { provide: PrismaService, useValue: prisma }, { provide: NotificationsService, useValue: { notify: jest.fn() } }, { provide: StorageService, useValue: storage }],
    }).compile();
    service = ref.get(TestingService);
  });

  it('upload stores the permanent key + original name (not a link)', async () => {
    await service.uploadReportFile('t1', 'lab-1', { filename: 'lab-reports/lab-report-1.pdf', originalname: 'Result.pdf' });
    expect(prisma.testingRequest.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { reportFileKey: 'lab-reports/lab-report-1.pdf', reportFileName: 'Result.pdf' } });
  });

  it('upload: needs a file, the right agency, and an open request', async () => {
    await expect(service.uploadReportFile('t1', 'lab-1', undefined)).rejects.toThrow(BadRequestException);
    await expect(service.uploadReportFile('t1', 'other-lab', { filename: 'k' })).rejects.toThrow(ForbiddenException);
    row.status = 'COMPLETED';
    await expect(service.uploadReportFile('t1', 'lab-1', { filename: 'k' })).rejects.toThrow(/can no longer be replaced/);
    row.status = 'CANCELLED';
    await expect(service.uploadReportFile('t1', 'lab-1', { filename: 'k' })).rejects.toThrow(/cancelled/);
  });

  it('download mints a FRESH signed link each time (10 min)', async () => {
    row = { ...row, status: 'COMPLETED', reportFileKey: 'lab-reports/a.pdf', reportFileName: 'A.pdf' };
    const r = await service.getReportFile('t1', 'buyer-1', 'BUYER');
    expect(r).toEqual({ url: 'https://signed/x', fileName: 'A.pdf' });
    expect(storage.getPresignedUrl).toHaveBeenCalledWith('lab-reports/a.pdf', 600);
  });

  it('download: agency & staff may fetch it early; requester only once submitted; strangers get a 404', async () => {
    row = { ...row, reportFileKey: 'k', status: 'IN_PROGRESS' };
    await expect(service.getReportFile('t1', 'lab-1', 'TESTING_AGENCY')).resolves.toBeDefined();
    await expect(service.getReportFile('t1', 'admin-1', 'ADMIN')).resolves.toBeDefined();
    await expect(service.getReportFile('t1', 'buyer-1', 'BUYER')).rejects.toThrow(NotFoundException);
    await expect(service.getReportFile('t1', 'stranger', 'BUYER')).rejects.toThrow(NotFoundException);
    row = { ...row, reportFileKey: null };
    await expect(service.getReportFile('t1', 'lab-1', 'TESTING_AGENCY')).rejects.toThrow(NotFoundException);
  });

  it('submitReport requires a file, a link or results — an empty submission is refused', async () => {
    await expect(service.submitReport('t1', 'lab-1', {} as any)).rejects.toThrow(/Attach the report/);
    row.reportFileKey = 'k';
    await expect(service.submitReport('t1', 'lab-1', {} as any)).resolves.toBeDefined();
  });
});
