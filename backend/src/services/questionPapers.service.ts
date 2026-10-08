import mongoose from 'mongoose';
import { QuestionPaper, IQuestionPaper } from '../models/QuestionPaper';
import { AnswerBook } from '../models/AnswerBook';
import { Exam } from '../models/Exam';
import { Question } from '../models/Question';
import { Evaluation } from '../models/Evaluation';
import {
  uploadMediaBuffer,
  buildQuestionPaperPublicId,
  generateAuthorizedMediaUrl,
  validateMediaFile,
} from './media.service';
import { geminiManager } from '../config/gemini';
import { areEntityIdsEqual } from '../utils/identity';
import { ExtractedQuestion } from '@evalnexa/types';

export interface UploadQuestionPaperInput {
  file: {
    buffer: Buffer;
    mimetype: string;
    size: number;
    originalname: string;
  };
  examId: string;
  answerBookId?: string;
  paperSet?: string;
  userId: string;
  userRole: string;
}

/**
 * Uploads question paper file to Cloudinary, creates QuestionPaper document,
 * associates with AnswerBook if provided, and triggers AI extraction.
 */
export async function uploadAndProcessQuestionPaper(
  input: UploadQuestionPaperInput
): Promise<IQuestionPaper> {
  const { file, examId, answerBookId, paperSet = 'Set A', userId, userRole } = input;

  // 1. Validate Exam
  const exam = await Exam.findById(examId);
  if (!exam) {
    const error: any = new Error('Examination not found');
    error.status = 404;
    error.code = 'EXAM_NOT_FOUND';
    throw error;
  }

  // 2. Validate RBAC if AnswerBook provided
  let targetAnswerBook = null;
  if (answerBookId) {
    targetAnswerBook = await AnswerBook.findById(answerBookId);
    if (!targetAnswerBook) {
      const error: any = new Error('Answer book not found');
      error.status = 404;
      error.code = 'ANSWER_BOOK_NOT_FOUND';
      throw error;
    }

    if (userRole === 'EXAMINER') {
      const assignedExaminerId = targetAnswerBook.assignedExaminerId;
      if (!assignedExaminerId || !areEntityIdsEqual(assignedExaminerId, userId)) {
        const error: any = new Error('Access denied: You are not assigned to this answer book');
        error.status = 403;
        error.code = 'ACCESS_DENIED';
        throw error;
      }
    }
  }

  // 3. Validate file
  const fileValidation = validateMediaFile(file);
  if (!fileValidation.isValid) {
    const error: any = new Error(fileValidation.error || 'Invalid file format');
    error.status = 400;
    error.code = 'INVALID_FILE';
    throw error;
  }

  // 4. Upload to Cloudinary
  const cleanSet = paperSet.trim() || 'Set A';
  const publicId = buildQuestionPaperPublicId(examId, cleanSet);
  const resourceType = file.mimetype === 'application/pdf' ? 'auto' : 'image';

  const uploadResult = await uploadMediaBuffer(file.buffer, {
    publicId,
    resourceType,
    deliveryType: 'upload',
    overwrite: true,
  });

  const authorized = generateAuthorizedMediaUrl(uploadResult.publicId, {
    resourceType: uploadResult.resourceType,
    format: uploadResult.format,
  });

  // 5. Create QuestionPaper record
  const questionPaper = await QuestionPaper.create({
    examId: new mongoose.Types.ObjectId(examId),
    paperSet: cleanSet,
    originalFileName: file.originalname,
    cloudinaryPublicId: uploadResult.publicId,
    secureUrl: authorized.secureUrl,
    resourceType: uploadResult.resourceType || 'auto',
    format: uploadResult.format,
    pageCount: 1,
    processingStatus: 'PROCESSING',
    extractionStatus: 'NOT_EXTRACTED',
    createdBy: new mongoose.Types.ObjectId(userId),
  });

  // 6. Link to AnswerBook if supplied
  if (targetAnswerBook) {
    targetAnswerBook.questionPaperId = questionPaper._id;
    targetAnswerBook.paperSet = cleanSet;
    await targetAnswerBook.save();

    // Clear previous stale AI suggestions on this AnswerBook's evaluation
    try {
      const evaluation = await Evaluation.findOne({ answerBookId: targetAnswerBook._id });
      if (evaluation && evaluation.questionMarks && evaluation.questionMarks.length > 0) {
        let changed = false;
        for (const qm of evaluation.questionMarks) {
          if (qm.aiAnalysis) {
            qm.aiAnalysis = undefined as any;
            changed = true;
          }
        }
        if (changed) {
          await evaluation.save();
        }
      }
    } catch (clearErr) {
      console.warn('[QuestionPapersService] Non-fatal evaluation AI cache clear warning:', clearErr);
    }
  }

  // 7. Extract Questions using Gemini Multimodal Model
  try {
    await extractQuestionsFromBuffer(questionPaper, file.buffer, file.mimetype, exam);
  } catch (extractErr: any) {
    console.error('[QuestionPapersService] Extraction error:', extractErr);
    questionPaper.extractionStatus = 'ERROR';
    questionPaper.processingStatus = 'ERROR';
    await questionPaper.save();
    throw extractErr;
  }

  return questionPaper;
}

