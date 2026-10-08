import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { Evaluation } from '../models/Evaluation';
import { AnswerBook } from '../models/AnswerBook';
import { AnswerPage } from '../models/AnswerPage';
import { QuestionPaper } from '../models/QuestionPaper';
import { Exam } from '../models/Exam';
import { User } from '../models/User';
import {
  startFullAnswerBookAnalysis,
  executeFullAnalysisBackground,
} from '../services/fullAnalysis.service';
import { autoMapAnswerBookPages } from '../services/pageMapping.service';
import {
  requestAISuggestionForQuestion,
  submitEvaluationFinal,
} from '../services/evaluations.service';
import { getAiPolicyConfig, isMappingConfident } from '../config/aiPolicy';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function runDynamicFullAnalysisTestSuite() {
  console.log('===============================================================');
  console.log('EVALNEXA REAL DYNAMIC FULL-BOOK AI WORKFLOW TEST SUITE');
  console.log('Testing dynamic, database-driven, multi-fixture pipeline');
  console.log('===============================================================\n');

  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/evalnexa';
  await mongoose.connect(mongoUri);
  console.log('✓ Connected to MongoDB.\n');

  let passCount = 0;
  const createdUserIds: mongoose.Types.ObjectId[] = [];
  const createdExamIds: mongoose.Types.ObjectId[] = [];
  const createdQpIds: mongoose.Types.ObjectId[] = [];
  const createdAbIds: mongoose.Types.ObjectId[] = [];
  const createdPageIds: mongoose.Types.ObjectId[] = [];
  const createdEvalIds: mongoose.Types.ObjectId[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Configurable AI & Mapping Policy Validation
    // -------------------------------------------------------------
    console.log('--- Test 1: Centralized Configurable AI Policy ---');
    const policy = getAiPolicyConfig();
    if (!policy || !policy.mappingConfidence || !policy.aiGradingConfidence) {
      throw new Error('AI policy configuration is missing or incomplete');
    }
    console.log(`Policy concurrency limit: ${policy.concurrencyLimit}`);
    console.log(`Mapping thresholds: High=${policy.mappingConfidence.high}, Med=${policy.mappingConfidence.medium}, Low=${policy.mappingConfidence.low}`);
    if (isMappingConfident(0.85, policy.mappingConfidence) !== true) {
      throw new Error('Expected 0.85 to be confident under default policy');
    }
    if (isMappingConfident(0.60, policy.mappingConfidence) !== false) {
      throw new Error('Expected 0.60 to not be high confidence under default policy');
    }
    console.log('✓ Test 1 Passed: AI Confidence Policy is centralized and configurable.\n');
    passCount++;

    // -------------------------------------------------------------
    // Test 2: Fixture A - Standard Multi-Question Structure
    // (6 questions, varying marks, 6 pages)
    // -------------------------------------------------------------
    console.log('--- Test 2: Fixture A - Standard Dynamic Script ---');
    const examinerA = await User.create({
      name: 'Dr. Jane Examiner',
      email: `examiner_a_${Date.now()}@evalnexa.test`,
      passwordHash: 'testhash',
      role: 'EXAMINER',
    });
    createdUserIds.push(examinerA._id);

    const examA = await Exam.create({
      title: 'Dynamic Test Exam Alpha',
      subjectCode: `CS-DYN-A`,
      subjectName: 'Computer Architecture',
      academicSession: '2026-2027',
      maximumMarks: 60,
      totalQuestions: 6,
      status: 'EVALUATION_OPEN',
      createdBy: examinerA._id,
    });
    createdExamIds.push(examA._id);

    const questionsA = [
      { questionNumber: 1, text: 'Explain Von Neumann architecture with diagram.', maximumMarks: 10, rubric: [{ criterion: 'Diagram', marks: 4 }, { criterion: 'Explanation', marks: 6 }] },
      { questionNumber: 2, text: 'Compare RISC and CISC architectures.', maximumMarks: 10, rubric: [{ criterion: 'Differences', marks: 6 }, { criterion: 'Examples', marks: 4 }] },
      { questionNumber: 3, text: 'Describe instruction pipeline hazards.', maximumMarks: 10, rubric: [{ criterion: 'Data Hazard', marks: 5 }, { criterion: 'Control Hazard', marks: 5 }] },
      { questionNumber: 4, text: 'Discuss cache memory mapping techniques.', maximumMarks: 10, rubric: [{ criterion: 'Direct mapping', marks: 5 }, { criterion: 'Associative', marks: 5 }] },
      { questionNumber: 5, text: 'Explain virtual memory and page tables.', maximumMarks: 10, rubric: [{ criterion: 'Page table concept', marks: 5 }, { criterion: 'TLB', marks: 5 }] },
      { questionNumber: 6, text: 'What is DMA and how does it improve I/O efficiency?', maximumMarks: 10, rubric: [{ criterion: 'DMA working', marks: 5 }, { criterion: 'Efficiency benefit', marks: 5 }] },
    ];

    const qpA = await QuestionPaper.create({
      examId: examA._id,
      paperSet: 'Set Alpha',
      originalFileName: 'cs_exam_alpha.pdf',
      cloudinaryPublicId: 'qp_dyn_a_sample',
      createdBy: examinerA._id,
      uploadedBy: examinerA._id,
      extractionStatus: 'VERIFIED',
      verifiedQuestions: questionsA,
    });
    createdQpIds.push(qpA._id);

    const abA = await AnswerBook.create({
      examId: examA._id,
      answerBookCode: `AB-DYN-A-${Date.now()}`,
      studentCode: `STU-A-${Date.now().toString().slice(-4)}`,
      barcode: `BC-DYN-A-${Date.now()}`,
      questionPaperId: qpA._id,
      assignedExaminerId: examinerA._id,
      status: 'IN_PROGRESS',
      processingStatus: 'READY_FOR_EVALUATION',
      qualityStatus: 'PASSED',
      pageCount: 6,
    });
    createdAbIds.push(abA._id);

    // Create 6 pages with OCR content that explicitly matches questions 1-5, leaving question 6 unmapped
    const pageTextsA = [
      'Question 1: Von Neumann architecture consists of CPU, Memory, and I/O. The control unit and ALU operate on registers.',
      'Question 2: RISC vs CISC. RISC has simple instructions with single clock cycle, whereas CISC has complex instructions.',
      'Question 3: Pipeline hazards occur when instruction execution stalls due to data dependency or branch penalties.',
      'Question 4: Cache mapping techniques include direct-mapped, fully associative, and set-associative cache structures.',
      'Question 5: Virtual memory abstracts physical RAM using page tables and translation lookaside buffer (TLB).',
      'General notes on hardware interfacing and external bus timing without specific question reference.',
    ];

    for (let i = 1; i <= 6; i++) {
      const pageDoc = await AnswerPage.create({
        answerBookId: abA._id,
        pageNumber: i,
        cloudinary: {
          publicId: `test_page_a_${i}`,
          secureUrl: `https://res.cloudinary.com/demo/image/upload/sample.jpg`,
          resourceType: 'image',
        },
        ocr: {
          text: pageTextsA[i - 1],
          confidence: 0.92,
        },
        processingStatus: 'COMPLETED',
        finalized: true,
      });
      createdPageIds.push(pageDoc._id);
    }

    const evalA = await Evaluation.create({
      answerBookId: abA._id,
      examinerId: examinerA._id,
      status: 'IN_PROGRESS',
      totalMarks: 0,
      questionMarks: questionsA.map((q) => ({
        questionNumber: q.questionNumber,
        marks: 0,
        status: 'NOT_STARTED',
        examinerReviewed: false,
      })),
    });
    createdEvalIds.push(evalA._id);

    // Run Full Analysis Job dynamically on Fixture A
    console.log('Queuing and executing full analysis for Fixture A...');
    const jobAInit = await startFullAnswerBookAnalysis(evalA._id.toString(), {
      userRole: 'EXAMINER',
      userId: examinerA._id.toString(),
      userName: examinerA.name,
    });
    await executeFullAnalysisBackground({
      evaluationId: evalA._id.toString(),
      jobId: jobAInit.jobId,
      answerBookId: abA._id.toString(),
      questionPaperId: qpA._id.toString(),
      options: {
        userRole: 'EXAMINER',
        userId: examinerA._id.toString(),
        userName: examinerA.name,
      },
      abortController: new AbortController(),
    });

    const refreshedEvalA = await Evaluation.findById(evalA._id);
    const refreshedAbA = await AnswerBook.findById(abA._id);

    if (!refreshedEvalA || !refreshedAbA) {
      throw new Error('Failed to reload refreshed evaluation or answer book');
    }

    // Verify dynamic counts came from DB
    console.log(`Job Total Questions in DB: ${refreshedEvalA.fullAnalysisJob.totalQuestions}`);
    console.log(`Job Analyzed Pages in DB: ${refreshedEvalA.fullAnalysisJob.analyzedPages}`);
    if (refreshedEvalA.fullAnalysisJob.totalQuestions !== questionsA.length) {
      throw new Error(`Expected ${questionsA.length} questions, got ${refreshedEvalA.fullAnalysisJob.totalQuestions}`);
    }
    if (refreshedEvalA.fullAnalysisJob.analyzedPages !== 6) {
      throw new Error(`Expected 6 pages, got ${refreshedEvalA.fullAnalysisJob.analyzedPages}`);
    }

    // Verify question 1-5 mapped and evaluated, question 6 unmapped
    const qm1 = refreshedEvalA.questionMarks.find((q) => q.questionNumber === 1);
    const qm6 = refreshedEvalA.questionMarks.find((q) => q.questionNumber === 6);

    if (!qm1 || !qm1.aiAnalysis) {
      throw new Error('Expected Q1 to have real AI evaluation');
    }
    console.log(`Q1 AI Suggested Marks: ${qm1.aiAnalysis.suggestedMarks}/${qm1.aiAnalysis.maxMarks}, Status: ${qm1.aiStatus}`);
    if (qm1.aiAnalysis.suggestedMarks <= 0 || qm1.aiAnalysis.suggestedMarks > 10) {
      throw new Error('Q1 AI suggested marks out of bounds');
    }

    if (!qm6) throw new Error('Q6 not found in evaluation questionMarks');
    console.log(`Q6 AI Status: ${qm6.aiStatus}, aiAnalysis is null: ${qm6.aiAnalysis === null}`);
    if (qm6.aiAnalysis !== null && qm6.aiAnalysis !== undefined) {
      throw new Error('Unmapped question Q6 must have aiAnalysis: null, not a fake placeholder');
    }
    if (qm6.aiStatus !== 'NEEDS_REVIEW') {
      throw new Error(`Expected Q6 to be NEEDS_REVIEW, got ${qm6.aiStatus}`);
    }

    console.log('✓ Test 2 Passed: Dynamic Fixture A executed successfully with real AI suggestions and unmapped protection.\n');
    passCount++;

    // -------------------------------------------------------------
    // Test 3: Stale Cache Protection Validation
    // -------------------------------------------------------------
    console.log('--- Test 3: Stale AI Result Protection Gate ---');
    // Request cached suggestion - should return cached
    const cachedResult = await requestAISuggestionForQuestion(evalA._id.toString(), 1, {
      userId: examinerA._id.toString(),
      userRole: 'EXAMINER',
    });
    if (!cachedResult.cached) {
      throw new Error('Expected initial request to return cached AI result');
    }

    // Now modify mapping for Question 1: examiner maps Q1 to page [1, 2] instead of [1]
    const q1Mapping = refreshedAbA.questionPageMapping.find((m) => m.questionNumber === 1);
    if (q1Mapping) {
      q1Mapping.pages = [1, 2];
      q1Mapping.verified = true;
      q1Mapping.source = 'EXAMINER_VERIFIED';
      await refreshedAbA.save();
    }

    // Request suggestion again: because mappedPages changed, stale cache MUST be invalidated
    const invalidatedResult = await requestAISuggestionForQuestion(evalA._id.toString(), 1, {
      userId: examinerA._id.toString(),
      userRole: 'EXAMINER',
    });
    if (invalidatedResult.cached === true) {
      throw new Error('Expected stale cache to be invalidated when page mapping changed!');
    }
    console.log('✓ Test 3 Passed: Stale AI result protection correctly detects mapping changes and re-evaluates.\n');
    passCount++;

    // -------------------------------------------------------------
    // Test 4: Submission Gating (Unreviewed and Unresolved decisions)
    // -------------------------------------------------------------
    console.log('--- Test 4: Submission Gating & Examiner Authority ---');
    // Attempt submit with unreviewed questions -> must throw UNREVIEWED_QUESTIONS
    let submitError: any = null;
    try {
      await submitEvaluationFinal(evalA._id.toString(), {}, examinerA._id.toString());
    } catch (err: any) {
      submitError = err;
    }

    if (!submitError || submitError.code !== 'UNREVIEWED_QUESTIONS') {
      throw new Error(`Expected UNREVIEWED_QUESTIONS error, got: ${submitError?.code || submitError?.message}`);
    }
    console.log(`Gate caught unreviewed questions: "${submitError.message}"`);

    // Now simulate examiner reviewing questions but leaving Q1 as NOT_STARTED
    refreshedEvalA.questionMarks.forEach((qm) => {
      qm.examinerReviewed = true;
      qm.reviewedAt = new Date();
    });
    await refreshedEvalA.save();

    let decisionError: any = null;
    try {
      await submitEvaluationFinal(evalA._id.toString(), {}, examinerA._id.toString());
    } catch (err: any) {
      decisionError = err;
    }

    if (!decisionError || decisionError.code !== 'QUESTION_DECISION_REQUIRED') {
      throw new Error(`Expected QUESTION_DECISION_REQUIRED error, got: ${decisionError?.code || decisionError?.message}`);
    }
    console.log(`Gate caught reviewed question without decision: "${decisionError.message}"`);

    // Now set valid decisions for all questions
    refreshedEvalA.questionMarks.forEach((qm, idx) => {
      qm.status = 'MARKED';
      qm.marks = idx === 5 ? 0 : 8; // Q6 scored 0 or marked not attempted
    });
    await refreshedEvalA.save();
    await AnswerBook.updateOne({ _id: abA._id }, { $set: { status: 'IN_PROGRESS' } });

    const submittedEval = await submitEvaluationFinal(
      evalA._id.toString(),
      {},
      examinerA._id.toString()
    );
    if (submittedEval.evaluation.status !== 'SUBMITTED') {
      throw new Error(`Expected SUBMITTED status, got ${submittedEval.evaluation.status}`);
    }
    console.log('✓ Test 4 Passed: Submission gate strictly enforces examiner review and final decisions.\n');
    passCount++;

    // -------------------------------------------------------------
    // Test 5: Fixture B - Structurally Different Paper Set & Numbering
    // (4 questions, subquestions 1(a), 1(b), 2, 3, different marks, 4 pages)
    // -------------------------------------------------------------
    console.log('--- Test 5: Fixture B - Structurally Different Paper Set ---');
    const examinerB = await User.create({
      name: 'Prof. Marcus Vance',
      email: `examiner_b_${Date.now()}@evalnexa.test`,
      passwordHash: 'testhash',
      role: 'EXAMINER',
    });
    createdUserIds.push(examinerB._id);

    const examB = await Exam.create({
      title: 'Advanced Distributed Systems Examination',
      subjectCode: `CS-DYN-B`,
      subjectName: 'Distributed Systems',
      academicSession: '2026-2027',
      maximumMarks: 100,
      totalQuestions: 4,
      status: 'EVALUATION_OPEN',
      createdBy: examinerB._id,
    });
    createdExamIds.push(examB._id);

    const questionsB = [
      {
        questionNumber: 1,
        questionLabel: '1(a)',
        section: 'Part A',
        subquestion: 'a',
        text: 'State and prove the CAP theorem in distributed data stores.',
        maximumMarks: 20,
        rubric: [{ criterion: 'Proof', marks: 10 }, { criterion: 'Tradeoffs', marks: 10 }],
      },
      {
        questionNumber: 2,
        questionLabel: '1(b)',
        section: 'Part A',
        subquestion: 'b',
        text: 'Compare linearizability vs sequential consistency.',
        maximumMarks: 20,
        rubric: [{ criterion: 'Formal definitions', marks: 10 }, { criterion: 'Comparison', marks: 10 }],
      },
      {
        questionNumber: 3,
        questionLabel: '2',
        section: 'Part B',
        text: 'Explain the Raft consensus algorithm leader election and log replication.',
        maximumMarks: 30,
        rubric: [{ criterion: 'Leader Election', marks: 15 }, { criterion: 'Log Replication', marks: 15 }],
      },
      {
        questionNumber: 4,
        questionLabel: '3',
        section: 'Part B',
        text: 'Design a distributed rate limiter using token bucket algorithm and Redis.',
        maximumMarks: 30,
        rubric: [{ criterion: 'Architecture', marks: 15 }, { criterion: 'Concurrency control', marks: 15 }],
      },
    ];

    const qpB = await QuestionPaper.create({
      examId: examB._id,
      paperSet: 'Set B-Specialized',
      originalFileName: 'dist_sys_exam_b.pdf',
      cloudinaryPublicId: 'qp_dyn_b_sample',
      createdBy: examinerB._id,
      uploadedBy: examinerB._id,
      extractionStatus: 'VERIFIED',
      verifiedQuestions: questionsB,
    });
    createdQpIds.push(qpB._id);

    const abB = await AnswerBook.create({
      examId: examB._id,
      answerBookCode: `AB-DYN-B-${Date.now()}`,
      studentCode: `STU-B-${Date.now().toString().slice(-4)}`,
      barcode: `BC-DYN-B-${Date.now()}`,
      questionPaperId: qpB._id,
      assignedExaminerId: examinerB._id,
      status: 'IN_PROGRESS',
      processingStatus: 'READY_FOR_EVALUATION',
      qualityStatus: 'PASSED',
      pageCount: 4,
    });
    createdAbIds.push(abB._id);

    const pageTextsB = [
      'Question 1(a): The CAP theorem states that a distributed system cannot simultaneously guarantee Consistency, Availability, and Partition Tolerance.',
      'Question 1(b): Linearizability is a strong recency condition where operations appear instantaneous. Sequential consistency allows interleaving.',
      'Question 2: In Raft consensus, nodes start in Follower state and transition to Candidate when election timers fire.',
      'Question 3: A distributed rate limiter uses sliding window or token bucket in Redis with atomic Lua scripts.',
    ];

    for (let i = 1; i <= 4; i++) {
      const pageDoc = await AnswerPage.create({
        answerBookId: abB._id,
        pageNumber: i,
        cloudinary: {
          publicId: `test_page_b_${i}`,
          secureUrl: `https://res.cloudinary.com/demo/image/upload/sample.jpg`,
          resourceType: 'image',
        },
        ocr: {
          text: pageTextsB[i - 1],
          confidence: 0.95,
        },
        processingStatus: 'COMPLETED',
        finalized: true,
      });
      createdPageIds.push(pageDoc._id);
    }

    const evalB = await Evaluation.create({
      answerBookId: abB._id,
      examinerId: examinerB._id,
      status: 'IN_PROGRESS',
      totalMarks: 0,
      questionMarks: questionsB.map((q) => ({
        questionNumber: q.questionNumber,
        questionLabel: q.questionLabel,
        section: q.section,
        subquestion: q.subquestion,
        marks: 0,
        status: 'NOT_STARTED',
        examinerReviewed: false,
      })),
    });
    createdEvalIds.push(evalB._id);

    console.log('Queuing and executing full analysis for Fixture B...');
    const jobBInit = await startFullAnswerBookAnalysis(evalB._id.toString(), {
      userRole: 'EXAMINER',
      userId: examinerB._id.toString(),
      userName: examinerB.name,
    });
    await executeFullAnalysisBackground({
      evaluationId: evalB._id.toString(),
      jobId: jobBInit.jobId,
      answerBookId: abB._id.toString(),
      questionPaperId: qpB._id.toString(),
      options: {
        userRole: 'EXAMINER',
        userId: examinerB._id.toString(),
        userName: examinerB.name,
      },
      abortController: new AbortController(),
    });

    const refreshedEvalB = await Evaluation.findById(evalB._id);
    if (!refreshedEvalB) {
      throw new Error('Failed to reload refreshed evaluation B');
    }

    console.log(`Fixture B Total Questions: ${refreshedEvalB.fullAnalysisJob.totalQuestions}`);
    console.log(`Fixture B Analyzed Pages: ${refreshedEvalB.fullAnalysisJob.analyzedPages}`);

    if (refreshedEvalB.fullAnalysisJob.totalQuestions !== 4) {
      throw new Error(`Expected exactly 4 questions for Fixture B, got ${refreshedEvalB.fullAnalysisJob.totalQuestions}`);
    }
    if (refreshedEvalB.fullAnalysisJob.analyzedPages !== 4) {
      throw new Error(`Expected exactly 4 pages for Fixture B, got ${refreshedEvalB.fullAnalysisJob.analyzedPages}`);
    }

    // Verify all 4 questions completed with correct labels and scores out of custom marks
    for (const qm of refreshedEvalB.questionMarks) {
      console.log(`Fixture B Question [${qm.questionLabel || qm.questionNumber}]: AI suggested ${qm.aiAnalysis?.suggestedMarks}/${qm.aiAnalysis?.maxMarks}, Status: ${qm.aiStatus}`);
      if (!qm.aiAnalysis) {
        throw new Error(`Expected question ${qm.questionLabel} to have aiAnalysis`);
      }
      if (qm.aiAnalysis.suggestedMarks <= 0 || qm.aiAnalysis.suggestedMarks > qm.aiAnalysis.maxMarks) {
        throw new Error(`Suggested marks out of bounds for question ${qm.questionLabel}`);
      }
    }

    console.log('✓ Test 5 Passed: Fixture B with custom subquestions, marks, and paper set handled completely dynamically.\n');
    passCount++;

    // -------------------------------------------------------------
    // Test 6: Regression Test - Stack / LIFO / Push / Pop Question
    // (Exact bug scenario: Question 9 with NO literal 'Q9' header on page)
    // -------------------------------------------------------------
    console.log('--- Test 6: Regression Test - Content-Driven Mapping (No Literal Q9 Header) ---');
    const examC = await Exam.create({
      title: 'Data Structures and Algorithms',
      subjectCode: 'CS-DSA-REGRESSION',
      subjectName: 'Data Structures',
      academicSession: '2026-2027',
      maximumMarks: 100,
      totalQuestions: 10,
      status: 'EVALUATION_OPEN',
      createdBy: examinerA._id,
    });
    createdExamIds.push(examC._id);

    const questionsC = [
      {
        questionNumber: 9,
        questionLabel: 'Q9',
        text: 'What is a stack? Explain the LIFO principle and the push and pop operations with a suitable example.',
        maximumMarks: 8,
        rubric: [
          { criterion: 'Stack definition and LIFO concept', marks: 3 },
          { criterion: 'Push and pop operations with example', marks: 5 },
        ],
        referenceAnswer: 'A stack is a linear data structure following Last-In-First-Out (LIFO). Push inserts an element onto the top of the stack. Pop removes the topmost element.',
        keyConcepts: ['stack data structure', 'lifo principle', 'push operation', 'pop operation'],
      },
    ];

    const qpC = await QuestionPaper.create({
      examId: examC._id,
      paperSet: 'Set Main',
      originalFileName: 'dsa_paper.pdf',
      cloudinaryPublicId: 'qp_dsa_sample',
      createdBy: examinerA._id,
      uploadedBy: examinerA._id,
      status: 'VERIFIED',
      extractionStatus: 'VERIFIED',
      verifiedQuestions: questionsC,
    });
    createdQpIds.push(qpC._id);

    const abC = await AnswerBook.create({
      examId: examC._id,
      questionPaperId: qpC._id,
      answerBookCode: `AB-STACK-${Date.now()}`,
      studentCode: `STU-C-${Date.now().toString().slice(-4)}`,
      barcode: `BC-STACK-${Date.now()}`,
      status: 'IN_PROGRESS',
      assignedExaminerId: examinerA._id,
      pageCount: 5,
      totalPages: 5,
      processingStatus: 'READY_FOR_EVALUATION',
      qualityStatus: 'PASSED',
      questionPageMapping: [],
    });
    createdAbIds.push(abC._id);

    // Page 1 & 2: completely unrelated introductory or other content
    const page1 = await AnswerPage.create({
      answerBookId: abC._id,
      pageNumber: 1,
      cloudinary: {
        publicId: 'page_dsa_1',
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        resourceType: 'image',
      },
      ocr: { text: 'Candidate details, instructions, index table, general remarks.' },
      processingStatus: 'COMPLETED',
      finalized: true,
    });
    const page2 = await AnswerPage.create({
      answerBookId: abC._id,
      pageNumber: 2,
      cloudinary: {
        publicId: 'page_dsa_2',
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        resourceType: 'image',
      },
      ocr: { text: 'Section A: Multiple choice questions. Array representation and memory indexing.' },
      processingStatus: 'COMPLETED',
      finalized: true,
    });
    // Page 3: The exact answer to Question 9 - NO literal 'Q9' or 'Question 9' anywhere!
    const page3 = await AnswerPage.create({
      answerBookId: abC._id,
      pageNumber: 3,
      cloudinary: {
        publicId: 'page_dsa_3',
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        resourceType: 'image',
      },
      ocr: {
        text: 'A stack is a linear data structure that follows the LIFO principle (Last In First Out). The primary operations are push operation which adds an element to the top of the stack...',
      },
      processingStatus: 'COMPLETED',
      finalized: true,
    });
    // Page 4: Continuation of Question 9 answer - NO question header
    const page4 = await AnswerPage.create({
      answerBookId: abC._id,
      pageNumber: 4,
      cloudinary: {
        publicId: 'page_dsa_4',
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        resourceType: 'image',
      },
      ocr: {
        text: 'The pop operation removes the element from top of stack. For example, pushing 10, then 20, then popping returns 20. Advantages of stack include function call management.',
      },
      processingStatus: 'COMPLETED',
      finalized: true,
    });
    createdPageIds.push(page1._id, page2._id, page3._id, page4._id);

    // Run auto mapping directly
    const detectedMappingsC = await autoMapAnswerBookPages({
      answerBook: abC,
      questionPaper: qpC,
      answerPages: [page1, page2, page3, page4],
    });

    console.log('Detected Mappings for Question 9:', JSON.stringify(detectedMappingsC, null, 2));

    const q9Mapping = detectedMappingsC.find((m) => m.questionNumber === 9);
    if (!q9Mapping) {
      throw new Error('Expected mapping entry for Question 9');
    }
    if (!q9Mapping.pages || q9Mapping.pages.length === 0) {
      throw new Error('FAIL: Question 9 was left unmapped despite clear stack/LIFO/push/pop content on pages 3 & 4!');
    }
    if (!q9Mapping.pages.includes(3)) {
      throw new Error(`FAIL: Question 9 expected to include Page 3, got: ${q9Mapping.pages.join(', ')}`);
    }
    if (!q9Mapping.pages.includes(4)) {
      throw new Error(`FAIL: Question 9 expected continuation onto Page 4, got: ${q9Mapping.pages.join(', ')}`);
    }
    if (q9Mapping.confidence < 0.85) {
      throw new Error(`FAIL: Expected confidence >= 0.85 for high-match concepts, got: ${q9Mapping.confidence}`);
    }
    if (q9Mapping.needsHumanReview === true) {
      throw new Error('FAIL: High-confidence content match should not be flagged as needsHumanReview');
    }

    console.log(`✓ Mapped Question 9 to pages [${q9Mapping.pages.join(', ')}] with confidence ${q9Mapping.confidence}`);
    console.log('✓ Test 6 Passed: Question without literal header successfully mapped via concepts & continuation.\n');
    passCount++;

    // -------------------------------------------------------------
    // Test 7: Manual Override Authority Protection
    // (Examiner manual mapping must NEVER be overwritten by auto mapper)
    // -------------------------------------------------------------
    console.log('--- Test 7: Examiner Manual Override Authority Protection ---');
    // Simulate examiner manually assigning Question 9 to page [3]
    abC.questionPageMapping = [
      {
        questionNumber: 9,
        pages: [3],
        verified: true,
        source: 'EXAMINER_VERIFIED',
        mappingSource: 'EXAMINER_VERIFIED',
        examinerVerified: true,
        confidence: 1.0,
        reason: 'Examiner verified single page allocation',
        needsHumanReview: false,
      },
    ];
    await abC.save();

    // Re-run auto mapping - MUST respect examiner manual mapping!
    const remapped = await autoMapAnswerBookPages({
      answerBook: abC,
      questionPaper: qpC,
      answerPages: [page1, page2, page3, page4],
      forceRemap: false,
    });

    const manualQ9 = remapped.find((m) => m.questionNumber === 9);
    if (!manualQ9 || manualQ9.pages.length !== 1 || manualQ9.pages[0] !== 3) {
      throw new Error('FAIL: Re-analysis overwrote examiner manual mapping!');
    }
    if (manualQ9.source !== 'EXAMINER_VERIFIED') {
      throw new Error(`FAIL: Expected source EXAMINER_VERIFIED, got: ${manualQ9.source}`);
    }
    console.log('✓ Test 7 Passed: Examiner manual mapping preserved against automatic re-analysis.\n');
    passCount++;

    // -------------------------------------------------------------
    // Test 8: Non-Proportional & Out-of-Order Question Answers
    // (Student answered Question 2 on page 1, and Question 1 on page 2)
    // -------------------------------------------------------------
    console.log('--- Test 8: Non-Proportional Content Matching ---');
    const examD = await Exam.create({
      title: 'Operating Systems',
      subjectCode: 'CS-OS-OUTOFORDER',
      subjectName: 'Operating Systems',
      academicSession: '2026-2027',
      maximumMarks: 50,
      totalQuestions: 2,
      status: 'EVALUATION_OPEN',
      createdBy: examinerA._id,
    });
    createdExamIds.push(examD._id);

    const questionsD = [
      {
        questionNumber: 1,
        questionLabel: 'Q1',
        text: 'Explain banker algorithm for deadlock avoidance.',
        maximumMarks: 10,
        rubric: [{ criterion: 'Safety algorithm', marks: 10 }],
        referenceAnswer: 'Bankers algorithm tests for safe states before allocation using available, max, allocation, and need matrices.',
        keyConcepts: ['banker algorithm', 'deadlock avoidance', 'safe state'],
      },
      {
        questionNumber: 2,
        questionLabel: 'Q2',
        text: 'Describe round robin CPU scheduling with time quantum.',
        maximumMarks: 10,
        rubric: [{ criterion: 'Time quantum', marks: 10 }],
        referenceAnswer: 'Round robin assigns fixed time slice to each process in ready queue circularly.',
        keyConcepts: ['round robin', 'cpu scheduling', 'time quantum'],
      },
    ];

    const qpD = await QuestionPaper.create({
      examId: examD._id,
      paperSet: 'Set A',
      originalFileName: 'os_paper.pdf',
      cloudinaryPublicId: 'qp_os_sample',
      createdBy: examinerA._id,
      uploadedBy: examinerA._id,
      status: 'VERIFIED',
      extractionStatus: 'VERIFIED',
      verifiedQuestions: questionsD,
    });
    createdQpIds.push(qpD._id);

    const abD = await AnswerBook.create({
      examId: examD._id,
      questionPaperId: qpD._id,
      answerBookCode: `AB-OS-${Date.now()}`,
      studentCode: `STU-D-${Date.now().toString().slice(-4)}`,
      barcode: `BC-OS-${Date.now()}`,
      status: 'IN_PROGRESS',
      assignedExaminerId: examinerA._id,
      pageCount: 2,
      totalPages: 2,
      processingStatus: 'READY_FOR_EVALUATION',
      qualityStatus: 'PASSED',
      questionPageMapping: [],
    });
    createdAbIds.push(abD._id);

    // Page 1: Student answered Q2 (Round Robin) FIRST (not Q1!)
    const pD1 = await AnswerPage.create({
      answerBookId: abD._id,
      pageNumber: 1,
      cloudinary: {
        publicId: 'page_os_1',
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        resourceType: 'image',
      },
      ocr: { text: 'In round robin cpu scheduling, each process gets a preemptive time quantum...' },
      processingStatus: 'COMPLETED',
      finalized: true,
    });
    // Page 2: Student answered Q1 (Banker algorithm) SECOND
    const pD2 = await AnswerPage.create({
      answerBookId: abD._id,
      pageNumber: 2,
      cloudinary: {
        publicId: 'page_os_2',
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
        resourceType: 'image',
      },
      ocr: { text: 'The banker algorithm is used for deadlock avoidance by verifying if state is in safe state...' },
      processingStatus: 'COMPLETED',
      finalized: true,
    });
    createdPageIds.push(pD1._id, pD2._id);

    const detectedD = await autoMapAnswerBookPages({
      answerBook: abD,
      questionPaper: qpD,
      answerPages: [pD1, pD2],
    });

    const mQ1 = detectedD.find((m) => m.questionNumber === 1);
    const mQ2 = detectedD.find((m) => m.questionNumber === 2);

    if (!mQ1?.pages.includes(2)) {
      throw new Error(`FAIL: Expected Q1 (Banker) to map to Page 2, got: ${mQ1?.pages.join(', ')}`);
    }
    if (!mQ2?.pages.includes(1)) {
      throw new Error(`FAIL: Expected Q2 (Round Robin) to map to Page 1, got: ${mQ2?.pages.join(', ')}`);
    }

    console.log(`✓ Non-proportional mapping verified: Q1 -> Page ${mQ1.pages.join(', ')}, Q2 -> Page ${mQ2.pages.join(', ')}`);
    console.log('✓ Test 8 Passed: Correct semantic mapping regardless of out-of-order student answers.\n');
    passCount++;

    console.log('===============================================================');
    console.log(`ALL ${passCount} DYNAMIC WORKFLOW & MAPPING TESTS PASSED SUCCESSFULLY!`);
    console.log('===============================================================\n');
  } finally {
    // Clean up all created test records
    console.log('Cleaning up test fixture database records...');
    await Promise.all([
      User.deleteMany({ _id: { $in: createdUserIds } }),
      Exam.deleteMany({ _id: { $in: createdExamIds } }),
      QuestionPaper.deleteMany({ _id: { $in: createdQpIds } }),
      AnswerBook.deleteMany({ _id: { $in: createdAbIds } }),
      AnswerPage.deleteMany({ _id: { $in: createdPageIds } }),
      Evaluation.deleteMany({ _id: { $in: createdEvalIds } }),
    ]);
    console.log('✓ Cleanup complete.\n');
    await mongoose.disconnect();
  }
}

runDynamicFullAnalysisTestSuite().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
