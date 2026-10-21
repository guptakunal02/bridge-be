/**
 * DI token for the ChannelAdapter interface. Interfaces don't survive
 * TypeScript's emit, so we use a symbol to bind implementations. The
 * runtime injects via `@Inject(CHANNEL_ADAPTER)`.
 *
 * BotModule binds the WhatsappChannelAdapter to this token (via
 * `useExisting` so the whatsapp-inbox module's singleton is reused);
 * the adapter itself routes to Meta Graph for WhatsApp tickets and
 * log-skips non-WhatsApp channels until an email send primitive
 * lands. LoggingChannelAdapter is kept as a reference implementation.
 */
export const CHANNEL_ADAPTER = Symbol('CHANNEL_ADAPTER');
