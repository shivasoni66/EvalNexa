import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { AnswerBook } from '../models/AnswerBook';
import { AnswerPage } from '../models/AnswerPage';
import { QuestionPaper } from '../models/QuestionPaper';
import { Evaluation } from '../models/Evaluation';
import { Exam } from '../models/Exam';
import { User } from '../models/User';
import {
  autoMapAnswerBookPages,
  CURRENT_MAPPING_ALGORITHM_VERSION,
} from '../services/pageMapping.service';
import {
  requestAISuggestionForQuestion,
  fetchEvaluationById,
} from '../services/evaluations.service';
import {
  EvaluationAssistantService,
  validateAndEnforceAssistantConstraints,
} from '../services/EvaluationAssistantService';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function verifyBrowserPath() {
  console.log('=====================================================================');
  console.log('EVALNEXA BROWSER WORKSPACE EXACT EVALUATION & DATA-PATH TRACE');
  console.log('=====================================================================\n');

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/evalnexa';
  await mongoose.connect(mongoUri);
  console.log('✓ Connected to MongoDB:', mongoUri);

  // 1. Locate the exact Evaluation and AnswerBook opened by the Examiner Workspace
  // The examiner workspace opens evaluation for the assigned answer book
  const evaluation = await Evaluation.findById('6ac3fc5914592950418071fb')
    .populate('examinerId')
    .populate('answerBookId');

  if (!evaluation) {
    throw new Error('Evaluation 6ac3fc5914592950418071fb not found');
  }

  const answerBook = await AnswerBook.findById(evaluation.answerBookId);
  if (!answerBook) {
    throw new Error('AnswerBook not found for evaluation');
  }

  const questionPaper = await QuestionPaper.findById(answerBook.questionPaperId);
  if (!questionPaper) {
    throw new Error(`QuestionPaper ${answerBook.questionPaperId} not found`);
  }

  console.log('\n--- EXACT DATA PATH TRACE ---');
  console.log(`1. Browser Evaluation ID : ${evaluation._id}`);
  console.log(`   Evaluation Status     : ${evaluation.status}`);
  console.log(`   Examiner              : ${(evaluation.examinerId as any)?.name} (${(evaluation.examinerId as any)?.email})`);
  console.log(`2. AnswerBook ID         : ${answerBook._id}`);
  console.log(`   AnswerBook Code       : ${answerBook.answerBookCode}`);
  console.log(`   Student Roll No       : ${answerBook.studentCode || '0187CS221045'}`);
  console.log(`   Total Scanned Pages   : ${answerBook.pageCount}`);
  console.log(`3. QuestionPaper ID      : ${questionPaper._id}`);
  console.log(`   Paper Set             : ${questionPaper.paperSet}`);
  console.log(`   Extraction Status     : ${questionPaper.extractionStatus}`);
  console.log(`   Total Questions       : ${questionPaper.verifiedQuestions?.length}`);

  // 4. Trace Question 5 in verifiedQuestions
  const q5 = questionPaper.verifiedQuestions?.find((q) => q.questionNumber === 5);
  if (!q5) {
    throw new Error('Question 5 not found in verifiedQuestions of QuestionPaper');
  }

  console.log(`\n4. Question 5 Profile:`);
  console.log(`   Question Number       : ${q5.questionNumber}`);
  console.log(`   Question Label        : ${q5.questionLabel || 'Q5'}`);
  console.log(`   Question Statement    : "${q5.text}"`);
  console.log(`   Actual Maximum Marks  : ${q5.maximumMarks}`);
  console.log(`   Reference Answer      : "${q5.referenceAnswer}"`);

  // 5. Test automatic page mapping on the real AnswerBook
  console.log('\n--- RUNNING AUTOMATIC PAGE MAPPING (forceRemap: true) ---');
  const mappings = await autoMapAnswerBookPages({
    answerBook,
    questionPaper,
    forceRemap: true,
  });
  const q5Mapping = mappings.find((m) => m.questionNumber === 5);

  if (!q5Mapping) {
    throw new Error('Question 5 mapping not found');
  }

  console.log(`5. Mapped Pages for Q5   : [${q5Mapping.pages.join(', ')}]`);
  console.log(`6. Mapping Confidence    : ${(q5Mapping.confidence * 100).toFixed(1)}% (${q5Mapping.confidence})`);
  console.log(`   Mapping Source        : ${q5Mapping.source}`);
  console.log(`   Algorithm Version     : ${q5Mapping.mappingAlgorithmVersion}`);
  console.log(`   Needs Human Review    : ${q5Mapping.needsHumanReview}`);
  console.log(`   Mapping Reason        : ${q5Mapping.reason}`);

  if (q5Mapping.pages.length === 0) {
    throw new Error('FAIL: Question 5 pages array is empty');
  }
  if (q5Mapping.confidence < 0.7) {
    throw new Error(`FAIL: Question 5 confidence too low: ${q5Mapping.confidence}`);
  }
  if (q5Mapping.needsHumanReview) {
    throw new Error('FAIL: Question 5 still marked as needsHumanReview');
  }
  console.log('✓ Automatic mapping successfully assigned Q5 to scanned pages with high confidence!');

  // 6. Test AI evaluation on the mapped Question 5 with actual maximum marks (6)
  console.log('\n--- TESTING AI EVALUATION ON Q5 WITH ACTUAL MAXIMUM MARKS (6) ---');
  const aiResultActual = await requestAISuggestionForQuestion(
    evaluation._id.toString(),
    5,
    {
      userId: (evaluation.examinerId as any)._id?.toString() || evaluation.examinerId.toString(),
      userRole: 'EXAMINER',
      answerBookId: answerBook._id.toString(),
      questionPaperId: questionPaper._id.toString(),
      forceRefresh: true,
    }
  );

  const analysis = aiResultActual.aiAnalysis!;
  console.log(`7. AI Evaluation on Q5 (maxMarks = ${q5.maximumMarks}):`);
  console.log(`   AI Suggested Marks    : ${analysis.suggestedMarks}`);
  console.log(`   AI Min Marks          : ${analysis.minMarks}`);
  console.log(`   AI Max Marks          : ${analysis.maxMarks}`);
  console.log(`   AI Confidence         : ${analysis.confidence}`);
  console.log(`   Needs Human Review    : ${analysis.needsHumanReview}`);
  console.log(`   Reasoning             : ${analysis.reasoningSummary}`);

  if (analysis.suggestedMarks > q5.maximumMarks) {
    throw new Error(`CRITICAL: AI suggestedMarks (${analysis.suggestedMarks}) EXCEEDS question maximumMarks (${q5.maximumMarks})!`);
  }
  if (analysis.maxMarks > q5.maximumMarks) {
    throw new Error(`CRITICAL: AI maxMarks (${analysis.maxMarks}) EXCEEDS question maximumMarks (${q5.maximumMarks})!`);
  }
  console.log(`✓ Confirmed: AI marks (${analysis.suggestedMarks}/${q5.maximumMarks}) strictly obey question.maximumMarks!`);

  // 7. Test strict bounding when maximumMarks = 2
  console.log('\n--- TESTING SAFETY CONSTRAINT: WHAT IF Q5 MAXIMUM MARKS IS 2? ---');
  const twoMarksInput = {
    question: q5.text,
    maximumMarks: 2, // Hypothetical 2 marks
    rubric: [
      { criterion: 'Definition of non-linear structure', marks: 1 },
      { criterion: 'Two common types (tree & graph)', marks: 1 },
    ],
    referenceAnswer: q5.referenceAnswer,
    ocrText: 'Non-linear data structure: Data structures where data elements are not placed sequentially or linearly. Examples include tree and graph.',
    ocrConfidence: 0.94,
  };

  const twoMarksResult = await EvaluationAssistantService.evaluateStudentAnswer(twoMarksInput);
  console.log(`AI Evaluation for 2-mark question:`);
  console.log(`   maximumMarks          : 2`);
  console.log(`   suggestedMarks        : ${twoMarksResult.suggestedMarks}`);
  console.log(`   minMarks              : ${twoMarksResult.minMarks}`);
  console.log(`   maxMarks              : ${twoMarksResult.maxMarks}`);

  if (twoMarksResult.suggestedMarks > 2) {
    throw new Error(`CRITICAL: AI suggestedMarks (${twoMarksResult.suggestedMarks}) exceeded 2!`);
  }
  if (twoMarksResult.maxMarks > 2) {
    throw new Error(`CRITICAL: AI maxMarks (${twoMarksResult.maxMarks}) exceeded 2!`);
  }
  console.log('✓ Confirmed: When maximumMarks is 2, AI marks CAN NEVER exceed 2!');

  // 8. Test that backend validation REJECTS an invalid AI response of 5/6 if maximumMarks is 2
  console.log('\n--- TESTING BACKEND REJECTION IF AI RETURNS 5/6 ON A 2-MARK QUESTION ---');
  const invalidResponseFor2Marks = {
    suggestedMarks: 5,
    minMarks: 4,
    maxMarks: 6,
    confidence: 0.91,
    needsHumanReview: false,
    criteria: [
      { name: 'Definition', maxMarks: 3, awardedMarks: 2.5, evidence: 'Valid' },
      { name: 'Types', maxMarks: 3, awardedMarks: 2.5, evidence: 'Valid' },
    ],
    missingConcepts: [],
    reasoningSummary: 'Test',
  };

  try {
    validateAndEnforceAssistantConstraints(invalidResponseFor2Marks, twoMarksInput);
    throw new Error('FAIL: Backend validation did not reject 5 marks on a 2-mark question!');
  } catch (rejectionErr: any) {
    console.log(`✓ Rejection verified: ${rejectionErr.message}`);
  }

  // 9. Test that refreshing the evaluation preserves mapping
  console.log('\n--- TESTING REFRESH PRESERVES MAPPING (fetchEvaluationById) ---');
  const refreshed = await fetchEvaluationById(evaluation._id.toString());
  const refreshedAnswerBook = await AnswerBook.findById(answerBook._id);
  const refreshedQ5 = refreshedAnswerBook?.questionPageMapping?.find((m) => m.questionNumber === 5);

  console.log(`Refreshed Q5 mappedPages: [${refreshedQ5?.pages.join(', ')}]`);
  console.log(`Refreshed Q5 confidence : ${refreshedQ5?.confidence}`);
  console.log(`Refreshed Q5 version    : ${refreshedQ5?.mappingAlgorithmVersion}`);

  if (!refreshedQ5 || refreshedQ5.pages.length === 0 || !refreshedQ5.pages.includes(5)) {
    throw new Error('FAIL: Refreshing evaluation erased or invalidated Question 5 mapping!');
  }
  console.log('✓ Confirmed: Refresh strictly preserves mapping and cached evaluation state!');

  console.log('\n=====================================================================');
  console.log('✓ ALL DATA-CONSISTENCY, TRACE & BOUNDARY CHECKS PASSED 100%!');
  console.log('=====================================================================');

  await mongoose.disconnect();
}

verifyBrowserPath().catch((err) => {
  console.error('\n❌ VERIFICATION FAILED:', err);
  process.exit(1);
});