/**
 * Extracts structured questions from document buffer via Gemini
 */
export async function extractQuestionsFromBuffer(
  questionPaper: IQuestionPaper,
  buffer: Buffer,
  mimeType: string,
  exam?: any
): Promise<IQuestionPaper> {
  const client = geminiManager.getClient();

  if (!client) {
    const error: any = new Error(
      'AI extraction service is unconfigured (GEMINI_API_KEY missing). Please configure GEMINI_API_KEY.'
    );
    error.status = 503;
    error.code = 'AI_UNCONFIGURED';
    throw error;
  }

  let lastModelError = '';
  const candidateModels = geminiManager.getCandidateModels();
  const prompt = `You are an expert examination processor. Analyze this uploaded examination question paper.
Extract all questions with strict fidelity.
For each question, extract:
- questionNumber: integer (1, 2, 3...)
- section: optional string (e.g. "Section A", "Part I")
- subquestion: optional string (e.g. "(a)", "(b)")
- text: complete and accurate statement of the question including parameters and equations.
- maximumMarks: number (maximum marks allocated for this question; if not explicitly stated, infer or default to 10)
- rubric: optional array of { criterion: string, marks: number }
- referenceAnswer: optional key summary of ideal answer if apparent
- choice: optional choice indication (e.g. "OR with Q3")

Return STRICT JSON format:
{
  "paperSet": "${questionPaper.paperSet || 'Set A'}",
  "totalMarks": number,
  "totalQuestions": number,
  "questions": [
    {
      "questionNumber": 1,
      "section": "Section A",
      "subquestion": "1(a)",
      "text": "Question statement here",
      "maximumMarks": 10,
      "rubric": [{ "criterion": "Core concepts", "marks": 6 }, { "criterion": "Accuracy", "marks": 4 }],
      "referenceAnswer": "Brief reference notes"
    }
  ]
}`;

  const contents: any[] = [prompt];

  // Multimodal payload supporting PDF, JPG/JPEG, PNG
  contents.push({
    inlineData: {
      data: buffer.toString('base64'),
      mimeType: mimeType || 'image/jpeg',
    },
  });

  let responseText = '';
  for (const m of candidateModels) {
    try {
      const response = await client.models.generateContent({
        model: m,
        contents,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });
      responseText = response.text || '';
      if (responseText) break;
    } catch (err: any) {
      lastModelError = err.message || String(err);
      console.warn(`[QuestionPapersService] Model ${m} extraction failed: ${err.message}`);
    }
  }

  if (!responseText) {
    const error: any = new Error(
      `AI extraction failed to generate content from uploaded document. ${lastModelError}`.trim()
    );
    error.status = 502;
    error.code = 'EXTRACTION_FAILED';
    throw error;
  }

  // Parse JSON
  let parsed: any;
  try {
    const cleaned = responseText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (parseErr: any) {
    const error: any = new Error(`Failed to parse AI question extraction response: ${parseErr.message}`);
    error.status = 502;
    error.code = 'JSON_PARSE_ERROR';
    throw error;
  }

  const questionsList: ExtractedQuestion[] = [];
  if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
    parsed.questions.forEach((q: any, idx: number) => {
      questionsList.push({
        questionNumber: Number(q.questionNumber) || idx + 1,
        section: q.section ? String(q.section).trim() : undefined,
        subquestion: q.subquestion ? String(q.subquestion).trim() : undefined,
        text: String(q.text || `Question ${idx + 1}`).trim(),
        maximumMarks: Math.max(0.5, Number(q.maximumMarks) || 10),
        rubric: Array.isArray(q.rubric)
          ? q.rubric.map((r: any) => ({
              criterion: String(r.criterion || 'Criterion'),
              marks: Number(r.marks) || 1,
            }))
          : [],
        referenceAnswer: q.referenceAnswer ? String(q.referenceAnswer).trim() : undefined,
        choice: q.choice ? String(q.choice).trim() : undefined,
        verified: false,
      });
    });
  }

  if (questionsList.length === 0) {
    const error: any = new Error(
      'No questions could be extracted from the uploaded question paper document. Please ensure the document is clear and readable.'
    );
    error.status = 422;
    error.code = 'NO_QUESTIONS_FOUND';
    throw error;
  }

  questionPaper.extractedQuestions = questionsList;
  questionPaper.totalQuestions = questionsList.length;
  questionPaper.maximumMarks = questionsList.reduce(
    (sum, q) => sum + (Number(q.maximumMarks) || 0),
    0
  );
  questionPaper.extractionStatus = 'EXTRACTED';
  questionPaper.processingStatus = 'COMPLETED';
  await questionPaper.save();

  return questionPaper;
}

