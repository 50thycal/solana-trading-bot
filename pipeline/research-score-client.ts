import { logger } from '../helpers/logger';
import { sleep } from '../helpers/promises';

export type ResearchSignal = 'strong_buy' | 'buy' | 'neutral' | 'avoid';
export type ResearchFailMode = 'open' | 'closed';

export interface ResearchFeatureScore {
  name: string;
  raw: number;
  score: number;
}

export interface ResearchModelMetadata {
  checkpointSeconds: number;
  sampleCount: number;
  baseRate2x: number;
}

export interface ResearchScoreResponse {
  mint: string;
  opportunityScore?: number;
  riskScore?: number;
  signal?: ResearchSignal;
  featureScores?: ResearchFeatureScore[];
  score?: number;
  model?: Record<string, unknown>;
  opportunityModel?: ResearchModelMetadata;
  riskModel?: ResearchModelMetadata;
}

export interface ResearchScoreClientConfig {
  baseUrl: string;
  timeoutMs: number;
  retries: number;
  checkpointSeconds: number;
}

export interface ResearchScoreClientResult {
  response: ResearchScoreResponse;
  latencyMs: number;
  attempts: number;
}

export async function fetchWithRetry(
  url: string,
  timeoutMs: number,
  retries: number,
): Promise<{ response: Response; attempts: number; latencyMs: number }> {
  let attempt = 0;
  let delayMs = 250;
  let lastError: Error | null = null;

  while (attempt <= retries) {
    attempt += 1;
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return {
        response,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt > retries) {
        break;
      }

      await sleep(delayMs);
      delayMs *= 2;
    }
  }

  throw new Error(`Research score request failed after ${attempt} attempt(s): ${lastError?.message || 'Unknown error'}`);
}

export class ResearchScoreClient {
  constructor(private readonly config: ResearchScoreClientConfig) {}

  async getScore(mint: string): Promise<ResearchScoreClientResult> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/api/analysis/score?mint=${encodeURIComponent(mint)}&checkpoint=${this.config.checkpointSeconds}`;

    const { response, attempts, latencyMs } = await fetchWithRetry(url, this.config.timeoutMs, this.config.retries);
    const payload = await response.json() as ResearchScoreResponse;

    logger.info(
      {
        stage: 'research-score-gate',
        event: 'research_score_api_response',
        mint,
        checkpointSeconds: this.config.checkpointSeconds,
        latencyMs,
        attempts,
        opportunityScore: payload.opportunityScore,
        riskScore: payload.riskScore,
        legacyScore: payload.score,
        signal: payload.signal,
      },
      '[research-score-client] Score payload received',
    );

    return {
      response: payload,
      latencyMs,
      attempts,
    };
  }
}
