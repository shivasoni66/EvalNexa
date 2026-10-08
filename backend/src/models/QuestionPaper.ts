import mongoose, { Document, Schema } from 'mongoose';
import { QuestionPaperStatus, ExtractedQuestion } from '@evalnexa/types';

export interface IQuestionPaper extends Document {
  _id: mongoose.Types.ObjectId;
  examId: mongoose.Types.ObjectId;
  paperSet: string;
  originalFileName: string;
  cloudinaryPublicId: string;
  secureUrl?: string;
  resourceType: string;
  format?: string;
  pageCount: number;
  processingStatus: 'RECEIVED' | 'PROCESSING' | 'COMPLETED' | 'ERROR';
  extractionStatus: QuestionPaperStatus;
  rawOcrText?: string;
  extractedQuestions: ExtractedQuestion[];
  verifiedQuestions: ExtractedQuestion[];
  totalQuestions: number;
  maximumMarks: number;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const RubricItemSchema = new Schema(
  {
    criterion: { type: String, required: true, trim: true },
    marks: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const ExtractedQuestionSchema = new Schema(
  {
    questionNumber: { type: Number, required: true },
    questionLabel: { type: String, trim: true },
    section: { type: String, trim: true },
    subquestion: { type: String, trim: true },
    text: { type: String, required: true, trim: true },
    maximumMarks: { type: Number, required: true, min: 0 },
    rubric: { type: [RubricItemSchema], default: [] },
    referenceAnswer: { type: String, trim: true },
    choice: { type: String, trim: true },
    verified: { type: Boolean, default: false },
  },
  { _id: false }
);

const QuestionPaperSchema = new Schema<IQuestionPaper>(
  {
    examId: {
      type: Schema.Types.ObjectId,
      ref: 'Exam',
      required: true,
      index: true,
    },
    paperSet: {
      type: String,
      default: 'Default',
      trim: true,
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true,
    },
    cloudinaryPublicId: {
      type: String,
      required: true,
      trim: true,
    },
    secureUrl: {
      type: String,
      trim: true,
    },
    resourceType: {
      type: String,
      default: 'auto',
    },
    format: {
      type: String,
      trim: true,
    },
    pageCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    processingStatus: {
      type: String,
      enum: ['RECEIVED', 'PROCESSING', 'COMPLETED', 'ERROR'],
      default: 'RECEIVED',
    },
    extractionStatus: {
      type: String,
      enum: ['NOT_EXTRACTED', 'EXTRACTED', 'VERIFIED', 'ERROR'],
      default: 'NOT_EXTRACTED',
    },
    rawOcrText: {
      type: String,
    },
    extractedQuestions: {
      type: [ExtractedQuestionSchema],
      default: [],
    },
    verifiedQuestions: {
      type: [ExtractedQuestionSchema],
      default: [],
    },
    totalQuestions: {
      type: Number,
      default: 0,
      min: 0,
    },
    maximumMarks: {
      type: Number,
      default: 0,
      min: 0,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    verifiedAt: {
      type: Date,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

// Index for quick lookup of papers by exam and paper set
QuestionPaperSchema.index({ examId: 1, paperSet: 1 });

export const QuestionPaper = mongoose.model<IQuestionPaper>('QuestionPaper', QuestionPaperSchema);
