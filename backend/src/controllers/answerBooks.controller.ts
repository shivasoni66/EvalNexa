import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import * as answerBooksService from '../services/answerBooks.service';
import {
  ingestAnswerBookData,
  updateScriptProcessingStatus,
} from '../services/ingestion.service';
import { AnswerBook, IQuestionPageMapping } from '../models/AnswerBook';
import { Evaluation } from '../models/Evaluation';
import { AnswerPage } from '../models/AnswerPage';
import {
  generateAuthorizedMediaUrl,
  uploadMediaBuffer,
  replaceMediaAsset,
  deleteMediaAsset,
  validateMediaFile,
  buildPagePublicId,
} from '../services/media.service';
import { logAuditAction } from '../services/audit.service';
import { emitToAll } from '../sockets';
import path from 'path';
import fs from 'fs';
import mongoose from 'mongoose';
import { config } from '../config';
import { areEntityIdsEqual } from '../utils/identity';

export async function getAnswerBooks(req: AuthRequest, res: Response): Promise<void> {
  try {
    const answerBooks = await answerBooksService.fetchAnswerBooks(
      {
        examId: req.query.examId as string,
        status: req.query.status as string,
      },
      req.user!.role,
      req.user!._id.toString()
    );
    res.json({ success: true, data: answerBooks });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch answer books',
      code: error.code || 'FETCH_ANSWER_BOOKS_ERROR',
    });
  }
}

export async function createAnswerBook(req: AuthRequest, res: Response): Promise<void> {
  try {
    const answerBook = await answerBooksService.createNewAnswerBook(
      req.body,
      req.user!._id.toString()
    );
    res.status(201).json({ success: true, data: answerBook });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to create answer book',
      code: error.code || 'CREATE_ANSWER_BOOK_ERROR',
    });
  }
}

export async function getAnswerBookById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await answerBooksService.fetchAnswerBookById(
      req.params.id,
      req.user!.role,
      req.user!._id.toString()
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to fetch answer book',
      code: error.code || 'FETCH_ANSWER_BOOK_ERROR',
    });
  }
}

export async function updateAnswerBook(req: AuthRequest, res: Response): Promise<void> {
  try {
    const answerBook = await answerBooksService.updateExistingAnswerBook(
      req.params.id,
      req.body,
      req.user!._id.toString()
    );
    if (!answerBook) {
      res.status(404).json({
        success: false,
        message: 'Answer book not found',
        code: 'NOT_FOUND',
      });
      return;
    }
    res.json({ success: true, data: answerBook });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to update answer book',
      code: error.code || 'UPDATE_ANSWER_BOOK_ERROR',
    });
  }
}

export async function assignAnswerBook(req: AuthRequest, res: Response): Promise<void> {
  try {
    const answerBook = await answerBooksService.assignAnswerBookToExaminer(
      req.params.id,
      req.body.examinerId,
      req.user!._id.toString()
    );
    res.json({ success: true, data: answerBook });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to assign answer book',
      code: error.code || 'ASSIGN_ANSWER_BOOK_ERROR',
    });
  }
}

export async function getExaminerAnswerBooks(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await answerBooksService.fetchExaminerAnswerBooks(
      req.user!._id.toString(),
      req.query.status as string
    );
    res.json({ success: true, data: result.answerBooks, stats: result.stats });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch examiner answer books',
      code: error.code || 'FETCH_EXAMINER_BOOKS_ERROR',
    });
  }
}

/**
 * Server-to-server digital script ingestion endpoint (Scanning/Recognition Service)
 * Protected by X-INGESTION-KEY
 */