/**
 * Human examiner verifies and confirms the question paper questions.
 */
export async function verifyQuestionPaperQuestions(
  questionPaperId: string,
  verifiedQuestions: ExtractedQuestion[],
  userId: string,
  userRole: string,
  answerBookId?: string
): Promise<IQuestionPaper> {
  const questionPaper = await QuestionPaper.findById(questionPaperId);
  if (!questionPaper) {
    const error: any = new Error('Question paper not found');
    error.status = 404;
    error.code = 'QUESTION_PAPER_NOT_FOUND';
    throw error;
  }

  // RBAC validation
  if (userRole === 'EXAMINER' && answerBookId) {
    const answerBook = await AnswerBook.findById(answerBookId);
    if (answerBook && answerBook.assignedExaminerId) {
      if (!areEntityIdsEqual(answerBook.assignedExaminerId, userId)) {
        const error: any = new Error('Access denied: You are not assigned to this answer book');
        error.status = 403;
        error.code = 'ACCESS_DENIED';
        throw error;
      }
    }
  }

  if (!Array.isArray(verifiedQuestions) || verifiedQuestions.length === 0) {
    const error: any = new Error('At least one question is required');
    error.status = 400;
    error.code = 'INVALID_QUESTIONS';
    throw error;
  }

  const cleanedQuestions: ExtractedQuestion[] = verifiedQuestions.map((q, idx) => ({
    questionNumber: Number(q.questionNumber) || idx + 1,
    section: q.section ? String(q.section).trim() : undefined,
    subquestion: q.subquestion ? String(q.subquestion).trim() : undefined,
    text: String(q.text || `Question ${idx + 1}`).trim(),
    maximumMarks: Math.max(0.5, Number(q.maximumMarks) || 1),
    rubric: Array.isArray(q.rubric)
      ? q.rubric.map((r) => ({
          criterion: String(r.criterion || 'Criterion').trim(),
          marks: Number(r.marks) || 1,
        }))
      : [],
    referenceAnswer: q.referenceAnswer ? String(q.referenceAnswer).trim() : undefined,
    choice: q.choice ? String(q.choice).trim() : undefined,
    verified: true,
  }));

  const totalMarks = cleanedQuestions.reduce((sum, q) => sum + (Number(q.maximumMarks) || 0), 0);

  questionPaper.verifiedQuestions = cleanedQuestions;
  questionPaper.totalQuestions = cleanedQuestions.length;
  questionPaper.maximumMarks = totalMarks;
  questionPaper.extractionStatus = 'VERIFIED';
  questionPaper.verifiedBy = new mongoose.Types.ObjectId(userId);
  questionPaper.verifiedAt = new Date();
  await questionPaper.save();

  // If AnswerBook provided, ensure it is linked
  if (answerBookId) {
    const answerBook = await AnswerBook.findById(answerBookId);
    if (answerBook) {
      answerBook.questionPaperId = questionPaper._id;
      answerBook.paperSet = questionPaper.paperSet;
      await answerBook.save();

      // Clear previous stale AI suggestions on this AnswerBook's evaluation
      try {
        const evaluation = await Evaluation.findOne({ answerBookId: answerBook._id });
        if (evaluation && evaluation.questionMarks && evaluation.questionMarks.length > 0) {
          let changed = false;
          for (const qm of evaluation.questionMarks) {
            if (qm.aiAnalysis) {
              qm.aiAnalysis = undefined as any;
              changed = true;
            }
          }
          if (changed) {
            await evaluation.save();
          }
        }
      } catch (clearErr) {
        console.warn('[QuestionPapersService] Non-fatal evaluation AI cache clear warning:', clearErr);
      }
    }
  }

  // Upsert into Question model for this exam so legacy routes also reflect verified questions
  try {
    for (const q of cleanedQuestions) {
      await Question.findOneAndUpdate(
        { examId: questionPaper.examId, questionNumber: q.questionNumber },
        {
          text: q.text,
          maximumMarks: q.maximumMarks,
          rubric: q.rubric || [],
          referenceAnswer: q.referenceAnswer,
        },
        { upsert: true, new: true }
      );
    }
  } catch (syncErr) {
    console.warn('[QuestionPapersService] Non-fatal question sync warning:', syncErr);
  }

  return questionPaper;
}

