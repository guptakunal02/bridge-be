import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../config/env.validation';

export type ReachEstimateDateInterval = 'L1D' | 'L7D' | 'L14D' | 'L28D';

export interface ReachEstimatePoint {
  /** Max price per 1,000 message deliveries, in WABA currency smallest unit (paisa for INR). */
  bidAmount: number;
  /** Target user count the estimate was computed against (fixed at 1,000 during beta). */
  users: number;
  deliveriesLowerBound: number;
  deliveriesUpperBound: number;
  costLowerBound: number;
  costUpperBound: number;
}

export interface ReachEstimateResponse {
  /** WABA billing currency, e.g. "INR". */
  currency: string;
  /** Raw Meta curve, already sorted by ascending bidAmount. */
  points: ReachEstimatePoint[];
}

/**
 * Thin wrapper around Meta's Marketing Messages Lite reach-estimate
 * endpoint:
 *
 *   GET /{WABA_ID}/reachestimate
 *       ?targeting_spec={"geo_locations":{"countries":["IN"]}}
 *       &date_interval=L7D
 *
 * The endpoint returns a curve of up to ~30 bid points with
 * delivery + cost ranges computed from Meta's historical data over
 * the chosen window. We expose the raw curve; the broadcast / template
 * authoring UIs scale it to the actual audience size at render time.
 *
 * This endpoint is informational only — Meta explicitly says actual
 * results may differ. Treat as planning data, not a guarantee.
 */
@Injectable()
export class WhatsappReachEstimateService {
  private readonly logger = new Logger(WhatsappReachEstimateService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  async estimate(input: {
    country: string;
    dateInterval: ReachEstimateDateInterval;
  }): Promise<ReachEstimateResponse> {
    const wabaId = this.config.get('WHATSAPP_BUSINESS_ACCOUNT_ID', {
      infer: true,
    });
    const token = this.config.get('WHATSAPP_ACCESS_TOKEN', { infer: true });
    const version = this.config.get('WHATSAPP_GRAPH_API_VERSION', {
      infer: true,
    });
    const targetingSpec = encodeURIComponent(
      JSON.stringify({ geo_locations: { countries: [input.country] } }),
    );
    const url =
      `https://graph.facebook.com/${version}/${wabaId}/reachestimate` +
      `?targeting_spec=${targetingSpec}` +
      `&date_interval=${input.dateInterval}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      this.logger.error(
        `reach_estimate network error: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException(
        'Could not reach Meta to fetch the reach estimate',
      );
    }
    if (!res.ok) {
      const body = await res.text();
      this.logger.warn(
        `reach_estimate rejected ${res.status}: ${body.slice(0, 400)}`,
      );
      throw new InternalServerErrorException(
        `Meta rejected the reach estimate (HTTP ${res.status})`,
      );
    }
    const parsed: {
      waba_currency?: string;
      estimates?: Array<{
        bid_amount: number;
        users: number;
        deliveries_lower_bound: number;
        deliveries_upper_bound: number;
        cost_lower_bound: number;
        cost_upper_bound: number;
      }>;
    } = await res.json();

    const points: ReachEstimatePoint[] = (parsed.estimates ?? [])
      .map((e) => ({
        bidAmount: e.bid_amount,
        users: e.users,
        deliveriesLowerBound: e.deliveries_lower_bound,
        deliveriesUpperBound: e.deliveries_upper_bound,
        costLowerBound: e.cost_lower_bound,
        costUpperBound: e.cost_upper_bound,
      }))
      .sort((a, b) => a.bidAmount - b.bidAmount);

    return {
      currency: parsed.waba_currency ?? 'INR',
      points,
    };
  }
}
