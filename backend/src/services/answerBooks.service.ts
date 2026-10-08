import {
  AnswerBook,
  IAnswerBook,
  validateProcessingStateTransition,
} from '../models/AnswerBook';
import { AnswerPage } from '../models/AnswerPage';
import { Evaluation } from '../models/Evaluation';
import { User } from '../models/User';
import { AnswerBookStatus, ProcessingStatus, QualityStatus } from '@evalnexa/types';
import { logAuditAction } from './audit.service';
import { emitToAll, emitToUser } from '../sockets';
import { normalizeEntityId, areEntityIdsEqual } from '../utils/identity';

const VALID_TRANSITIONS: Record<AnswerBookStatus, AnswerBookStatus[]> = {
  READY: ['ASSIGNED'],
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW', 'APPROVED', 'RETURNED'],
  UNDER_REVIEW: ['APPROVED', 'RETURNED'],
  RETURNED: ['ASSIGNED', 'IN_PROGRESS'],
  APPROVED: ['FINALIZED'],
  FINALIZED: [],
};

export function validateStateTransition(
  currentStatus: AnswerBookStatus,
  nextStatus: AnswerBookStatus
): void {
  if (currentStatus === nextStatus) return;

  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    const error: any = new Error(
      `Invalid state transition: Cannot transition from '${currentStatus}' to '${nextStatus}'. Allowed transitions: ${allowed.join(', ') || 'None'}`
    );
    error.status = 400;
    error.code = 'INVALID_STATE_TRANSITION';
    throw error;
  }
}

export async function fetchAnswerBooks(
  query: { examId?: string; status?: string },
  userRole: string,
  userId: string
) {
  const filter: Record<string, unknown> = {};
  if (query.examId) filter.examId = query.examId;
  if (query.status) filter.status = query.status;

  // Examiner can only see answer books assigned to themselves
  if (userRole === 'EXAMINER') {
    filter.assignedExaminerId = userId;
  }

  return AnswerBook.find(filter)
    .populate('examId', 'title subjectCode subjectName maximumMarks')
    .populate('assignedExaminerId', 'name email')
    .sort({ createdAt: -1 });
}

export async function fetchExaminerAnswerBooks(userId: string, status?: string) {
  const filter: Record<string, unknown> = { assignedExaminerId: userId };
  if (status) filter.status = status;

  const answerBooks = await AnswerBook.find(filter)
    .populate('examId', 'title subjectCode subjectName maximumMarks')
    .sort({ createdAt: -1 });

  const stats = {
    assigned: 0,
    inProgress: 0,
    submitted: 0,
    returned: 0,
  };

  answerBooks.forEach((ab) => {
    if (ab.status === 'ASSIGNED') stats.assigned++;
    if (ab.status === 'IN_PROGRESS') stats.inProgress++;
    if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(ab.status)) stats.submitted++;
    if (ab.status === 'RETURNED') stats.returned++;
  });

  return { answerBooks, stats };
}

export async function fetchAnswerBookById(id: string, userRole: string, userId: string) {
  const answerBook = await AnswerBook.findById(id)
    .populate('examId', 'title subjectCode subjectName maximumMarks totalQuestions')
    .populate('assignedExaminerId', 'name email')
    .populate('questionPaperId');

  if (!answerBook) {
    const error: any = new Error('Answer book not found');
    error.status = 404;
    error.code = 'ANSWER_BOOK_NOT_FOUND';
    throw error;
  }

  const normalizedAssignedExaminerId = normalizeEntityId(answerBook.assignedExaminerId);
  const normalizedUserId = normalizeEntityId(userId);
  const isMatch = Boolean(
    normalizedAssignedExaminerId &&
    normalizedUserId &&
    normalizedAssignedExaminerId === normalizedUserId
  );

  // Safe diagnostic logging (no JWTs, passwords, secrets, or headers)
  const isRejected = userRole === 'EXAMINER' && !isMatch;
  console.log('[Diagnostic:fetchAnswerBookById]', {
    requestAnswerBookId: id,
    authenticatedUserId: userId,
    authenticatedUserRole: userRole,
    rawAssignedExaminerIdType: typeof answerBook.assignedExaminerId,
    assignedExaminerValue: (answerBook.assignedExaminerId as any)?._id
      ? String((answerBook.assignedExaminerId as any)._id)
      : String(answerBook.assignedExaminerId),
    normalizedAssignedExaminerId,
    normalizedAuthenticatedUserId: normalizedUserId,
    isMatch,
    decision: isRejected ? 'REJECTED: NOT_ASSIGNED' : 'AUTHORIZED',
  });

  if (isRejected) {
    const error: any = new Error('Access denied: Answer book is not assigned to you');
    error.status = 403;
    error.code = 'ACCESS_DENIED';
    throw error;
  }

  const evaluation = await Evaluation.findOne({ answerBookId: answerBook._id });

  return { answerBook, evaluation };
}

