import {
  Controller, Post, Body, Get, Param, UseGuards, UseInterceptors,
  UploadedFiles, HttpCode, HttpStatus, Res, Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import {
  RegisterDto, LoginDto, VerifyOtpDto,
  SubmitKycDto, ForgotPasswordDto, ResetPasswordDto,
  ChangePasswordDto, AdminCreateUserDto, AdminResetPasswordDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FileValidationInterceptor } from '../common/guards/file-validation.interceptor';
import { OtpThrottleGuard } from '../common/guards/otp-throttle.guard';

const REFRESH_COOKIE = 'agri_refresh_token';
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/v1/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private setRefreshCookie(res: Response, refreshToken: string) {
    res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS);
  }

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
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

  @Post('kyc/submit')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 5), FileValidationInterceptor)
  submitKyc(
    @CurrentUser('id') userId: string,
    @Body() dto: SubmitKycDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.authService.submitKyc(userId, dto, files || []);
  }

  @Get('kyc/status')
  @UseGuards(JwtAuthGuard)
  getKycStatus(@CurrentUser('id') userId: string) {
    return this.authService.getKycStatus(userId);
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
