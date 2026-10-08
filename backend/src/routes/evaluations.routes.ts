import { Router } from 'express';
import {
  getEvaluations,
  getEvaluationById,
  startEvaluation,
  updateEvaluation,
  submitEvaluation,
  getAIEvaluationSuggestion,
  startFullAnalysisController,
  getFullAnalysisStatusController,
  cancelFullAnalysisController,
  retryQuestionAnalysisController,
  markQuestionReviewedController,
} from '../controllers/evaluations.controller';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateEvaluationSchema, submitEvaluationSchema } from '../validators/schemas';
import { aiAssistantLimiter } from '../middleware/rateLimiter';

const router = Router();

router.use(authenticate);

router.get('/', authorize('ADMIN', 'MODERATOR', 'EXAMINER'), getEvaluations);
router.get('/:id', authorize('ADMIN', 'MODERATOR', 'EXAMINER'), getEvaluationById);
router.post('/:id/start', authorize('EXAMINER'), startEvaluation);
router.patch('/:id', authorize('EXAMINER'), validate(updateEvaluationSchema), updateEvaluation);
router.post('/:id/submit', authorize('EXAMINER'), validate(submitEvaluationSchema), submitEvaluation);

// AI-Assisted Question Evaluation Copilot (with rate limiting and RBAC protection)
router.get(
  '/:id/questions/:questionNumber/suggest',
  aiAssistantLimiter,
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  getAIEvaluationSuggestion
);
router.post(
  '/:id/questions/:questionNumber/suggest',
  aiAssistantLimiter,
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  getAIEvaluationSuggestion
);
router.post(
  '/:id/questions/:questionNumber/ai-suggest',
  aiAssistantLimiter,
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  getAIEvaluationSuggestion
);
router.post(
  '/:evaluationId/questions/:questionNumber/ai-suggest',
  aiAssistantLimiter,
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  getAIEvaluationSuggestion
);

// One-Click Full Answer Book AI Analysis (Asynchronous background processing)
router.post(
  '/:id/ai/full-analysis',
  aiAssistantLimiter,
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  startFullAnalysisController
);
router.get(
  '/:id/ai/full-analysis',
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  getFullAnalysisStatusController
);
router.get(
  '/:id/ai/full-analysis/status',
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  getFullAnalysisStatusController
);
router.post(
  '/:id/ai/full-analysis/cancel',
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  cancelFullAnalysisController
);
router.post(
  '/:id/ai/questions/:questionNumber/retry',
  aiAssistantLimiter,
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  retryQuestionAnalysisController
);
router.post(
  '/:id/questions/:questionNumber/review',
  authorize('EXAMINER', 'MODERATOR', 'ADMIN'),
  markQuestionReviewedController
);

export default router;
