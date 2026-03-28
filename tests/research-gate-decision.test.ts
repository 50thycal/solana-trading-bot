import assert from 'node:assert/strict';
import { decideResearchGate } from '../pipeline/research-score-decision';

function run(): void {
  const highOppLowRisk = decideResearchGate({
    payload: { mint: 'mint1', opportunityScore: 90, riskScore: 20, signal: 'strong_buy' },
    minOpportunityScore: 60,
    maxRiskScore: 45,
  });
  assert.equal(highOppLowRisk.pass, true);

  const highOppHighRisk = decideResearchGate({
    payload: { mint: 'mint2', opportunityScore: 90, riskScore: 80, signal: 'avoid' },
    minOpportunityScore: 60,
    maxRiskScore: 45,
  });
  assert.equal(highOppHighRisk.pass, false);
  assert.equal(highOppHighRisk.rejectReason, 'risk_high');

  const lowOppLowRisk = decideResearchGate({
    payload: { mint: 'mint3', opportunityScore: 30, riskScore: 10, signal: 'neutral' },
    minOpportunityScore: 60,
    maxRiskScore: 45,
  });
  assert.equal(lowOppLowRisk.pass, false);
  assert.equal(lowOppLowRisk.rejectReason, 'opportunity_low');

  const legacyFallback = decideResearchGate({
    payload: { mint: 'mint4', score: 70, signal: 'buy' },
    minOpportunityScore: 60,
    maxRiskScore: 45,
  });
  assert.equal(legacyFallback.pass, true);
  assert.equal(legacyFallback.usedLegacyFallback, true);

  console.log('research-gate-decision tests passed');
}

run();
