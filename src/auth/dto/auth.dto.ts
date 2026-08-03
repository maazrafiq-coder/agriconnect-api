import { IsString, IsEmail, IsOptional, IsEnum, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  // Phone and email are BOTH optional at the field level — validated as
  // "at least one required" in AuthService.register() itself, since
  // class-validator doesn't cleanly express "one of these two" across
  // separate optional fields.
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  fullName: string;
}

export class VerifyOtpDto {
  // Whichever identifier (phone or email) the OTP was sent to
  @IsString()
  identifier: string;

  @IsString()
  otp: string;

  @IsString()
  purpose: string;
}

export class LoginDto {
  // Accepts either a phone number or an email address
  @IsString()
  identifier: string;

  @IsString()
  password: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}

export class SubmitKycDto {
  @IsOptional()
  @IsString()
  cnicNumber?: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  address?: string;
}

export class ForgotPasswordDto {
  @IsString()
  identifier: string;
}

export class ResetPasswordDto {
  @IsString()
  identifier: string;

  @IsString()
  otp: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

export class AdminCreateUserDto {
  @IsOptional() @IsString() phoneNumber?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsString() fullName: string;
  @IsEnum(UserRole) role: UserRole;
  @IsOptional() @IsString() @MinLength(8) password?: string; // auto-generated if omitted
}

export class AdminResetPasswordDto {
  @IsOptional() @IsString() @MinLength(8) newPassword?: string; // auto-generated if omitted
}
