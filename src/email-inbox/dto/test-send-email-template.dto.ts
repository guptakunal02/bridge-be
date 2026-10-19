import { IsEmail, IsObject, IsOptional } from 'class-validator';

export class TestSendEmailTemplateDto {
  @IsEmail()
  recipientEmail!: string;

  @IsOptional()
  @IsObject()
  variableOverrides?: Record<string, string>;
}
