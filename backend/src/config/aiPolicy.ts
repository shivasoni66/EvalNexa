/**
 * Centralized AI Evaluation & Page Mapping Confidence Policy
 * All thresholds are configurable via environment variables and runtime overrides.
 * Magic numbers are strictly eliminated from business logic.
 */

export interface ConfidenceThresholds {
  high: number;    // E.g. >= 0.85 (High confidence: automatic mapping / direct evaluation)
  medium: number;  // E.g. >= 0.70 (Medium confidence: acceptable with advisory)
  low: number;     // E.g. < 0.70 (Low confidence: human review required)
}

export type ConfidenceBand = 'HIGH_CONFIDENCE' | 'MEDIUM_CONFIDENCE' | 'LOW_CONFIDENCE';

export interface AiPolicyConfig {
  mappingConfidence: ConfidenceThresholds;
  aiGradingConfidence: {
    high: number;
    medium: number;
    low: number;
  };
  ocrQualityMinimum: number;
  concurrencyLimit: number;
}

export function getAiPolicyConfig(): AiPolicyConfig {
  const mappingHigh = parseFloat(process.env.AI_MAPPING_HIGH_CONFIDENCE || '0.85');
  const mappingMedium = parseFloat(process.env.AI_MAPPING_MEDIUM_CONFIDENCE || '0.70');
  const mappingLow = parseFloat(process.env.AI_MAPPING_LOW_CONFIDENCE || '0.50');

  const gradingHigh = parseFloat(process.env.AI_GRADING_HIGH_CONFIDENCE || '0.85');
  const gradingMedium = parseFloat(process.env.AI_GRADING_MEDIUM_CONFIDENCE || '0.70');
  const gradingLow = parseFloat(process.env.AI_GRADING_LOW_CONFIDENCE || '0.50');

  const ocrQualityMinimum = parseFloat(process.env.AI_OCR_MINIMUM_CONFIDENCE || '0.35');
  const concurrencyLimit = parseInt(process.env.AI_FULL_ANALYSIS_CONCURRENCY || '2', 10);

  return {
    mappingConfidence: {
      high: isNaN(mappingHigh) ? 0.85 : mappingHigh,
      medium: isNaN(mappingMedium) ? 0.70 : mappingMedium,
      low: isNaN(mappingLow) ? 0.50 : mappingLow,
    },
    aiGradingConfidence: {
      high: isNaN(gradingHigh) ? 0.85 : gradingHigh,
      medium: isNaN(gradingMedium) ? 0.70 : gradingMedium,
      low: isNaN(gradingLow) ? 0.50 : gradingLow,
    },
    ocrQualityMinimum: isNaN(ocrQualityMinimum) ? 0.35 : ocrQualityMinimum,
    concurrencyLimit: isNaN(concurrencyLimit) || concurrencyLimit < 1 ? 2 : concurrencyLimit,
  };
}

export function evaluateConfidenceBand(score: number, thresholds?: ConfidenceThresholds): ConfidenceBand {
  const t = thresholds || getAiPolicyConfig().mappingConfidence;
  if (score >= t.high) return 'HIGH_CONFIDENCE';
  if (score >= t.medium) return 'MEDIUM_CONFIDENCE';
  return 'LOW_CONFIDENCE';
}

export function isMappingConfident(score: number, thresholds?: ConfidenceThresholds): boolean {
  const band = evaluateConfidenceBand(score, thresholds);
  return band === 'HIGH_CONFIDENCE' || band === 'MEDIUM_CONFIDENCE';
}
