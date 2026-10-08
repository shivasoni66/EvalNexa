import mongoose from 'mongoose';
import { Evaluation, IEvaluation, IEvaluationQuestionMark } from '../models/Evaluation';
import { AnswerBook, IQuestionPageMapping } from '../models/AnswerBook';
import { AnswerPage } from '../models/AnswerPage';
import { Question } from '../models/Question';
import { QuestionPaper } from '../models/QuestionPaper';
import { Exam } from '../models/Exam';
import { validateStateTransition } from './answerBooks.service';
import { logAuditAction } from './audit.service';
import { emitToAll, emitToRole } from '../sockets';
import { generateAuthorizedMediaUrl } from './media.service';
import { EvaluationAssistantService } from './EvaluationAssistantService';
import { autoMapAnswerBookPages, CURRENT_MAPPING_ALGORITHM_VERSION } from './pageMapping.service';
import { areEntityIdsEqual } from '../utils/identity';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface IAuthoritativeQuestion {
  questionNumber: number;
  maximumMarks: number;
  text?: string;
}

/**
 * Calculates total possible marks from authoritative questions map.
 */
export function calculateTotalPossibleMarks(
  authoritativeQuestions: Map<number, IAuthoritativeQuestion>
): number {
  let total = 0;
  for (const q of authoritativeQuestions.values()) {
    total += Number(q.maximumMarks || 0);
  }
  return total;
}

/**
 * Fetches official exam questions from MongoDB.
 * Falls back to Exam metadata if individual Question records are not populated.
 */
export async function fetchAuthoritativeQuestions(
  examId: string | mongoose.Types.ObjectId,
  answerBookId?: string | mongoose.Types.ObjectId
): Promise<Map<number, IAuthoritativeQuestion>> {
  // 1. If AnswerBook has an active verified QuestionPaper, it is the primary authority!
  if (answerBookId) {
    const answerBook = await AnswerBook.findById(answerBookId);
    if (answerBook) {
      let qp = null;
      if (answerBook.questionPaperId) {
        qp = await QuestionPaper.findById(answerBook.questionPaperId);
      }
      if (!qp) {
        qp = await QuestionPaper.findOne({
          examId: answerBook.examId,
          extractionStatus: 'VERIFIED',
        }).sort({ updatedAt: -1 });
      }
      if (
        qp &&
        (qp.extractionStatus === 'VERIFIED' || (qp as any).status === 'VERIFIED') &&
        qp.verifiedQuestions &&
        qp.verifiedQuestions.length > 0
      ) {
        const questionMap = new Map<number, IAuthoritativeQuestion>();
        for (const q of qp.verifiedQuestions) {
          questionMap.set(q.questionNumber, {
            questionNumber: q.questionNumber,
            maximumMarks: q.maximumMarks,
            text: q.text,
          });
        }
        return questionMap;
      }
    }
  }

  // 2. Official questions in DB
  const officialQuestions = await Question.find({ examId }).sort({ questionNumber: 1 });
  const questionMap = new Map<number, IAuthoritativeQuestion>();

  if (officialQuestions.length > 0) {
    for (const q of officialQuestions) {
      questionMap.set(q.questionNumber, {
        questionNumber: q.questionNumber,
        maximumMarks: q.maximumMarks,
        text: q.text,
      });
    }
    return questionMap;
  }

  // 3. Fallback to exam metadata if individual Question records are not populated
  const exam = await Exam.findById(examId);
  if (exam && exam.totalQuestions > 0) {
    const defaultMaxMarks = exam.maximumMarks
      ? Math.round((exam.maximumMarks / exam.totalQuestions) * 100) / 100
      : 100;
    for (let i = 1; i <= exam.totalQuestions; i++) {
      questionMap.set(i, {
        questionNumber: i,
        maximumMarks: defaultMaxMarks,
        text: `Question ${i}`,
      });
    }
  }

  return questionMap;
}

/**
 * Authoritative question mark validator and total calculator.
 * Strictly verifies against official database questions:
 * - Rejects duplicate question numbers
 * - Rejects unknown question numbers
 * - Validates marks are between 0 and maximumMarks
 * - Ensures NOT_ATTEMPTED has zero marks
 * - Rejects invalid statuses
 * - On submit, ensures every expected question is present and evaluated (no NOT_STARTED)
 * - Returns the authoritative backend-computed total
 */
export interface QuestionMarksValidationSummary {
  totalExpected: number;
  evaluatedQuestions: number;
  notAttemptedQuestions: number;
  flaggedQuestions: number;
  unansweredQuestions: number;
  missingQuestionNumbers: number[];
}

export function computeQuestionMarksSummary(
  questionMarks: IEvaluationQuestionMark[],
  authoritativeQuestions: Map<number, IAuthoritativeQuestion>
): QuestionMarksValidationSummary {
  const seenQuestions = new Set<number>();
  let evaluatedQuestions = 0;
  let notAttemptedQuestions = 0;
  let flaggedQuestions = 0;
  let unansweredQuestions = 0;
  const missingQuestionNumbers: number[] = [];

  for (const qm of questionMarks) {
    seenQuestions.add(qm.questionNumber);
    if (qm.status === 'MARKED') {
      evaluatedQuestions++;
    } else if (qm.status === 'NOT_ATTEMPTED') {
      notAttemptedQuestions++;
    } else if (qm.status === 'FLAGGED') {
      flaggedQuestions++;
    } else if (qm.status === 'NOT_STARTED') {
      unansweredQuestions++;
      if (!missingQuestionNumbers.includes(qm.questionNumber)) {
        missingQuestionNumbers.push(qm.questionNumber);
      }
    }
  }

  // Also check if any authoritative questions were not included in questionMarks at all
  if (authoritativeQuestions.size > 0) {
    for (const qNum of authoritativeQuestions.keys()) {
      if (!seenQuestions.has(qNum)) {
        unansweredQuestions++;
        if (!missingQuestionNumbers.includes(qNum)) {
          missingQuestionNumbers.push(qNum);
        }
      }
    }
  }

  const totalExpected = authoritativeQuestions.size > 0
    ? authoritativeQuestions.size
    : Math.max(questionMarks.length, 1);

  missingQuestionNumbers.sort((a, b) => a - b);

  return {
    totalExpected,
    evaluatedQuestions,
    notAttemptedQuestions,
    flaggedQuestions,
    unansweredQuestions,
    missingQuestionNumbers,
  };
}