export async function ingestAnswerBook(req: Request, res: Response): Promise<void> {
  try {
    let payload = req.body;

    // If metadata was provided as JSON string in multipart form-data
    if (payload.metadata && typeof payload.metadata === 'string') {
      try {
        const parsed = JSON.parse(payload.metadata);
        payload = { ...payload, ...parsed };
      } catch {
        res.status(400).json({ success: false, message: 'Invalid JSON in metadata field' });
        return;
      }
    }

    if (payload.pages && typeof payload.pages === 'string') {
      try {
        payload.pages = JSON.parse(payload.pages);
      } catch {
        res.status(400).json({ success: false, message: 'Invalid JSON in pages field' });
        return;
      }
    }

    if (!payload.examId || !payload.answerBookCode || !payload.studentCode) {
      res.status(400).json({
        success: false,
        message: 'Missing required ingestion fields: examId, answerBookCode, studentCode',
      });
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    const result = await ingestAnswerBookData(payload, files);

    res.status(200).json({
      success: true,
      message: 'Answer book and digital pages ingested successfully',
      data: {
        answerBook: result.answerBook,
        pages: result.pages.map((p) => ({
          pageNumber: p.pageNumber,
          ocr: p.ocr,
          quality: p.quality,
          processingStatus: p.processingStatus,
          finalized: p.finalized,
          cloudinary: {
            publicId: p.cloudinary.publicId,
            resourceType: p.cloudinary.resourceType,
            format: p.cloudinary.format,
          },
        })),
      },
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Ingestion failed',
      code: error.code || 'INGESTION_ERROR',
    });
  }
}

/**
 * Server-to-server processing status webhook endpoint
 * Protected by X-INGESTION-KEY
 */
export async function updateProcessingStatus(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { status, qualityStatus } = req.body;

    if (!status) {
      res.status(400).json({ success: false, message: 'status field is required' });
      return;
    }

    const answerBook = await updateScriptProcessingStatus(id, status, qualityStatus);

    res.json({
      success: true,
      message: 'Processing status updated successfully',
      data: answerBook,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to update processing status',
      code: error.code || 'STATUS_UPDATE_ERROR',
    });
  }
}

/**
 * Lists page metadata for an answer book
 * Authenticated; strictly verifies role and examiner assignment
 */
export async function getAnswerBookPages(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    const userRole = req.user!.role;
    const userId = req.user!._id.toString();

    // Examiners can only see pages of answer books assigned to them
    if (userRole === 'EXAMINER') {
      if (!areEntityIdsEqual(answerBook.assignedExaminerId, userId)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: Answer book is not assigned to you',
          code: 'UNAUTHORIZED_EXAMINER_ACCESS',
        });
        return;
      }
    }

    const pages = await AnswerPage.find({ answerBookId: answerBook._id })
      .select('pageNumber ocr quality processingStatus finalized createdAt')
      .sort({ pageNumber: 1 });

    res.json({
      success: true,
      data: {
        answerBookId: answerBook._id,
        answerBookCode: answerBook.answerBookCode,
        pageCount: answerBook.pageCount,
        processingStatus: answerBook.processingStatus,
        qualityStatus: answerBook.qualityStatus,
        pages,
      },
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to fetch answer book pages',
    });
  }
}

/**
 * Secure media viewing endpoint:
 * Authenticates user, verifies RBAC & assignment, generates cryptographically signed Cloudinary URL with expiration
 */
