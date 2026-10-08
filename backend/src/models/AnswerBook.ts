import mongoose, { Document, Schema } from 'mongoose';
import { AnswerBookStatus, ProcessingStatus, QualityStatus } from '@evalnexa/types';

export const ALLOWED_PROCESSING_TRANSITIONS: Record<ProcessingStatus, ProcessingStatus[]> = {
  RECEIVED: ['PROCESSING', 'ERROR'],
  PROCESSING: [
    'QUALITY_REVIEW',
    'OCR_PROCESSING',
    'RESCAN_REQUIRED',
    'FINALIZING',
    'FINALIZED',
    'READY_FOR_EVALUATION',
    'ERROR',
  ],
  QUALITY_REVIEW: [
    'OCR_PROCESSING',
    'RESCAN_REQUIRED',
    'FINALIZING',
    'FINALIZED',
    'READY_FOR_EVALUATION',
    'ERROR',
  ],
  OCR_PROCESSING: [
    'QUALITY_REVIEW',
    'FINALIZING',
    'FINALIZED',
    'READY_FOR_EVALUATION',
    'ERROR',
  ],
  RESCAN_REQUIRED: ['PROCESSING', 'RECEIVED', 'ERROR'],
  FINALIZING: ['FINALIZED', 'READY_FOR_EVALUATION', 'ERROR', 'QUALITY_REVIEW'],
  FINALIZED: ['READY_FOR_EVALUATION', 'FINALIZING'],
  READY_FOR_EVALUATION: [],
  COMPLETED: ['FINALIZED', 'READY_FOR_EVALUATION', 'ERROR'],
  ERROR: ['RECEIVED', 'PROCESSING'],
};

/**
 * Authoritative processing state transition validator.
 * Enforces valid state machine transitions across all mutations.
 */
export function validateProcessingStateTransition(
  current: ProcessingStatus,
  next: ProcessingStatus
): void {
  if (current === next) return;
  const allowed = ALLOWED_PROCESSING_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    const error: any = new Error(
      `Invalid processing state transition from '${current}' to '${next}'. Allowed: ${allowed.join(', ') || 'None'}`
    );
    error.status = 400;
    error.code = 'INVALID_PROCESSING_TRANSITION';
    throw error;
  }
}

export interface IQuestionPageMapping {
  questionNumber: number;
  questionLabel?: string;
  pages: number[];
  mappedPages?: number[];
  verified?: boolean;
  confidence?: number;
  mappingConfidence?: number;
  reason?: string;
  evidence?: string[];
  needsHumanReview?: boolean;
  source?:
    | 'AUTO_EXPLICIT'
    | 'AUTO_SEMANTIC'
    | 'AUTO_MULTIMODAL'
    | 'AUTO_CONTINUATION'
    | 'AI_SUGGESTED'
    | 'EXAMINER_VERIFIED';
  mappingSource?: string;
  examinerVerified?: boolean;
  isContinuation?: boolean;
  mappingAlgorithmVersion?: string;
  aiSuggestedPages?: number[];
  aiConfidence?: number;
  aiReason?: string;
}

export interface IAnswerBook extends Document {
  _id: mongoose.Types.ObjectId;
  examId: mongoose.Types.ObjectId;
  answerBookCode: string;
  studentCode: string;
  pageCount: number;
  status: AnswerBookStatus;
  processingStatus: ProcessingStatus;
  qualityStatus: QualityStatus;
  scanBatch?: string;
  pdfUrl?: string;
  cloudinaryAsset?: {
    publicId: string;
    assetId?: string;
    resourceType?: string;
    format?: string;
    bytes?: number;
    secureUrl?: string;
  };
  assignedExaminerId?: mongoose.Types.ObjectId;
  questionPageMapping?: IQuestionPageMapping[];
  questionPaperId?: mongoose.Types.ObjectId;
  paperSet?: string;
  createdAt: Date;
  updatedAt: Date;
  transitionProcessingStatus(newStatus: ProcessingStatus): void;
}

