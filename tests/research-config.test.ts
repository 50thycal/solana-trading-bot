import assert from 'node:assert/strict';
import { parseResearchConfigFromEnv } from '../helpers/config-validator';

function run(): void {
  const parsed = parseResearchConfigFromEnv({
    RESEARCH_CHECKPOINT_SECONDS: '35',
    RESEARCH_MIN_OPPORTUNITY_SCORE: '72',
    RESEARCH_MAX_RISK_SCORE: '41',
    RESEARCH_REQUEST_TIMEOUT_MS: '1800',
    RESEARCH_RETRIES: '4',
    RESEARCH_FAIL_MODE: 'open',
  });

  assert.equal(parsed.checkpointSeconds, 35);
  assert.equal(parsed.minOpportunityScore, 72);
  assert.equal(parsed.maxRiskScore, 41);
  assert.equal(parsed.requestTimeoutMs, 1800);
  assert.equal(parsed.retries, 4);
  assert.equal(parsed.failMode, 'open');

  const legacyFallbackParsed = parseResearchConfigFromEnv({
    RESEARCH_SCORE_CHECKPOINT: '40',
    RESEARCH_SCORE_THRESHOLD: '67',
    RESEARCH_RISK_SCORE_THRESHOLD: '43',
  });

  assert.equal(legacyFallbackParsed.checkpointSeconds, 40);
  assert.equal(legacyFallbackParsed.minOpportunityScore, 67);
  assert.equal(legacyFallbackParsed.maxRiskScore, 43);
  assert.equal(legacyFallbackParsed.failMode, 'closed');

  console.log('research-config tests passed');
}

run();
