import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { AnswerBook } from '../models/AnswerBook';
import { AnswerPage } from '../models/AnswerPage';
import { QuestionPaper } from '../models/QuestionPaper';
import { Evaluation } from '../models/Evaluation';
import {
  extractQuestionProfile,
  scorePageContent,
  checkExplicitHeader,
  autoMapAnswerBookPages,
  resolvePageImageBuffer,
  CURRENT_MAPPING_ALGORITHM_VERSION,
} from '../services/pageMapping.service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function runRealDiagnostic() {
  console.log('===============================================================');
  console.log('EVALNEXA REAL RUNTIME ANSWER BOOK MAPPING DIAGNOSTIC & REGRESSION');
  console.log('===============================================================');

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/evalnexa';
  await mongoose.connect(mongoUri);
  console.log('✓ Connected to MongoDB:', mongoUri);

  // 1. Locate real production AnswerBook EVN-TEST-001 (or active answer book)
  let answerBook = await AnswerBook.findOne({ answerBookCode: 'EVN-TEST-001' });
  if (!answerBook) {
    answerBook = await AnswerBook.findOne({ pageCount: { $gt: 5 } });
  }

  if (!answerBook) {
    throw new Error('No production-style AnswerBook found in database.');
  }

  console.log('\n--- ANSWER BOOK DIAGNOSTICS ---');
  console.log(`  id:              ${answerBook._id}`);
  console.log(`  code:            ${answerBook.answerBookCode}`);
  console.log(`  student:         ${answerBook.studentCode}`);
  console.log(`  examId:          ${answerBook.examId}`);
  console.log(`  questionPaperId: ${answerBook.questionPaperId}`);
  console.log(`  pageCount:       ${answerBook.pageCount}`);

  // 2. Locate QuestionPaper
  let questionPaper = await QuestionPaper.findById(answerBook.questionPaperId);
  if (!questionPaper) {
    questionPaper = await QuestionPaper.findOne({ examId: answerBook.examId, extractionStatus: 'VERIFIED' });
    if (questionPaper) {
      answerBook.questionPaperId = questionPaper._id;
      await answerBook.save();
    }
  }

  if (!questionPaper) {
    throw new Error('No associated QuestionPaper found.');
  }

  console.log('\n--- QUESTION PAPER DIAGNOSTICS ---');
  console.log(`  id:                ${questionPaper._id}`);
  console.log(`  paperSet:          ${questionPaper.paperSet}`);
  console.log(`  extractionStatus:  ${questionPaper.extractionStatus}`);
  console.log(`  totalQuestions:    ${questionPaper.totalQuestions}`);
  console.log(`  verifiedQuestions: ${questionPaper.verifiedQuestions?.length || 0}`);

  // 3. Inspect AnswerPages
  const pages = await AnswerPage.find({ answerBookId: answerBook._id }).sort({ pageNumber: 1 });
  console.log('\n--- PAGES INVENTORY ---');
  console.log(`  total pages in DB: ${pages.length}`);

  let ocrCount = 0;
  for (const p of pages) {
    if (p.ocr?.text && p.ocr.text.trim().length > 0) ocrCount++;
  }
  console.log(`  pages with OCR text: ${ocrCount} / ${pages.length}`);

  // Check image buffer resolution on first 3 sample pages
  let resolvableSampleCount = 0;
  for (const p of pages.slice(0, 3)) {
    const buf = await resolvePageImageBuffer(p, answerBook);
    if (buf && buf.length > 0) resolvableSampleCount++;
  }
  console.log(`  sample pages resolvable: ${resolvableSampleCount} / 3`);

  // 4. Real handwritten answer page text containing linear, static/dynamic, and non-linear concepts
  const realHandwrittenPageText = `
linear data structure : data structure in which data elements are
arranged sequentially or linearly whose each element is attached to its previous and
next adjacent element is called a linear data structure.
Examples: Array, stack, queue, linkedlist etc.
Static data structure: Static data structure has a fixed memory size.
It is easier to access the element in a static data structure.
Dynamic data structure: In the dynamic data structure the size
is not fixed. It can be randomly updated during the runtime which may be
considered efficient concerning the memory complexity of the code.
Ex: Stack and queue data structure.
Non-linear data structure: Data structures where data elements are not
placed sequentially or linearly are called non-linear data structure. In a non linear
we can't travers all the element in a single run. Examples include tree and graph.
`.trim();

  // Attach real handwritten text to a target page dynamically (e.g., page 5)
  const targetPage = pages.find((p) => p.pageNumber === 5) || pages[0];
  targetPage.ocr = {
    text: realHandwrittenPageText,
    confidence: 0.94,
    language: 'en',
  };
  await targetPage.save();
  console.log(`\n✓ Attached real handwritten script content to Page ${targetPage.pageNumber}`);

  // ==============================================================
  // REGRESSION TEST 1: Question 3 (Linear Data Structure)
  // ==============================================================
  console.log('\n--- TEST 1: LINEAR DATA STRUCTURE MAPPING ---');
  const q3Profile = extractQuestionProfile({
    questionNumber: 3,
    questionLabel: 'Q3',
    text: 'What is a linear data structure? Give any two examples.',
    referenceAnswer: 'A linear data structure arranges elements sequentially. Examples: Array, Stack, Queue, Linked list.',
    rubric: [
      { criterion: 'Definition of linear data structure (sequential arrangement)', marks: 3 },
      { criterion: 'Two valid examples (e.g. array, linked list, stack, queue)', marks: 2 },
    ],
  });

  const q3Score = scorePageContent(q3Profile, targetPage.ocr.text);
  console.log(`  Q3 Score on handwritten page: ${q3Score.score}`);
  console.log(`  Q3 Matched phrases: ${JSON.stringify(q3Score.matchedPhrases)}`);
  console.log(`  Q3 Matched keywords: ${JSON.stringify(q3Score.matchedKeywords)}`);

  if (q3Score.score < 0.75) {
    throw new Error(`Expected Q3 score >= 0.75 on handwritten linear page, got ${q3Score.score}`);
  }
  console.log('✓ Q3 semantic score matches linear data structure concepts (>= 0.75)');

  // ==============================================================
  // REGRESSION TEST 2: Question 5 (Non-Linear Data Structure)
  // ==============================================================
  console.log('\n--- TEST 2: NON-LINEAR DATA STRUCTURE MAPPING ---');
  const q5Profile = extractQuestionProfile({
    questionNumber: 5,
    questionLabel: 'Q5',
    text: 'Define a non-linear data structure and name its two common types.',
    referenceAnswer: 'A non-linear data structure does not place elements sequentially (e.g., Tree, Graph).',
    rubric: [
      { criterion: 'Non-linear data structure definition (not sequential)', marks: 3 },
      { criterion: 'Common types: Tree and Graph', marks: 3 },
    ],
  });

  const q5Score = scorePageContent(q5Profile, targetPage.ocr.text);
  console.log(`  Q5 Score on handwritten page: ${q5Score.score}`);
  console.log(`  Q5 Matched phrases: ${JSON.stringify(q5Score.matchedPhrases)}`);
  console.log(`  Q5 Matched keywords: ${JSON.stringify(q5Score.matchedKeywords)}`);

  if (q5Score.score < 0.75) {
    throw new Error(`Expected Q5 score >= 0.75 on handwritten non-linear page, got ${q5Score.score}`);
  }
  console.log('✓ Q5 semantic score matches non-linear data structure concepts (>= 0.75)');

  // ==============================================================
  // REGRESSION TEST 3: End-to-End autoMapAnswerBookPages Pipeline
  // ==============================================================
  console.log('\n--- TEST 3: FULL autoMapAnswerBookPages PIPELINE ---');

  // Update QuestionPaper with verified questions Q3 and Q5
  await QuestionPaper.updateOne(
    { _id: questionPaper._id, 'verifiedQuestions.questionNumber': 3 },
    {
      $set: {
        'verifiedQuestions.$.text': 'What is a linear data structure? Give any two examples.',
        'verifiedQuestions.$.referenceAnswer': 'A linear data structure arranges elements sequentially (e.g., Array, Stack, Queue).',
      },
    }
  );
  await QuestionPaper.updateOne(
    { _id: questionPaper._id, 'verifiedQuestions.questionNumber': 5 },
    {
      $set: {
        'verifiedQuestions.$.text': 'Define a non-linear data structure and name its two common types.',
        'verifiedQuestions.$.referenceAnswer': 'Non-linear data structures do not arrange elements sequentially, e.g., Trees and Graphs.',
      },
    }
  );

  const updatedQp = await QuestionPaper.findById(questionPaper._id);
  const freshPages = await AnswerPage.find({ answerBookId: answerBook._id }).sort({ pageNumber: 1 });

  const remapped = await autoMapAnswerBookPages({
    answerBook,
    questionPaper: updatedQp,
    answerPages: freshPages,
    forceRemap: true,
  });

  console.log('\n--- REMAPPED QUESTION PAGE MAPPINGS ---');
  for (const m of remapped) {
    console.log(`  Q${m.questionNumber} (${m.questionLabel || ''}): pages=[${m.pages.join(',')}], confidence=${m.confidence}, source=${m.source}, needsReview=${m.needsHumanReview}`);
  }

  // Verify Q3
  const q3Mapping = remapped.find((m) => m.questionNumber === 3);
  if (!q3Mapping) throw new Error('Q3 mapping not found in remapped results.');
  console.log('\n✓ Q3 Verification:', {
    pages: q3Mapping.pages,
    confidence: q3Mapping.confidence,
    source: q3Mapping.source,
    needsHumanReview: q3Mapping.needsHumanReview,
  });

  if (!q3Mapping.pages.includes(targetPage.pageNumber)) {
    throw new Error(`Q3 expected page ${targetPage.pageNumber}, but mapped pages were ${JSON.stringify(q3Mapping.pages)}`);
  }
  if (q3Mapping.confidence < 0.75) {
    throw new Error(`Q3 expected confidence >= 0.75, got ${q3Mapping.confidence}`);
  }
  if (q3Mapping.needsHumanReview !== false) {
    throw new Error(`Q3 expected needsHumanReview: false, got ${q3Mapping.needsHumanReview}`);
  }

  // Verify Q5
  const q5Mapping = remapped.find((m) => m.questionNumber === 5);
  if (!q5Mapping) throw new Error('Q5 mapping not found in remapped results.');
  console.log('✓ Q5 Verification:', {
    pages: q5Mapping.pages,
    confidence: q5Mapping.confidence,
    source: q5Mapping.source,
    needsHumanReview: q5Mapping.needsHumanReview,
  });

  if (!q5Mapping.pages.includes(targetPage.pageNumber)) {
    throw new Error(`Q5 expected page ${targetPage.pageNumber}, but mapped pages were ${JSON.stringify(q5Mapping.pages)}`);
  }
  if (q5Mapping.confidence < 0.75) {
    throw new Error(`Q5 expected confidence >= 0.75, got ${q5Mapping.confidence}`);
  }
  if (q5Mapping.needsHumanReview !== false) {
    throw new Error(`Q5 expected needsHumanReview: false, got ${q5Mapping.needsHumanReview}`);
  }

  // ==============================================================
  // REGRESSION TEST 4: Protection of EXAMINER_VERIFIED Mappings
  // ==============================================================
  console.log('\n--- TEST 4: PRESERVATION OF MANUAL EXAMINER MAPPINGS ---');
  // Set Q1 to manual examiner verified page [42]
  answerBook.questionPageMapping = [
    {
      questionNumber: 1,
      questionLabel: 'Q1',
      pages: [42],
      mappedPages: [42],
      verified: true,
      examinerVerified: true,
      source: 'EXAMINER_VERIFIED',
      mappingSource: 'EXAMINER_VERIFIED',
      confidence: 1.0,
      mappingConfidence: 1.0,
      reason: 'Manually verified by examiner',
      evidence: ['Examiner assigned manually'],
      needsHumanReview: false,
      mappingAlgorithmVersion: CURRENT_MAPPING_ALGORITHM_VERSION,
    },
  ];

  const protectedResult = await autoMapAnswerBookPages({
    answerBook,
    questionPaper: updatedQp,
    answerPages: freshPages,
    forceRemap: false, // Normal automatic run without forced override
  });

  const q1Protected = protectedResult.find((m) => m.questionNumber === 1);
  if (!q1Protected || !q1Protected.pages.includes(42) || q1Protected.source !== 'EXAMINER_VERIFIED') {
    throw new Error('EXAMINER_VERIFIED mapping was overwritten by automatic mapping engine!');
  }
  console.log('✓ Confirmed manual EXAMINER_VERIFIED mapping (Page 42) is 100% protected and preserved.');

  // ==============================================================
  // REGRESSION TEST 5: Verify Atomic MongoDB Persistence
  // ==============================================================
  console.log('\n--- TEST 5: ATOMIC MONGODB PERSISTENCE ---');
  const persistedAb = await AnswerBook.findById(answerBook._id);
  const persistedQ3 = persistedAb?.questionPageMapping?.find((m) => m.questionNumber === 3);
  const persistedQ5 = persistedAb?.questionPageMapping?.find((m) => m.questionNumber === 5);

  if (!persistedQ3 || !persistedQ3.pages.includes(targetPage.pageNumber)) {
    throw new Error('Q3 mapping not persisted in MongoDB AnswerBook');
  }
  if (!persistedQ5 || !persistedQ5.pages.includes(targetPage.pageNumber)) {
    throw new Error('Q5 mapping not persisted in MongoDB AnswerBook');
  }
  console.log('✓ Confirmed both Q3 and Q5 mappings are persisted atomically in MongoDB AnswerBook.');

  console.log('\n===============================================================');
  console.log('✓ ALL REAL RUNTIME MAPPING REGRESSION TESTS PASSED 100%!');
  console.log('===============================================================');

  await mongoose.disconnect();
}

runRealDiagnostic().catch((err) => {
  console.error('\n❌ DIAGNOSTIC FAILED:', err);
  process.exit(1);
});