export async function createNewAnswerBook(
  data: {
    examId: string;
    answerBookCode: string;
    studentCode: string;
    pageCount?: number;
    scanBatch?: string;
    processingStatus?: ProcessingStatus;
    qualityStatus?: QualityStatus;
    status?: AnswerBookStatus;
    pdfUrl?: string;
  },
  actorId: string
): Promise<IAnswerBook> {
  const cleanCode = data.answerBookCode.trim().toUpperCase();
  const cleanStudentCode = data.studentCode.trim().toUpperCase();

  const existing = await AnswerBook.findOne({
    answerBookCode: cleanCode,
  });

  if (existing) {
    // If already finalized or beyond initial READY state, reject duplicate code
    if (existing.processingStatus === 'READY_FOR_EVALUATION' || existing.status !== 'READY') {
      const error: any = new Error(
        `Answer book code '${cleanCode}' already exists and is finalized or assigned.`
      );
      error.status = 409;
      error.code = 'ANSWER_BOOK_CODE_EXISTS';
      throw error;
    }

    // Idempotent resume/update for in-progress intake session
    if (data.pageCount) existing.pageCount = data.pageCount;
    if (data.scanBatch) existing.scanBatch = data.scanBatch;
    if (data.qualityStatus) existing.qualityStatus = data.qualityStatus;
    if (data.processingStatus && data.processingStatus !== existing.processingStatus) {
      const previousStatus = existing.processingStatus;
      validateProcessingStateTransition(previousStatus, data.processingStatus);
      existing.processingStatus = data.processingStatus;

      await logAuditAction({
        actorId,
        action: 'PROCESSING_STATUS_UPDATED',
        entityType: 'AnswerBook',
        entityId: existing._id.toString(),
        metadata: {
          previousStatus,
          newStatus: data.processingStatus,
          qualityStatus: data.qualityStatus || existing.qualityStatus,
          answerBookCode: existing.answerBookCode,
          examId: existing.examId?.toString(),
          timestamp: new Date().toISOString(),
        },
      });
    }
    if (data.pdfUrl) existing.pdfUrl = data.pdfUrl;
    existing.studentCode = cleanStudentCode;
    await existing.save();
    await existing.populate('examId', 'title subjectCode subjectName');
    return existing;
  }

  const answerBook = await AnswerBook.create({
    ...data,
    answerBookCode: cleanCode,
    studentCode: cleanStudentCode,
    pageCount: data.pageCount || 1,
    status: data.status || 'READY',
    processingStatus: data.processingStatus || 'PROCESSING',
    qualityStatus: data.qualityStatus || 'PENDING',
  });

  await answerBook.populate('examId', 'title subjectCode subjectName');

  await logAuditAction({
    actorId,
    action: 'ANSWER_BOOK_CREATED',
    entityType: 'AnswerBook',
    entityId: answerBook._id.toString(),
    metadata: {
      code: answerBook.answerBookCode,
      examId: answerBook.examId,
    },
  });

  emitToAll('answerbook.created', { answerBook });

  return answerBook;
}

