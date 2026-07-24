import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Stricter throttle specifically for OTP verification and login.
 * Tracked per phone number (not just IP) so an attacker rotating
 * IPs still can't brute-force a single account.
 */
@Injectable()
export class OtpThrottleGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const phone = req.body?.phoneNumber || req.ip;
    return `otp:${phone}`;
  }
}
