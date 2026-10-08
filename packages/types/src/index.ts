// ============================================================
// EVALNEXA SHARED TYPE DEFINITIONS
// ============================================================

// --- Roles ---
export type UserRole = 'ADMIN' | 'EXAMINER' | 'MODERATOR';

// --- User ---
export interface User {
  _id: string;
  name: string;
  email: string;
  role: UserRole;
  institutionId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Exam Status ---
export type ExamStatus =
  | 'DRAFT'
  | 'READY'
  | 'EVALUATION_OPEN'
  | 'EVALUATION_CLOSED'
  | 'MODERATION'
  | 'FINALIZED';

// --- Exam ---
export interface Exam {
  _id: string;
  title: string;
  subjectCode: string;
  subjectName: string;
  academicSession: string;
  maximumMarks: number;
  totalQuestions: number;
  status: ExamStatus;
  createdBy: string | User;
  createdAt: string;
  updatedAt: string;
}

// --- Processing Status ---
export type ProcessingStatus =
  | 'RECEIVED'
  | 'PROCESSING'
  | 'QUALITY_REVIEW'
  | 'RESCAN_REQUIRED'
  | 'OCR_PROCESSING'
  | 'FINALIZING'
  | 'FINALIZED'
  | 'READY_FOR_EVALUATION'
  | 'COMPLETED'
  | 'ERROR';

// --- Answer Book Status ---
export type AnswerBookStatus =
  | 'READY'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'RETURNED'
  | 'FINALIZED';

export type QualityStatus =
  | 'PENDING'
  | 'PASSED'
  | 'REVIEW_REQUIRED'
  | 'RESCAN_REQUIRED'
  | 'VERIFIED'
  | 'READY'
  | 'PROCESSING'
  | 'QUALITY_REVIEW';

// --- Cloudinary Asset Metadata ---
export interface CloudinaryAssetMetadata {
  publicId: string;
  assetId?: string;
  resourceType: string;
  deliveryType?: string;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  secureUrl?: string;
}

// --- Page OCR & Quality ---
export interface PageOcrMetadata {
  text?: string;
  confidence?: number | null;
  language?: string;
}

export interface PageQualityMetadata {
  status: 'PENDING' | 'PASSED' | 'REVIEW_REQUIRED' | 'RESCAN_REQUIRED' | 'VERIFIED';
  score?: number | null;
  reviewedAt?: string;
  reviewedBy?: string;
}

// --- Answer Page ---
export interface AnswerPage {
  _id: string;
  answerBookId: string;
  pageNumber: number;
  cloudinary: CloudinaryAssetMetadata;
  ocr?: PageOcrMetadata;
  quality?: PageQualityMetadata;
  processingStatus?: ProcessingStatus;
  finalized: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Answer Book ---
export interface AnswerBook {
  _id: string;
  examId: string | Exam;
  answerBookCode: string;
  studentCode: string;
  pageCount: number;
  status: AnswerBookStatus;
  processingStatus?: ProcessingStatus;
  qualityStatus?: QualityStatus;
  scanBatch?: string;
  pdfUrl?: string;
  cloudinaryAsset?: {
    publicId: string;
    assetId?: string;
    format?: string;
    resourceType?: string;
    secureUrl?: string;
  };
  assignedExaminerId?: string | User;
  questionPageMapping?: QuestionPageMapping[];
  questionPaperId?: string | QuestionPaper;
  paperSet?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionPageMapping {
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

// --- Evaluation Status ---
export type EvaluationStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'RETURNED';

// --- Question Marking Status ---
export type QuestionMarkStatus = 'NOT_STARTED' | 'MARKED' | 'FLAGGED' | 'NOT_ATTEMPTED';

// --- AI Analysis States ---
export type QuestionAiAnalysisStatus =
  | 'NOT_STARTED'
  | 'QUEUED'
  | 'ANALYZING'
  | 'COMPLETED'
  | 'NEEDS_REVIEW'
  | 'FAILED';

export type FullAnalysisJobStatus =
  | 'NOT_STARTED'
  | 'QUEUED'
  | 'RUNNING'
  | 'PARTIAL'
  | 'COMPLETED'
  | 'COMPLETED_WITH_REVIEW'
  | 'COMPLETED_WITH_ERRORS'
  | 'FAILED'
  | 'CANCELLED';

export interface FullAnalysisJob {
  jobId: string;
  status: FullAnalysisJobStatus;
  questionPaperId?: string;
  totalQuestions: number;
  completedQuestions: number;
  failedQuestions: number;
  needsReviewQuestions: number;
  totalPages: number;
  analyzedPages: number;
  currentStep?: string;
  currentQuestionNumber?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface QuestionMarkAiAnalysis {
  questionPaperId?: string;
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
  generatedAt: string;
  model: string;
  mappedPages?: number[];
  questionTextHash?: string;
}

export interface QuestionMarkItem {
  questionNumber: number;
  questionLabel?: string;
  section?: string;
  subquestion?: string;
  marks: number;
  status: QuestionMarkStatus;
  comment?: string;
  aiStatus?: QuestionAiAnalysisStatus;
  aiError?: string;
  aiAnalysis?: QuestionMarkAiAnalysis;
  examinerReviewed?: boolean;
  reviewedAt?: string;
}

// --- Evaluation ---
export interface Evaluation {
  _id: string;
  answerBookId: string | AnswerBook;
  examinerId: string | User;
  status: EvaluationStatus;
  totalMarks?: number;
  totalPossibleMarks?: number;
  remarks?: string;
  questionMarks?: QuestionMarkItem[];
  fullAnalysisJob?: FullAnalysisJob;
  startedAt?: string;
  submittedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Question ---
export interface QuestionRubricItem {
  criterion: string;
  marks: number;
}

export interface Question {
  _id: string;
  examId: string | Exam;
  questionNumber: number;
  questionLabel?: string;
  section?: string;
  subquestion?: string;
  text: string;
  maximumMarks: number;
  rubric: QuestionRubricItem[];
  referenceAnswer?: string;
  keyConcepts?: string[];
  gradingNotes?: string;
  evaluationLanguage?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Question Paper ---
export type QuestionPaperStatus = 'NOT_EXTRACTED' | 'EXTRACTED' | 'VERIFIED' | 'ERROR';

export interface ExtractedQuestion {
  questionNumber: number;
  questionLabel?: string;
  section?: string;
  subquestion?: string;
  text: string;
  maximumMarks: number;
  rubric?: QuestionRubricItem[];
  referenceAnswer?: string;
  choice?: string;
  verified?: boolean;
}

export interface QuestionPaper {
  _id: string;
  examId: string | Exam;
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
  verifiedBy?: string | User;
  verifiedAt?: string;
  createdBy: string | User;
  createdAt: string;
  updatedAt: string;
}

// --- AI Evaluation Assistant ---
export interface EvaluationAssistantCriteriaSuggestion {
  name: string;
  maxMarks: number;
  awardedMarks: number;
  evidence: string;
}

export interface EvaluationAssistantResult {
  suggestedMarks: number;
  minMarks: number;
  maxMarks: number;
  confidence: number;
  needsHumanReview: boolean;
  criteria: EvaluationAssistantCriteriaSuggestion[];
  missingConcepts: string[];
  reasoningSummary: string;
}

export interface EvaluationAssistantInput {
  question: string;
  maximumMarks: number;
  rubric: Array<{
    criterion: string;
    marks: number;
  }>;
  referenceAnswer?: string;
  keyConcepts?: string[];
  gradingNotes?: string;
  studentAnswerImage?: string;
  ocrText?: string;
  ocrConfidence?: number | null;
  language?: string;
}

// --- Moderation ---
export interface Moderation {
  _id: string;
  evaluationId: string | Evaluation;
  moderatorId: string | User;
  status: 'UNDER_REVIEW' | 'APPROVED' | 'RETURNED';
  decision: 'APPROVE' | 'RETURN';
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Audit Log ---
export interface AuditLog {
  _id: string;
  actorId: string | User;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// --- API Response Wrappers ---
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ApiError {
  success: false;
  message: string;
  errors?: Record<string, string[]>;
}

// --- Dashboard Stats ---
export interface AdminDashboardStats {
  totalExams: number;
  totalAnswerBooks: number;
  byStatus: {
    ready: number;
    assigned: number;
    inProgress: number;
    submitted: number;
    underReview: number;
    approved: number;
    returned: number;
    finalized: number;
  };
}

export interface ExaminerDashboardStats {
  assigned: number;
  inProgress: number;
  submitted: number;
}

export interface ModeratorDashboardStats {
  submitted: number;
  underReview: number;
  approved: number;
  returned: number;
}

export interface IntegrityIssue {
  id: string;
  ruleName: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  answerBookCode: string;
  examCode: string;
  examinerName: string;
  description: string;
  timestamp: string;
  evaluationId?: string;
  answerBookId?: string;
}

export interface ExaminerAnalyticsItem {
  examinerId: string;
  name: string;
  email: string;
  isActive: boolean;
  assigned: number;
  completed: number;
  returned: number;
  flags: number;
  averageMarks: number;
  averageEvaluationTimeMinutes: number;
}

// --- Result Status ---
export type ResultStatus = 'FINALIZED' | 'PUBLISHED' | 'WITHHELD';

// --- Result ---
export interface Result {
  _id: string;
  examId: string | Exam;
  answerBookId: string | AnswerBook;
  evaluationId: string | Evaluation;
  examinerId: string | User;
  totalMarks: number;
  maximumMarks: number;
  percentage: number;
  grade?: string;
  gradePoint?: number;
  classification?: string;
  status: ResultStatus;
  finalizedAt: string;
  finalizedBy: string | User;
  publishedAt?: string;
  publishedBy?: string | User;
  withheldReason?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Socket.IO Events ---
export type SocketEvent =
  | 'exam.created'
  | 'exam.updated'
  | 'answerbook.created'
  | 'answerbook.assigned'
  | 'answerbook.status.changed'
  | 'script.processing.updated'
  | 'script.quality.updated'
  | 'script.finalized'
  | 'page.created'
  | 'page.updated'
  | 'page.deleted'
  | 'evaluation.started'
  | 'evaluation.updated'
  | 'evaluation.submitted'
  | 'evaluation.ai.updated'
  | 'ai.full-analysis.started'
  | 'ai.full-analysis.progress'
  | 'ai.full-analysis.completed'
  | 'answerbook.mapping.updated'
  | 'moderation.approved'
  | 'moderation.returned'
  | 'result.finalized'
  | 'result.published'
  | 'result.withheld'
  | 'result.updated'
  | 'user.created';

export interface SocketEventPayload {
  event: SocketEvent;
  data: Record<string, unknown>;
  timestamp: string;
}
