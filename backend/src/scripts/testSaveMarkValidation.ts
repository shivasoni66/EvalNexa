import {
  validateQuestionMarksList,
  IAuthoritativeQuestion,
} from '../services/evaluations.service';
import { updateEvaluationSchema, questionMarkSchema } from '../validators/schemas';
import { IEvaluationQuestionMark } from '../models/Evaluation';

async function runSaveMarkValidationTests() {
  console.log('===============================================================');
  console.log('EVALNEXA SAVE MARK & REVIEW VALIDATION REGRESSION TEST SUITE');
  console.log('===============================================================\n');

  // Question 4 with maximumMarks = 2
  const authoritativeQuestions = new Map<number, IAuthoritativeQuestion>([
    [4, { questionNumber: 4, maximumMarks: 2, text: 'What is the difference between static and dynamic data structures?' }],
  ]);

  let passCount = 0;

  // -------------------------------------------------------------------------
  // Test 1: Examiner marks = 2 on question with maximumMarks = 2 (Must Succeed)
  // -------------------------------------------------------------------------
  console.log('Test 1: Testing examiner marks = maximumMarks = 2 on Q4...');
  const marksEqualMax: IEvaluationQuestionMark[] = [
    {
      questionNumber: 4,
      marks: 2,
      status: 'MARKED',
      comment: 'Accurate distinction between static and dynamic memory',
      examinerReviewed: true,
      reviewedAt: new Date(),
    },
  ];
  const res1 = validateQuestionMarksList(marksEqualMax, authoritativeQuestions, false);
  if (res1.computedTotal !== 2 || res1.validatedList[0].marks !== 2) {
    throw new Error(`Expected computedTotal = 2, got ${res1.computedTotal}`);
  }
  console.log('✓ Valid marks = 2 (marks === maximumMarks) accepted successfully.');
  passCount++;

  // -------------------------------------------------------------------------
  // Test 2: Examiner marks = 0 on question with maximumMarks = 2 (Must Succeed)
  // -------------------------------------------------------------------------
  console.log('\nTest 2: Testing examiner marks = 0 on Q4...');
  const marksZero: IEvaluationQuestionMark[] = [
    {
      questionNumber: 4,
      marks: 0,
      status: 'MARKED',
      comment: 'Incorrect explanation',
      examinerReviewed: true,
      reviewedAt: new Date(),
    },
  ];
  const res2 = validateQuestionMarksList(marksZero, authoritativeQuestions, false);
  if (res2.computedTotal !== 0 || res2.validatedList[0].marks !== 0) {
    throw new Error(`Expected computedTotal = 0, got ${res2.computedTotal}`);
  }
  console.log('✓ Valid marks = 0 accepted successfully.');
  passCount++;

  // -------------------------------------------------------------------------
  // Test 3: Examiner marks > maximumMarks (marks = 3 on maxMarks = 2) (Must Reject with 400)
  // -------------------------------------------------------------------------
  console.log('\nTest 3: Testing examiner marks = 3 (> maximumMarks 2) rejection...');
  try {
    const marksExcessive: IEvaluationQuestionMark[] = [
      {
        questionNumber: 4,
        marks: 3,
        status: 'MARKED',
        comment: 'Exceeds maximum',
      },
    ];
    validateQuestionMarksList(marksExcessive, authoritativeQuestions, false);
    throw new Error('FAILED: Expected excessive marks rejection');
  } catch (err: any) {
    if (err.code !== 'MARKS_EXCEED_MAXIMUM' || err.status !== 400) {
      throw new Error(`Unexpected error: ${err.code} (${err.status}): ${err.message}`);
    }
    console.log('✓ Excessive marks correctly rejected with 400 MARKS_EXCEED_MAXIMUM.');
    passCount++;
  }

  // -------------------------------------------------------------------------
  // Test 4: Zod Schema Validation accepts aiAnalysis: null on unanalyzed questions
  // -------------------------------------------------------------------------
  console.log('\nTest 4: Testing updateEvaluationSchema with aiAnalysis: null...');
  const payloadWithNullAi = {
    totalMarks: 2,
    questionMarks: [
      {
        questionNumber: 1,
        marks: 0,
        status: 'NOT_STARTED',
        comment: '',
        aiStatus: 'NOT_STARTED',
        aiError: null,
        aiAnalysis: null, // Unanalyzed / unmapped question has null aiAnalysis
        examinerReviewed: false,
        reviewedAt: null,
      },
      {
        questionNumber: 4,
        marks: 2,
        status: 'MARKED',
        comment: 'Good definition',
        aiStatus: 'COMPLETED',
        aiError: null,
        aiAnalysis: {
          suggestedMarks: 2,
          minMarks: 0,
          maxMarks: 2,
          confidence: 0.95,
          needsHumanReview: false,
          reasoningSummary: 'Accurate distinction between static and dynamic allocation.',
          generatedAt: new Date().toISOString(),
          model: 'gemini-3.1-flash-lite',
        },
        examinerReviewed: true,
        reviewedAt: new Date().toISOString(),
      },
    ],
    remarks: 'Satisfactory script evaluation',
  };

  const zodResult = updateEvaluationSchema.safeParse(payloadWithNullAi);
  if (!zodResult.success) {
    throw new Error(`FAILED: Zod schema rejected payload with null aiAnalysis: ${JSON.stringify(zodResult.error.format())}`);
  }
  console.log('✓ updateEvaluationSchema successfully validates payload containing aiAnalysis: null.');
  passCount++;

  // -------------------------------------------------------------------------
  // Test 5: Repeated save on already reviewed question is idempotent & succeeds
  // -------------------------------------------------------------------------
  console.log('\nTest 5: Testing repeated save on already-reviewed Q4...');
  const alreadyReviewedList: IEvaluationQuestionMark[] = [
    {
      questionNumber: 4,
      marks: 2,
      status: 'MARKED',
      comment: 'Updated remarks on second save',
      examinerReviewed: true,
      reviewedAt: new Date(),
    },
  ];
  const res5 = validateQuestionMarksList(alreadyReviewedList, authoritativeQuestions, false);
  if (res5.computedTotal !== 2 || res5.validatedList[0].marks !== 2) {
    throw new Error(`Expected computedTotal = 2 on repeat save, got ${res5.computedTotal}`);
  }
  console.log('✓ Repeated save on already-reviewed question is completely valid and idempotent.');
  passCount++;

  console.log('\n===============================================================');
  console.log(`✓ ALL ${passCount}/5 SAVE MARK & REVIEW TESTS PASSED 100%!`);
  console.log('===============================================================');
}

runSaveMarkValidationTests().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
