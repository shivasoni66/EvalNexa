import { EvaluationAssistantCriteriaSuggestion, EvaluationAssistantInput } from '../EvaluationAssistantService';

export interface SingleModelEvaluationResult {
  modelName: string;
  provider: 'gemini' | 'openai-compatible' | 'other';
  suggestedMarks: number;
  minMarks: number;
  maxMarks: number;
  confidence: number;
  needsHumanReview: boolean;
  criteria: EvaluationAssistantCriteriaSuggestion[];
  missingConcepts: string[];
  reasoningSummary: string;
  latencyMs: number;
  isMultimodal: boolean;
}

export interface EnsembleConsensusResult {
  suggestedMarks: number;
  minMarks: number;
  maxMarks: number;
  confidence: number;
  needsHumanReview: boolean;
  criteria: EvaluationAssistantCriteriaSuggestion[];
  missingConcepts: string[];
  reasoningSummary: string;
  model: string;
  ensembleMetadata: {
    modelsEvaluated: string[];
    modelsRespondedCount: number;
    agreementRatio: number; // 0 to 1
    scoreVariance: number;
    individualScores: Array<{
      model: string;
      score: number;
      latencyMs: number;
    }>;
    consensusStrategy: 'UNANIMOUS' | 'MAJORITY_QUORUM' | 'WEIGHTED_MEDIAN' | 'SINGLE_FALLBACK';
  };
}

export interface IAIEvaluator {
  readonly id: string;
  readonly name: string;
  readonly supportsVision: boolean;
  evaluate(input: EvaluationAssistantInput, signal?: AbortSignal): Promise<SingleModelEvaluationResult>;
}
