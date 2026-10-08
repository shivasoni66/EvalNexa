import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
  uploadAndProcessQuestionPaper,
  verifyQuestionPaperQuestions,
  getQuestionPaperForAnswerBook,
} from '../services/questionPapers.service';
import { QuestionPaper } from '../models/QuestionPaper';
import { AnswerBook } from '../models/AnswerBook';
import { areEntityIdsEqual } from '../utils/identity';

export async function uploadQuestionPaper(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No file uploaded', code: 'NO_FILE' });
      return;
    }

    const { examId, answerBookId, paperSet } = req.body;
    if (!examId) {
      res.status(400).json({ success: false, message: 'examId is required', code: 'MISSING_EXAM_ID' });
      return;
    }

    const questionPaper = await uploadAndProcessQuestionPaper({
      file: {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        size: req.file.size,
        originalname: req.file.originalname,
      },
      examId,
      answerBookId,
      paperSet,
      userId: req.user!._id.toString(),
      userRole: req.user!.role,
    });

    res.status(201).json({
      success: true,
      message: 'Question paper uploaded and processed successfully',
      data: questionPaper,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to upload question paper',
      code: error.code || 'UPLOAD_ERROR',
    });
  }
}

export async function getQuestionPaperById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const questionPaper = await QuestionPaper.findById(req.params.id);
    if (!questionPaper) {
      res.status(404).json({ success: false, message: 'Question paper not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ success: true, data: questionPaper });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch question paper',
      code: 'FETCH_ERROR',
    });
  }
}

export async function getAnswerBookQuestionPaper(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { answerBookId } = req.params;
    const answerBook = await AnswerBook.findById(answerBookId);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found', code: 'NOT_FOUND' });
      return;
    }

    // RBAC check: Examiner must be assigned
    if (req.user!.role === 'EXAMINER') {
      const assigned = answerBook.assignedExaminerId;
      if (!assigned || !areEntityIdsEqual(assigned, req.user!._id)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: You are not assigned to this answer book',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    const questionPaper = await getQuestionPaperForAnswerBook(answerBookId);
    res.json({ success: true, data: questionPaper });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch question paper for answer book',
      code: 'FETCH_ERROR',
    });
  }
}

export async function verifyQuestionPaper(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { questions, answerBookId } = req.body;

    const updated = await verifyQuestionPaperQuestions(
      id,
      questions,
      req.user!._id.toString(),
      req.user!.role,
      answerBookId
    );

    res.json({
      success: true,
      message: 'Question paper verified successfully',
      data: updated,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to verify question paper',
      code: error.code || 'VERIFY_ERROR',
    });
  }
}

export async function attachQuestionPaperToAnswerBook(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { answerBookId } = req.params;
    const { questionPaperId } = req.body;

    const answerBook = await AnswerBook.findById(answerBookId);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found', code: 'NOT_FOUND' });
      return;
    }

    if (req.user!.role === 'EXAMINER') {
      const assigned = answerBook.assignedExaminerId;
      if (!assigned || !areEntityIdsEqual(assigned, req.user!._id)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: You are not assigned to this answer book',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    const questionPaper = await QuestionPaper.findById(questionPaperId);
    if (!questionPaper) {
      res.status(404).json({ success: false, message: 'Question paper not found', code: 'NOT_FOUND' });
      return;
    }

    answerBook.questionPaperId = questionPaper._id;
    answerBook.paperSet = questionPaper.paperSet;
    await answerBook.save();

    res.json({
      success: true,
      message: 'Question paper attached to answer book successfully',
      data: { answerBook, questionPaper },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to attach question paper',
      code: 'ATTACH_ERROR',
    });
  }
}
