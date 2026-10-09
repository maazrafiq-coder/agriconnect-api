import {
  Controller, Post, Body, Get, Param, UseGuards, UseInterceptors,
  UploadedFiles, HttpCode, HttpStatus, Res, Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { StorageService } from '../common/storage/storage.service';
import {
  RegisterDto, LoginDto, VerifyOtpDto,
  SubmitKycDto, ForgotPasswordDto, ResetPasswordDto,
  ChangePasswordDto, AdminCreateUserDto, AdminResetPasswordDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { KycAuthGuard } from '../common/guards/kyc-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OtpThrottleGuard } from '../common/guards/otp-throttle.guard';

// Named upload slots so each document keeps its real type (previously all
// files landed under one generic 'files' field and docType was recorded as
// the literal string "files" for every upload — indistinguishable in the
// admin review UI). File count limits mirror what section 5 of the fix
// plan asks for; "otherDocument" allows a few for anything uncategorized.
const KYC_FILE_FIELDS = [
  { name: 'cnicFront', maxCount: 1 },
  { name: 'cnicBack', maxCount: 1 },
  { name: 'companyRegistration', maxCount: 1 },
  { name: 'ntnDocument', maxCount: 1 },
  { name: 'businessLicense', maxCount: 1 },
  { name: 'otherDocument', maxCount: 3 },
];

const REFRESH_COOKIE = 'agri_refresh_token';

// Frontend (Vercel) and backend (Railway/Render) run on different domains,
// so every request between them is cross-site. Cross-site cookies REQUIRE
// SameSite=None + Secure=true or the browser drops them silently — this was
// the root cause of "admin logged out after refresh" (Lax cookies are not
// sent on background fetch/XHR across sites, only on top-level navigation).
// In local dev, frontend and backend are both on localhost (same-site), so
// Lax + non-Secure still works there — Chrome also refuses Secure cookies
// over plain http://localhost, which is why this must stay conditional.
const IS_PROD = process.env.NODE_ENV === 'production';
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: (IS_PROD ? 'none' : 'lax') as 'none' | 'lax',
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly storage: StorageService,
  ) {}

  private setRefreshCookie(res: Response, refreshToken: string) {
    res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS);
  }

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('resend-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  resendOtp(@Body('identifier') identifier: string) {
    return this.authService.resendRegistrationOtp(String(identifier ?? ''));
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OtpThrottleGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    // Verifying OTP no longer logs the user in (registration is pending
    // admin approval at this point) — so there's no token/cookie to set.
    return this.authService.verifyOtp(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto);
    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken, ...rest } = result;
    return rest;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) return { accessToken: null };
    const result = await this.authService.refreshToken(token);
    this.setRefreshCookie(res, result.refreshToken);
    const { refreshToken, ...rest } = result;
    return rest;
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await this.authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return { message: 'Logged out successfully' };
  }

  // KycAuthGuard (not plain JwtAuthGuard): a user who has just verified
  // their OTP is not logged in yet — login is gated on admin approval — so
  // they authenticate here with the short-lived registration token issued
  // by verify-otp instead. Already-approved users revisiting their
  // documents from My Portal use their normal login the same as any other
  // authenticated route; KycAuthGuard accepts either.
  @Post('kyc/submit')
  @UseGuards(KycAuthGuard)
  @UseInterceptors(FileFieldsInterceptor(KYC_FILE_FIELDS))
  submitKyc(
    @CurrentUser('id') userId: string,
    @Body() dto: SubmitKycDto,
    @UploadedFiles() filesByField: Record<string, Express.Multer.File[]>,
  ) {
    const files = Object.values(filesByField || {}).flat();
    return this.authService.submitKyc(userId, dto, files);
  }

  @Get('kyc/status')
  @UseGuards(KycAuthGuard)
  getKycStatus(@CurrentUser('id') userId: string) {
    return this.authService.getKycStatus(userId);
  }

  // Issues a short-lived signed URL to view ONE specific document.
  // Requires a normal login (not the registration token — a user only
  // needs this once they're revisiting their own documents later, or an
  // admin/moderator is reviewing someone else's), and re-checks
  // ownership/role every time it's called — see AuthService for the
  // actual check.
  @Get('kyc/documents/:docId/signed-url')
  @UseGuards(JwtAuthGuard)
  getKycDocumentSignedUrl(
    @Param('docId') docId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.authService.getKycDocumentSignedUrl(userId, role, docId);
  }

  // Serves the actual file bytes for a signed URL issued above.
  // Deliberately NOT behind JwtAuthGuard — it's opened as a plain URL
  // (new tab / <img src>), which can't attach an Authorization header.
  // The signed, short-lived token in the path IS the credential; see
  // AuthService.resolveKycFileToken for the verification.
  //
  // Round 2, Milestone 4: no longer streams bytes from local disk —
  // redirects to a fresh, short-lived presigned bucket URL. The 302 is
  // transparent to both `<img src>` and "open in new tab" usage.
  @Get('kyc/documents/file/:token')
  async serveKycFile(@Param('token') token: string, @Res() res: Response) {
    const { s3Key } = await this.authService.resolveKycFileToken(token);
    const presignedUrl = await this.storage.getPresignedUrl(s3Key, 60);
    res.set({ 'Cache-Control': 'private, no-store' }); // never cache a document behind a one-time link
    return res.redirect(presignedUrl);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.identifier);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() user: any) {
    return user;
  }

  // ─── SELF-SERVICE ───────────────────────────────────────────────────────────

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(userId, dto);
  }

  @Post('deactivate-self')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  deactivateSelf(@CurrentUser('id') userId: string) {
    return this.authService.deactivateSelf(userId);
  }

  @Get('my-documents')
  @UseGuards(JwtAuthGuard)
  getMyDocuments(@CurrentUser('id') userId: string) {
    return this.authService.getMyDocuments(userId);
  }

  @Get('my-activity')
  @UseGuards(JwtAuthGuard)
  getMyAuditLog(@CurrentUser('id') userId: string) {
    return this.authService.getMyAuditLog(userId);
  }

  // ─── ADMIN ────────────────────────────────────────────────────────────────

  @Post('admin/create-user')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminCreateUser(@Body() dto: AdminCreateUserDto, @CurrentUser('id') adminId: string) {
    return this.authService.adminCreateUser(dto, adminId);
  }

  @Post('admin/:userId/reset-password')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminResetPassword(
    @Param('userId') userId: string,
    @Body() dto: AdminResetPasswordDto,
    @CurrentUser('id') adminId: string,
  ) {
    return this.authService.adminResetPassword(userId, dto, adminId);
  }

  // ─── MODERATOR (delegated staff) ──────────────────────────────────────────
  // Moderators can recommend an account for approval after reviewing its
  // documents, but cannot themselves grant final approval — only ADMIN can
  // (see UsersController.adminKyc, still ADMIN-only).
  @Post('moderator/:userId/recommend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'MODERATOR')
  moderatorRecommend(
    @Param('userId') userId: string,
    @Body('note') note: string,
    @CurrentUser('id') moderatorId: string,
  ) {
    return this.authService.moderatorRecommend(userId, moderatorId, note);
  }
}
