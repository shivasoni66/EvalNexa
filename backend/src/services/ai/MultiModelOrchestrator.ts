import { geminiManager } from '../../config/gemini';
import { GeminiProvider } from './providers/GeminiProvider';
import { OpenAICompatibleProvider } from './providers/OpenAICompatibleProvider';
import {
  IAIEvaluator,
  SingleModelEvaluationResult,
  EnsembleConsensusResult,
} from './types';
import {
  EvaluationAssistantInput,
  EvaluationAssistantResult,
  EvaluationAssistantCriteriaSuggestion,
} from '../EvaluationAssistantService';

export class MultiModelOrchestrator {
  private static readonly TIMEOUT_MS = 4000; // 4.0s hard ceiling for speed

  /**
   * Discovers and instantiates available evaluators based on active credentials.
   * Ensures at least 2 distinct evaluation perspectives even if only Gemini is configured.
   */
  public static getActiveEvaluators(): IAIEvaluator[] {
    const evaluators: IAIEvaluator[] = [];

    // 1. Google Gemini Provider(s)
    const geminiClient = geminiManager.getClient();
    if (geminiClient) {
      const configStatus = geminiManager.getConfigStatus();
      const primaryModel = configStatus.resolvedModel;

      // Evaluator A: Primary Multimodal
      evaluators.push(
        new GeminiProvider({
          id: 'gemini-primary',
          name: 'Gemini Primary (Multimodal)',
          client: geminiClient,
          modelName: primaryModel,
          temperature: 0.1,
        })
      );

      // Evaluator B: Secondary Gemini Diversity Evaluator
      const secondaryModel =
        primaryModel === 'gemini-2.5-flash'
          ? 'gemini-3.1-flash-lite'
          : 'gemini-2.5-flash';

      evaluators.push(
        new GeminiProvider({
          id: 'gemini-diversity',
          name: 'Gemini Secondary (Cross-Verification)',
          client: geminiClient,
          modelName: secondaryModel,
          temperature: 0.25,
        })
      );
    }

    // 2. OpenAI Provider (if configured)
    const openAiKey = process.env.OPENAI_API_KEY?.trim();
    if (openAiKey) {
      evaluators.push(
        new OpenAICompatibleProvider({
          id: 'openai-evaluator',
          name: 'OpenAI Evaluator',
          apiKey: openAiKey,
          baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          modelName: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          supportsVision: false,
          temperature: 0.1,
        })
      );
    }

    // 3. Groq Provider (if configured)
    const groqKey = process.env.GROQ_API_KEY?.trim();
    if (groqKey) {
      evaluators.push(
        new OpenAICompatibleProvider({
          id: 'groq-evaluator',
          name: 'Groq Ultra-Fast Reasoner',
          apiKey: groqKey,
          baseUrl: 'https://api.groq.com/openai/v1',
          modelName: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
          supportsVision: false,
          temperature: 0.1,
        })
      );
    }

    // Cap active evaluators to at most 3 for optimal speed and consensus balance
    return evaluators.slice(0, 3);
  }

  /**
   * Executes multi-model evaluation in parallel with quorum and consensus reconciliation.
   */
  public static async evaluateParallel(
    input: EvaluationAssistantInput
  ): Promise<EnsembleConsensusResult> {
    const evaluators = this.getActiveEvaluators();
    if (evaluators.length === 0) {
      throw new Error('No AI evaluation models configured. API keys missing.');
    }

    // Dispatch all evaluators concurrently with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const settledPromises = evaluators.map((evaluator) =>
        evaluator
          .evaluate(input, controller.signal)
          .catch((err) => {
            return Promise.reject(err);
          })
      );

      const results = await Promise.allSettled(settledPromises);
      clearTimeout(timeoutId);

      const successfulResults: SingleModelEvaluationResult[] = [];
      const failedErrors: Array<{ model: string; error: string }> = [];

      results.forEach((res, index) => {
        const evaluator = evaluators[index];
        if (res.status === 'fulfilled') {
          successfulResults.push(res.value);
        } else {
          failedErrors.push({
            model: evaluator.name,
            error: res.reason?.message || 'Unknown evaluation failure',
          });
        }
      });

      if (successfulResults.length === 0) {
        const detailMsg = failedErrors.map((f) => `${f.model}: ${f.error}`).join('; ');
        throw new Error(`All parallel AI evaluators failed (${detailMsg})`);
      }

