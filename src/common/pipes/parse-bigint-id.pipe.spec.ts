import { BadRequestException } from '@nestjs/common';
import { ParseBigintIdPipe } from './parse-bigint-id.pipe';

describe('ParseBigintIdPipe', () => {
  const pipe = new ParseBigintIdPipe();
  const meta = { type: 'param' as const, metatype: String, data: 'id' };

  it('accepts positive integers as strings', () => {
    expect(pipe.transform('1', meta)).toBe('1');
    expect(pipe.transform('42', meta)).toBe('42');
    // Bigger than Number.MAX_SAFE_INTEGER — the whole point.
    expect(pipe.transform('9007199254740993', meta)).toBe(
      '9007199254740993',
    );
    // Postgres bigint max
    expect(pipe.transform('9223372036854775807', meta)).toBe(
      '9223372036854775807',
    );
  });

  it('rejects zero', () => {
    expect(() => pipe.transform('0', meta)).toThrow(BadRequestException);
  });

  it('rejects leading zeros', () => {
    expect(() => pipe.transform('01', meta)).toThrow(BadRequestException);
    expect(() => pipe.transform('007', meta)).toThrow(BadRequestException);
  });

  it('rejects non-digit characters', () => {
    expect(() => pipe.transform('1a', meta)).toThrow(BadRequestException);
    expect(() => pipe.transform('1.5', meta)).toThrow(BadRequestException);
    expect(() => pipe.transform('-1', meta)).toThrow(BadRequestException);
    expect(() => pipe.transform('1 OR 1=1', meta)).toThrow(
      BadRequestException,
    );
  });

  it('rejects empty / whitespace / non-string inputs', () => {
    expect(() => pipe.transform('', meta)).toThrow(BadRequestException);
    expect(() => pipe.transform('  ', meta)).toThrow(BadRequestException);
    // TypeScript would normally block this, but a stray runtime type
    // (e.g. undefined route param) shouldn't crash the pipe.
    expect(() =>
      pipe.transform(undefined as unknown as string, meta),
    ).toThrow(BadRequestException);
  });

  it('rejects numbers longer than 19 digits', () => {
    // 20 digits — one over Postgres bigint max width.
    expect(() =>
      pipe.transform('12345678901234567890', meta),
    ).toThrow(BadRequestException);
  });
});
