import mongoose, { Document, Schema } from 'mongoose';
import { EvaluationStatus } from '@evalnexa/types';

export interface IEvaluationQuestionAiAnalysis {
  questionPaperId?: mongoose.Types.ObjectId;
  suggestedMarks: number;
  minMarks: number;
  maxMarks: number;
  questionMaxMarks?: number;
  confidence: number;
  needsHumanReview: boolean;
  criteria: Array<{
    name: string;
    maxMarks: number;
    awardedMarks: number;
    evidence: string;
  }>;
  missingConcepts: string[];
  reasoningSummary: string;
  generatedAt: Date;
  model: string;
  mappedPages?: number[];
  questionTextHash?: string;
}

export interface IEvaluationQuestionMark {
  questionNumber: number;
  questionLabel?: string;
  section?: string;
  subquestion?: string;
  marks: number;
  status: 'NOT_STARTED' | 'MARKED' | 'FLAGGED' | 'NOT_ATTEMPTED';
  comment?: string;
  aiStatus?: 'NOT_STARTED' | 'QUEUED' | 'ANALYZING' | 'COMPLETED' | 'NEEDS_REVIEW' | 'FAILED';
  aiError?: string;
  aiAnalysis?: IEvaluationQuestionAiAnalysis;
  examinerReviewed?: boolean;
  reviewedAt?: Date;
}

export interface IFullAnalysisJob {
  jobId: string;
  status:
    | 'NOT_STARTED'
    | 'QUEUED'
    | 'RUNNING'
    | 'PARTIAL'
    | 'COMPLETED'
    | 'COMPLETED_WITH_REVIEW'
    | 'COMPLETED_WITH_ERRORS'
    | 'FAILED'
    | 'CANCELLED';
  questionPaperId?: mongoose.Types.ObjectId;
  totalQuestions: number;
  completedQuestions: number;
  failedQuestions: number;
  needsReviewQuestions: number;
  totalPages: number;
  analyzedPages: number;
  currentStep?: string;
  currentQuestionNumber?: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface IEvaluation extends Document {
  _id: mongoose.Types.ObjectId;
  answerBookId: mongoose.Types.ObjectId;
  examinerId: mongoose.Types.ObjectId;
  status: EvaluationStatus;
  totalMarks?: number;
  totalPossibleMarks?: number;
  remarks?: string;
  questionMarks: IEvaluationQuestionMark[];
  fullAnalysisJob?: IFullAnalysisJob;
  startedAt?: Date;
  submittedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EvaluationSchema = new Schema<IEvaluation>(
  {
    answerBookId: {
      type: Schema.Types.ObjectId,
      ref: 'AnswerBook',
      required: true,
    },
    examinerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: [
        'NOT_STARTED',
        'IN_PROGRESS',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'RETURNED',
      ],
      default: 'NOT_STARTED',
    },
    totalMarks: { type: Number, min: 0, default: 0 },
    totalPossibleMarks: { type: Number, min: 0 },
    remarks: { type: String, trim: true },
    fullAnalysisJob: {
      type: new Schema(
        {
          jobId: { type: String, required: true },
          status: {
            type: String,
            enum: [
              'NOT_STARTED',
              'QUEUED',
              'RUNNING',
              'PARTIAL',
              'COMPLETED',
              'COMPLETED_WITH_REVIEW',
              'COMPLETED_WITH_ERRORS',
              'FAILED',
              'CANCELLED',
            ],
            default: 'NOT_STARTED',
          },
          questionPaperId: { type: Schema.Types.ObjectId, ref: 'QuestionPaper' },
          totalQuestions: { type: Number, default: 0 },
          completedQuestions: { type: Number, default: 0 },
          failedQuestions: { type: Number, default: 0 },
          needsReviewQuestions: { type: Number, default: 0 },
          totalPages: { type: Number, default: 0 },
          analyzedPages: { type: Number, default: 0 },
          currentStep: { type: String },
          currentQuestionNumber: { type: Number },
          startedAt: { type: Date },
          completedAt: { type: Date },
          error: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
    questionMarks: [
      {
        questionNumber: { type: Number, required: true },
        questionLabel: { type: String, trim: true },
        section: { type: String, trim: true },
        subquestion: { type: String, trim: true },
        marks: { type: Number, required: true, default: 0, min: 0 },
        status: {
          type: String,
          enum: ['NOT_STARTED', 'MARKED', 'FLAGGED', 'NOT_ATTEMPTED'],
          default: 'NOT_STARTED',
        },
        comment: { type: String, trim: true },
        aiStatus: {
          type: String,
          enum: ['NOT_STARTED', 'QUEUED', 'ANALYZING', 'COMPLETED', 'NEEDS_REVIEW', 'FAILED'],
          default: 'NOT_STARTED',
        },
        aiError: { type: String, trim: true },
        aiAnalysis: {
          type: new Schema(
            {
              questionPaperId: { type: Schema.Types.ObjectId, ref: 'QuestionPaper' },
              suggestedMarks: { type: Number },
              minMarks: { type: Number },
              maxMarks: { type: Number },
              questionMaxMarks: { type: Number },
              confidence: { type: Number },
              needsHumanReview: { type: Boolean },
              criteria: [
                {
                  name: { type: String },
                  maxMarks: { type: Number },
                  awardedMarks: { type: Number },
                  evidence: { type: String },
                },
              ],
              missingConcepts: { type: [String], default: undefined },
              reasoningSummary: { type: String },
              generatedAt: { type: Date },
              model: { type: String },
              mappedPages: { type: [Number], default: undefined },
              questionTextHash: { type: String, trim: true },
            },
            { _id: false }
          ),
          default: undefined,
        },
        examinerReviewed: { type: Boolean, default: false },
        reviewedAt: { type: Date },
      },
    ],
    startedAt: { type: Date },
    submittedAt: { type: Date },
  },
  { timestamps: true }
);

// Authoritative totalMarks calculation: always recalculate from questionMarks
EvaluationSchema.pre('validate', function (next) {
  if (this.questionMarks && Array.isArray(this.questionMarks)) {
    this.totalMarks = this.questionMarks
      .filter((q) => q.status === 'MARKED' || q.status === 'FLAGGED')
      .reduce((sum, q) => sum + (Number(q.marks) || 0), 0);
  }
  next();
});

export const Evaluation = mongoose.model<IEvaluation>('Evaluation', EvaluationSchema);
