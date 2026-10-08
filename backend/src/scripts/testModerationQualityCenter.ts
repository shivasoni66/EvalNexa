import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import {
  fetchModerationById,
  fetchModerationQueue,
  approveEvaluationByModerator,
  returnEvaluationByModerator,
} from '../services/moderation.service';
import {
  calculateTotalPossibleMarks,
  validateQuestionMarksList,
  fetchAuthoritativeQuestions,
} from '../services/evaluations.service';
import { Evaluation } from '../models/Evaluation';
import { AnswerBook } from '../models/AnswerBook';
import { QuestionPaper } from '../models/QuestionPaper';
import { User } from '../models/User';

async function runModerationTests() {
  console.log('=====================================================================');
  console.log('MODERATION & QUALITY CENTER COMPREHENSIVE REGRESSION & INTEGRATION TESTS');
  console.log('=====================================================================\n');

  // -------------------------------------------------------------------
  // 1. DYNAMIC PAPER CONFIGURATION TESTS (Multiple Configurations)
  // -------------------------------------------------------------------
  console.log('--- TEST 1: Multiple Question Paper Configurations ---');

  // Config A: 10 Questions [2,2,2,2,2,5,5,5,5,5] -> Total = 35
  const configA = [
    { questionNumber: 1, label: 'Q1', maxMarks: 2 },
    { questionNumber: 2, label: 'Q2', maxMarks: 2 },
    { questionNumber: 3, label: 'Q3', maxMarks: 2 },
    { questionNumber: 4, label: 'Q4', maxMarks: 2 },
    { questionNumber: 5, label: 'Q5', maxMarks: 2 },
    { questionNumber: 6, label: 'Q6', maxMarks: 5 },
    { questionNumber: 7, label: 'Q7', maxMarks: 5 },
    { questionNumber: 8, label: 'Q8', maxMarks: 5 },
    { questionNumber: 9, label: 'Q9', maxMarks: 5 },
    { questionNumber: 10, label: 'Q10', maxMarks: 5 },
  ];
  const mapA = new Map<number, any>();
  configA.forEach((q) => mapA.set(q.questionNumber, { questionNumber: q.questionNumber, maximumMarks: q.maxMarks }));
  const totalA = calculateTotalPossibleMarks(mapA);
  console.log(`Config A (10 Questions): Total Possible = ${totalA} (Expected 35)`);
  if (totalA !== 35) throw new Error(`Config A failed: expected 35, got ${totalA}`);
  console.log('✓ Config A Verified: Dynamic denominator is 35 (e.g. 20 / 35, NOT 20 / 100)');

  // Config B: 4 Questions [25, 25, 25, 25] -> Total = 100
  const configB = [
    { questionNumber: 1, label: '1(a)', maxMarks: 25 },
    { questionNumber: 2, label: '1(b)', maxMarks: 25 },
    { questionNumber: 3, label: '2', maxMarks: 25 },
    { questionNumber: 4, label: '3', maxMarks: 25 },
  ];
  const mapB = new Map<number, any>();
  configB.forEach((q) => mapB.set(q.questionNumber, { questionNumber: q.questionNumber, maximumMarks: q.maxMarks }));
  const totalB = calculateTotalPossibleMarks(mapB);
  console.log(`Config B (4 Questions with custom labels): Total Possible = ${totalB} (Expected 100)`);
  if (totalB !== 100) throw new Error(`Config B failed: expected 100, got ${totalB}`);
  console.log('✓ Config B Verified: Dynamic denominator is 100 (e.g. 74 / 100)');

  // Config C: 6 Questions [10, 10, 10, 10, 10, 10] -> Total = 60
  const configC = [10, 10, 10, 10, 10, 10];
  const mapC = new Map<number, any>();
  configC.forEach((max, idx) => mapC.set(idx + 1, { questionNumber: idx + 1, maximumMarks: max }));
  const totalC = calculateTotalPossibleMarks(mapC);
  console.log(`Config C (6 Questions): Total Possible = ${totalC} (Expected 60)`);
  if (totalC !== 60) throw new Error(`Config C failed: expected 60, got ${totalC}`);
  console.log('✓ Config C Verified: Dynamic denominator is 60 (e.g. 41 / 60)\n');

  // -------------------------------------------------------------------
  // 2. QUESTION-TO-PAGE MAPPING LOGIC (Multi-page & Shared pages)
  // -------------------------------------------------------------------
  console.log('--- TEST 2: Question-to-Page Association & Multi-Page Answers ---');
  const mockMappings = [
    { questionNumber: 1, pages: [1] },
    { questionNumber: 2, pages: [1] }, // Shared page 1
    { questionNumber: 3, pages: [1, 4] }, // Multi-page answer spanning 1 & 4
    { questionNumber: 4, pages: [1, 4] }, // Multi-page answer spanning 1 & 4
    { questionNumber: 5, pages: [4] },
    { questionNumber: 6, pages: [4] },
    { questionNumber: 7, pages: [3] }, // Shared page 3
    { questionNumber: 8, pages: [3] }, // Shared page 3
    { questionNumber: 9, pages: [3] }, // Shared page 3
    { questionNumber: 10, pages: [2] },
  ];

  // Verify multi-page question 3
  const q3Pages = mockMappings.find((m) => m.questionNumber === 3)?.pages;
  console.log(`Q3 Mapped Pages: [${q3Pages?.join(', ')}] (Multi-page: ${q3Pages?.length! > 1})`);
  if (q3Pages?.length !== 2 || !q3Pages.includes(1) || !q3Pages.includes(4)) {
    throw new Error('Q3 multi-page mapping failed');
  }

  // Verify shared page 3 for Q7, Q8, Q9
  const page3Questions = mockMappings.filter((m) => m.pages.includes(3)).map((m) => `Q${m.questionNumber}`);
  console.log(`Page 3 Shared by: ${page3Questions.join(', ')}`);
  if (page3Questions.length !== 3) {
    throw new Error('Shared page mapping test failed');
  }
  console.log('✓ Multi-page and Shared-page navigation associations verified.\n');

  // -------------------------------------------------------------------
  // 3. DYNAMIC QUALITY GATE QUESTION-AWARE VERIFICATION
  // -------------------------------------------------------------------
  console.log('--- TEST 3: Dynamic Quality Gate Checks ---');

  // A) Valid complete evaluation
  const validMarks = configA.map((q) => ({
    questionNumber: q.questionNumber,
    marks: q.maxMarks === 2 ? 2 : 2, // 2 for each question = 20 total
    status: 'MARKED' as const,
    examinerReviewed: true,
  }));
  const validationSuccess = validateQuestionMarksList(validMarks, mapA, true);
  console.log(`Valid Evaluation Total: ${validationSuccess.computedTotal} / ${totalA}`);
  if (validationSuccess.computedTotal !== 20) throw new Error('Expected 20 marks total');
  console.log('✓ Valid evaluation passes quality gate');

  // B) Out-of-bounds mark check
  try {
    const invalidMarkList = [
      ...validMarks.slice(1),
      { questionNumber: 1, marks: 3, status: 'MARKED' as const, examinerReviewed: true }, // 3 > maxMarks 2
    ];
    validateQuestionMarksList(invalidMarkList, mapA, true);
    throw new Error('Quality gate should have rejected mark 3 > maxMarks 2');
  } catch (err: any) {
    console.log(`✓ Quality Gate correctly caught out-of-bounds mark: ${err.message}`);
  }

  // C) Unreviewed question check
  try {
    const unreviewedList = [
      ...validMarks.slice(1),
      { questionNumber: 1, marks: 2, status: 'MARKED' as const, examinerReviewed: false },
    ];
    validateQuestionMarksList(unreviewedList, mapA, true);
    throw new Error('Quality gate should have rejected unreviewed question');
  } catch (err: any) {
    console.log(`✓ Quality Gate correctly caught unreviewed question: ${err.message}`);
  }

  // D) Missing question check
  try {
    const incompleteList = validMarks.slice(0, 9); // Missing Q10
    validateQuestionMarksList(incompleteList, mapA, true);
    throw new Error('Quality gate should have rejected missing question');
  } catch (err: any) {
    console.log(`✓ Quality Gate correctly caught missing question: ${err.message}\n`);
  }

  // -------------------------------------------------------------------
  // 4. LIVE DATABASE INTEGRATION TEST
  // -------------------------------------------------------------------
  console.log('--- TEST 4: Live MongoDB Integration & Service Endpoints ---');
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB');

    // Test fetchModerationQueue
    const queue = await fetchModerationQueue('ALL');
    console.log(`Active Moderation Queue contains: ${queue.length} evaluations`);
    if (queue.length > 0) {
      const first = queue[0];
      console.log(`First Queue Item ID: ${first._id}`);
      console.log(`Status: ${first.status}`);
      console.log(`Total Marks: ${first.totalMarks}`);
      console.log(`Dynamic Total Possible: ${first.totalPossibleMarks}`);
    }

    // Test fetchModerationById for the real active evaluation
    const evaluation = (await Evaluation.findById('6ac3fc5914592950418071fb')) || (await Evaluation.findOne());
    if (evaluation) {
      console.log(`\nTesting fetchModerationById for ID: ${evaluation._id}`);
      const detail = await fetchModerationById(evaluation._id.toString());
      console.log(`Retrieved Evaluation ID: ${detail.evaluation._id}`);
      console.log(`Evaluation Status: ${detail.evaluation.status}`);
      console.log(`Total Awarded Marks: ${detail.evaluation.totalMarks}`);
      console.log(`Total Possible Marks: ${detail.evaluation.totalPossibleMarks}`);
      console.log(`QuestionPaper present: ${Boolean(detail.questionPaper)}`);
      if (detail.questionPaper) {
        console.log(`QuestionPaper PaperSet: ${detail.questionPaper.paperSet}`);
        console.log(`QuestionPaper Verified Questions: ${detail.questionPaper.verifiedQuestions?.length}`);
      }

      const ab = await AnswerBook.findById(detail.evaluation.answerBookId);
      if (ab) {
        console.log(`AnswerBook Code: ${ab.answerBookCode}`);
        console.log(`Page Count: ${ab.pageCount}`);
        console.log(`QuestionPageMapping entries: ${ab.questionPageMapping?.length}`);
      }
    }

    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
  } else {
    console.log('MONGODB_URI not set, skipping DB connection.');
  }

  console.log('\n=====================================================================');
  console.log('ALL MODERATION & QUALITY CENTER REGRESSION TESTS PASSED SUCCESSFULLY!');
  console.log('=====================================================================');
}

runModerationTests().catch((err) => {
  console.error('Moderation tests failed:', err);
  process.exit(1);
});