const AnswerBookSchema = new Schema<IAnswerBook>(
  {
    examId: { type: Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
    answerBookCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    studentCode: { type: String, required: true, trim: true, uppercase: true },
    pageCount: { type: Number, required: true, min: 1, default: 1 },
    status: {
      type: String,
      enum: [
        'READY',
        'ASSIGNED',
        'IN_PROGRESS',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'RETURNED',
        'FINALIZED',
      ],
      default: 'READY',
      index: true,
    },
    processingStatus: {
      type: String,
      enum: [
        'RECEIVED',
        'PROCESSING',
        'QUALITY_REVIEW',
        'RESCAN_REQUIRED',
        'OCR_PROCESSING',
        'FINALIZING',
        'FINALIZED',
        'READY_FOR_EVALUATION',
        'COMPLETED',
        'ERROR',
      ],
      default: 'RECEIVED',
      index: true,
    },
    qualityStatus: {
      type: String,
      enum: [
        'PENDING',
        'PASSED',
        'REVIEW_REQUIRED',
        'RESCAN_REQUIRED',
        'VERIFIED',
        'READY',
        'PROCESSING',
        'QUALITY_REVIEW',
      ],
      default: 'PENDING',
    },
    scanBatch: { type: String, trim: true },
    pdfUrl: { type: String, trim: true },
    cloudinaryAsset: {
      publicId: { type: String, trim: true },
      assetId: { type: String, trim: true },
      resourceType: { type: String, trim: true },
      format: { type: String, trim: true },
      bytes: { type: Number },
      secureUrl: { type: String, trim: true },
    },
    assignedExaminerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    questionPaperId: {
      type: Schema.Types.ObjectId,
      ref: 'QuestionPaper',
      default: null,
      index: true,
    },
    paperSet: {
      type: String,
      trim: true,
    },
    questionPageMapping: [
      {
        questionNumber: { type: Number, required: true },
        questionLabel: { type: String, trim: true },
        pages: [{ type: Number, required: true }],
        mappedPages: [{ type: Number }],
        verified: { type: Boolean, default: false },
        confidence: { type: Number },
        mappingConfidence: { type: Number },
        reason: { type: String, trim: true },
        evidence: [{ type: String, trim: true }],
        needsHumanReview: { type: Boolean, default: false },
        source: {
          type: String,
          enum: [
            'AUTO_EXPLICIT',
            'AUTO_SEMANTIC',
            'AUTO_MULTIMODAL',
            'AUTO_CONTINUATION',
            'AI_SUGGESTED',
            'EXAMINER_VERIFIED',
          ],
          default: 'AI_SUGGESTED',
        },
        mappingSource: { type: String, trim: true },
        examinerVerified: { type: Boolean, default: false },
        isContinuation: { type: Boolean, default: false },
        mappingAlgorithmVersion: { type: String, trim: true },
        aiSuggestedPages: [{ type: Number }],
        aiConfidence: { type: Number },
        aiReason: { type: String, trim: true },
      },
    ],
  },
  { timestamps: true }
);

// Track original processingStatus on hydration and after save
AnswerBookSchema.post('init', function () {
  (this as any)._originalProcessingStatus = this.processingStatus;
});

AnswerBookSchema.post('save', function () {
  (this as any)._originalProcessingStatus = this.processingStatus;
});

// Explicit transition method
AnswerBookSchema.methods.transitionProcessingStatus = function (
  newStatus: ProcessingStatus
): void {
  const current = this.processingStatus;
  validateProcessingStateTransition(current, newStatus);
  this.processingStatus = newStatus;
};

// Document validation hook to prevent invalid transitions on save
AnswerBookSchema.pre('validate', function (next) {
  if (!this.isNew && this.isModified('processingStatus')) {
    const prev = (this as any)._originalProcessingStatus;
    if (prev && this.processingStatus) {
      try {
        validateProcessingStateTransition(prev, this.processingStatus);
      } catch (err) {
        return next(err as Error);
      }
    }
  }
  next();
});

export const AnswerBook = mongoose.model<IAnswerBook>('AnswerBook', AnswerBookSchema);

// Intercept direct assignment (e.g. answerBook.processingStatus = newStatus)
// to prevent invalid arbitrary status mutations before persistence
const processingStatusDescriptor = Object.getOwnPropertyDescriptor(
  AnswerBook.prototype,
  'processingStatus'
);
if (processingStatusDescriptor && processingStatusDescriptor.set) {
  const originalSetter = processingStatusDescriptor.set;
  Object.defineProperty(AnswerBook.prototype, 'processingStatus', {
    get: processingStatusDescriptor.get,
    set: function (newVal: any) {
      if (
        this &&
        !this.$__?.initializing &&
        (this as any)._originalProcessingStatus &&
        newVal
      ) {
        validateProcessingStateTransition(
          (this as any)._originalProcessingStatus,
          newVal as ProcessingStatus
        );
      }
      return originalSetter.call(this, newVal);
    },
    enumerable: processingStatusDescriptor.enumerable,
    configurable: processingStatusDescriptor.configurable,
  });
}
