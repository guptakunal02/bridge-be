import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappSenderService } from './whatsapp-sender.service';

const envValues: Record<string, string> = {
  WHATSAPP_PHONE_NUMBER_ID: '1366135436584826',
  WHATSAPP_ACCESS_TOKEN: 'test_token',
  WHATSAPP_GRAPH_API_VERSION: 'v22.0',
};

function makeConfig(): ConfigService {
  const cfg = { get: (k: string) => envValues[k] } as unknown as ConfigService;
  return cfg;
}

function mockFetch(
  status: number,
  body: unknown,
): jest.Mock<Promise<Response>, [string, RequestInit?]> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const res = {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
  return jest.fn(() => Promise.resolve(res));
}

describe('WhatsappSenderService', () => {
  let service: WhatsappSenderService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    service = new WhatsappSenderService(makeConfig());
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts to Meta Graph with the right URL + payload + bearer', async () => {
    const fetchMock = mockFetch(200, {
      messaging_product: 'whatsapp',
      messages: [{ id: 'wamid.ABC' }],
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const result = await service.sendText('918569993083', 'hello');

    expect(result.wamid).toBe('wamid.ABC');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://graph.facebook.com/v22.0/1366135436584826/messages',
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test_token');
    expect(headers['Content-Type']).toBe('application/json');
    const payload = JSON.parse(init?.body as string);
    expect(payload.to).toBe('918569993083');
    expect(payload.type).toBe('text');
    expect(payload.text.body).toBe('hello');
  });

  it('strips a leading "+" and non-digit chars from the wa_id', async () => {
    // The DB stores raw digits but the DTO mapper might pass a pretty
    // string in on some paths — the sender must coerce.
    const fetchMock = mockFetch(200, {
      messaging_product: 'whatsapp',
      messages: [{ id: 'wamid.XYZ' }],
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await service.sendText('+91 85699 93083', 'hey');

    const payload = JSON.parse(
      fetchMock.mock.calls[0]![1]?.body as string,
    );
    expect(payload.to).toBe('918569993083');
  });

  it('trims the body before sending', async () => {
    const fetchMock = mockFetch(200, {
      messaging_product: 'whatsapp',
      messages: [{ id: 'wamid.X' }],
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await service.sendText('918569993083', '   hi there   \n');

    const payload = JSON.parse(
      fetchMock.mock.calls[0]![1]?.body as string,
    );
    expect(payload.text.body).toBe('hi there');
  });

  it('rejects empty wa_id and empty body before hitting the network', async () => {
    const fetchMock = mockFetch(200, {});
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await expect(service.sendText('', 'hey')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.sendText('918569993083', '   '),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 131026 (undeliverable) to a friendly BadRequestException', async () => {
    global.fetch = mockFetch(400, {
      error: {
        code: 131026,
        message: 'Receiver incapable of receiving message',
      },
    }) as unknown as typeof global.fetch;

    await expect(
      service.sendText('918569993083', 'hey'),
    ).rejects.toThrow(/can't receive this message/i);
  });

  it('maps 131047 (window closed) to the template-required message', async () => {
    global.fetch = mockFetch(400, {
      error: { code: 131047, message: 'Re-engagement message' },
    }) as unknown as typeof global.fetch;

    await expect(
      service.sendText('918569993083', 'hey'),
    ).rejects.toThrow(/24-hour reply window/i);
  });

  it('maps 190 (bad token) to the token-rotation message', async () => {
    global.fetch = mockFetch(401, {
      error: { code: 190, message: 'Invalid OAuth access token.' },
    }) as unknown as typeof global.fetch;

    await expect(
      service.sendText('918569993083', 'hey'),
    ).rejects.toThrow(/token has expired/i);
  });

  it('rejects on 2xx without a wamid (defensive — Meta always sends one)', async () => {
    global.fetch = mockFetch(200, {
      messaging_product: 'whatsapp',
      // no messages array
    }) as unknown as typeof global.fetch;

    await expect(
      service.sendText('918569993083', 'hey'),
    ).rejects.toThrow(/did not return a message id/i);
  });

  it('rethrows a network-layer error for the caller to see as 5xx', async () => {
    global.fetch = jest.fn(() =>
      Promise.reject(new Error('ETIMEDOUT')),
    ) as unknown as typeof global.fetch;

    await expect(
      service.sendText('918569993083', 'hey'),
    ).rejects.toThrow('ETIMEDOUT');
  });
});
