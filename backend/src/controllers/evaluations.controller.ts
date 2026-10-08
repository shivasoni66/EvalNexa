import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import * as evaluationsService from '../services/evaluations.service';

export async function getEvaluations(req: AuthRequest, res: Response): Promise<void> {
  try {
    const evaluations = await evaluationsService.fetchEvaluations(
      { status: req.query.status as string },
      req.user!.role,
      req.user!._id.toString()
    );
    res.json({ success: true, data: evaluations });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch evaluations',
      code: error.code || 'FETCH_EVALUATIONS_ERROR',
    });
  }
}

export async function getEvaluationById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const evaluation = await evaluationsService.fetchEvaluationById(
      req.params.id,
      req.user!.role,
      req.user!._id.toString()
    );
    res.json({ success: true, data: evaluation });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to fetch evaluation',
      code: error.code || 'FETCH_EVALUATION_ERROR',
    });
  }
}

export async function startEvaluation(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { evaluation } = await evaluationsService.beginEvaluation(
      req.params.id,
      req.user!._id.toString()
    );
    res.json({ success: true, data: evaluation });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to start evaluation',
      code: error.code || 'START_EVALUATION_ERROR',
    });
  }
}

export async function updateEvaluation(req: AuthRequest, res: Response): Promise<void> {
  try {
    const evaluation = await evaluationsService.updateEvaluationMarks(
      req.params.id,
      req.body,
      req.user!._id.toString()
    );
    res.json({ success: true, data: evaluation });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to update evaluation',
      code: error.code || 'UPDATE_EVALUATION_ERROR',
    });
  }
}

export async function submitEvaluation(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { evaluation, summary } = await evaluationsService.submitEvaluationFinal(
      req.params.id,
      req.body,
      req.user!._id.toString()
    );
    res.json({ success: true, data: evaluation, summary });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to submit evaluation',
      code: error.code || 'SUBMIT_EVALUATION_ERROR',
      details: error.details,
    });
  }
}

export async function getAIEvaluationSuggestion(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, evaluationId, questionNumber } = req.params;
    const targetEvaluationId = evaluationId || id;
    const { pageNumber, force, forceRefresh } = req.query;
    const isForce =
      force === 'true' ||
      forceRefresh === 'true' ||
      req.body?.force === true ||
      req.body?.forceRefresh === true;

    const qNum = parseInt((questionNumber || req.body?.questionNumber) as string, 10);

    const result = await evaluationsService.requestAISuggestionForQuestion(
      targetEvaluationId,
      qNum,
      {
        pageNumber: pageNumber ? parseInt(pageNumber as string, 10) : undefined,
        forceRefresh: isForce,
        userRole: req.user!.role,
        userId: req.user!._id.toString(),
        userName: req.user!.name,
        answerBookId: req.body?.answerBookId,
        questionPaperId: req.body?.questionPaperId,
        questionId: req.body?.questionId,
      }
    );

    res.json({
      success: true,
      message: result.cached
        ? 'Retrieved existing AI analysis suggestion'
        : 'Generated new AI analysis suggestion',
      data: result.aiAnalysis,
      cached: result.cached,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to generate AI evaluation suggestion',
      code: error.code || 'AI_EVALUATION_ERROR',
    });
  }
}

export async function startFullAnalysisController(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, evaluationId } = req.params;
    const targetEvaluationId = evaluationId || id;
    const { forceRefresh } = req.body || {};

    const { startFullAnswerBookAnalysis } = await import('../services/fullAnalysis.service');
    const result = await startFullAnswerBookAnalysis(targetEvaluationId, {
      userId: req.user!._id.toString(),
      userRole: req.user!.role,
      userName: req.user!.name,
      forceRefresh: Boolean(forceRefresh),
    });

    res.status(202).json({
      success: true,
      message: result.message,
      data: {
        jobId: result.jobId,
        status: result.status,
        job: result.evaluation?.fullAnalysisJob,
      },
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to start full answer book AI analysis',
      code: error.code || 'FULL_ANALYSIS_ERROR',
    });
  }
}

export async function getFullAnalysisStatusController(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, evaluationId } = req.params;
    const targetEvaluationId = evaluationId || id;

    const { getFullAnalysisStatus } = await import('../services/fullAnalysis.service');
    const data = await getFullAnalysisStatus(targetEvaluationId);
    res.json({
      success: true,
      data,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to retrieve analysis status',
      code: error.code || 'GET_STATUS_ERROR',
    });
  }
}

export async function cancelFullAnalysisController(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, evaluationId } = req.params;
    const targetEvaluationId = evaluationId || id;

    const { cancelFullAnalysis } = await import('../services/fullAnalysis.service');
    const result = await cancelFullAnalysis(targetEvaluationId, {
      userId: req.user!._id.toString(),
      userRole: req.user!.role,
    });
    res.json({ success: true, message: result.message });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to cancel analysis job',
    });
  }
}

export async function retryQuestionAnalysisController(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, evaluationId, questionNumber } = req.params;
    const targetEvaluationId = evaluationId || id;

    const { retryQuestionAnalysis } = await import('../services/fullAnalysis.service');
    const result = await retryQuestionAnalysis(
      targetEvaluationId,
      parseInt(questionNumber, 10),
      {
        userId: req.user!._id.toString(),
        userRole: req.user!.role,
        userName: req.user!.name,
      }
    );

    res.json({
      success: true,
      message: `Retried AI evaluation for Question ${questionNumber}`,
      data: result.data,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to retry question evaluation',
      code: error.code || 'RETRY_ERROR',
    });
  }
}

export async function markQuestionReviewedController(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, questionNumber } = req.params;
    const qNum = parseInt(questionNumber, 10);
    if (isNaN(qNum)) {
      res.status(400).json({ success: false, message: 'Invalid question number' });
      return;
    }

    const evaluation = await evaluationsService.markQuestionReviewed(
      id,
      qNum,
      req.user!._id.toString()
    );

    res.json({
      success: true,
      message: `Question Q${qNum} marked as reviewed`,
      data: evaluation.questionMarks.find((qm) => qm.questionNumber === qNum),
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to mark question reviewed',
      code: error.code || 'REVIEW_ERROR',
    });
  }
}

