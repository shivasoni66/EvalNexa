import 'dotenv/config';
import { MultiModelOrchestrator } from '../services/ai/MultiModelOrchestrator';
import { SingleModelEvaluationResult } from '../services/ai/types';
import { EvaluationAssistantInput } from '../services/EvaluationAssistantService';

async function runMultiModelConsensusTests() {
  console.log('===============================================================');
  console.log('EVALNEXA MULTI-LLM CONSENSUS & ENSEMBLE ORCHESTRATOR TEST SUITE');
  console.log('===============================================================\n');

  let passed = 0;

  const mockInput: EvaluationAssistantInput = {
    question: 'Describe photosynthesis and the role of chlorophyll.',
    maximumMarks: 10,
    rubric: [
      { criterion: 'Equation and Concept', marks: 5 },
      { criterion: 'Role of Chlorophyll and Light', marks: 5 },
    ],
    ocrText: 'Photosynthesis converts light into glucose using chlorophyll.',
  };

  // -------------------------------------------------------------------------
  // Test 1: Evaluator discovery without crashing
  // -------------------------------------------------------------------------
  console.log('Test 1: Testing evaluator auto-discovery...');
  const evaluators = MultiModelOrchestrator.getActiveEvaluators();
  console.log(`Discovered ${evaluators.length} active evaluators.`);
  evaluators.forEach((e) => console.log(`  - [${e.id}] ${e.name} (supportsVision: ${e.supportsVision})`));
  console.log('✓ Evaluator auto-discovery executed successfully\n');
  passed++;

  // -------------------------------------------------------------------------
  // Test 2: Unanimous consensus across 3 models
  // -------------------------------------------------------------------------
  console.log('Test 2: Reconciling unanimous multi-model scoring...');
  const unanimousResults: SingleModelEvaluationResult[] = [
    {
      modelName: 'Gemini Primary (Multimodal)',
      provider: 'gemini',
      suggestedMarks: 8.5,
      minMarks: 8,
      maxMarks: 10,
      confidence: 0.95,
      needsHumanReview: false,
      criteria: [
        { name: 'Equation and Concept', maxMarks: 5, awardedMarks: 4.5, evidence: 'Full concept' },
        { name: 'Role of Chlorophyll and Light', maxMarks: 5, awardedMarks: 4.0, evidence: 'Good explanation' },
      ],
      missingConcepts: [],
      reasoningSummary: 'Strong answer',
      latencyMs: 1200,
      isMultimodal: true,
    },
    {
      modelName: 'OpenAI Evaluator (gpt-4o-mini)',
      provider: 'openai-compatible',
      suggestedMarks: 8.5,
      minMarks: 8,
      maxMarks: 10,
      confidence: 0.94,
      needsHumanReview: false,
      criteria: [
        { name: 'Equation and Concept', maxMarks: 5, awardedMarks: 4.5, evidence: 'Concept described' },
        { name: 'Role of Chlorophyll and Light', maxMarks: 5, awardedMarks: 4.0, evidence: 'Chlorophyll highlighted' },
      ],
      missingConcepts: [],
      reasoningSummary: 'Accurate description',
      latencyMs: 850,
      isMultimodal: false,
    },
    {
      modelName: 'Groq Ultra-Fast Reasoner (llama-3.3)',
      provider: 'openai-compatible',
      suggestedMarks: 8.5,
      minMarks: 8,
      maxMarks: 10,
      confidence: 0.92,
      needsHumanReview: false,
      criteria: [
        { name: 'Equation and Concept', maxMarks: 5, awardedMarks: 4.5, evidence: 'Correct equation' },
        { name: 'Role of Chlorophyll and Light', maxMarks: 5, awardedMarks: 4.0, evidence: 'Matches rubric' },
      ],
      missingConcepts: [],
      reasoningSummary: 'Matches grading notes',
      latencyMs: 450,
      isMultimodal: false,
    },
  ];

  const unanimousConsensus = (MultiModelOrchestrator as any).reconcileConsensus(unanimousResults, mockInput);
  if (unanimousConsensus.suggestedMarks !== 8.5) {
    throw new Error(`Expected 8.5, got ${unanimousConsensus.suggestedMarks}`);
  }
  if (unanimousConsensus.ensembleMetadata.agreementRatio !== 1) {
    throw new Error(`Expected agreementRatio 1, got ${unanimousConsensus.ensembleMetadata.agreementRatio}`);
  }
  if (unanimousConsensus.ensembleMetadata.consensusStrategy !== 'UNANIMOUS') {
    throw new Error(`Expected UNANIMOUS, got ${unanimousConsensus.ensembleMetadata.consensusStrategy}`);
  }
  console.log(`✓ Unanimous score verified: ${unanimousConsensus.suggestedMarks}/10 (Strategy: ${unanimousConsensus.ensembleMetadata.consensusStrategy})\n`);
  passed++;

  // -------------------------------------------------------------------------
  // Test 3: Outlier rejection in 3-model ensemble
  // (Model A: 9.0, Model B: 8.5, Model C: 4.0 [outlier hallucination])
  // -------------------------------------------------------------------------
  console.log('Test 3: Testing outlier rejection (detecting anomalous model)...');
  const outlierResults: SingleModelEvaluationResult[] = [
    {
      ...unanimousResults[0],
      suggestedMarks: 9.0,
    },
    {
      ...unanimousResults[1],
      suggestedMarks: 8.5,
    },
    {
      ...unanimousResults[2],
      modelName: 'Rogue Model',
      suggestedMarks: 4.0, // Outlier!
    },
  ];

  const outlierConsensus = (MultiModelOrchestrator as any).reconcileConsensus(outlierResults, mockInput);
  // Concordant pair average: (9.0 + 8.5) / 2 = 8.75 -> rounded to 8.8
  if (outlierConsensus.suggestedMarks < 8.5 || outlierConsensus.suggestedMarks > 9.0) {
    throw new Error(`Outlier was not filtered! Score: ${outlierConsensus.suggestedMarks}`);
  }
  if (outlierConsensus.ensembleMetadata.consensusStrategy !== 'MAJORITY_QUORUM') {
    throw new Error(`Expected MAJORITY_QUORUM strategy, got ${outlierConsensus.ensembleMetadata.consensusStrategy}`);
  }
  console.log(`✓ Outlier successfully filtered: Final mark ${outlierConsensus.suggestedMarks}/10 (Strategy: ${outlierConsensus.ensembleMetadata.consensusStrategy})\n`);
  passed++;

  // -------------------------------------------------------------------------
  // Test 4: Divergence detection triggers human review flag
  // (Model A: 9.0, Model B: 6.0 => delta = 3.0 / 10 = 30% > 15% threshold)
  // -------------------------------------------------------------------------
  console.log('Test 4: Testing divergence safety trigger (needsHumanReview)...');
  const divergentResults: SingleModelEvaluationResult[] = [
    {
      ...unanimousResults[0],
      suggestedMarks: 9.0,
      needsHumanReview: false,
    },
    {
      ...unanimousResults[1],
      suggestedMarks: 6.0,
      needsHumanReview: false,
    },
  ];

  const divergentConsensus = (MultiModelOrchestrator as any).reconcileConsensus(divergentResults, mockInput);
  if (!divergentConsensus.needsHumanReview) {
    throw new Error('Divergence of 30% did NOT trigger needsHumanReview=true');
  }
  if (!divergentConsensus.reasoningSummary.includes('Divergence notice')) {
    throw new Error('Reasoning summary missing divergence notice');
  }
  console.log(`✓ Divergent scoring correctly flagged for human review: needsHumanReview=${divergentConsensus.needsHumanReview}\n`);
  passed++;

  console.log('===============================================================');
  console.log(`ALL ${passed} MULTI-MODEL CONSENSUS TESTS PASSED!`);
  console.log('===============================================================');
}

runMultiModelConsensusTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
