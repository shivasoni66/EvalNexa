import { Router } from 'express';
import {
  uploadQuestionPaper,
  getQuestionPaperById,
  getAnswerBookQuestionPaper,
  verifyQuestionPaper,
  attachQuestionPaperToAnswerBook,
} from '../controllers/questionPapers.controller';
import { authenticate, authorize } from '../middleware/auth';
import { uploadMedia } from '../middleware/upload';

const router = Router();

router.use(authenticate);

// Upload and process question paper
router.post(
  '/upload',
  authorize('ADMIN', 'EXAMINER'),
  uploadMedia.single('file'),
  uploadQuestionPaper
);

// Review and verification
router.get('/:id', authorize('ADMIN', 'EXAMINER', 'MODERATOR'), getQuestionPaperById);
router.post('/:id/verify', authorize('ADMIN', 'EXAMINER'), verifyQuestionPaper);
router.put('/:id/verify', authorize('ADMIN', 'EXAMINER'), verifyQuestionPaper);

// AnswerBook question paper operations
router.get(
  '/answer-book/:answerBookId',
  authorize('ADMIN', 'EXAMINER', 'MODERATOR'),
  getAnswerBookQuestionPaper
);
router.post(
  '/answer-book/:answerBookId/attach',
  authorize('ADMIN', 'EXAMINER'),
  attachQuestionPaperToAnswerBook
);

export default router;
