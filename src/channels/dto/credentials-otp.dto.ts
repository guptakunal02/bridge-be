import { IsString, Length, Matches } from 'class-validator';

export class VerifyCredentialsOtpDto {
  @IsString()
  challengeId!: string;

  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  @Length(6, 6)
  code!: string;
}

export interface StartCredentialsOtpResponse {
  challengeId: string;
  sentToEmail: string;
  expiresAt: string;
}

export interface VerifyCredentialsOtpResponse {
  ok: true;
}
