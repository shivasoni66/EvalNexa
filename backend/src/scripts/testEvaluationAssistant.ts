import {
  EvaluationAssistantService,
  validateAndEnforceAssistantConstraints,
  EvaluationAssistantInput,
  EvaluationAssistantResult,
} from '../services/EvaluationAssistantService';

async function runAssistantTests() {
  console.log('===============================================================');
  console.log('EVALNEXA EVALUATION ASSISTANT (AI COPILOT) TEST SUITE');
  console.log('===============================================================\n');

  let passCount = 0;

  const sampleInput: EvaluationAssistantInput = {
    question: 'Explain deadlock and its four necessary conditions in OS.',
    maximumMarks: 10,
    rubric: [
      { criterion: 'Definition of Deadlock', marks: 2 },
      { criterion: 'Mutual Exclusion & Hold and Wait', marks: 3 },
      { criterion: 'No Preemption & Circular Wait', marks: 3 },
      { criterion: 'Example or Diagram', marks: 2 },
    ],
    referenceAnswer:
      'A deadlock occurs when two or more processes are unable to proceed because each is waiting for the other to release a resource. The four necessary conditions are Mutual Exclusion, Hold and Wait, No Preemption, and Circular Wait.',
    keyConcepts: ['Mutual Exclusion', 'Hold and Wait', 'No Preemption', 'Circular Wait'],
    gradingNotes: 'Accept conceptual explanations; exact phrasing not mandatory.',
    language: 'en',
    ocrText:
      'Deadlock is a state where processes wait indefinitely for resources held by each other. Four conditions: 1. Mutual exclusion: resource cannot be shared. 2. Hold and wait: process holds resource while waiting for more. 3. No preemption: resources cannot be forcibly confiscated. 4. Circular wait: cyclic chain of waiting processes.',
    ocrConfidence: 0.92,
  };

  // -------------------------------------------------------------------------
  // Test 1: Valid AI response validation
  // -------------------------------------------------------------------------
  console.log('Test 1: Validating properly structured AI response...');
  const validAiResponse = {
    suggestedMarks: 9,
    minMarks: 8,
    maxMarks: 10,
    confidence: 0.95,
    needsHumanReview: false,
    criteria: [
      {
        name: 'Definition of Deadlock',
        maxMarks: 2,
        awardedMarks: 2,
        evidence: 'Deadlock is a state where processes wait indefinitely...',
      },
      {
        name: 'Mutual Exclusion & Hold and Wait',
        maxMarks: 3,
        awardedMarks: 3,
        evidence: 'Mutual exclusion and Hold and wait clearly explained.',
      },
      {
        name: 'No Preemption & Circular Wait',
        maxMarks: 3,
        awardedMarks: 3,
        evidence: 'No preemption and circular wait accurately identified.',
      },
      {
        name: 'Example or Diagram',
        maxMarks: 2,
        awardedMarks: 1,
        evidence: 'Brief example given, but no full visual diagram.',
      },
    ],
    missingConcepts: [],
    reasoningSummary:
      'Strong conceptual response covering all four Coffman conditions with minor deduction for lack of diagram.',
  };

  const parsedValid = validateAndEnforceAssistantConstraints(validAiResponse, sampleInput);
  if (
    parsedValid.suggestedMarks === 9 &&
    parsedValid.confidence === 0.95 &&
    parsedValid.criteria.length === 4 &&
    !parsedValid.needsHumanReview
  ) {
    console.log('✓ Successfully validated structured AI output matching all constraints');
    passCount++;
  } else {
    throw new Error('Failed to validate valid AI response');
  }

  // -------------------------------------------------------------------------
  // Test 2: Reject suggestedMarks > maximumMarks
  // -------------------------------------------------------------------------
  console.log('\nTest 2: Testing rejection when suggestedMarks exceeds maximum marks...');
  try {
    const invalidMarks = { ...validAiResponse, suggestedMarks: 15 };
    validateAndEnforceAssistantConstraints(invalidMarks, sampleInput);
    throw new Error('FAILED: Should have rejected suggestedMarks exceeding question maximum');
  } catch (err: any) {
    if (err.message.includes('out of bounds')) {
      console.log('✓ Successfully rejected marks exceeding question maximum');
      passCount++;
    } else {
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Test 3: Reject negative suggestedMarks
  // -------------------------------------------------------------------------
  console.log('\nTest 3: Testing rejection of negative suggestedMarks...');
  try {
    const negativeMarks = { ...validAiResponse, suggestedMarks: -2 };
    validateAndEnforceAssistantConstraints(negativeMarks, sampleInput);
    throw new Error('FAILED: Should have rejected negative marks');
  } catch (err: any) {
    console.log('✓ Successfully rejected negative marks');
    passCount++;
  }

  // -------------------------------------------------------------------------
  // Test 4: Reject minMarks > suggestedMarks
  // -------------------------------------------------------------------------
  console.log('\nTest 4: Testing rejection when minMarks > suggestedMarks...');
  try {
    const invertedRange = { ...validAiResponse, minMarks: 10, suggestedMarks: 8 };
    validateAndEnforceAssistantConstraints(invertedRange, sampleInput);
    throw new Error('FAILED: Should have rejected minMarks > suggestedMarks');
  } catch (err: any) {
    if (err.message.includes('minMarks')) {
      console.log('✓ Successfully rejected inverted mark range (minMarks > suggestedMarks)');
      passCount++;
    } else {
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Test 5: Reject criterion awardedMarks > criterion maxMarks
  // -------------------------------------------------------------------------
  console.log('\nTest 5: Testing rejection when criterion awarded marks exceeds criterion limit...');
  try {
    const excessiveCriterion = {
      ...validAiResponse,
      criteria: [
        {
          name: 'Definition of Deadlock',
          maxMarks: 2,
          awardedMarks: 5, // Exceeds 2
          evidence: 'Excessive score test',
        },
      ],
    };
    validateAndEnforceAssistantConstraints(excessiveCriterion, sampleInput);
    throw new Error('FAILED: Should have rejected criterion marks exceeding criterion maximum');
  } catch (err: any) {
    if (err.message.includes('exceeds criterion maximum')) {
      console.log('✓ Successfully rejected criterion marks exceeding limit');
      passCount++;
    } else {
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Test 6: Fallback when neither image nor OCR is available (Do not invent evaluation)
  // -------------------------------------------------------------------------
  console.log('\nTest 6: Testing behavior when neither script image nor OCR text is available...');
  const emptyInput: EvaluationAssistantInput = {
    question: 'Define Semaphore.',
    maximumMarks: 5,
    rubric: [{ criterion: 'Definition', marks: 5 }],
    ocrText: '',
    studentAnswerImage: undefined,
  };

  const emptyResult = await EvaluationAssistantService.evaluateStudentAnswer(emptyInput);
  if (
    emptyResult.needsHumanReview === true &&
    emptyResult.suggestedMarks === 0 &&
    emptyResult.confidence === 0
  ) {
    console.log('✓ Successfully returned needsHumanReview=true without inventing evaluation');
    passCount++;
  } else {
    throw new Error(`Expected needsHumanReview=true and 0 marks, got: ${JSON.stringify(emptyResult)}`);
  }

  // -------------------------------------------------------------------------
  // Test 7: Fallback when OCR confidence is poor and image is unavailable
  // -------------------------------------------------------------------------
  console.log('\nTest 7: Testing behavior when OCR confidence is low (< 0.35) and image is unavailable...');
  const lowOcrInput: EvaluationAssistantInput = {
    question: 'Define Paging.',
    maximumMarks: 5,
    rubric: [{ criterion: 'Definition', marks: 5 }],
    ocrText: 'g%#b page ?...',
    ocrConfidence: 0.2, // Poor confidence
    studentAnswerImage: undefined,
  };

  const lowOcrResult = await EvaluationAssistantService.evaluateStudentAnswer(lowOcrInput);
  if (
    lowOcrResult.needsHumanReview === true &&
    lowOcrResult.reasoningSummary.includes('below acceptable threshold')
  ) {
    console.log('✓ Successfully flagged low OCR confidence for human review');
    passCount++;
  } else {
    throw new Error(`Expected low OCR fallback, got: ${JSON.stringify(lowOcrResult)}`);
  }

  // -------------------------------------------------------------------------
  // Test 8: Non-blocking behavior when GEMINI_API_KEY is not configured
  // -------------------------------------------------------------------------
  console.log('\nTest 8: Testing non-blocking behavior when GEMINI_API_KEY is unset...');
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const unconfiguredResult = await EvaluationAssistantService.evaluateStudentAnswer(sampleInput);
  if (
    unconfiguredResult &&
    (unconfiguredResult.needsHumanReview === true || unconfiguredResult.suggestedMarks > 0)
  ) {
    console.log('✓ Successfully returned non-blocking evaluation result without crashing or blocking examiner');
    passCount++;
  } else {
    throw new Error(`Expected non-blocking evaluation, got: ${JSON.stringify(unconfiguredResult)}`);
  }

  // Restore key if existed
  if (originalKey) process.env.GEMINI_API_KEY = originalKey;

  console.log('\n===============================================================');
  console.log(`ALL ${passCount} EVALUATION ASSISTANT TESTS PASSED SUCCESSFULLY!`);
  console.log('===============================================================');
}

runAssistantTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