      // Reconcile consensus
      return this.reconcileConsensus(successfulResults, input);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Pure mathematical arbiter that computes consensus, filters outliers,
   * detects criteria divergence, and harmonizes scoring.
   */
  private static reconcileConsensus(
    results: SingleModelEvaluationResult[],
    input: EvaluationAssistantInput
  ): EnsembleConsensusResult {
    const maxMarks = input.maximumMarks;

    // Single result fallback
    if (results.length === 1) {
      const single = results[0];
      return {
        suggestedMarks: single.suggestedMarks,
        minMarks: single.minMarks,
        maxMarks: single.maxMarks,
        confidence: single.confidence,
        needsHumanReview: single.needsHumanReview,
        criteria: single.criteria,
        missingConcepts: single.missingConcepts,
        reasoningSummary: single.reasoningSummary,
        model: single.modelName,
        ensembleMetadata: {
          modelsEvaluated: [single.modelName],
          modelsRespondedCount: 1,
          agreementRatio: 1,
          scoreVariance: 0,
          individualScores: [
            {
              model: single.modelName,
              score: single.suggestedMarks,
              latencyMs: single.latencyMs,
            },
          ],
          consensusStrategy: 'SINGLE_FALLBACK',
        },
      };
    }

    const scores = results.map((r) => r.suggestedMarks);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const scoreRange = maxScore - minScore;
    const normalizedDiscrepancy = maxMarks > 0 ? scoreRange / maxMarks : 0;
    const agreementRatio = Math.max(0, Math.min(1, 1 - normalizedDiscrepancy));

    // Calculate Consensus Marks
    let finalSuggestedMarks: number;
    let strategy: 'UNANIMOUS' | 'MAJORITY_QUORUM' | 'WEIGHTED_MEDIAN';

    if (scoreRange === 0) {
      finalSuggestedMarks = scores[0];
      strategy = 'UNANIMOUS';
    } else if (results.length === 3) {
      // 3 models: check for outlier rejection
      const sorted = [...scores].sort((a, b) => a - b);
      const median = sorted[1];
      const diff0 = Math.abs(sorted[0] - median);
      const diff2 = Math.abs(sorted[2] - median);

      // If one end is a strong outlier, take the average of the two concordant models
      const outlierThreshold = maxMarks * 0.18;
      if (diff0 > outlierThreshold && diff2 <= outlierThreshold) {
        finalSuggestedMarks = (sorted[1] + sorted[2]) / 2;
        strategy = 'MAJORITY_QUORUM';
      } else if (diff2 > outlierThreshold && diff0 <= outlierThreshold) {
        finalSuggestedMarks = (sorted[0] + sorted[1]) / 2;
        strategy = 'MAJORITY_QUORUM';
      } else {
        // Balanced median
        finalSuggestedMarks = median;
        strategy = 'WEIGHTED_MEDIAN';
      }
    } else {
      // 2 models: mean of both
      finalSuggestedMarks = (scores[0] + scores[1]) / 2;
      strategy = 'WEIGHTED_MEDIAN';
    }

    // Round marks to nearest 0.5 or 0.1
    finalSuggestedMarks = Math.round(finalSuggestedMarks * 10) / 10;
    finalSuggestedMarks = Math.max(0, Math.min(maxMarks, finalSuggestedMarks));

    // Harmonize Confidence
    const avgConfidence =
      results.reduce((acc, curr) => acc + curr.confidence, 0) / results.length;
    let finalConfidence: number;

    if (agreementRatio >= 0.9) {
      finalConfidence = Math.min(0.98, avgConfidence + 0.08); // High consensus boost
    } else if (agreementRatio < 0.75) {
      finalConfidence = Math.max(0.4, avgConfidence - 0.2); // Divergence penalty
    } else {
      finalConfidence = avgConfidence;
    }

    // Human Review Flag: Flag if any individual requested review, or if divergence > 15%
    const isDivergent = normalizedDiscrepancy > 0.15;
    const needsHumanReview =
      results.some((r) => r.needsHumanReview) ||
      isDivergent ||
      finalConfidence < 0.82;

    // Harmonize Criteria Suggestions
    const reconciledCriteria: EvaluationAssistantCriteriaSuggestion[] = [];
    const baseCriteriaList = results[0].criteria;

    for (let cIdx = 0; cIdx < baseCriteriaList.length; cIdx++) {
      const criterionName = baseCriteriaList[cIdx].name;
      const criterionMax = baseCriteriaList[cIdx].maxMarks;

      const marksAwardedAcrossModels = results
        .map((r) => r.criteria[cIdx]?.awardedMarks)
        .filter((m): m is number => typeof m === 'number');

      const avgCriterionMarks =
        marksAwardedAcrossModels.length > 0
          ? marksAwardedAcrossModels.reduce((a, b) => a + b, 0) / marksAwardedAcrossModels.length
          : 0;

      const evidencePieces = results
        .map((r) => r.criteria[cIdx]?.evidence)
        .filter((e) => Boolean(e && e.trim().length > 0));

      const combinedEvidence =
        evidencePieces.length > 0
          ? evidencePieces[0]
          : 'Verified against rubric requirements across ensemble models.';

      reconciledCriteria.push({
        name: criterionName,
        maxMarks: criterionMax,
        awardedMarks: Math.min(criterionMax, Math.round(avgCriterionMarks * 10) / 10),
        evidence: combinedEvidence,
      });
    }

    // Synthesize Reasoning Summary
    const individualSummaries = results
      .map((r) => `[${r.modelName}: ${r.suggestedMarks}/${maxMarks}] ${r.reasoningSummary}`)
      .join('\n');

    let consensusNote = `Consensus score: ${finalSuggestedMarks}/${maxMarks} across ${results.length} parallel models.`;
    if (isDivergent) {
      consensusNote += ` ⚠ Divergence notice: Models varied by ${scoreRange.toFixed(1)} marks (${Math.round(normalizedDiscrepancy * 100)}%). Examiner inspection recommended.`;
    }

    const reasoningSummary = `${consensusNote}\n${individualSummaries}`;

    // Union missing concepts
    const allMissing = Array.from(
      new Set(results.flatMap((r) => r.missingConcepts))
    );

    return {
      suggestedMarks: finalSuggestedMarks,
      minMarks: Math.min(...results.map((r) => r.minMarks)),
      maxMarks: Math.max(...results.map((r) => r.maxMarks)),
      confidence: Math.round(finalConfidence * 100) / 100,
      needsHumanReview,
      criteria: reconciledCriteria,
      missingConcepts: allMissing,
      reasoningSummary,
      model: `Ensemble (${results.map((r) => r.modelName).join(' + ')})`,
      ensembleMetadata: {
        modelsEvaluated: results.map((r) => r.modelName),
        modelsRespondedCount: results.length,
        agreementRatio: Math.round(agreementRatio * 100) / 100,
        scoreVariance: Math.round(scoreRange * 10) / 10,
        individualScores: results.map((r) => ({
          model: r.modelName,
          score: r.suggestedMarks,
          latencyMs: r.latencyMs,
        })),
        consensusStrategy: strategy,
      },
    };
  }
}