/**
 * Validates question marks list against authoritative questions and examination rules:
 * - Determines total expected, evaluated, not-attempted, flagged, unanswered, and invalid marks
 * - Rejects duplicate question numbers
 * - Rejects unknown question numbers
 * - Rejects marks out of bounds [0, maxMarks]
 * - Rejects non-zero marks for NOT_ATTEMPTED or NOT_STARTED
 * - Rejects invalid statuses
 * - On submit, ensures every expected question is present and evaluated (no NOT_STARTED)
 * - Returns the authoritative backend-computed total and summary
 */
export function validateQuestionMarksList(
  questionMarks: IEvaluationQuestionMark[],
  authoritativeQuestions: Map<number, IAuthoritativeQuestion>,
  isSubmitting = false
): {
  validatedList: IEvaluationQuestionMark[];
  computedTotal: number;
  summary: QuestionMarksValidationSummary;
} {
  const summary = computeQuestionMarksSummary(questionMarks, authoritativeQuestions);
  const seenQuestions = new Set<number>();
  const VALID_STATUSES = ['NOT_STARTED', 'MARKED', 'FLAGGED', 'NOT_ATTEMPTED'] as const;

  for (const qm of questionMarks) {
    // 1. Check duplicate question number
    if (seenQuestions.has(qm.questionNumber)) {
      const error: any = new Error(
        `Duplicate question number detected: Q${qm.questionNumber}. Each question must only appear once.`
      );
      error.status = 400;
      error.code = 'DUPLICATE_QUESTION_NUMBER';
      throw error;
    }
    seenQuestions.add(qm.questionNumber);

    // 2. Check unknown question number
    if (authoritativeQuestions.size > 0 && !authoritativeQuestions.has(qm.questionNumber)) {
      const error: any = new Error(
        `Unknown question number: Q${qm.questionNumber}. This question is not part of the examination specifications.`
      );
      error.status = 400;
      error.code = 'UNKNOWN_QUESTION_NUMBER';
      throw error;
    }

    // 3. Check invalid status
    if (!VALID_STATUSES.includes(qm.status as any)) {
      const error: any = new Error(
        `Invalid status '${qm.status}' for question Q${qm.questionNumber}. Allowed statuses: ${VALID_STATUSES.join(', ')}.`
      );
      error.status = 400;
      error.code = 'INVALID_QUESTION_STATUS';
      throw error;
    }

    // 4. Validate marks is a number
    const marksNum = Number(qm.marks);
    if (typeof qm.marks !== 'number' || isNaN(marksNum)) {
      const error: any = new Error(
        `Invalid marks value for question Q${qm.questionNumber}: Marks must be a valid number.`
      );
      error.status = 400;
      error.code = 'INVALID_MARKS';
      throw error;
    }

    // 5. Ensure marks are not negative
    if (marksNum < 0) {
      const error: any = new Error(
        `Negative marks detected for question Q${qm.questionNumber} (${marksNum}). Marks cannot be negative.`
      );
      error.status = 400;
      error.code = 'INVALID_MARKS_NEGATIVE';
      throw error;
    }

    // 6. Ensure marks do not exceed question maximumMarks
    const officialQ = authoritativeQuestions.get(qm.questionNumber);
    if (officialQ && marksNum > officialQ.maximumMarks) {
      const error: any = new Error(
        `Question Q${qm.questionNumber} marks (${marksNum}) exceed the maximum allowed marks (${officialQ.maximumMarks}).`
      );
      error.status = 400;
      error.code = 'MARKS_EXCEED_MAXIMUM';
      throw error;
    }

    // 7. Ensure NOT_ATTEMPTED has zero marks
    if (qm.status === 'NOT_ATTEMPTED' && marksNum !== 0) {
      const error: any = new Error(
        `Question Q${qm.questionNumber} is marked as NOT_ATTEMPTED but has non-zero marks (${marksNum}). Questions not attempted must have 0 marks.`
      );
      error.status = 400;
      error.code = 'INVALID_NOT_ATTEMPTED_MARKS';
      throw error;
    }

    // 8. Ensure NOT_STARTED has zero marks
    if (qm.status === 'NOT_STARTED' && marksNum !== 0) {
      const error: any = new Error(
        `Question Q${qm.questionNumber} is marked as NOT_STARTED but has non-zero marks (${marksNum}). Questions not started must have 0 marks.`
      );
      error.status = 400;
      error.code = 'INVALID_NOT_STARTED_MARKS';
      throw error;
    }
  }

  // 9. On SUBMIT: Every expected question must have exactly one valid evaluation state
  if (isSubmitting && authoritativeQuestions.size > 0) {
    const missingKeys: number[] = [];
    for (const [qNum] of authoritativeQuestions.entries()) {
      if (!seenQuestions.has(qNum)) {
        missingKeys.push(qNum);
      }
    }
    if (missingKeys.length > 0) {
      const error: any = new Error(
        `Missing question entry: Question ${missingKeys.map(k => `Q${k}`).join(', ')} is required but missing from the submission.`
      );
      error.status = 400;
      error.code = 'MISSING_QUESTION_EVALUATION';
      error.details = { summary, missingQuestions: missingKeys };
      throw error;
    }

    // Ensure every question has been reviewed and has an explicit final decision
    const unreviewedKeys: number[] = [];
    const reviewedWithoutDecision: number[] = [];
    const unstartedKeys: number[] = [];

    for (const qm of questionMarks) {
      if (!qm.examinerReviewed) {
        unreviewedKeys.push(qm.questionNumber);
      }
      if (qm.status === 'NOT_STARTED' || qm.status === undefined) {
        if (qm.examinerReviewed) {
          reviewedWithoutDecision.push(qm.questionNumber);
        } else {
          unstartedKeys.push(qm.questionNumber);
        }
      }
    }

    if (unreviewedKeys.length > 0) {
      const error: any = new Error(
        `Review all questions before submitting. The following questions have not been reviewed by the examiner: ${unreviewedKeys.map(k => `Q${k}`).join(', ')}`
      );
      error.status = 400;
      error.code = 'UNREVIEWED_QUESTIONS';
      error.details = { summary, unreviewedQuestions: unreviewedKeys };
      throw error;
    }

    if (reviewedWithoutDecision.length > 0) {
      const error: any = new Error(
        `${reviewedWithoutDecision.map(k => `Q${k}`).join(', ')} has been reviewed but does not have a final examiner decision. Every question must have final marks entered or be marked as NOT_ATTEMPTED before submission.`
      );
      error.status = 400;
      error.code = 'QUESTION_DECISION_REQUIRED';
      error.details = { summary, unresolvedQuestions: reviewedWithoutDecision };
      throw error;
    }

    if (unstartedKeys.length > 0) {
      const error: any = new Error(
        `Question ${unstartedKeys.map(k => `Q${k}`).join(', ')} has not been evaluated. Every question must have an explicit evaluated status (MARKED, FLAGGED, or NOT_ATTEMPTED) before submission.`
      );
      error.status = 400;
      error.code = 'QUESTION_UNMARKED';
      error.details = { summary, unstartedQuestions: unstartedKeys };
      throw error;
    }
  }

  // Authoritative total marks calculation:
  // only MARKED and FLAGGED statuses contribute marks
  const computedTotal = questionMarks
    .filter((q) => q.status === 'MARKED' || q.status === 'FLAGGED')
    .reduce((sum, q) => sum + (Number(q.marks) || 0), 0);

  return { validatedList: questionMarks, computedTotal, summary };
}

