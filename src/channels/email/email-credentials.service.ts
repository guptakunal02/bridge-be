import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decodeKey, decrypt, encrypt } from '../../common/crypto/secret-box';
import type { EnvVars } from '../../config/env.validation';
import {
  EmailChannelCredentials,
  parseEmailCredentials,
} from './email-credentials';

@Injectable()
export class EmailCredentialsService {
  private readonly key: Buffer;

  constructor(config: ConfigService<EnvVars, true>) {
    this.key = decodeKey(config.get('CHANNEL_ENCRYPTION_KEY', { infer: true }));
  }

  seal(creds: EmailChannelCredentials): string {
    const validated = parseEmailCredentials(creds);
    return encrypt(this.key, JSON.stringify(validated));
  }

  open(envelope: string): EmailChannelCredentials {
    const json = decrypt(this.key, envelope);
    const parsed: unknown = JSON.parse(json);
    return parseEmailCredentials(parsed);
  }
}
