import { Inject, Injectable, Optional } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import type { ChannelAdapter } from './channel-adapter.port';

export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');

/**
 * Registry of ChannelAdapters keyed by ChannelType. Adapter modules
 * (Phase 6 onwards) provide their adapter implementation via the
 * CHANNEL_ADAPTERS multi-provider token.
 */
@Injectable()
export class ChannelAdapterRegistry {
  private readonly byType = new Map<ChannelType, ChannelAdapter>();

  constructor(
    @Optional()
    @Inject(CHANNEL_ADAPTERS)
    adapters: ChannelAdapter[] = [],
  ) {
    for (const adapter of adapters) {
      if (this.byType.has(adapter.type)) {
        throw new Error(
          `Duplicate ChannelAdapter registered for type ${adapter.type}`,
        );
      }
      this.byType.set(adapter.type, adapter);
    }
  }

  get(type: ChannelType): ChannelAdapter | null {
    return this.byType.get(type) ?? null;
  }

  require(type: ChannelType): ChannelAdapter {
    const adapter = this.get(type);
    if (!adapter) {
      throw new Error(`No ChannelAdapter registered for type ${type}`);
    }
    return adapter;
  }

  hasAdapterFor(type: ChannelType): boolean {
    return this.byType.has(type);
  }

  supportedTypes(): ChannelType[] {
    return Array.from(this.byType.keys());
  }
}