export async function fetchEvaluations(
  query: { status?: string },
  userRole: string,
  userId: string
) {
  const filter: Record<string, unknown> = {};

  // Examiners can only see their own evaluations
  if (userRole === 'EXAMINER') {
    filter.examinerId = userId;
  }

  if (query.status) {
    filter.status = query.status;
  }

  return Evaluation.find(filter)
    .populate({
      path: 'answerBookId',
      populate: { path: 'examId', select: 'title subjectCode subjectName maximumMarks' },
    })
    .populate('examinerId', 'name email')
    .sort({ createdAt: -1 });
}

export async function fetchEvaluationById(id: string, userRole: string, userId: string) {
  const evaluation = await Evaluation.findById(id)
    .populate({
      path: 'answerBookId',
      populate: { path: 'examId', select: 'title subjectCode subjectName maximumMarks totalQuestions' },
    })
    .populate('examinerId', 'name email');

  if (!evaluation) {
    const error: any = new Error('Evaluation not found');
    error.status = 404;
    error.code = 'EVALUATION_NOT_FOUND';
    throw error;
  }

  if (userRole === 'EXAMINER' && evaluation.examinerId._id?.toString() !== userId && (evaluation.examinerId as any).toString() !== userId) {
    const error: any = new Error('Access denied: Evaluation is not assigned to you');
    error.status = 403;
    error.code = 'ACCESS_DENIED';
    throw error;
  }

  // Automatic content-driven page mapping runs first if answer book mappings are not yet established
  const answerBookDoc = evaluation.answerBookId as any;
  if (answerBookDoc && answerBookDoc._id) {
    const rawAnswerBook = await AnswerBook.findById(answerBookDoc._id);
    if (rawAnswerBook) {
      const currentMappings: any[] = rawAnswerBook.questionPageMapping || [];
      const hasUnresolvedQuestions = currentMappings.some(
        (m: any) => (!m.pages || m.pages.length === 0) && !m.examinerVerified && m.source !== 'EXAMINER_VERIFIED'
      );
      const hasOutdatedVersion = currentMappings.some(
        (m: any) => m.mappingAlgorithmVersion !== CURRENT_MAPPING_ALGORITHM_VERSION && !m.examinerVerified && m.source !== 'EXAMINER_VERIFIED'
      );
      const needsMapping =
        currentMappings.length === 0 ||
        hasUnresolvedQuestions ||
        hasOutdatedVersion;

      if (needsMapping) {
        let qpId = rawAnswerBook.questionPaperId;
        let qp = null;
        if (qpId) {
          qp = await QuestionPaper.findById(qpId);
        }
        if (!qp) {
          qp = await QuestionPaper.findOne({
            examId: rawAnswerBook.examId,
            status: 'VERIFIED',
          }).sort({ updatedAt: -1 });
          if (qp) {
            rawAnswerBook.questionPaperId = qp._id;
            await rawAnswerBook.save();
          }
        }

        if (qp) {
          const pages = await AnswerPage.find({ answerBookId: rawAnswerBook._id }).sort({ pageNumber: 1 });
          if (pages.length > 0) {
            try {
              const updatedMappings = await autoMapAnswerBookPages({
                answerBook: rawAnswerBook,
                questionPaper: qp,
                answerPages: pages,
                forceRemap: hasUnresolvedQuestions || hasOutdatedVersion,
              });
              rawAnswerBook.questionPageMapping = updatedMappings;
              answerBookDoc.questionPageMapping = updatedMappings;
            } catch (mapErr) {
              console.warn('[fetchEvaluationById] Auto mapping initialization error:', mapErr);
            }
          }
        }
      }
    }

    // Dynamically attach authoritative totalPossibleMarks from active QuestionPaper / exam questions
    const examId =
      typeof answerBookDoc.examId === 'object' && answerBookDoc.examId !== null && '_id' in answerBookDoc.examId
        ? answerBookDoc.examId._id
        : answerBookDoc.examId;
    if (examId) {
      const authoritativeQuestions = await fetchAuthoritativeQuestions(examId, answerBookDoc._id);
      const computedPossible = calculateTotalPossibleMarks(authoritativeQuestions);
      if (computedPossible > 0) {
        evaluation.totalPossibleMarks = computedPossible;
      }
    }
  }

  return evaluation;
}