/**
 * Gets the QuestionPaper attached to an AnswerBook or latest for Exam
 */
export async function getQuestionPaperForAnswerBook(
  answerBookId: string
): Promise<IQuestionPaper | null> {
  const answerBook = await AnswerBook.findById(answerBookId);
  if (!answerBook) return null;

  // 1. Direct link
  if (answerBook.questionPaperId) {
    const qp = await QuestionPaper.findById(answerBook.questionPaperId);
    if (qp) {
      // Refresh secureUrl if expired
      if (qp.cloudinaryPublicId) {
        const authorized = generateAuthorizedMediaUrl(qp.cloudinaryPublicId, {
          resourceType: qp.resourceType,
          format: qp.format,
        });
        qp.secureUrl = authorized.secureUrl;
      }
      return qp;
    }
  }

  // 2. Lookup latest QuestionPaper for this Exam and matching paperSet
  const query: any = { examId: answerBook.examId };
  if (answerBook.paperSet) {
    query.paperSet = answerBook.paperSet;
  }

  const latestPaper = await QuestionPaper.findOne(query).sort({ updatedAt: -1 });
  if (latestPaper) {
    // Associate with AnswerBook
    answerBook.questionPaperId = latestPaper._id;
    if (!answerBook.paperSet) answerBook.paperSet = latestPaper.paperSet;
    await answerBook.save();

    if (latestPaper.cloudinaryPublicId) {
      const authorized = generateAuthorizedMediaUrl(latestPaper.cloudinaryPublicId, {
        resourceType: latestPaper.resourceType,
        format: latestPaper.format,
      });
      latestPaper.secureUrl = authorized.secureUrl;
    }
    return latestPaper;
  }

  return null;
}
