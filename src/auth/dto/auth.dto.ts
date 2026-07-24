import { IsString, IsEmail, IsOptional, IsEnum, MinLength, IsMobilePhone } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @IsString()
  phoneNumber: string;

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
  @IsString()
  phoneNumber: string;

  @IsString()
  otp: string;

  @IsString()
  purpose: string;
}

export class LoginDto {
  @IsString()
  phoneNumber: string;

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
  phoneNumber: string;
}

export class ResetPasswordDto {
  @IsString()
  phoneNumber: string;

  @IsString()
  otp: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