export async function beginEvaluation(id: string, examinerId: string) {
  // Support either answerBookId or evaluationId
  let answerBook = await AnswerBook.findById(id);
  let evaluation: IEvaluation | null = null;

  if (!answerBook) {
    evaluation = await Evaluation.findById(id);
    if (evaluation) {
      answerBook = await AnswerBook.findById(evaluation.answerBookId);
    }
  }

  if (!answerBook) {
    const error: any = new Error('Answer book not found');
    error.status = 404;
    error.code = 'ANSWER_BOOK_NOT_FOUND';
    throw error;
  }

  if (!areEntityIdsEqual(answerBook.assignedExaminerId, examinerId)) {
    const error: any = new Error('You are not assigned to this answer book');
    error.status = 403;
    error.code = 'NOT_ASSIGNED';
    throw error;
  }

  if (!['ASSIGNED', 'RETURNED'].includes(answerBook.status)) {
    const error: any = new Error(
      `Cannot start evaluation for answer book with status: ${answerBook.status}. Must be ASSIGNED or RETURNED.`
    );
    error.status = 400;
    error.code = 'INVALID_STATUS';
    throw error;
  }

  // Validate state transition
  validateStateTransition(answerBook.status, 'IN_PROGRESS');

  if (!evaluation) {
    evaluation = await Evaluation.findOne({ answerBookId: answerBook._id });
  }

  if (!evaluation) {
    evaluation = await Evaluation.create({
      answerBookId: answerBook._id,
      examinerId,
      status: 'IN_PROGRESS',
      startedAt: new Date(),
    });
  } else {
    evaluation.status = 'IN_PROGRESS';
    evaluation.startedAt = evaluation.startedAt || new Date();
  }

  const examId =
    typeof answerBook.examId === 'object' && answerBook.examId !== null && '_id' in (answerBook.examId as any)
      ? (answerBook.examId as any)._id
      : answerBook.examId;
  const authoritativeQuestions = await fetchAuthoritativeQuestions(examId, answerBook._id);
  const computedPossible = calculateTotalPossibleMarks(authoritativeQuestions);
  if (computedPossible > 0) {
    evaluation.totalPossibleMarks = computedPossible;
  }
  await evaluation.save();

  answerBook.status = 'IN_PROGRESS';
  await answerBook.save();

  await evaluation.populate({
    path: 'answerBookId',
    populate: { path: 'examId', select: 'title subjectCode subjectName maximumMarks totalQuestions' },
  });
  await evaluation.populate('examinerId', 'name email');

  await logAuditAction({
    actorId: examinerId,
    action: 'EVALUATION_STARTED',
    entityType: 'Evaluation',
    entityId: evaluation._id.toString(),
    metadata: { answerBookId: answerBook._id.toString() },
  });

  emitToAll('evaluation.started', { evaluation, answerBook });

  return { evaluation, answerBook };
}

export async function updateEvaluationMarks(
  id: string,
  data: { totalMarks?: number; remarks?: string; questionMarks?: IEvaluationQuestionMark[] },
  examinerId: string
) {
  const evaluation = await Evaluation.findById(id);
  if (!evaluation) {
    const error: any = new Error('Evaluation not found');
    error.status = 404;
    error.code = 'EVALUATION_NOT_FOUND';
    throw error;
  }

  if (!areEntityIdsEqual(evaluation.examinerId, examinerId)) {
    const error: any = new Error('Access denied: You do not own this evaluation');
    error.status = 403;
    error.code = 'ACCESS_DENIED';
    throw error;
  }

  if (evaluation.status !== 'IN_PROGRESS') {
    const error: any = new Error('Can only update in-progress evaluations');
    error.status = 400;
    error.code = 'EVALUATION_NOT_IN_PROGRESS';
    throw error;
  }

  const answerBook = await AnswerBook.findById(evaluation.answerBookId);
  if (!answerBook) {
    const error: any = new Error('Associated answer book not found');
    error.status = 404;
    error.code = 'ANSWER_BOOK_NOT_FOUND';
    throw error;
  }

  const examId =
    typeof answerBook.examId === 'object' && answerBook.examId !== null && '_id' in (answerBook.examId as any)
      ? (answerBook.examId as any)._id
      : answerBook.examId;

  // 1. Fetch authoritative questions for this exam from MongoDB
  const authoritativeQuestions = await fetchAuthoritativeQuestions(examId, answerBook._id);
  const totalPossibleMarks = calculateTotalPossibleMarks(authoritativeQuestions);
  if (totalPossibleMarks > 0) {
    evaluation.totalPossibleMarks = totalPossibleMarks;
  }

  // 2. Validate and calculate authoritative total
  if (data.questionMarks && Array.isArray(data.questionMarks)) {
    const { validatedList, computedTotal } = validateQuestionMarksList(
      data.questionMarks,
      authoritativeQuestions,
      false // draft update
    );

    evaluation.questionMarks = validatedList;
    // Discard any frontend-provided data.totalMarks; authoritative calculation only
    evaluation.totalMarks = computedTotal;
  } else {
    // If only remarks were updated, recalculate total from existing question marks
    const { computedTotal } = validateQuestionMarksList(
      evaluation.questionMarks || [],
      authoritativeQuestions,
      false
    );
    evaluation.totalMarks = computedTotal;
  }

  if (data.remarks !== undefined) evaluation.remarks = data.remarks;
  await evaluation.save();

  await logAuditAction({
    actorId: examinerId,
    action: 'EVALUATION_UPDATED',
    entityType: 'Evaluation',
    entityId: evaluation._id.toString(),
    metadata: {
      totalMarks: evaluation.totalMarks,
      questionCount: evaluation.questionMarks.length,
      answerBookId: evaluation.answerBookId.toString(),
      timestamp: new Date().toISOString(),
    },
  });

  emitToAll('evaluation.updated', { evaluationId: evaluation._id });

  return evaluation;
}

