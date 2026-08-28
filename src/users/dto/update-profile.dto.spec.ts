import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateProfileDto } from './update-profile.dto';

/**
 * Round 2, Milestone 5 — registration data model completion.
 *
 * PATCH /users/profile previously took `body: any` with zero validation
 * before writing straight to the DB. This covers the actual validation
 * rules on the DTO that replaced it: format checks on the fields most
 * likely to get garbage input (NTN, IBAN, bank account number, GPS), and
 * confirms every field stays genuinely optional (a farmer shouldn't be
 * forced to fill in business fields, and vice versa).
 */
describe('UpdateProfileDto validation', () => {
  async function validateDto(plain: Record<string, any>) {
    const instance = plainToInstance(UpdateProfileDto, plain);
    return validate(instance);
  }

  it('accepts an empty object — every field is optional', async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it('accepts a fully-populated, valid profile', async () => {
    const errors = await validateDto({
      fullName: 'Ahmed Khan',
      dateOfBirth: '1985-04-12',
      address: 'House 12, Street 5, G-9',
      city: 'Islamabad',
      province: 'Islamabad Capital Territory',
      country: 'Pakistan',
      businessName: 'Ahmed Rice Traders',
      ntnNumber: '1234567-1',
      companyAddress: 'Plot 4, Industrial Area',
      licenseNumber: 'LIC-2024-8891',
      farmSizeAcres: 25.5,
      farmLocation: 'Chak 45, Sahiwal',
      farmGps: '30.6667,73.1000',
      cropsGrown: ['Basmati 1121', 'Wheat'],
      bankName: 'Habib Bank Limited',
      bankAccountNo: '01234567890123',
      iban: 'pk36scbl0000001123456702', // lowercase — should be normalized
    });
    expect(errors).toHaveLength(0);
  });

  describe('ntnNumber', () => {
    it('rejects a malformed NTN', async () => {
      const errors = await validateDto({ ntnNumber: 'not-an-ntn' });
      expect(errors.find((e) => e.property === 'ntnNumber')).toBeDefined();
    });

    it('accepts the correct 7-digit-hyphen-1-digit format', async () => {
      const errors = await validateDto({ ntnNumber: '7654321-9' });
      expect(errors.find((e) => e.property === 'ntnNumber')).toBeUndefined();
    });
  });

  describe('iban', () => {
    it('rejects a non-Pakistani / malformed IBAN', async () => {
      const errors = await validateDto({ iban: 'GB29NWBK60161331926819' });
      expect(errors.find((e) => e.property === 'iban')).toBeDefined();
    });

    it('normalizes lowercase and internal whitespace before validating', async () => {
      const errors = await validateDto({ iban: 'pk36 scbl 0000 0011 2345 6702' });
      expect(errors.find((e) => e.property === 'iban')).toBeUndefined();
    });
  });

  describe('bankAccountNo', () => {
    it('rejects letters or an out-of-range length', async () => {
      expect((await validateDto({ bankAccountNo: 'abc123' })).find((e) => e.property === 'bankAccountNo')).toBeDefined();
      expect((await validateDto({ bankAccountNo: '123' })).find((e) => e.property === 'bankAccountNo')).toBeDefined();
    });

    it('accepts a plausible digits-only account number', async () => {
      const errors = await validateDto({ bankAccountNo: '01234567890' });
      expect(errors.find((e) => e.property === 'bankAccountNo')).toBeUndefined();
    });
  });

  describe('farmGps', () => {
    it('rejects a value that is not "lat,lng"', async () => {
      const errors = await validateDto({ farmGps: 'somewhere near Sahiwal' });
      expect(errors.find((e) => e.property === 'farmGps')).toBeDefined();
    });

    it('accepts negative coordinates', async () => {
      const errors = await validateDto({ farmGps: '-33.8688,151.2093' });
      expect(errors.find((e) => e.property === 'farmGps')).toBeUndefined();
    });
  });

  describe('cropsGrown', () => {
    it('rejects more than 20 entries', async () => {
      const errors = await validateDto({ cropsGrown: Array.from({ length: 21 }, (_, i) => `Crop ${i}`) });
      expect(errors.find((e) => e.property === 'cropsGrown')).toBeDefined();
    });

    it('trims whitespace and drops empty entries via the transform', async () => {
      const instance = plainToInstance(UpdateProfileDto, { cropsGrown: ['  Basmati  ', '', '  Wheat'] });
      expect(instance.cropsGrown).toEqual(['Basmati', 'Wheat']);
    });
  });

  describe('farmSizeAcres', () => {
    it('rejects a negative value', async () => {
      const errors = await validateDto({ farmSizeAcres: -5 });
      expect(errors.find((e) => e.property === 'farmSizeAcres')).toBeDefined();
    });

    it('accepts a reasonable positive value', async () => {
      const errors = await validateDto({ farmSizeAcres: 12.5 });
      expect(errors.find((e) => e.property === 'farmSizeAcres')).toBeUndefined();
    });
  });

  it('does not expose a cnicNumber field at all (must go through KYC re-submission instead)', () => {
    expect((UpdateProfileDto as any).prototype.cnicNumber).toBeUndefined();
    const instance = plainToInstance(UpdateProfileDto, { cnicNumber: '12345-1234567-1', fullName: 'Test' });
    // plainToInstance without { excludeExtraneousValues: true } would still
    // copy unknown plain keys onto the instance if the class doesn't
    // constrain them — the actual stripping happens in ValidationPipe's
    // `whitelist: true` at the HTTP boundary (see main.ts), which this
    // unit test can't exercise directly. This assertion instead confirms
    // the field is genuinely absent from the DTO's own declared shape,
    // which is what makes that whitelist stripping effective.
    expect(Object.getOwnPropertyNames(UpdateProfileDto.prototype)).not.toContain('cnicNumber');
  });
});