export async function assignAnswerBookToExaminer(
  answerBookId: string,
  examinerId: string,
  actorId: string
): Promise<IAnswerBook> {
  const examiner = await User.findOne({
    _id: examinerId,
    role: 'EXAMINER',
    isActive: true,
  });

  if (!examiner) {
    const error: any = new Error('Active examiner not found');
    error.status = 404;
    error.code = 'EXAMINER_NOT_FOUND';
    throw error;
  }

  const answerBook = await AnswerBook.findById(answerBookId);
  if (!answerBook) {
    const error: any = new Error('Answer book not found');
    error.status = 404;
    error.code = 'ANSWER_BOOK_NOT_FOUND';
    throw error;
  }

  if (!['READY', 'RETURNED'].includes(answerBook.status)) {
    const error: any = new Error(
      `Cannot assign an answer book with status: ${answerBook.status}. Must be READY or RETURNED.`
    );
    error.status = 400;
    error.code = 'INVALID_STATUS_FOR_ASSIGNMENT';
    throw error;
  }

  if (answerBook.processingStatus !== 'READY_FOR_EVALUATION' && answerBook.status !== 'RETURNED') {
    const error: any = new Error(
      `Cannot assign answer book: Script is not finalized. Current processing status is '${answerBook.processingStatus}'. Must be READY_FOR_EVALUATION.`
    );
    error.status = 400;
    error.code = 'SCRIPT_NOT_READY_FOR_EVALUATION';
    throw error;
  }

  answerBook.assignedExaminerId = examiner._id;
  answerBook.status = 'ASSIGNED';
  await answerBook.save();

  await answerBook.populate('examId', 'title subjectCode subjectName');
  await answerBook.populate('assignedExaminerId', 'name email');

  await logAuditAction({
    actorId,
    action: 'ANSWER_BOOK_ASSIGNED',
    entityType: 'AnswerBook',
    entityId: answerBook._id.toString(),
    metadata: { examinerId, examinerName: examiner.name },
  });

  emitToAll('answerbook.assigned', { answerBook });
  emitToUser(examinerId, 'answerbook.assigned', { answerBook });

  return answerBook;
}

/**
 * Strict Answer Book finalization validation and state transition.
 * Enforces all integrity requirements before a script can become READY / READY_FOR_EVALUATION.
 */