export async function submitEvaluationFinal(
  id: string,
  data: { totalMarks?: number; remarks?: string; questionMarks?: IEvaluationQuestionMark[] },
  examinerId: string
) {
  const evaluation = await Evaluation.findById(id);
  if (!evaluation) {
    const error: any = new Error('Evaluation not found');
    error.status = 404;
    error.code = 'EVALUATION_NOT_FOUND';
    throw error;
  }

  if (!areEntityIdsEqual(evaluation.examinerId, examinerId)) {
    const error: any = new Error('Access denied: You do not own this evaluation');
    error.status = 403;
    error.code = 'ACCESS_DENIED';
    throw error;
  }

  if (evaluation.status !== 'IN_PROGRESS') {
    const error: any = new Error('Can only submit in-progress evaluations');
    error.status = 400;
    error.code = 'EVALUATION_NOT_IN_PROGRESS';
    throw error;
  }

  const answerBook = await AnswerBook.findById(evaluation.answerBookId);
  if (!answerBook) {
    const error: any = new Error('Associated answer book not found');
    error.status = 404;
    error.code = 'ANSWER_BOOK_NOT_FOUND';
    throw error;
  }

  const examId =
    typeof answerBook.examId === 'object' && answerBook.examId !== null && '_id' in (answerBook.examId as any)
      ? (answerBook.examId as any)._id
      : answerBook.examId;

  // 1. Fetch official questions for the exam from MongoDB
  const authoritativeQuestions = await fetchAuthoritativeQuestions(examId, answerBook._id);

  // 2. Build target question marks from submission payload or already saved state
  const targetQuestionMarks =
    data.questionMarks && Array.isArray(data.questionMarks) && data.questionMarks.length > 0
      ? data.questionMarks
      : evaluation.questionMarks;

  if (!targetQuestionMarks || targetQuestionMarks.length === 0) {
    const error: any = new Error('Cannot submit evaluation: No question marks provided or saved');
    error.status = 400;
    error.code = 'NO_QUESTION_MARKS';
    throw error;
  }

  // 3. Strict submission validation against authoritative questions:
  // - reject duplicate question numbers
  // - reject unknown question numbers
  // - reject missing required question entries
  // - validate every question against official question
  // - ensure marks between 0 and maximumMarks
  // - ensure NOT_ATTEMPTED has zero marks
  // - ensure invalid statuses are rejected
  // - every expected question must have exactly one valid evaluation state
  const { validatedList, computedTotal, summary } = validateQuestionMarksList(
    targetQuestionMarks,
    authoritativeQuestions,
    true // isSubmitting = true
  );

  // 3b. Mandatory Examiner Review Requirement (Requirement 7 & 16)
  // 1. Verify that every question entry has been opened / reviewed by the examiner
  const unreviewedQuestions = validatedList.filter((qm: any) => !qm.examinerReviewed);
  if (unreviewedQuestions.length > 0) {
    const unreviewedNumbers = unreviewedQuestions.map((q: any) => `Q${q.questionNumber}`).join(', ');
    const error: any = new Error(
      `Review all questions before submitting. The following questions have not been reviewed by the examiner: ${unreviewedNumbers}`
    );
    error.status = 400;
    error.code = 'UNREVIEWED_QUESTIONS';
    throw error;
  }

  // 2. Second Fix: Verify every question has a final examiner decision
  const unresolvedQuestions = validatedList.filter(
    (qm: any) => qm.status === 'NOT_STARTED' || qm.status === undefined
  );
  if (unresolvedQuestions.length > 0) {
    const unresolvedNumbers = unresolvedQuestions.map((q: any) => `Q${q.questionNumber}`).join(', ');
    const error: any = new Error(
      `${unresolvedNumbers} has been reviewed but does not have a final examiner decision. Every question must have final marks entered or be marked as NOT_ATTEMPTED before submission.`
    );
    error.status = 400;
    error.code = 'QUESTION_DECISION_REQUIRED';
    throw error;
  }

  // 4. Validate against authoritative totalPossibleMarks (or examination maximumMarks as fallback)
  const totalPossibleMarks = calculateTotalPossibleMarks(authoritativeQuestions);
  const exam = await Exam.findById(examId);
  const maxAllowed = totalPossibleMarks > 0 ? totalPossibleMarks : (exam?.maximumMarks || 0);
  if (maxAllowed > 0 && computedTotal > maxAllowed) {
    const error: any = new Error(
      `Total calculated marks (${computedTotal}) exceed maximum allowed (${maxAllowed}).`
    );
    error.status = 400;
    error.code = 'TOTAL_EXCEEDS_EXAM_MAXIMUM';
    throw error;
  }

  // 5. Store ONLY the backend-calculated total and authoritative totalPossibleMarks
  evaluation.questionMarks = validatedList;
  evaluation.totalMarks = computedTotal;
  evaluation.totalPossibleMarks = maxAllowed;

  // Validate state transition
  validateStateTransition(answerBook.status, 'SUBMITTED');

  if (data.remarks !== undefined) evaluation.remarks = data.remarks;
  evaluation.status = 'SUBMITTED';
  evaluation.submittedAt = new Date();
  await evaluation.save();

  answerBook.status = 'SUBMITTED';
  await answerBook.save();

  await answerBook.populate('examId', 'title subjectCode subjectName');
  await evaluation.populate({
    path: 'answerBookId',
    populate: { path: 'examId', select: 'title subjectCode subjectName' },
  });
  await evaluation.populate('examinerId', 'name email');

  await logAuditAction({
    actorId: examinerId,
    action: 'EVALUATION_SUBMITTED',
    entityType: 'Evaluation',
    entityId: evaluation._id.toString(),
    metadata: {
      totalMarks: evaluation.totalMarks,
      maximumMarks: evaluation.totalPossibleMarks || exam?.maximumMarks,
      answerBookId: evaluation.answerBookId.toString(),
      totalExpected: summary.totalExpected,
      evaluatedQuestions: summary.evaluatedQuestions,
      notAttemptedQuestions: summary.notAttemptedQuestions,
      flaggedQuestions: summary.flaggedQuestions,
      unansweredQuestions: summary.unansweredQuestions,
      questionCount: evaluation.questionMarks.length,
      timestamp: new Date().toISOString(),
    },
  });

  emitToAll('answerbook.status.changed', {
    answerBookId: answerBook._id,
    status: 'SUBMITTED',
  });
  emitToAll('evaluation.submitted', { evaluation, answerBook, summary });
  emitToRole('MODERATOR', 'evaluation.submitted', { evaluation, answerBook, summary });

  return { evaluation, answerBook, summary };
}

/**
 * Requests AI-assisted evaluation for a question.
 * Fetches authoritative data, secures media through signed delivery, invokes EvaluationAssistantService,
 * stores aiAnalysis in the evaluation model, and emits real-time socket events.
 * AI analysis remains completely separate from final examiner marks.
 */