export async function getAnswerBookPage(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);
    if (isNaN(pageNum) || pageNum < 1) {
      res.status(400).json({ success: false, message: 'Invalid page number' });
      return;
    }

    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    const userRole = req.user!.role;
    const userId = req.user!._id.toString();

    // Strict access control: examiner cannot view another examiner's answer book
    if (userRole === 'EXAMINER') {
      if (!areEntityIdsEqual(answerBook.assignedExaminerId, userId)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: Answer book is not assigned to you',
          code: 'UNAUTHORIZED_EXAMINER_ACCESS',
        });
        return;
      }
    }

    const page = await AnswerPage.findOne({
      answerBookId: answerBook._id,
      pageNumber: pageNum,
    });

    if (!page) {
      res.status(404).json({
        success: false,
        message: `Page ${pageNum} not found for this answer book`,
        code: 'PAGE_NOT_FOUND',
      });
      return;
    }

    // Determine delivery URL (Cloudinary signed URL or local image streamer)
    let deliveryUrl = page.cloudinary?.secureUrl;
    const isCloudinaryActive = Boolean(
      config.cloudinary.cloudName &&
      config.cloudinary.cloudName !== 'Root' &&
      config.cloudinary.apiKey &&
      config.cloudinary.apiSecret
    );

    if (isCloudinaryActive && page.cloudinary?.publicId && !page.cloudinary.publicId.startsWith('local:')) {
      try {
        const signedMedia = generateAuthorizedMediaUrl(page.cloudinary.publicId, {
          resourceType: page.cloudinary.resourceType,
          deliveryType: page.cloudinary.deliveryType,
          format: page.cloudinary.format,
          expiresInSeconds: 3600,
        });
        deliveryUrl = signedMedia.secureUrl;
      } catch {
        // Fallback to local
      }
    }

    if (!deliveryUrl || deliveryUrl.includes('/Root/')) {
      deliveryUrl = `/api/answer-books/${answerBook._id}/pages/${pageNum}/image`;
    }

    // Audit log media access
    await logAuditAction({
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'MEDIA_ACCESSED',
      entityType: 'AnswerPage',
      entityId: page._id.toString(),
      metadata: {
        answerBookId: answerBook._id.toString(),
        answerBookCode: answerBook.answerBookCode,
        pageNumber: page.pageNumber,
      },
    });

    res.json({
      success: true,
      data: {
        pageNumber: page.pageNumber,
        secureUrl: deliveryUrl,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        ocr: page.ocr,
        quality: page.quality,
        processingStatus: page.processingStatus,
        finalized: page.finalized,
        width: page.cloudinary?.width,
        height: page.cloudinary?.height,
        format: page.cloudinary?.format || 'jpg',
      },
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to retrieve answer page',
    });
  }
}

/**
 * Serves real scanned page images from local disk.
 * Enables zero-external-dependency image delivery for browser <img> tags.
 */
