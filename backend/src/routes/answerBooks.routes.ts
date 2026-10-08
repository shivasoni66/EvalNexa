import { Router } from 'express';
import {
  getAnswerBooks,
  createAnswerBook,
  getAnswerBookById,
  updateAnswerBook,
  assignAnswerBook,
  finalizeAnswerBookController,
  getExaminerAnswerBooks,
  ingestAnswerBook,
  updateProcessingStatus,
  getAnswerBookPages,
  getAnswerBookPage,
  addAnswerBookPage,
  replaceAnswerBookPage,
  deleteAnswerBookPage,
  updateQuestionPageMapping,
  acceptAiPageMapping,
  dismissAiPageMapping,
} from '../controllers/answerBooks.controller';
import { authenticate, authorize } from '../middleware/auth';
import { requireIngestionKey, ingestionRateLimiter } from '../middleware/ingestionAuth';
import { uploadMedia } from '../middleware/upload';
import { validate } from '../middleware/validate';
import { createAnswerBookSchema, assignAnswerBookSchema } from '../validators/schemas';

const router = Router();

// ============================================================
// Server-to-Server Ingestion Webhooks (Scanning/Recognition Service)
// Protected by X-INGESTION-KEY & Rate Limiting (No frontend JWT)
// ============================================================
router.post(
  '/ingest',
  ingestionRateLimiter,
  requireIngestionKey,
  uploadMedia.any(),
  ingestAnswerBook
);

router.patch(
  '/:id/processing-status',
  ingestionRateLimiter,
  requireIngestionKey,
  updateProcessingStatus
);

// ============================================================
// Authenticated User Endpoints (JWT Required)
// ============================================================
router.use(authenticate);

// Answer book listings
router.get('/my', authorize('EXAMINER'), getExaminerAnswerBooks);
router.get('/', authorize('ADMIN', 'MODERATOR', 'EXAMINER'), getAnswerBooks);
router.post('/', authorize('ADMIN'), validate(createAnswerBookSchema), createAnswerBook);
router.get('/:id', getAnswerBookById);
router.patch('/:id', authorize('ADMIN'), updateAnswerBook);
router.patch('/:id/question-mapping', authorize('ADMIN', 'EXAMINER'), updateQuestionPageMapping);
router.post(
  '/:id/questions/:questionNumber/accept-ai-mapping',
  authorize('ADMIN', 'EXAMINER'),
  acceptAiPageMapping
);
router.post(
  '/:id/questions/:questionNumber/dismiss-ai-mapping',
  authorize('ADMIN', 'EXAMINER'),
  dismissAiPageMapping
);
router.post('/:id/assign', authorize('ADMIN'), validate(assignAnswerBookSchema), assignAnswerBook);
router.post('/:id/finalize', authorize('ADMIN'), finalizeAnswerBookController);

// Digital Script Pages & Media
router.get('/:id/pages', getAnswerBookPages);
router.get('/:id/pages/:pageNumber', getAnswerBookPage);

// Media management (Admin only)
router.post(
  '/:id/pages',
  authorize('ADMIN'),
  uploadMedia.single('file'),
  addAnswerBookPage
);
router.post(
  '/:id/pages/:pageNumber/replace',
  authorize('ADMIN'),
  uploadMedia.single('file'),
  replaceAnswerBookPage
);
router.delete(
  '/:id/pages/:pageNumber',
  authorize('ADMIN'),
  deleteAnswerBookPage
);

export default router;