export async function requestAISuggestionForQuestion(
  evaluationId: string,
  questionNumber: number,
  options: {
    pageNumber?: number;
    forceRefresh?: boolean;
    userRole: string;
    userId: string;
    userName?: string;
    answerBookId?: string;
    questionPaperId?: string;
    questionId?: string;
  }
) {
  // 1. Authenticate user & RBAC
  let evaluation = await Evaluation.findById(evaluationId);
  if (!evaluation) {
    evaluation = await Evaluation.findOne({ answerBookId: evaluationId });
  }
  if (!evaluation) {
    const error: any = new Error('Evaluation not found');
    error.status = 404;
    error.code = 'EVALUATION_NOT_FOUND';
    throw error;
  }

  // Allow only EXAMINER, MODERATOR, or ADMIN
  if (!['EXAMINER', 'MODERATOR', 'ADMIN'].includes(options.userRole)) {
    const error: any = new Error('Forbidden: Your role is not authorized to request AI evaluation suggestions');
    error.status = 403;
    error.code = 'FORBIDDEN_ROLE';
    throw error;
  }

  // 2. Only assigned examiner can request suggestion, unless privileged role (ADMIN, MODERATOR)
  if (options.userRole === 'EXAMINER') {
    const examinerId =
      typeof evaluation.examinerId === 'object' &&
      evaluation.examinerId !== null &&
      '_id' in (evaluation.examinerId as any)
        ? (evaluation.examinerId as any)._id.toString()
        : evaluation.examinerId.toString();

    if (examinerId !== options.userId) {
      const error: any = new Error(
        'Access denied: You are not the assigned examiner for this evaluation'
      );
      error.status = 403;
      error.code = 'UNAUTHORIZED_EXAMINER_ACCESS';
      throw error;
    }
  }

  // 3. Fetch authoritative AnswerBook
  let answerBook = null;
  if (options.answerBookId) {
    answerBook = await AnswerBook.findById(options.answerBookId);
  }
  if (!answerBook && evaluation.answerBookId) {
    answerBook = await AnswerBook.findById(evaluation.answerBookId);
  }
  if (!answerBook) {
    const error: any = new Error('Associated answer book not found');
    error.status = 404;
    error.code = 'ANSWER_BOOK_NOT_FOUND';
    throw error;
  }

  // 4. Resolve Authoritative QuestionPaper
  let activeQuestionPaper = null;
  const targetQpId = options.questionPaperId || answerBook.questionPaperId;
  if (targetQpId) {
    activeQuestionPaper = await QuestionPaper.findById(targetQpId);
  }

  // Ensure answerBook links to activeQuestionPaper if found
  if (
    activeQuestionPaper &&
    (!answerBook.questionPaperId ||
      answerBook.questionPaperId.toString() !== activeQuestionPaper._id.toString())
  ) {
    answerBook.questionPaperId = activeQuestionPaper._id;
    await answerBook.save();
  }

  const examId =
    typeof answerBook.examId === 'object' &&
    answerBook.examId !== null &&
    '_id' in (answerBook.examId as any)
      ? (answerBook.examId as any)._id
      : answerBook.examId;

  const exam = await Exam.findById(examId);
  if (!exam) {
    const error: any = new Error('Associated exam not found');
    error.status = 404;
    error.code = 'EXAM_NOT_FOUND';
    throw error;
  }

  let targetQuestionText = '';
  let targetMaximumMarks = 0;
  let targetRubric: Array<{ criterion: string; marks: number }> = [];
  let targetReferenceAnswer: string | undefined = undefined;
  let targetKeyConcepts: string[] | undefined = undefined;
  let targetGradingNotes: string | undefined = undefined;
  let targetLanguage: string | undefined = undefined;
  let questionSource = 'EXAM_QUESTIONS_FALLBACK';

  // 5. QUESTION PAPER MUST TAKE ABSOLUTE PRIORITY
  if (activeQuestionPaper) {
    const isVerified = Boolean(
      activeQuestionPaper.verifiedQuestions && activeQuestionPaper.verifiedQuestions.length > 0
    );
    const qList = isVerified
      ? activeQuestionPaper.verifiedQuestions
      : (activeQuestionPaper.extractedQuestions || []);

    // Resolve question by stable questionId or normalized questionNumber
    let qMatch = null;
    if (options.questionId) {
      qMatch = qList.find(
        (q: any) =>
          q._id?.toString() === options.questionId ||
          (q as any).id === options.questionId
      );
    }
    if (!qMatch) {
      qMatch = qList.find((q) => Number(q.questionNumber) === Number(questionNumber));
    }

    if (qMatch) {
      targetQuestionText = qMatch.text;
      targetMaximumMarks = qMatch.maximumMarks;
      targetRubric =
        qMatch.rubric && qMatch.rubric.length > 0
          ? qMatch.rubric.map((r) => ({ criterion: r.criterion, marks: r.marks }))
          : [
              { criterion: 'Core answer & understanding', marks: Math.round(qMatch.maximumMarks * 0.6) },
              { criterion: 'Accuracy & methodology', marks: Math.round(qMatch.maximumMarks * 0.4) },
            ];
      targetReferenceAnswer = qMatch.referenceAnswer;
      questionSource = isVerified ? 'VERIFIED_QUESTION_PAPER' : 'EXTRACTED_QUESTION_PAPER';
    } else {
      // Do NOT fall back to Exam.questions if a QuestionPaper is attached!
      const error: any = new Error(
        `Question Q${questionNumber} not found in the active Question Paper (${activeQuestionPaper.paperSet || 'Active Set'}).`
      );
      error.status = 404;
      error.code = 'QUESTION_NOT_FOUND_IN_PAPER';
      throw error;
    }
  } else {
    // Fallback to Question collection ONLY when NO QuestionPaper is attached at all
    const question = await Question.findOne({ examId, questionNumber });
    if (question) {
      targetQuestionText = question.text;
      targetMaximumMarks = question.maximumMarks;
      targetRubric = question.rubric.map((r) => ({ criterion: r.criterion, marks: r.marks }));
      targetReferenceAnswer = question.referenceAnswer;
      targetKeyConcepts = question.keyConcepts;
      targetGradingNotes = question.gradingNotes;
      targetLanguage = question.evaluationLanguage;
      questionSource = 'EXAM_QUESTIONS_FALLBACK';
    }
  }

  if (!targetQuestionText) {
    const error: any = new Error(
      `Question Q${questionNumber} not found for this examination or question paper`
    );
    error.status = 404;
    error.code = 'QUESTION_NOT_FOUND';
    throw error;
  }

  // Safe debug logging (no secrets or sensitive tokens)
  console.log(`\n[AI CONTEXT]
AnswerBook ID   : ${answerBook._id}
QuestionPaper ID: ${activeQuestionPaper?._id || 'None'}
Question Number : ${questionNumber}
Question Text   : ${targetQuestionText}
Maximum Marks   : ${targetMaximumMarks}
Question Source : ${questionSource}\n`);

  // 6. Determine mapped pages for this question from AnswerBook questionPageMapping or options
  let targetPageNumbers: number[] = [];
  const mapping = answerBook.questionPageMapping?.find(
    (m: IQuestionPageMapping) => m.questionNumber === questionNumber
  );

  if (mapping?.pages && mapping.pages.length > 0) {
    targetPageNumbers = mapping.pages;
  } else if (options.pageNumber) {
    targetPageNumbers = [options.pageNumber];
  }

  // Safety Gate: If question is not mapped to any pages, do not evaluate
  if (targetPageNumbers.length === 0) {
    const error: any = new Error(
      `Question Q${questionNumber} is not mapped to any scanned answer pages. AI copilot cannot evaluate without mapped page evidence.`
    );
    error.status = 400;
    error.code = 'QUESTION_PAGES_NOT_MAPPED';
    throw error;
  }

  // 7. Check for existing cached analysis - verify it is NOT stale
  const existingIndex = evaluation.questionMarks.findIndex(
    (q) => q.questionNumber === questionNumber
  );
  const existingQm = existingIndex >= 0 ? evaluation.questionMarks[existingIndex] : null;

  let isCacheValid = false;
  const isPlaceholderAnalysis =
    !existingQm?.aiAnalysis?.confidence ||
    existingQm.aiAnalysis.confidence === 0;

  if (existingQm?.aiAnalysis?.generatedAt && !isPlaceholderAnalysis && !options.forceRefresh) {
    let qpMatch = false;
    if (activeQuestionPaper) {
      const cachedQpId = existingQm.aiAnalysis.questionPaperId?.toString();
      if (cachedQpId && cachedQpId === activeQuestionPaper._id.toString()) {
        qpMatch = true;
      }
    } else {
      if (!existingQm.aiAnalysis.questionPaperId) {
        qpMatch = true;
      }
    }

    const marksMatch =
      existingQm.aiAnalysis.questionMaxMarks !== undefined
        ? existingQm.aiAnalysis.questionMaxMarks === targetMaximumMarks
        : existingQm.aiAnalysis.maxMarks <= targetMaximumMarks;

    const cachedPages = Array.isArray(existingQm.aiAnalysis.mappedPages)
      ? [...existingQm.aiAnalysis.mappedPages].sort((a, b) => a - b)
      : [];
    const currentPages = [...targetPageNumbers].sort((a, b) => a - b);
    const pagesMatch =
      cachedPages.length > 0 &&
      cachedPages.length === currentPages.length &&
      cachedPages.every((p, idx) => p === currentPages[idx]);

    const currentHash = crypto.createHash('md5').update(targetQuestionText).digest('hex');
    const hashMatch =
      !existingQm.aiAnalysis.questionTextHash ||
      existingQm.aiAnalysis.questionTextHash === currentHash;

    if (qpMatch && marksMatch && pagesMatch && hashMatch) {
      isCacheValid = true;
    } else {
      console.log(
        `[AI STALE DETECTED] Cached AI result for Q${questionNumber} invalidated (qpMatch=${qpMatch}, marksMatch=${marksMatch}, pagesMatch=${pagesMatch}, hashMatch=${hashMatch}). Re-running evaluation.`
      );
    }
  }

  if (isCacheValid && existingQm?.aiAnalysis) {
    return {
      cached: true,
      aiAnalysis: existingQm.aiAnalysis,
      evaluationId: evaluation._id.toString(),
      questionNumber,
    };
  }

  // Fetch all mapped AnswerPages in strict ascending page order
  const answerPages = await AnswerPage.find({
    answerBookId: answerBook._id,
    pageNumber: { $in: targetPageNumbers },
  }).sort({ pageNumber: 1 });

  // Safety Gate: Ensure ALL mapped pages exist
  if (answerPages.length !== targetPageNumbers.length) {
    const foundNumbers = new Set(answerPages.map((p) => p.pageNumber));
    const missingPages = targetPageNumbers.filter((pn) => !foundNumbers.has(pn));
    const error: any = new Error(
      `Required scanned answer page(s) [${missingPages.join(', ')}] not found for question Q${questionNumber}. Incomplete evidence cannot be evaluated.`
    );
    error.status = 400;
    error.code = 'MISSING_ANSWER_PAGES';
    throw error;
  }

  const studentImages: Array<string | Buffer> = [];
  const ocrParts: string[] = [];
  let avgConfidenceSum = 0;
  let ocrConfidenceCount = 0;

  for (const p of answerPages) {
    let imageLoaded = false;
    let imageBufferLength = 0;

    // 1. Try reading real high-res page directly from local uploads/ folder if available
    const pageFileName = `page-${String(p.pageNumber).padStart(4, '0')}.jpg`;
    const localFilePath = path.join(
      process.cwd(),
      'uploads',
      'answer-books',
      answerBook.answerBookCode,
      'pages',
      pageFileName
    );

    if (fs.existsSync(localFilePath)) {
      try {
        const fileBuffer = fs.readFileSync(localFilePath);
        studentImages.push(fileBuffer);
        imageLoaded = true;
        imageBufferLength = fileBuffer.length;
      } catch {
        // Fall back to Cloudinary URL below
      }
    }

    // 2. If not read from disk, use secure Cloudinary URL
    let resolvedUrl = p.cloudinary?.secureUrl || (p as any).imageUrl;
    if (!imageLoaded && p.cloudinary?.publicId) {
      try {
        const signed = generateAuthorizedMediaUrl(p.cloudinary.publicId, {
          resourceType: p.cloudinary.resourceType,
          deliveryType: p.cloudinary.deliveryType,
          format: p.cloudinary.format,
          expiresInSeconds: 3600,
        });
        if (signed?.secureUrl) {
          resolvedUrl = signed.secureUrl;
          studentImages.push(signed.secureUrl);
          imageLoaded = true;
        }
      } catch (err) {
        console.warn(`[AI EVAL] Failed to generate signed Cloudinary URL:`, err);
      }
    }

    // 3. Fallback to existing imageUrl or cloudinary.secureUrl (zero filesystem dependency)
    if (!imageLoaded && resolvedUrl) {
      studentImages.push(resolvedUrl);
      imageLoaded = true;
    }

    // Structured logging for media verification
    console.log(`[FULL-AI] [PAGE-MEDIA] pageNumber=${p.pageNumber}, cloudinaryPublicId=${p.cloudinary?.publicId || 'none'}, resourceType=${p.cloudinary?.resourceType || 'image'}, secureUrl=${resolvedUrl ? 'available' : 'none'}, imageBufferLength=${imageBufferLength}`);

    if (p.ocr?.text && p.ocr.text.trim().length > 0) {
      ocrParts.push(`--- Page ${p.pageNumber} ---\n${p.ocr.text}`);
    }
    if (p.ocr?.confidence !== undefined && p.ocr.confidence !== null) {
      avgConfidenceSum += p.ocr.confidence;
      ocrConfidenceCount++;
    }

    // Audit media access
    await logAuditAction({
      actorId: options.userId,
      actorName: options.userName || 'Assigned Examiner',
      actorRole: options.userRole,
      action: 'MEDIA_ACCESSED_BY_AI_COPILOT',
      entityType: 'AnswerPage',
      entityId: p._id.toString(),
      metadata: {
        evaluationId: evaluation._id.toString(),
        answerBookId: answerBook._id.toString(),
        pageNumber: p.pageNumber,
        questionNumber,
      },
    });
  }

  // Safety Gate: Ensure ALL mapped pages have their media/image retrieved
  if (studentImages.length !== targetPageNumbers.length) {
    const error: any = new Error(
      `Could not retrieve media for all mapped pages (retrieved ${studentImages.length} of ${targetPageNumbers.length}). Incomplete evidence cannot be evaluated.`
    );
    error.status = 400;
    error.code = 'INCOMPLETE_PAGE_MEDIA';
    throw error;
  }

  // 6. Call EvaluationAssistantService with all multi-page images and OCR
  const assistantResult = await EvaluationAssistantService.evaluateStudentAnswer({
    question: targetQuestionText,
    maximumMarks: targetMaximumMarks,
    rubric: targetRubric,
    referenceAnswer: targetReferenceAnswer,
    keyConcepts: targetKeyConcepts,
    gradingNotes: targetGradingNotes,
    language: targetLanguage,
    studentAnswerImages: studentImages,
    studentAnswerImageMimeType: 'image/jpeg',
    ocrText: ocrParts.join('\n\n'),
    ocrConfidence: ocrConfidenceCount > 0 ? avgConfidenceSum / ocrConfidenceCount : null,
  });

  // 7. Store AI analysis in evaluation question data model (NEVER touching final examiner marks)
  const actualModelName = assistantResult.model || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const aiAnalysisData = {
    questionPaperId: activeQuestionPaper ? activeQuestionPaper._id : (answerBook.questionPaperId || undefined),
    suggestedMarks: assistantResult.suggestedMarks,
    minMarks: assistantResult.minMarks,
    maxMarks: assistantResult.maxMarks,
    questionMaxMarks: targetMaximumMarks,
    confidence: assistantResult.confidence,
    needsHumanReview: assistantResult.needsHumanReview,
    criteria: assistantResult.criteria,
    missingConcepts: assistantResult.missingConcepts,
    reasoningSummary: assistantResult.reasoningSummary,
    generatedAt: new Date(),
    model: actualModelName,
    mappedPages: [...targetPageNumbers].sort((a, b) => a - b),
    questionTextHash: crypto.createHash('md5').update(targetQuestionText).digest('hex'),
  };

  const calculatedAiStatus =
    assistantResult.needsHumanReview ||
    (assistantResult.confidence !== undefined && assistantResult.confidence < 0.75)
      ? 'NEEDS_REVIEW'
      : 'COMPLETED';

  if (existingIndex >= 0) {
    evaluation.questionMarks[existingIndex].aiAnalysis = aiAnalysisData;
    evaluation.questionMarks[existingIndex].aiStatus = calculatedAiStatus;
    evaluation.questionMarks[existingIndex].aiError = undefined;
  } else {
    evaluation.questionMarks.push({
      questionNumber,
      marks: 0,
      status: 'NOT_STARTED',
      aiStatus: calculatedAiStatus,
      aiAnalysis: aiAnalysisData,
    });
  }

  // Save evaluation (marks and totalMarks remain untouched by AI)
  await evaluation.save();

  // 8. Audit log
  await logAuditAction({
    actorId: options.userId,
    actorName: options.userName || 'Assigned Examiner',
    actorRole: options.userRole,
    action: 'EVALUATION_AI_ASSISTED',
    entityType: 'Evaluation',
    entityId: evaluation._id.toString(),
    metadata: {
      questionNumber,
      suggestedMarks: assistantResult.suggestedMarks,
      confidence: assistantResult.confidence,
      needsHumanReview: assistantResult.needsHumanReview,
      model: actualModelName,
      generatedAt: aiAnalysisData.generatedAt.toISOString(),
    },
  });

  // 9. Emit Socket.IO event
  emitToAll('evaluation.ai.updated', {
    evaluationId: evaluation._id.toString(),
    questionNumber,
    aiAnalysis: aiAnalysisData,
  });

  return {
    cached: false,
    aiAnalysis: aiAnalysisData,
    evaluationId: evaluation._id.toString(),
    questionNumber,
  };
}

/**
 * Marks a specific question as reviewed/inspected by the assigned examiner.
 */
export async function markQuestionReviewed(
  evaluationId: string,
  questionNumber: number,
  examinerId: string
) {
  const evaluation = await Evaluation.findById(evaluationId);
  if (!evaluation) {
    const error: any = new Error('Evaluation not found');
    error.status = 404;
    error.code = 'EVALUATION_NOT_FOUND';
    throw error;
  }

  const existingIdx = evaluation.questionMarks.findIndex(
    (qm) => qm.questionNumber === questionNumber
  );
  if (existingIdx >= 0) {
    evaluation.questionMarks[existingIdx].examinerReviewed = true;
    evaluation.questionMarks[existingIdx].reviewedAt = new Date();
  } else {
    evaluation.questionMarks.push({
      questionNumber,
      marks: 0,
      status: 'NOT_STARTED',
      examinerReviewed: true,
      reviewedAt: new Date(),
    });
  }

  await evaluation.save();
  return evaluation;
}

