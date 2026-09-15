/**
 * DI token for the ChannelAdapter interface. Interfaces don't survive
 * TypeScript's emit, so we use a symbol to bind implementations. The
 * runtime injects via `@Inject(CHANNEL_ADAPTER)`.
 *
 * BotModule provides LoggingChannelAdapter under this token today;
 * the real WhatsApp adapter will swap in without touching runtime code.
 */
export const CHANNEL_ADAPTER = Symbol('CHANNEL_ADAPTER');