export async function validateAndFinalizeAnswerBook(
  answerBookId: string,
  actor?: { id?: string; name?: string; role?: string }
): Promise<IAnswerBook> {
  // 1. AnswerBook must exist
  const answerBook = await AnswerBook.findById(answerBookId);
  if (!answerBook) {
    const error: any = new Error(`Answer book not found with id '${answerBookId}'`);
    error.status = 404;
    error.code = 'ANSWER_BOOK_NOT_FOUND';
    throw error;
  }

  // 2. Expected page count must be known and positive integer
  if (
    typeof answerBook.pageCount !== 'number' ||
    answerBook.pageCount <= 0 ||
    !Number.isInteger(answerBook.pageCount)
  ) {
    const error: any = new Error(
      `Cannot finalize script: Expected page count is unknown or invalid (${answerBook.pageCount}).`
    );
    error.status = 400;
    error.code = 'INVALID_EXPECTED_PAGE_COUNT';
    throw error;
  }

  // 3. Fetch all actual pages for this answer book in MongoDB
  const pages = await AnswerPage.find({ answerBookId: answerBook._id }).sort({ pageNumber: 1 });

  if (pages.length === 0) {
    const error: any = new Error(
      `Cannot finalize script '${answerBook.answerBookCode}': No answer pages exist in database.`
    );
    error.status = 400;
    error.code = 'NO_PAGES';
    throw error;
  }

  // 4. Actual pages in MongoDB must equal expected page count
  if (pages.length !== answerBook.pageCount) {
    const error: any = new Error(
      `Cannot finalize script '${answerBook.answerBookCode}': Page count mismatch. Expected ${answerBook.pageCount} page(s), but found ${pages.length} page(s) in database.`
    );
    error.status = 400;
    error.code = 'PAGE_COUNT_MISMATCH';
    throw error;
  }

  // 5. Pages must be numbered sequentially from 1 to N with no duplicate page numbers
  const seenPages = new Set<number>();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const expectedPageNum = i + 1;

    if (seenPages.has(page.pageNumber)) {
      const error: any = new Error(
        `Cannot finalize script '${answerBook.answerBookCode}': Duplicate page number ${page.pageNumber} detected.`
      );
      error.status = 400;
      error.code = 'DUPLICATE_PAGES';
      throw error;
    }
    seenPages.add(page.pageNumber);

    if (page.pageNumber !== expectedPageNum) {
      const error: any = new Error(
        `Cannot finalize script '${answerBook.answerBookCode}': Page sequence broken. Expected page ${expectedPageNum}, but found page ${page.pageNumber}.`
      );
      error.status = 400;
      error.code = 'INVALID_PAGE_SEQUENCE';
      throw error;
    }
  }

  // 6. Every expected page must contain valid Cloudinary media metadata
  for (const page of pages) {
    const cloudinary = page.cloudinary;
    if (
      !cloudinary ||
      !cloudinary.publicId ||
      typeof cloudinary.publicId !== 'string' ||
      cloudinary.publicId.trim() === ''
    ) {
      const error: any = new Error(
        `Cannot finalize script '${answerBook.answerBookCode}': Page ${page.pageNumber} is missing valid Cloudinary media metadata.`
      );
      error.status = 400;
      error.code = 'MISSING_MEDIA_METADATA';
      throw error;
    }
  }

  // 7. Quality status checks: Acceptable status required, no RESCAN_REQUIRED
  if (answerBook.qualityStatus === 'RESCAN_REQUIRED') {
    const error: any = new Error(
      `Cannot finalize script '${answerBook.answerBookCode}': Answer book is marked as RESCAN_REQUIRED.`
    );
    error.status = 400;
    error.code = 'RESCAN_REQUIRED';
    throw error;
  }

  const ACCEPTABLE_QUALITY_STATUSES: QualityStatus[] = ['PASSED', 'VERIFIED', 'READY'];
  for (const page of pages) {
    const qualityStatus = page.quality?.status;

    if (qualityStatus === 'RESCAN_REQUIRED') {
      const error: any = new Error(
        `Cannot finalize script '${answerBook.answerBookCode}': Page ${page.pageNumber} requires rescan due to quality/blur failure.`
      );
      error.status = 400;
      error.code = 'RESCAN_REQUIRED';
      throw error;
    }

    if (!qualityStatus || !ACCEPTABLE_QUALITY_STATUSES.includes(qualityStatus)) {
      const error: any = new Error(
        `Cannot finalize script '${answerBook.answerBookCode}': Page ${page.pageNumber} has unacceptable quality status '${qualityStatus || 'PENDING'}'. Expected one of: ${ACCEPTABLE_QUALITY_STATUSES.join(', ')}.`
      );
      error.status = 400;
      error.code = 'UNACCEPTABLE_QUALITY_STATUS';
      throw error;
    }
  }

  // 8. Processing status checks:
  // - No page may still be PROCESSING / OCR_PROCESSING / FINALIZING
  // - Every page must be in a completed state
  const IN_PROGRESS_STATUSES: ProcessingStatus[] = ['PROCESSING', 'OCR_PROCESSING', 'FINALIZING'];
  const COMPLETED_STATUSES: ProcessingStatus[] = ['COMPLETED', 'FINALIZED', 'READY_FOR_EVALUATION'];

  for (const page of pages) {
    if (IN_PROGRESS_STATUSES.includes(page.processingStatus)) {
      const error: any = new Error(
        `Cannot finalize script '${answerBook.answerBookCode}': Page ${page.pageNumber} is still processing (${page.processingStatus}).`
      );
      error.status = 400;
      error.code = 'PAGE_STILL_PROCESSING';
      throw error;
    }

    if (!COMPLETED_STATUSES.includes(page.processingStatus)) {
      const error: any = new Error(
        `Cannot finalize script '${answerBook.answerBookCode}': Page ${page.pageNumber} is in incomplete processing state '${page.processingStatus}'. Must be in a completed state.`
      );
      error.status = 400;
      error.code = 'PAGE_NOT_COMPLETED';
      throw error;
    }
  }

  // 9. All validations passed! Transition AnswerPages
  await AnswerPage.updateMany(
    { answerBookId: answerBook._id },
    { $set: { finalized: true, processingStatus: 'FINALIZED' } }
  );

  const previousProcessingStatus = answerBook.processingStatus;
  validateProcessingStateTransition(previousProcessingStatus, 'READY_FOR_EVALUATION');

  // Transition AnswerBook to READY / READY_FOR_EVALUATION
  answerBook.status = 'READY';
  answerBook.processingStatus = 'READY_FOR_EVALUATION';
  answerBook.qualityStatus = 'VERIFIED';
  await answerBook.save();

  await answerBook.populate('examId', 'title subjectCode subjectName maximumMarks');
  if (answerBook.assignedExaminerId) {
    await answerBook.populate('assignedExaminerId', 'name email');
  }

  // 10. Audit logs
  await logAuditAction({
    actorId: actor?.id,
    actorName: actor?.name || 'Scanning Service',
    actorRole: actor?.role || 'SCANNING_SERVICE',
    action: 'PROCESSING_STATUS_UPDATED',
    entityType: 'AnswerBook',
    entityId: answerBook._id.toString(),
    metadata: {
      previousStatus: previousProcessingStatus,
      newStatus: 'READY_FOR_EVALUATION',
      answerBookCode: answerBook.answerBookCode,
      pageCount: pages.length,
      timestamp: new Date().toISOString(),
    },
  });

  await logAuditAction({
    actorId: actor?.id,
    actorName: actor?.name || 'Scanning Service',
    actorRole: actor?.role || 'SCANNING_SERVICE',
    action: 'SCRIPT_FINALIZED',
    entityType: 'AnswerBook',
    entityId: answerBook._id.toString(),
    metadata: {
      answerBookCode: answerBook.answerBookCode,
      pageCount: pages.length,
    },
  });

  await logAuditAction({
    actorId: actor?.id,
    actorName: actor?.name || 'Scanning Service',
    actorRole: actor?.role || 'SCANNING_SERVICE',
    action: 'SCRIPT_READY_FOR_EVALUATION',
    entityType: 'AnswerBook',
    entityId: answerBook._id.toString(),
    metadata: {
      answerBookCode: answerBook.answerBookCode,
      pageCount: pages.length,
    },
  });

  // 11. Emit Socket.IO events
  emitToAll('script.finalized', { answerBook });
  emitToAll('answerbook.status.changed', { answerBook });

  return answerBook;
}

