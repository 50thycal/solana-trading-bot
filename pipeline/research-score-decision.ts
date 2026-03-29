import { ResearchScoreResponse, ResearchSignal } from './research-score-client';

export interface ResearchGateDecisionInput {
  payload: ResearchScoreResponse;
  minOpportunityScore: number;
  maxRiskScore: number;
}

export interface ResearchGateDecision {
  pass: boolean;
  usedLegacyFallback: boolean;
  opportunityScore: number;
  riskScore: number | null;
  signal: ResearchSignal;
  rejectReason?: 'opportunity_low' | 'risk_high' | 'missing_scores';
}

export function decideResearchGate(input: ResearchGateDecisionInput): ResearchGateDecision {
  const signal: ResearchSignal = input.payload.signal || 'neutral';
  const opportunity = input.payload.opportunityScore;
  const risk = input.payload.riskScore;

  if (typeof opportunity === 'number' && typeof risk === 'number') {
    if (opportunity < input.minOpportunityScore) {
      return {
        pass: false,
        usedLegacyFallback: false,
        opportunityScore: opportunity,
        riskScore: risk,
        signal,
        rejectReason: 'opportunity_low',
      };
    }

    if (risk > input.maxRiskScore) {
      return {
        pass: false,
        usedLegacyFallback: false,
        opportunityScore: opportunity,
        riskScore: risk,
        signal,
        rejectReason: 'risk_high',
      };
    }

    return {
      pass: true,
      usedLegacyFallback: false,
      opportunityScore: opportunity,
      riskScore: risk,
      signal,
    };
  }

  if (typeof input.payload.score === 'number') {
    const pass = input.payload.score >= input.minOpportunityScore;
    return {
      pass,
      usedLegacyFallback: true,
      opportunityScore: input.payload.score,
      riskScore: null,
      signal,
      rejectReason: pass ? undefined : 'opportunity_low',
    };
  }

  return {
    pass: false,
    usedLegacyFallback: false,
    opportunityScore: 0,
    riskScore: null,
    signal,
    rejectReason: 'missing_scores',
  };
}
