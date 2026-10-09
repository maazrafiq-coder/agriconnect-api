import 'reflect-metadata';
import { UsersController } from './users.controller';

// Roles are enforced by RolesGuard from @Roles metadata. This pins who may
// call the registration-review routes so a refactor can't silently let
// moderators decide KYC or suspend users.
describe('UsersController — role metadata', () => {
  const rolesOf = (method: string) => Reflect.getMetadata('roles', (UsersController.prototype as any)[method]);

  it('moderators may LIST and VIEW registrations', () => {
    expect(rolesOf('adminList')).toEqual(['ADMIN', 'MODERATOR']);
    expect(rolesOf('adminDetail')).toEqual(['ADMIN', 'MODERATOR']);
  });

  it('only ADMIN may approve/reject KYC or suspend accounts', () => {
    expect(rolesOf('adminKyc')).toEqual(['ADMIN']);
    expect(rolesOf('adminSetActive')).toEqual(['ADMIN']);
  });
});
