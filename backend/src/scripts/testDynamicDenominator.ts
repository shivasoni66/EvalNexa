import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import {
  calculateTotalPossibleMarks,
  validateQuestionMarksList,
  fetchAuthoritativeQuestions,
  fetchEvaluationById,
} from '../services/evaluations.service';
import { AnswerBook } from '../models/AnswerBook';
import { QuestionPaper } from '../models/QuestionPaper';
import { Evaluation } from '../models/Evaluation';
import { Exam } from '../models/Exam';

async function runRegressionTests() {
  console.log('====================================================');
  console.log('RUNNING REGRESSION TESTS FOR DYNAMIC DENOMINATOR');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // Test Case 1: 10 Questions [2,2,2,2,2,5,5,5,5,5]
  // Expected: totalPossibleMarks = 35
  // Examiner marks total = 20 -> 20 / 35
  // ----------------------------------------------------
  console.log('--- Test Case 1: 10 Questions [2,2,2,2,2,5,5,5,5,5] ---');
  const marks1 = [2, 2, 2, 2, 2, 5, 5, 5, 5, 5];
  const questionMap1 = new Map<number, any>();
  marks1.forEach((max, idx) => {
    questionMap1.set(idx + 1, {
      questionNumber: idx + 1,
      maximumMarks: max,
      text: `Question ${idx + 1}`,
    });
  });

  const totalPossible1 = calculateTotalPossibleMarks(questionMap1);
  console.log(`Calculated totalPossibleMarks: ${totalPossible1}`);
  if (totalPossible1 !== 35) {
    throw new Error(`Test 1 FAILED: Expected 35, got ${totalPossible1}`);
  }

  const examinerMarks1: any[] = [
    { questionNumber: 1, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 2, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 3, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 4, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 5, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 6, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 7, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 8, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 9, marks: 2, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 10, marks: 2, status: 'MARKED', examinerReviewed: true },
  ];
  const validation1 = validateQuestionMarksList(examinerMarks1, questionMap1, false);
  console.log(`Examiner Total: ${validation1.computedTotal} / ${totalPossible1}`);
  if (validation1.computedTotal !== 20) {
    throw new Error(`Test 1 FAILED: Expected computedTotal 20, got ${validation1.computedTotal}`);
  }
  console.log('✓ Test Case 1 PASSED: Display/Backend total = 20 / 35\n');

  // ----------------------------------------------------
  // Test Case 2: 3 Questions [10, 20, 30]
  // Expected: totalPossibleMarks = 60
  // Examiner marks total = 42 -> 42 / 60
  // ----------------------------------------------------
  console.log('--- Test Case 2: 3 Questions [10, 20, 30] ---');
  const questionMap2 = new Map<number, any>();
  [10, 20, 30].forEach((max, idx) => {
    questionMap2.set(idx + 1, {
      questionNumber: idx + 1,
      maximumMarks: max,
      text: `Question ${idx + 1}`,
    });
  });
  const totalPossible2 = calculateTotalPossibleMarks(questionMap2);
  console.log(`Calculated totalPossibleMarks: ${totalPossible2}`);
  if (totalPossible2 !== 60) {
    throw new Error(`Test 2 FAILED: Expected 60, got ${totalPossible2}`);
  }
  const examinerMarks2: any[] = [
    { questionNumber: 1, marks: 8, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 2, marks: 14, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 3, marks: 20, status: 'MARKED', examinerReviewed: true },
  ];
  const validation2 = validateQuestionMarksList(examinerMarks2, questionMap2, false);
  console.log(`Examiner Total: ${validation2.computedTotal} / ${totalPossible2}`);
  if (validation2.computedTotal !== 42) {
    throw new Error(`Test 2 FAILED: Expected computedTotal 42, got ${validation2.computedTotal}`);
  }
  console.log('✓ Test Case 2 PASSED: Display/Backend total = 42 / 60\n');

  // ----------------------------------------------------
  // Test Case 3: 4 Questions [25, 25, 25, 25]
  // Expected: totalPossibleMarks = 100
  // Examiner marks total = 78 -> 78 / 100
  // ----------------------------------------------------
  console.log('--- Test Case 3: 4 Questions [25, 25, 25, 25] ---');
  const questionMap3 = new Map<number, any>();
  [25, 25, 25, 25].forEach((max, idx) => {
    questionMap3.set(idx + 1, {
      questionNumber: idx + 1,
      maximumMarks: max,
      text: `Question ${idx + 1}`,
    });
  });
  const totalPossible3 = calculateTotalPossibleMarks(questionMap3);
  console.log(`Calculated totalPossibleMarks: ${totalPossible3}`);
  if (totalPossible3 !== 100) {
    throw new Error(`Test 3 FAILED: Expected 100, got ${totalPossible3}`);
  }
  const examinerMarks3: any[] = [
    { questionNumber: 1, marks: 20, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 2, marks: 20, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 3, marks: 20, status: 'MARKED', examinerReviewed: true },
    { questionNumber: 4, marks: 18, status: 'MARKED', examinerReviewed: true },
  ];
  const validation3 = validateQuestionMarksList(examinerMarks3, questionMap3, false);
  console.log(`Examiner Total: ${validation3.computedTotal} / ${totalPossible3}`);
  if (validation3.computedTotal !== 78) {
    throw new Error(`Test 3 FAILED: Expected computedTotal 78, got ${validation3.computedTotal}`);
  }
  console.log('✓ Test Case 3 PASSED: Display/Backend total = 78 / 100\n');

  // ----------------------------------------------------
  // Test Case 4: Mark Boundary Validation (cannot exceed per-question maxMarks)
  // ----------------------------------------------------
  console.log('--- Test Case 4: Per-Question Max Marks Enforcement ---');
  try {
    const invalidMarks = [
      { questionNumber: 1, marks: 3, status: 'MARKED', examinerReviewed: true }, // Max is 2!
    ];
    validateQuestionMarksList(invalidMarks as any, questionMap1, false);
    throw new Error('Test 4 FAILED: Should have rejected mark 3 > maxMarks 2');
  } catch (err: any) {
    if (err.code === 'MARKS_EXCEED_MAXIMUM') {
      console.log('✓ Correctly rejected mark exceeding question maximumMarks: ' + err.message);
    } else {
      throw err;
    }
  }
  console.log('✓ Test Case 4 PASSED\n');

  // ----------------------------------------------------
  // Test Case 5: Verify Live DB Data & Backend Population
  // ----------------------------------------------------
  console.log('--- Test Case 5: Live Database Verification & Dynamic Population ---');
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB.');

    // Look for evaluation
    const evaluation = (await Evaluation.findById('6ac3fc5914592950418071fb')) || (await Evaluation.findOne());
    if (evaluation) {
      const answerBook = await AnswerBook.findById(evaluation.answerBookId);
      if (answerBook) {
        console.log(`Found AnswerBook: ${answerBook.answerBookCode} (ID: ${answerBook._id})`);
        const qp = answerBook.questionPaperId ? await QuestionPaper.findById(answerBook.questionPaperId) : null;
        if (qp) {
          console.log(`QuestionPaper Set: ${qp.paperSet}, Status: ${qp.extractionStatus}`);
          console.log(`Verified questions count: ${qp.verifiedQuestions?.length}`);
          const verifiedSum = (qp.verifiedQuestions || []).reduce(
            (sum, q) => sum + Number(q.maximumMarks || 0),
            0
          );
          console.log(`Sum of verified questions maximumMarks: ${verifiedSum}`);

          const authQuestions = await fetchAuthoritativeQuestions(answerBook.examId, answerBook._id);
          const dynamicTotalPossible = calculateTotalPossibleMarks(authQuestions);
          console.log(`Authoritative totalPossibleMarks: ${dynamicTotalPossible}`);
          if (dynamicTotalPossible !== verifiedSum) {
            throw new Error(`Mismatch: dynamicTotalPossible (${dynamicTotalPossible}) !== verifiedSum (${verifiedSum})`);
          }

          const loadedEval = await fetchEvaluationById(
            evaluation._id.toString(),
            'SUPER_ADMIN',
            'system'
          );
          console.log(`Evaluation ID: ${loadedEval._id}`);
          console.log(`Evaluation totalMarks: ${loadedEval.totalMarks}`);
          console.log(`Evaluation totalPossibleMarks (backend): ${loadedEval.totalPossibleMarks}`);
          console.log(`\n=> LIVE WORKSPACE DYNAMIC RATIO: ${loadedEval.totalMarks} / ${loadedEval.totalPossibleMarks}`);
          if (loadedEval.totalPossibleMarks !== verifiedSum) {
            throw new Error(`Expected loadedEval.totalPossibleMarks to be ${verifiedSum}, got ${loadedEval.totalPossibleMarks}`);
          }
          console.log('✓ Dynamic denominator matches authoritative QuestionPaper verified sum exactly!');
        }
      }
    }
    await mongoose.disconnect();
  } else {
    console.log('MONGODB_URI not configured, skipping live DB test.');
  }

  console.log('\n====================================================');
  console.log('ALL REGRESSION TESTS COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
}

runRegressionTests().catch((err) => {
  console.error('Regression tests failed:', err);
  process.exit(1);
});