export async function getAnswerBookPageImage(req: Request, res: Response): Promise<void> {
  try {
    const { id, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);
    if (isNaN(pageNum) || pageNum < 1) {
      res.status(400).json({ success: false, message: 'Invalid page number' });
      return;
    }

    const answerBook = await AnswerBook.findOne({
      $or: [
        { _id: mongoose.isValidObjectId(id) ? id : null },
        { answerBookCode: id }
      ]
    });

    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    const pageFileName = `page-${String(pageNum).padStart(4, '0')}.jpg`;
    const localFilePath = path.join(
      process.cwd(),
      'uploads',
      'answer-books',
      answerBook.answerBookCode,
      'pages',
      pageFileName
    );

    if (!fs.existsSync(localFilePath)) {
      res.status(404).json({ success: false, message: `Page ${pageNum} image not found on server` });
      return;
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(localFilePath).pipe(res);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Updates question-to-page mappings for an answer book.
 * Allows examiner/moderator to correct or customize which pages belong to which question.
 */
export async function updateQuestionPageMapping(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { questionNumber, pages } = req.body;

    if (!questionNumber || !Array.isArray(pages) || pages.length === 0) {
      res.status(400).json({ success: false, message: 'Invalid questionNumber or pages array' });
      return;
    }

    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    if (req.user?.role === 'EXAMINER') {
      const assignedExaminerId = answerBook.assignedExaminerId;
      if (!assignedExaminerId || !areEntityIdsEqual(assignedExaminerId, req.user._id)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: You are not assigned to this answer book',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    if (!answerBook.questionPageMapping) {
      answerBook.questionPageMapping = [];
    }

    const existingIdx = answerBook.questionPageMapping.findIndex(
      (m: IQuestionPageMapping) => m.questionNumber === Number(questionNumber)
    );

    if (existingIdx >= 0) {
      answerBook.questionPageMapping[existingIdx].pages = pages.map(Number);
      answerBook.questionPageMapping[existingIdx].verified = true;
      answerBook.questionPageMapping[existingIdx].source = 'EXAMINER_VERIFIED';
      answerBook.questionPageMapping[existingIdx].mappingSource = 'EXAMINER_VERIFIED';
      answerBook.questionPageMapping[existingIdx].examinerVerified = true;
      answerBook.questionPageMapping[existingIdx].needsHumanReview = false;
      answerBook.questionPageMapping[existingIdx].reason = 'Manually verified by examiner';
      answerBook.questionPageMapping[existingIdx].aiSuggestedPages = undefined;
    } else {
      answerBook.questionPageMapping.push({
        questionNumber: Number(questionNumber),
        pages: pages.map(Number),
        verified: true,
        source: 'EXAMINER_VERIFIED',
        mappingSource: 'EXAMINER_VERIFIED',
        examinerVerified: true,
        needsHumanReview: false,
        reason: 'Manually verified by examiner',
      });
    }

    await answerBook.save();

    // Invalidate affected stale AI analysis for this question
    await Evaluation.updateMany(
      { answerBookId: answerBook._id, 'questionMarks.questionNumber': Number(questionNumber) },
      {
        $set: {
          'questionMarks.$.aiAnalysis': null,
          'questionMarks.$.aiStatus': 'IDLE',
          'questionMarks.$.aiError': null,
        },
      }
    );

    // Emit real-time mapping update to all connected examiner desks
    emitToAll('answerbook.mapping.updated', {
      answerBookId: answerBook._id.toString(),
      mappings: answerBook.questionPageMapping,
      updatedQuestionNumber: Number(questionNumber),
    });

    res.json({
      success: true,
      message: `Mapping updated for Question ${questionNumber}`,
      data: answerBook.questionPageMapping,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
}

export const updateQuestionMapping = updateQuestionPageMapping;

/**
 * Accepts an AI-suggested page mapping for a specific question
 */
export async function acceptAiPageMapping(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, questionNumber } = req.params;
    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    if (req.user?.role === 'EXAMINER') {
      const assignedExaminerId = answerBook.assignedExaminerId;
      if (!assignedExaminerId || !areEntityIdsEqual(assignedExaminerId, req.user._id)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: You are not assigned to this answer book',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    const qNum = parseInt(questionNumber, 10);
    const m = answerBook.questionPageMapping?.find((x: IQuestionPageMapping) => x.questionNumber === qNum);
    if (!m) {
      res.status(404).json({ success: false, message: 'Mapping not found for this question' });
      return;
    }

    if (m.aiSuggestedPages && m.aiSuggestedPages.length > 0) {
      m.pages = m.aiSuggestedPages;
      m.confidence = m.aiConfidence || 1.0;
      m.reason = m.aiReason || 'Examiner accepted AI page mapping';
      m.verified = true;
      m.source = 'EXAMINER_VERIFIED';
      m.mappingSource = 'EXAMINER_VERIFIED';
      m.examinerVerified = true;
      m.aiSuggestedPages = undefined;
      m.aiConfidence = undefined;
      m.aiReason = undefined;
      m.needsHumanReview = false;
      await answerBook.save();

      emitToAll('answerbook.mapping.updated', {
        answerBookId: answerBook._id.toString(),
        mappings: answerBook.questionPageMapping,
        updatedQuestionNumber: qNum,
      });
    }

    res.json({
      success: true,
      message: `Accepted AI mapping for Question ${questionNumber}`,
      data: answerBook.questionPageMapping,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Dismisses an AI-suggested page mapping, keeping the existing manual mapping
 */
export async function dismissAiPageMapping(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, questionNumber } = req.params;
    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    if (req.user?.role === 'EXAMINER') {
      const assignedExaminerId = answerBook.assignedExaminerId;
      if (!assignedExaminerId || !areEntityIdsEqual(assignedExaminerId, req.user._id)) {
        res.status(403).json({
          success: false,
          message: 'Access denied: You are not assigned to this answer book',
          code: 'ACCESS_DENIED',
        });
        return;
      }
    }

    const qNum = parseInt(questionNumber, 10);
    const m = answerBook.questionPageMapping?.find((x: IQuestionPageMapping) => x.questionNumber === qNum);
    if (m) {
      m.aiSuggestedPages = undefined;
      m.aiConfidence = undefined;
      m.aiReason = undefined;
      m.verified = true;
      m.source = 'EXAMINER_VERIFIED';
      m.needsHumanReview = false;
      await answerBook.save();
    }

    res.json({
      success: true,
      message: `Kept existing mapping for Question ${questionNumber}`,
      data: answerBook.questionPageMapping,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Replaces an existing page's media safely (Admin only)
 */
export async function replaceAnswerBookPage(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);
    const file = req.file;

    if (!file) {
      res.status(400).json({ success: false, message: 'No replacement file uploaded' });
      return;
    }

    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    const page = await AnswerPage.findOne({ answerBookId: answerBook._id, pageNumber: pageNum });
    if (!page) {
      res.status(404).json({ success: false, message: `Page ${pageNum} not found` });
      return;
    }

    const validation = validateMediaFile(file);
    if (!validation.isValid) {
      res.status(400).json({ success: false, message: validation.error });
      return;
    }

    const newPublicId = buildPagePublicId(
      answerBook.examId.toString(),
      answerBook._id.toString(),
      pageNum
    );

    // Replace in Cloudinary safely
    const newAsset = await replaceMediaAsset(page.cloudinary.publicId, file.buffer, {
      newPublicId,
      resourceType: file.mimetype === 'application/pdf' ? 'auto' : 'image',
    });

    page.cloudinary = {
      publicId: newAsset.publicId,
      assetId: newAsset.assetId,
      resourceType: newAsset.resourceType,
      deliveryType: newAsset.deliveryType,
      format: newAsset.format,
      bytes: newAsset.bytes,
      width: newAsset.width,
      height: newAsset.height,
    };

    if (req.body.ocrText !== undefined) {
      page.ocr = {
        text: req.body.ocrText,
        confidence: req.body.ocrConfidence ? parseFloat(req.body.ocrConfidence) : null,
        language: req.body.ocrLanguage || 'en',
      };
    }

    if (req.body.qualityStatus) {
      page.quality = {
        status: req.body.qualityStatus,
        score: req.body.qualityScore ? parseFloat(req.body.qualityScore) : null,
        reviewedAt: new Date(),
        reviewedBy: req.user!.name,
      };
    }

    await page.save();

    await logAuditAction({
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'PAGE_REPLACED',
      entityType: 'AnswerPage',
      entityId: page._id.toString(),
      metadata: {
        answerBookId: answerBook._id.toString(),
        pageNumber: pageNum,
        newPublicId: newAsset.publicId,
      },
    });

    await logAuditAction({
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'MEDIA_REPLACED',
      entityType: 'AnswerPage',
      entityId: page._id.toString(),
      metadata: {
        answerBookId: answerBook._id.toString(),
        pageNumber: pageNum,
        publicId: newAsset.publicId,
      },
    });

    emitToAll('page.updated', {
      answerBookId: answerBook._id,
      pageNumber: pageNum,
      pageId: page._id,
    });

    res.json({
      success: true,
      message: `Page ${pageNum} replaced successfully`,
      data: page,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to replace page',
    });
  }
}

/**
 * Deletes an answer page and associated Cloudinary asset (Admin only)
 */
export async function deleteAnswerBookPage(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);

    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    const page = await AnswerPage.findOne({ answerBookId: answerBook._id, pageNumber: pageNum });
    if (!page) {
      res.status(404).json({ success: false, message: `Page ${pageNum} not found` });
      return;
    }

    // Delete Cloudinary asset
    await deleteMediaAsset(page.cloudinary.publicId, page.cloudinary.resourceType as any);

    // Delete AnswerPage
    await AnswerPage.deleteOne({ _id: page._id });

    // Recalculate page count
    const remainingCount = await AnswerPage.countDocuments({ answerBookId: answerBook._id });
    answerBook.pageCount = remainingCount;
    await answerBook.save();

    await logAuditAction({
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'PAGE_DELETED',
      entityType: 'AnswerPage',
      entityId: page._id.toString(),
      metadata: {
        answerBookId: answerBook._id.toString(),
        pageNumber: pageNum,
      },
    });

    await logAuditAction({
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'MEDIA_DELETED',
      entityType: 'AnswerPage',
      entityId: page._id.toString(),
      metadata: {
        answerBookId: answerBook._id.toString(),
        pageNumber: pageNum,
        publicId: page.cloudinary.publicId,
      },
    });

    emitToAll('page.deleted', {
      answerBookId: answerBook._id,
      pageNumber: pageNum,
    });

    res.json({
      success: true,
      message: `Page ${pageNum} deleted successfully`,
    });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to delete page',
    });
  }
}

/**
 * Uploads/adds a new page to an answer book directly to Cloudinary (Admin only)
 */
export async function addAnswerBookPage(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const file = req.file;

    if (!file) {
      res.status(400).json({ success: false, message: 'No media file provided' });
      return;
    }

    const answerBook = await AnswerBook.findById(id);
    if (!answerBook) {
      res.status(404).json({ success: false, message: 'Answer book not found' });
      return;
    }

    const pageNum = parseInt(req.body.pageNumber || req.params.pageNumber, 10) || 1;

    const validation = validateMediaFile(file);
    if (!validation.isValid) {
      res.status(400).json({ success: false, message: validation.error });
      return;
    }

    const publicId = buildPagePublicId(
      answerBook.examId.toString(),
      answerBook._id.toString(),
      pageNum
    );

    const asset = await uploadMediaBuffer(file.buffer, {
      publicId,
      resourceType: file.mimetype === 'application/pdf' ? 'auto' : 'image',
    });

    const page = await AnswerPage.findOneAndUpdate(
      { answerBookId: answerBook._id, pageNumber: pageNum },
      {
        answerBookId: answerBook._id,
        examId: answerBook.examId,
        pageNumber: pageNum,
        cloudinary: {
          publicId: asset.publicId,
          assetId: asset.assetId,
          resourceType: asset.resourceType,
          deliveryType: asset.deliveryType,
          format: asset.format,
          bytes: asset.bytes,
          width: asset.width,
          height: asset.height,
        },
        ocr: {
          text: req.body.ocrText || '',
          confidence: req.body.ocrConfidence ? parseFloat(req.body.ocrConfidence) : null,
          language: req.body.ocrLanguage || 'en',
        },
        quality: {
          status: req.body.qualityStatus || 'PASSED',
          score: req.body.qualityScore ? parseFloat(req.body.qualityScore) : null,
          reviewedAt: new Date(),
          reviewedBy: req.user!.name,
        },
        processingStatus: 'COMPLETED',
        finalized: true,
      },
      { upsert: true, new: true }
    );

    // Update answerBook pageCount if needed
    if (pageNum > answerBook.pageCount) {
      answerBook.pageCount = pageNum;
      await answerBook.save();
    }

    await logAuditAction({
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'PAGE_UPLOADED',
      entityType: 'AnswerPage',
      entityId: page._id.toString(),
      metadata: {
        answerBookId: answerBook._id.toString(),
        pageNumber: pageNum,
        publicId: asset.publicId,
      },
    });

    emitToAll('page.uploaded', {
      answerBookId: answerBook._id,
      pageNumber: pageNum,
      pageId: page._id,
    });

    res.status(201).json({
      success: true,
      message: `Page ${pageNum} uploaded successfully`,
      data: page,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload page',
    });
  }
}

/**
 * Strict finalization of an AnswerBook (Admin only).
 * Performs thorough validation: page count, sequential 1..N, valid Cloudinary metadata,
 * acceptable quality, no rescan required, and completed status.
 */
export async function finalizeAnswerBookController(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const answerBook = await answerBooksService.validateAndFinalizeAnswerBook(id, {
      id: req.user!._id.toString(),
      name: req.user!.name,
      role: req.user!.role,
    });

    res.json({
      success: true,
      message: 'Answer book validated and finalized successfully',
      data: answerBook,
    });
  } catch (error: any) {
    const status = error.status || 400;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to finalize answer book',
      code: error.code || 'FINALIZATION_ERROR',
    });
  }
}