export async function updateExistingAnswerBook(
  id: string,
  data: Partial<IAnswerBook>,
  actorId: string
): Promise<IAnswerBook | null> {
  const current = await AnswerBook.findById(id);
  if (!current) return null;

  if (data.status && data.status !== current.status) {
    validateStateTransition(current.status, data.status);
  }

  const previousProcessingStatus = current.processingStatus;
  const isProcessingStatusChanged =
    Boolean(data.processingStatus) && data.processingStatus !== previousProcessingStatus;

  if (isProcessingStatusChanged) {
    validateProcessingStateTransition(previousProcessingStatus, data.processingStatus!);
  }

  const answerBook = await AnswerBook.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  })
    .populate('examId', 'title subjectCode subjectName')
    .populate('assignedExaminerId', 'name email');

  if (answerBook) {
    if (isProcessingStatusChanged) {
      await logAuditAction({
        actorId,
        action: 'PROCESSING_STATUS_UPDATED',
        entityType: 'AnswerBook',
        entityId: answerBook._id.toString(),
        metadata: {
          previousStatus: previousProcessingStatus,
          newStatus: data.processingStatus,
          answerBookCode: answerBook.answerBookCode,
          examId: answerBook.examId?._id?.toString() || answerBook.examId?.toString(),
          timestamp: new Date().toISOString(),
        },
      });
    }

    await logAuditAction({
      actorId,
      action: 'ANSWER_BOOK_UPDATED',
      entityType: 'AnswerBook',
      entityId: answerBook._id.toString(),
      metadata: data as Record<string, unknown>,
    });

    emitToAll('answerbook.status.changed', { answerBook });
    if (isProcessingStatusChanged) {
      emitToAll('script.processing.updated', { answerBook });
    }
  }

  return answerBook;
}
