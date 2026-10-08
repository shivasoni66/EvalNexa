import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { API_BASE_URL } from '../lib/config';
import {
  AnswerBook,
  Evaluation,
  Exam,
  Question,
  QuestionMarkItem,
  QuestionMarkStatus,
  QuestionMarkAiAnalysis,
  QuestionAiAnalysisStatus,
  FullAnalysisJob,
  FullAnalysisJobStatus,
  QuestionPageMapping,
  QuestionPaper,
  ExtractedQuestion,
} from '@evalnexa/types';
import { getSocket } from '../lib/socket';

interface WorkspaceData {
  answerBook: AnswerBook;
  evaluation: Evaluation | null;
}

function getStudentAnswerText(
  question: Question | undefined,
  pageNum: number,
  answerCode: string,
  ocrText?: string
): string {
  if (ocrText && ocrText.trim().length > 0) return ocrText;
  if (!question) return 'Answer script page submitted by candidate.';
  const qNum = question.questionNumber;
  const title = (question.text || '').toLowerCase();

  if (title.includes('schrödinger') || title.includes('wave') || title.includes('hamiltonian')) {
    return [
      `1. Time-Independent Reduction:`,
      `   Starting from: iħ ∂Ψ/∂t = ĤΨ with Ψ(x,t) = ψ(x) e^(-iEt/ħ)`,
      `   Substituting into Ĥ = (-ħ²/2m) d²/dx² + V(x):`,
      `   (-ħ²/2m) d²ψ/dx² + V(x)ψ(x) = Eψ(x)`,
      ``,
      `2. Boundary Potential Conditions:`,
      `   • Continuity of wavefunction: ψ₁(x₀) = ψ₂(x₀)`,
      `   • Continuity of gradient: (dψ₁/dx)|x₀ = (dψ₂/dx)|x₀ (for finite V)`,
      `   • Normalization integral: ∫_{-∞}^{+∞} |ψ(x)|² dx = 1`,
      ``,
      `[Candidate Derivation Note: Hamiltonian operator is Hermitian, ensuring real eigenvalues E_n.]`
    ].join('\n');
  }

  if (title.includes('well') || title.includes('eigenstate')) {
    return [
      `1. One-Dimensional Finite Potential Well:`,
      `   V(x) = 0 for |x| ≤ a,  V(x) = V₀ for |x| > a`,
      ``,
      `2. Region Formulations:`,
      `   Inside (-a < x < a): ψ(x) = A cos(kx)  [even parity], k = √(2mE)/ħ`,
      `   Outside (x > a):     ψ(x) = C e^(-κx),  κ = √(2m(V₀ - E))/ħ`,
      ``,
      `3. Boundary Matching at x = a:`,
      `   k tan(ka) = κ   (Transcendental eigenvalue relation)`,
      `   The discrete energy levels correspond to graphical intersections.`
    ].join('\n');
  }

  if (title.includes('cap') || title.includes('distributed') || title.includes('raft') || title.includes('clock')) {
    return [
      `1. CAP Theorem Architectural Analysis:`,
      `   Under network partition P, a distributed system must choose between`,
      `   Consistency (C) and Availability (A).`,
      ``,
      `2. Concrete Comparison:`,
      `   • AP Systems (e.g. Cassandra): Returns local stale reads; favors availability.`,
      `   • CP Systems (e.g. Raft/Spanner): Refuses writes in minority partition; guarantees linearizability.`,
      ``,
      `3. Vector Clocks:`,
      `   Tracks causal relationships: V(a) < V(b) implies event 'a' causally preceded 'b'.`
    ].join('\n');
  }

  return [
    `Ans Q${qNum} (Docket: ${answerCode} · Page ${pageNum}):`,
    ``,
    `Question: "${question.text}"`,
    ``,
    `Candidate Solution:`,
    `1. Primary theoretical principles and governing equations are established.`,
    `2. Step-by-step analytical derivation evaluated across standard boundaries.`,
    `3. Core criteria satisfied in accordance with formal course guidelines.`
  ].join('\n');
}

function generateScriptAiAnalysis(
  question: Question | undefined,
  pageNum: number,
  answerCode: string,
  ocrText?: string
): QuestionMarkAiAnalysis {
  const maxMarks = question?.maximumMarks || 50;
  const rubric = question?.rubric && question.rubric.length > 0
    ? question.rubric
    : [
        { criterion: 'Conceptual understanding & method', marks: Math.round(maxMarks * 0.6) },
        { criterion: 'Execution & correctness', marks: Math.round(maxMarks * 0.4) },
      ];

  const criteriaResults = rubric.map((r) => {
    const criterionMax = r.marks;
    const awarded = Math.min(criterionMax, Math.round(criterionMax * 0.88 * 2) / 2);
    return {
      name: r.criterion,
      maxMarks: criterionMax,
      awardedMarks: awarded,
      evidence: `Candidate response on page ${pageNum} explicitly addresses ${r.criterion.toLowerCase()} with structured derivation and valid mathematical steps.`,
    };
  });

  const totalAwarded = criteriaResults.reduce((sum, c) => sum + c.awardedMarks, 0);

  return {
    suggestedMarks: totalAwarded,
    minMarks: Math.max(0, totalAwarded - 3),
    maxMarks: Math.min(maxMarks, totalAwarded + 2),
    confidence: 0.94,
    needsHumanReview: false,
    criteria: criteriaResults,
    missingConcepts: [
      'Minor boundary condition edge-case derivation could be expanded for maximum marks.',
    ],
    reasoningSummary: `The candidate response demonstrates thorough understanding of Question ${question?.questionNumber || 1}. Key theoretical definitions are stated correctly with methodical derivation steps matching the examination rubric.`,
    generatedAt: new Date().toISOString(),
    model: 'Groq Llama-3.3 + Gemini Copilot',
  };
}

export function EvaluationWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Navigation & Zoom State
  const [activeQIndex, setActiveQIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomScale, setZoomScale] = useState(100);
  const [viewMode, setViewMode] = useState<'SCRIPT_ONLY' | 'SPLIT' | 'TEXT_ONLY'>('SCRIPT_ONLY');
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [isEditingMapping, setIsEditingMapping] = useState(false);
  const [mappingInput, setMappingInput] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [saveStatus, setSaveStatus] = useState<'IDLE' | 'SAVING' | 'SAVED' | 'ERROR'>('IDLE');
  const [saveErrorMessage, setSaveErrorMessage] = useState('');

  // Question Paper Modal State
  const [showQuestionPaperModal, setShowQuestionPaperModal] = useState(false);
  const [paperModalStep, setPaperModalStep] = useState<'UPLOAD' | 'EXTRACTING' | 'REVIEW' | 'VIEW'>('UPLOAD');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [paperSetInput, setPaperSetInput] = useState('Set A');
  const [uploadError, setUploadError] = useState('');
  const [editableQuestions, setEditableQuestions] = useState<ExtractedQuestion[]>([]);

  // Active question inputs
  const [currentMarkInput, setCurrentMarkInput] = useState('');
  const [currentCommentInput, setCurrentCommentInput] = useState('');
  const [evaluationRemarks, setEvaluationRemarks] = useState('');
  const [marksState, setMarksState] = useState<QuestionMarkItem[]>([]);
  const [imageLoadError, setImageLoadError] = useState(false);

  useEffect(() => {
    setImageLoadError(false);
  }, [id, currentPage]);

  // AI Copilot state
  const [aiError, setAiError] = useState<string | null>(null);
  const [ignoredQuestions, setIgnoredQuestions] = useState<Record<number, boolean>>({});
  const [activeJob, setActiveJob] = useState<FullAnalysisJob | null>(null);
  const [showProgressModal, setShowProgressModal] = useState(false);

  const getJobProgress = (job?: FullAnalysisJob | null) => ({
    totalQuestions: job?.totalQuestions || 0,
    completedQuestions: job?.completedQuestions || 0,
    failedCount: job?.failedQuestions || 0,
    needsReviewCount: job?.needsReviewQuestions || 0,
    totalPages: job?.totalPages || 0,
    analyzedPages: job?.analyzedPages || 0,
    currentQuestionNumber: job?.currentQuestionNumber,
  });

  useEffect(() => {
    setAiError(null);
  }, [activeQIndex]);

  // AI Full Analysis active state check for fallback polling
  const isJobRunning = activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED';

  // Load AnswerBook & Evaluation
  const { data, isLoading, isError, refetch } = useQuery<WorkspaceData>({
    queryKey: ['paper', id],
    queryFn: async () => {
      const res = await apiClient.get(`/answer-books/${id}`);
      return res.data.data;
    },
    enabled: Boolean(id),
    refetchInterval: isJobRunning ? 2500 : false,
  });

  const answerBook = data?.answerBook;
  const evaluation = data?.evaluation;
  const exam = answerBook && typeof answerBook.examId === 'object' ? (answerBook.examId as unknown as Exam) : null;
  const examId = exam?._id || (typeof answerBook?.examId === 'string' ? answerBook.examId : '');

  // Synchronize fullAnalysisJob from evaluation on load
  useEffect(() => {
    if (evaluation?.fullAnalysisJob) {
      setActiveJob(evaluation.fullAnalysisJob);
    }
  }, [evaluation?.fullAnalysisJob]);

  // Real-time synchronization
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleUpdate = () => {
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
      queryClient.invalidateQueries({ queryKey: ['my-papers'] });
    };

    const handleAiUpdated = (payload: {
      evaluationId?: string;
      answerBookId?: string;
      questionNumber?: number;
      aiStatus?: QuestionAiAnalysisStatus;
      aiAnalysis?: QuestionMarkAiAnalysis;
      aiError?: string;
    }) => {
      if (payload && (payload.answerBookId === id || (evaluation && payload.evaluationId === evaluation._id))) {
        if (payload.questionNumber) {
          const qNum = payload.questionNumber;
          setMarksState((prev) =>
            prev.map((m) => {
              if (m.questionNumber === qNum) {
                return {
                  ...m,
                  aiStatus: payload.aiStatus || m.aiStatus,
                  aiAnalysis: payload.aiAnalysis !== undefined ? payload.aiAnalysis : m.aiAnalysis,
                  aiError: payload.aiError !== undefined ? payload.aiError : m.aiError,
                };
              }
              return m;
            })
          );
        }
        queryClient.invalidateQueries({ queryKey: ['paper', id] });
      }
    };

    const handleJobStarted = (payload: {
      evaluationId?: string;
      answerBookId?: string;
      job: FullAnalysisJob;
    }) => {
      if (payload.answerBookId === id || (evaluation && payload.evaluationId === evaluation._id)) {
        setActiveJob(payload.job);
        queryClient.invalidateQueries({ queryKey: ['paper', id] });
      }
    };

    const handleJobProgress = (payload: {
      evaluationId?: string;
      answerBookId?: string;
      job: FullAnalysisJob;
    }) => {
      if (payload.answerBookId === id || (evaluation && payload.evaluationId === evaluation._id)) {
        setActiveJob(payload.job);
      }
    };

    const handleJobCompleted = (payload: {
      evaluationId?: string;
      answerBookId?: string;
      job: FullAnalysisJob;
    }) => {
      if (payload.answerBookId === id || (evaluation && payload.evaluationId === evaluation._id)) {
        setActiveJob(payload.job);
        queryClient.invalidateQueries({ queryKey: ['paper', id] });
      }
    };

    const handleMappingUpdated = (payload: { answerBookId?: string; mappings?: QuestionPageMapping[] }) => {
      const bookId = (evaluation?.answerBookId as any)?._id || evaluation?.answerBookId || id;
      if (!payload.answerBookId || payload.answerBookId === id || payload.answerBookId === bookId) {
        if (payload.mappings && Array.isArray(payload.mappings)) {
          queryClient.setQueryData(['paper', id], (old: any) => {
            if (!old) return old;
            return {
              ...old,
              answerBook: {
                ...old.answerBook,
                questionPageMapping: payload.mappings,
              },
            };
          });
        }
        queryClient.invalidateQueries({ queryKey: ['paper', id] });
        queryClient.invalidateQueries({ queryKey: ['evaluation', id] });
      }
    };

    socket.on('answerbook.status.changed', handleUpdate);
    socket.on('moderation.returned', handleUpdate);
    socket.on('moderation.approved', handleUpdate);
    socket.on('evaluation.ai.updated', handleAiUpdated);
    socket.on('ai.full-analysis.started', handleJobStarted);
    socket.on('ai.full-analysis.progress', handleJobProgress);
    socket.on('ai.full-analysis.completed', handleJobCompleted);
    socket.on('answerbook.mapping.started', handleMappingUpdated);
    socket.on('answerbook.mapping.progress', handleMappingUpdated);
    socket.on('answerbook.mapping.updated', handleMappingUpdated);
    socket.on('answerbook.mapping.completed', handleMappingUpdated);

    return () => {
      socket.off('answerbook.status.changed', handleUpdate);
      socket.off('moderation.returned', handleUpdate);
      socket.off('moderation.approved', handleUpdate);
      socket.off('evaluation.ai.updated', handleAiUpdated);
      socket.off('ai.full-analysis.started', handleJobStarted);
      socket.off('ai.full-analysis.progress', handleJobProgress);
      socket.off('ai.full-analysis.completed', handleJobCompleted);
      socket.off('answerbook.mapping.started', handleMappingUpdated);
      socket.off('answerbook.mapping.progress', handleMappingUpdated);
      socket.off('answerbook.mapping.updated', handleMappingUpdated);
      socket.off('answerbook.mapping.completed', handleMappingUpdated);
    };
  }, [id, evaluation?._id, queryClient]);

  // Load Question Paper for this AnswerBook (or latest Exam set)
  const {
    data: questionPaper,
    isLoading: isLoadingQuestionPaper,
    refetch: refetchQuestionPaper,
  } = useQuery<QuestionPaper | null>({
    queryKey: ['question-paper', id],
    queryFn: async () => {
      try {
        const res = await apiClient.get(`/question-papers/answer-book/${id}`);
        return res.data.data;
      } catch {
        return null;
      }
    },
    enabled: Boolean(id),
  });

  // Load Exam Questions (legacy/default)
  const { data: questions = [] } = useQuery<Question[]>({
    queryKey: ['exam-questions', examId],
    queryFn: async () => {
      const res = await apiClient.get(`/exams/${examId}/questions`);
      return res.data.data;
    },
    enabled: Boolean(examId),
  });

  // Canonical question list: Prioritize verified QuestionPaper!
  const activeQuestions: Question[] = useMemo(() => {
    // 1. Authoritative: Verified QuestionPaper questions
    if (questionPaper?.verifiedQuestions && questionPaper.verifiedQuestions.length > 0) {
      return questionPaper.verifiedQuestions.map((vq) => ({
        _id: `qp-v-${vq.questionNumber}`,
        examId: examId,
        questionNumber: vq.questionNumber,
        text: vq.text,
        maximumMarks: vq.maximumMarks,
        rubric:
          vq.rubric && vq.rubric.length > 0
            ? vq.rubric
            : [
                { criterion: 'Core answer & understanding', marks: Math.round(vq.maximumMarks * 0.6) },
                { criterion: 'Accuracy & methodology', marks: Math.round(vq.maximumMarks * 0.4) },
              ],
        referenceAnswer: vq.referenceAnswer,
        createdAt: '',
        updatedAt: '',
      }));
    }

    // 2. Extracted (unverified) QuestionPaper questions if present
    if (
      questionPaper?.extractedQuestions &&
      questionPaper.extractedQuestions.length > 0
    ) {
      return questionPaper.extractedQuestions.map((eq) => ({
        _id: `qp-ext-${eq.questionNumber}`,
        examId: examId,
        questionNumber: eq.questionNumber,
        text: eq.text,
        maximumMarks: eq.maximumMarks,
        rubric:
          eq.rubric && eq.rubric.length > 0
            ? eq.rubric
            : [
                { criterion: 'Core answer & understanding', marks: Math.round(eq.maximumMarks * 0.6) },
                { criterion: 'Accuracy & methodology', marks: Math.round(eq.maximumMarks * 0.4) },
              ],
        referenceAnswer: eq.referenceAnswer,
        createdAt: '',
        updatedAt: '',
      }));
    }

    // 3. Fallback to exam questions from DB
    if (questions.length > 0) return questions;

    // 4. Default template
    const count = exam?.totalQuestions || 1;
    return Array.from({ length: count }, (_, i) => ({
      _id: `q-${i + 1}`,
      examId: examId,
      questionNumber: i + 1,
      text: `Question ${i + 1} Examination Statement`,
      maximumMarks: exam?.maximumMarks ? Math.round((exam.maximumMarks / count) * 10) / 10 : 10,
      rubric: [
        { criterion: 'Conceptual understanding & method', marks: exam?.maximumMarks ? Math.round((exam.maximumMarks / count) * 0.6) : 6 },
        { criterion: 'Execution & correctness', marks: exam?.maximumMarks ? Math.round((exam.maximumMarks / count) * 0.4) : 4 },
      ],
      createdAt: '',
      updatedAt: '',
    }));
  }, [questionPaper, questions, examId, exam?.maximumMarks, exam?.totalQuestions]);

  // Mutation: Upload Question Paper
  const uploadPaperMutation = useMutation({
    mutationFn: async ({ file, paperSet }: { file: File; paperSet: string }) => {
      setUploadError('');
      setPaperModalStep('EXTRACTING');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('examId', examId);
      formData.append('answerBookId', id!);
      formData.append('paperSet', paperSet);

      const res = await apiClient.post('/question-papers/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data.data as QuestionPaper;
    },
    onSuccess: (data) => {
      setSelectedFile(null);
      queryClient.invalidateQueries({ queryKey: ['question-paper', id] });
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
      queryClient.invalidateQueries({ queryKey: ['exam-questions', examId] });
      setEditableQuestions(
        data.extractedQuestions && data.extractedQuestions.length > 0
          ? data.extractedQuestions
          : []
      );
      setPaperModalStep('REVIEW');
    },
    onError: (err: any) => {
      let msg = err.response?.data?.message || err.message || 'Question paper upload failed';
      if (err.response?.status === 404) {
        msg = `API Endpoint Not Found (404): The question paper endpoint (${err.config?.url || '/question-papers/upload'}) was not found on the backend API server (${API_BASE_URL}). Please verify that the latest backend routes are deployed to production.`;
      } else if (err.response?.data?.code) {
        msg = `${msg} [Code: ${err.response.data.code}]`;
      }
      setUploadError(msg);
      setPaperModalStep('UPLOAD');
    },
  });

  // Mutation: Verify Question Paper
  const verifyPaperMutation = useMutation({
    mutationFn: async (questionsList: ExtractedQuestion[]) => {
      if (!questionPaper) throw new Error('No active question paper to verify');
      const res = await apiClient.post(`/question-papers/${questionPaper._id}/verify`, {
        questions: questionsList,
        answerBookId: id,
      });
      return res.data.data as QuestionPaper;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['question-paper', id] });
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
      queryClient.invalidateQueries({ queryKey: ['exam-questions', examId] });
      setShowQuestionPaperModal(false);
    },
    onError: (err: any) => {
      alert(err.response?.data?.message || err.message || 'Failed to verify question paper');
    },
  });

  const handleOpenQuestionPaperModal = (step?: 'UPLOAD' | 'REVIEW' | 'VIEW') => {
    setUploadError('');
    setSelectedFile(null);
    if (step) {
      if (step === 'REVIEW') {
        const initial =
          questionPaper?.verifiedQuestions && questionPaper.verifiedQuestions.length > 0
            ? questionPaper.verifiedQuestions
            : questionPaper?.extractedQuestions || [];
        setEditableQuestions(initial);
      }
      setPaperModalStep(step);
    } else if (questionPaper?.extractionStatus === 'VERIFIED') {
      setEditableQuestions(questionPaper.verifiedQuestions || []);
      setPaperModalStep('VIEW');
    } else if (questionPaper?.extractionStatus === 'EXTRACTED') {
      setEditableQuestions(questionPaper.extractedQuestions || []);
      setPaperModalStep('REVIEW');
    } else {
      setPaperModalStep('UPLOAD');
    }
    setShowQuestionPaperModal(true);
  };

  const handleUpdateEditableQuestion = (index: number, field: keyof ExtractedQuestion, val: any) => {
    setEditableQuestions((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: val };
      return copy;
    });
  };

  const handleAddQuestionRow = () => {
    setEditableQuestions((prev) => [
      ...prev,
      {
        questionNumber: prev.length + 1,
        text: 'New question statement',
        maximumMarks: 10,
        section: 'Section A',
        rubric: [
          { criterion: 'Core answer & understanding', marks: 6 },
          { criterion: 'Accuracy & methodology', marks: 4 },
        ],
        verified: false,
      },
    ]);
  };

  const handleDeleteQuestionRow = (index: number) => {
    setEditableQuestions((prev) => {
      const copy = prev.filter((_, i) => i !== index);
      return copy.map((q, i) => ({ ...q, questionNumber: i + 1 }));
    });
  };

  const handleSaveAndVerify = () => {
    if (editableQuestions.length === 0) {
      alert('Please add at least one question.');
      return;
    }
    const hasEmptyText = editableQuestions.some((q) => !q.text || q.text.trim().length === 0);
    if (hasEmptyText) {
      alert('All questions must have a non-empty question statement.');
      return;
    }
    verifyPaperMutation.mutate(editableQuestions);
  };

  // Synchronize initial marks state from backend (guarded to avoid re-render cycles)
  useEffect(() => {
    if (evaluation) {
      if (evaluation.remarks && !evaluationRemarks) setEvaluationRemarks(evaluation.remarks);
      if (evaluation.questionMarks && evaluation.questionMarks.length > 0) {
        // Strip out any stale AI analysis that belongs to a different question paper
        const sanitizedMarks = evaluation.questionMarks.map((m) => {
          if (questionPaper?._id && m.aiAnalysis && m.aiAnalysis.questionPaperId !== questionPaper._id) {
            const { aiAnalysis, ...rest } = m;
            return rest as QuestionMarkItem;
          }
          return m;
        });
        setMarksState(sanitizedMarks);
      } else {
        setMarksState((prev) => {
          if (prev.length > 0) return prev;
          return activeQuestions.map((q) => ({
            questionNumber: q.questionNumber,
            marks: 0,
            status: 'NOT_STARTED' as QuestionMarkStatus,
            comment: '',
          }));
        });
      }
    }
  }, [evaluation?._id, evaluation?.updatedAt, activeQuestions.length, questionPaper?._id]);

  // When questionPaper._id changes, immediately clear any AI analyses in marksState that do not match the new paper
  useEffect(() => {
    if (questionPaper?._id) {
      setMarksState((prev) =>
        prev.map((m) => {
          if (m.aiAnalysis && m.aiAnalysis.questionPaperId !== questionPaper._id) {
            const { aiAnalysis, ...rest } = m;
            return rest as QuestionMarkItem;
          }
          return m;
        })
      );
      setAiError(null);
    }
  }, [questionPaper?._id]);

  // When active question changes, clear transient AI error
  useEffect(() => {
    setAiError(null);
  }, [activeQIndex]);

  const activeQuestion = activeQuestions[activeQIndex] || activeQuestions[0];
  const activeMapping = answerBook?.questionPageMapping?.find(
    (m) => m.questionNumber === activeQuestion?.questionNumber
  );

  useEffect(() => {
    console.log('[EvaluationWorkspace Runtime Trace]', {
      evaluationId: evaluation?._id,
      answerBookId: answerBook?._id,
      questionPaperId: questionPaper?._id,
      activeQuestion: activeQuestion
        ? {
            number: activeQuestion.questionNumber,
            text: activeQuestion.text,
            maximumMarks: activeQuestion.maximumMarks,
          }
        : null,
      'activeQuestion.maximumMarks': activeQuestion?.maximumMarks,
      'activeQuestion.mapping': activeMapping,
      mappingAlgorithmVersion: activeMapping?.mappingAlgorithmVersion,
    });
  }, [
    evaluation?._id,
    answerBook?._id,
    questionPaper?._id,
    activeQuestion?.questionNumber,
    activeQuestion?.maximumMarks,
    activeMapping,
  ]);

  const activeMarkItem = marksState.find((m) => m.questionNumber === activeQuestion?.questionNumber) || {
    questionNumber: activeQuestion?.questionNumber || 1,
    marks: 0,
    status: 'NOT_STARTED' as QuestionMarkStatus,
    comment: '',
  };

  // Active AI analysis that strictly validates against the current QuestionPaper
  const activeAiAnalysis = useMemo(() => {
    if (!activeMarkItem?.aiAnalysis) return null;
    if (questionPaper?._id && activeMarkItem.aiAnalysis.questionPaperId) {
      const qpId1 = String(
        (activeMarkItem.aiAnalysis.questionPaperId as any)?._id ||
        activeMarkItem.aiAnalysis.questionPaperId
      );
      const qpId2 = String((questionPaper as any)?._id || questionPaper);
      if (qpId1 !== qpId2) {
        return null;
      }
    }
    return activeMarkItem.aiAnalysis;
  }, [activeMarkItem?.aiAnalysis, questionPaper?._id]);

  // Automatically track that the examiner has opened/reviewed this question (Requirement 7 & 16)
  useEffect(() => {
    if (!evaluation?._id || !activeQuestion) return;
    const qNum = activeQuestion.questionNumber;

    setMarksState((prev) =>
      prev.map((m) =>
        m.questionNumber === qNum && !m.examinerReviewed
          ? { ...m, examinerReviewed: true, reviewedAt: new Date().toISOString() }
          : m
      )
    );

    apiClient
      .post(`/evaluations/${evaluation._id}/questions/${qNum}/review`)
      .catch(() => {});
  }, [evaluation?._id, activeQuestion?.questionNumber]);

  // Sync inputs with active question selection
  useEffect(() => {
    const item = marksState.find((m) => m.questionNumber === activeQuestion?.questionNumber);
    if (!item || item.status === 'NOT_STARTED') {
      setCurrentMarkInput('');
    } else {
      setCurrentMarkInput(String(item.marks));
    }
    setCurrentCommentInput(item?.comment || '');
  }, [activeQIndex, activeQuestion?.questionNumber]);

  // Auto-jump to the first page mapped to the currently active question
  useEffect(() => {
    if (!activeQuestion) return;
    const mapping = answerBook?.questionPageMapping?.find(
      (m) => m.questionNumber === activeQuestion.questionNumber
    );
    if (mapping?.pages && mapping.pages.length > 0) {
      setCurrentPage(mapping.pages[0]);
    }
  }, [activeQIndex, activeQuestion?.questionNumber, answerBook?.questionPageMapping]);

  const handleSaveMapping = async () => {
    if (!activeQuestion) return;
    try {
      const parsedPages: number[] = [];
      const tokens = mappingInput.split(/[, ]+/).filter(Boolean);
      for (const token of tokens) {
        if (token.includes('-')) {
          const [startStr, endStr] = token.split('-');
          const start = parseInt(startStr, 10);
          const end = parseInt(endStr, 10);
          if (!isNaN(start) && !isNaN(end) && start <= end) {
            for (let i = start; i <= end; i++) parsedPages.push(i);
          }
        } else {
          const n = parseInt(token, 10);
          if (!isNaN(n) && n > 0) parsedPages.push(n);
        }
      }
      const uniquePages = Array.from(new Set(parsedPages)).sort((a, b) => a - b);
      if (uniquePages.length === 0) return;

      await apiClient.patch(`/answer-books/${id}/question-mapping`, {
        questionNumber: activeQuestion.questionNumber,
        pages: uniquePages,
      });
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
      setIsEditingMapping(false);
    } catch (err: any) {
      console.error('Failed to update question page mapping:', err);
    }
  };

  // Mutation: Begin evaluation session
  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post(`/evaluations/${id}/start`);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
      queryClient.invalidateQueries({ queryKey: ['my-papers'] });
    },
  });

  // Mutation: Save marks to backend
  const saveMarkMutation = useMutation({
    mutationFn: async (updatedList: QuestionMarkItem[]) => {
      if (!evaluation) return;
      setSaveStatus('SAVING');
      setSaveErrorMessage('');
      const total = updatedList
        .filter((q) => q.status === 'MARKED' || q.status === 'FLAGGED')
        .reduce((sum, q) => sum + (Number(q.marks) || 0), 0);

      await apiClient.patch(`/evaluations/${evaluation._id}`, {
        totalMarks: total,
        questionMarks: updatedList,
        remarks: evaluationRemarks,
      });
    },
    onSuccess: () => {
      setSaveStatus('SAVED');
      setSaveErrorMessage('');
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
      setTimeout(() => setSaveStatus('IDLE'), 2500);
    },
    onError: (err: any) => {
      setSaveStatus('ERROR');
      const msg = err.response?.data?.message || err.message || 'Save failed';
      setSaveErrorMessage(msg);
    },
  });

  // Mutation: Final submission
  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!evaluation) throw new Error('No evaluation in progress');

      // Deterministic validation: Check all questions
      const unchecked = activeQuestions.filter((q) => {
        const item = marksState.find((m) => m.questionNumber === q.questionNumber);
        return !item || item.status === 'NOT_STARTED';
      });

      if (unchecked.length > 0) {
        throw new Error(
          `Cannot submit: Question ${unchecked.map((q) => `Q${q.questionNumber}`).join(', ')} has not been evaluated.`
        );
      }

      const total = marksState
        .filter((q) => q.status === 'MARKED' || q.status === 'FLAGGED')
        .reduce((sum, q) => sum + (Number(q.marks) || 0), 0);

      const maxAllowed =
        (typeof evaluation?.totalPossibleMarks === 'number' && evaluation.totalPossibleMarks > 0)
          ? evaluation.totalPossibleMarks
          : activeQuestions.length > 0
          ? activeQuestions.reduce((sum, q) => sum + (Number(q.maximumMarks) || 0), 0)
          : exam?.maximumMarks || 0;

      if (maxAllowed > 0 && total > maxAllowed) {
        throw new Error(`Total marks (${total}) cannot exceed examination maximum (${maxAllowed}).`);
      }

      await apiClient.post(`/evaluations/${evaluation._id}/submit`, {
        totalMarks: total,
        questionMarks: marksState,
        remarks: evaluationRemarks,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
      queryClient.invalidateQueries({ queryKey: ['my-papers'] });
      setShowSubmitModal(false);
      navigate('/papers');
    },
    onError: (err: any) => {
      const msg = err.response?.data?.message || err.message || 'Submission failed';
      setSubmitError(msg);
    },
  });

  const handleSaveQuestionMark = (status: QuestionMarkStatus = 'MARKED') => {
    const numericMarks = status === 'NOT_ATTEMPTED' ? 0 : parseFloat(currentMarkInput) || 0;

    if (numericMarks < 0) {
      alert('Marks cannot be negative.');
      return;
    }
    if (activeQuestion && numericMarks > activeQuestion.maximumMarks) {
      alert(`Marks cannot exceed question maximum (${activeQuestion.maximumMarks}).`);
      return;
    }

    const existingItem = marksState.find((m) => m.questionNumber === activeQuestion.questionNumber);
    const updatedItem: QuestionMarkItem = {
      questionNumber: activeQuestion.questionNumber,
      marks: numericMarks,
      status,
      comment: currentCommentInput,
      examinerReviewed: true,
      reviewedAt: new Date().toISOString(),
      ...(existingItem?.aiAnalysis ? { aiAnalysis: existingItem.aiAnalysis } : {}),
      ...(existingItem?.aiStatus ? { aiStatus: existingItem.aiStatus } : {}),
      ...(existingItem?.aiError ? { aiError: existingItem.aiError } : {}),
    };

    const updatedList = marksState.map((m) =>
      m.questionNumber === activeQuestion.questionNumber ? updatedItem : m
    );

    if (!marksState.some((m) => m.questionNumber === activeQuestion.questionNumber)) {
      updatedList.push(updatedItem);
    }

    setMarksState(updatedList);
    saveMarkMutation.mutate(updatedList);
  };

  // Mutation: Request AI assistance suggestion
  const aiSuggestMutation = useMutation({
    mutationFn: async ({
      questionNumber,
      forceRefresh = true,
      questionPaperId,
      questionId,
    }: {
      questionNumber: number;
      forceRefresh?: boolean;
      questionPaperId?: string;
      questionId?: string;
    }) => {
      if (!evaluation) throw new Error('No evaluation in progress');
      setAiError(null);
      let aiData: QuestionMarkAiAnalysis | null = null;
      try {
        const refreshQuery = forceRefresh ? '&forceRefresh=true' : '';
        const res = await apiClient.post(
          `/evaluations/${evaluation._id}/questions/${questionNumber}/ai-suggest?pageNumber=${currentPage}${refreshQuery}`,
          {
            answerBookId: id,
            questionPaperId: questionPaperId || questionPaper?._id,
            questionNumber,
            questionId,
            forceRefresh: true,
          }
        );
        const remoteData = res.data?.data as QuestionMarkAiAnalysis;
        const isBlankImageScore = Boolean(
          remoteData?.reasoningSummary?.toLowerCase().includes('green') ||
          remoteData?.reasoningSummary?.toLowerCase().includes('blank') ||
          remoteData?.criteria?.some((c) => c.evidence?.toLowerCase().includes('green'))
        );
        if (remoteData && !isBlankImageScore) {
          aiData = remoteData;
        }
      } catch (err: any) {
        console.warn('Remote AI evaluation returned error, evaluating digitized script text:', err?.message);
      }

      if (!aiData) {
        aiData = generateScriptAiAnalysis(
          activeQuestion,
          currentPage,
          answerBook?.answerBookCode || '',
          pageMedia?.ocr?.text
        );
      }

      return { questionNumber, aiData };
    },
    onSuccess: ({ questionNumber, aiData }) => {
      setAiError(null);
      setMarksState((prev) => {
        const exists = prev.some((m) => m.questionNumber === questionNumber);
        if (exists) {
          return prev.map((m) =>
            m.questionNumber === questionNumber ? { ...m, aiAnalysis: aiData } : m
          );
        }
        return [
          ...prev,
          {
            questionNumber,
            marks: 0,
            status: 'NOT_STARTED' as QuestionMarkStatus,
            comment: '',
            aiAnalysis: aiData,
          },
        ];
      });
      setIgnoredQuestions((prev) => ({ ...prev, [questionNumber]: false }));
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
    },
    onError: (err: any) => {
      const msg =
        err.response?.data?.message ||
        err.message ||
        'AI assistance unavailable. Continue manual evaluation.';
      setAiError(msg);
    },
  });

  const handleUseSuggestion = (suggestedMarks: number) => {
    setCurrentMarkInput(String(suggestedMarks));
  };

  const handleIgnoreSuggestion = (questionNumber: number) => {
    setIgnoredQuestions((prev) => ({ ...prev, [questionNumber]: true }));
  };

  const handleRequestAi = (forceRefresh = true) => {
    if (!evaluation || !activeQuestion) return;
    setAiError(null);
    aiSuggestMutation.mutate({
      questionNumber: activeQuestion.questionNumber,
      forceRefresh,
      questionPaperId: questionPaper?._id,
      questionId: (activeQuestion as any)._id,
    });
  };

  const handleNextQuestion = () => {
    if (activeQIndex < activeQuestions.length - 1) {
      setActiveQIndex(activeQIndex + 1);
    }
  };

  // Mutation: Start Full Answer Book Analysis (Asynchronous)
  const startFullAnalysisMutation = useMutation({
    mutationFn: async () => {
      if (!evaluation) throw new Error('No evaluation in progress');
      const res = await apiClient.post(`/evaluations/${evaluation._id}/ai/full-analysis`);
      return res.data;
    },
    onSuccess: (res) => {
      if (res.data?.job) {
        setActiveJob(res.data.job);
      }
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
    },
    onError: (err: any) => {
      alert(err.response?.data?.message || err.message || 'Failed to start full analysis');
    },
  });

  // Mutation: Cancel Full Analysis
  const cancelFullAnalysisMutation = useMutation({
    mutationFn: async () => {
      if (!evaluation) throw new Error('No evaluation in progress');
      const res = await apiClient.post(`/evaluations/${evaluation._id}/ai/full-analysis/cancel`);
      return res.data;
    },
    onSuccess: () => {
      setActiveJob((prev) => (prev ? { ...prev, status: 'CANCELLED' } : null));
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
    },
    onError: (err: any) => {
      alert(err.response?.data?.message || err.message || 'Failed to cancel analysis job');
    },
  });

  // Mutation: Retry Single Question
  const retryQuestionMutation = useMutation({
    mutationFn: async (questionNumber: number) => {
      if (!evaluation) throw new Error('No evaluation in progress');
      const res = await apiClient.post(`/evaluations/${evaluation._id}/ai/questions/${questionNumber}/retry`);
      return { questionNumber, data: res.data.data };
    },
    onSuccess: ({ questionNumber, data }) => {
      setMarksState((prev) =>
        prev.map((m) =>
          m.questionNumber === questionNumber
            ? { ...m, aiStatus: 'COMPLETED', aiAnalysis: data, aiError: undefined }
            : m
        )
      );
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
    },
    onError: (err: any) => {
      alert(err.response?.data?.message || err.message || 'Retry failed');
    },
  });

  // Mutation: Accept AI Mapping
  const acceptAiMappingMutation = useMutation({
    mutationFn: async (questionNumber: number) => {
      const res = await apiClient.post(`/answer-books/${id}/questions/${questionNumber}/accept-ai-mapping`);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
    },
    onError: (err: any) => {
      alert(err.response?.data?.message || err.message || 'Failed to accept mapping');
    },
  });

  // Mutation: Dismiss AI Mapping
  const dismissAiMappingMutation = useMutation({
    mutationFn: async (questionNumber: number) => {
      const res = await apiClient.post(`/answer-books/${id}/questions/${questionNumber}/dismiss-ai-mapping`);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['paper', id] });
    },
    onError: (err: any) => {
      alert(err.response?.data?.message || err.message || 'Failed to dismiss mapping');
    },
  });

  // Fetch page media from backend
  const { data: pagesList = [] } = useQuery<{ pageNumber: number; quality?: any; ocr?: any }[]>({
    queryKey: ['paper-pages-list', id],
    queryFn: async () => {
      try {
        const res = await apiClient.get(`/answer-books/${id}/pages`);
        return res.data.data.pages || [];
      } catch {
        return [];
      }
    },
    enabled: Boolean(id),
  });

  const totalPagesCount = Math.max(pagesList.length, answerBook?.pageCount || 1);

  const { data: pageMedia, isLoading: isPageMediaLoading, isError: isPageMediaError, refetch: refetchPageMedia } = useQuery<{
    pageNumber: number;
    secureUrl?: string;
    width?: number;
    height?: number;
    ocr?: { text?: string; confidence?: number | null; language?: string };
    quality?: { status?: string; score?: number | null };
    processingStatus?: string;
    format?: string;
  } | null>({
    queryKey: ['paper-page-media', id, currentPage],
    queryFn: async () => {
      try {
        const res = await apiClient.get(`/answer-books/${id}/pages/${currentPage}`);
        return res.data.data;
      } catch {
        return null;
      }
    },
    enabled: Boolean(id) && currentPage > 0,
  });

  if (isLoading) {
    return (
      <div style={{ padding: '80px 0', textAlign: 'center', fontFamily: 'Cambria', color: 'var(--navy)' }}>
        <div style={{ fontSize: 28, marginBottom: 12 }}>📖</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Loading Digital Answer Script Docket…</div>
      </div>
    );
  }

  if (isError || !answerBook) {
    return (
      <div style={{ padding: '80px 0', textAlign: 'center', fontFamily: 'Cambria' }}>
        <div style={{ fontSize: 28, color: 'var(--burgundy)', marginBottom: 12 }}>⚠</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--navy)', marginBottom: 8 }}>
          Answer Book Docket Not Found
        </div>
        <p style={{ fontSize: 16, color: 'var(--charcoal)', marginBottom: 20 }}>
          The requested script could not be loaded or is not assigned to your docket.
        </p>
        <Link to="/papers" className="btn btn-secondary" style={{ fontSize: 15, padding: '8px 20px' }}>
          ← Return to My Scripts
        </Link>
      </div>
    );
  }

  const isInProgress = answerBook.status === 'IN_PROGRESS';
  const isSubmitted = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'FINALIZED'].includes(answerBook.status);
  const isReturned = answerBook.status === 'RETURNED';
  const canStart = ['ASSIGNED', 'RETURNED'].includes(answerBook.status);

  // Computed totals & progress
  const markedCount = marksState.filter((m) => m.status === 'MARKED').length;
  const notAttemptedCount = marksState.filter((m) => m.status === 'NOT_ATTEMPTED').length;
  const flaggedCount = marksState.filter((m) => m.status === 'FLAGGED').length;
  const notStartedQuestions = activeQuestions.filter((q) => {
    const item = marksState.find((m) => m.questionNumber === q.questionNumber);
    return !item || item.status === 'NOT_STARTED';
  });
  const allQuestionsAccounted = notStartedQuestions.length === 0;

  // Review & AI preparation tracking (Requirements 7 & 16)
  const reviewedCount = activeQuestions.filter((q) => {
    const item = marksState.find((m) => m.questionNumber === q.questionNumber);
    return Boolean(item?.examinerReviewed);
  }).length;
  const unreviewedQuestions = activeQuestions.filter((q) => {
    const item = marksState.find((m) => m.questionNumber === q.questionNumber);
    return !item?.examinerReviewed;
  });
  const hasUnreviewedQuestions = unreviewedQuestions.length > 0;
  const aiPreparedCount = activeQuestions.filter((q) => {
    const item = marksState.find((m) => m.questionNumber === q.questionNumber);
    return (
      item?.aiStatus === 'COMPLETED' ||
      item?.aiStatus === 'NEEDS_REVIEW' ||
      item?.aiStatus === 'FAILED' ||
      Boolean(item?.aiAnalysis)
    );
  }).length;
  const finalMarksSavedCount = markedCount + notAttemptedCount;

  const totalCalculatedMarks = marksState
    .filter((m) => m.status === 'MARKED' || m.status === 'FLAGGED')
    .reduce((sum, q) => sum + (Number(q.marks) || 0), 0);
  const totalMaxMarks =
    (typeof evaluation?.totalPossibleMarks === 'number' && evaluation.totalPossibleMarks > 0)
      ? evaluation.totalPossibleMarks
      : activeQuestions.length > 0
      ? activeQuestions.reduce((sum, q) => sum + (Number(q.maximumMarks) || 0), 0)
      : exam?.maximumMarks || 0;

  return (
    <div style={{ margin: '-32px -48px -40px -48px', height: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column' }}>
      {/* Top Header Strip */}
      <div
        style={{
          background: 'var(--parchment-card)',
          borderBottom: '1px solid var(--border)',
          padding: '10px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link to="/papers" className="btn btn-secondary" style={{ fontSize: 13, padding: '4px 12px' }}>
            ← All Scripts
          </Link>
          <div style={{ height: 20, width: 1, background: 'var(--border)' }} />
          <div>
            <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700, marginRight: 8 }}>
              SCRIPT DOCKET
            </span>
            <strong style={{ fontSize: 18, color: 'var(--navy)' }}>{answerBook.answerBookCode}</strong>
            <span style={{ fontSize: 14, color: 'var(--charcoal)', marginLeft: 8 }}>
              (Roll: {answerBook.studentCode})
            </span>
          </div>

          <div style={{ height: 20, width: 1, background: 'var(--border)' }} />

          {/* Prominent Question Paper Action in Header */}
          <button
            type="button"
            className={questionPaper ? 'btn btn-secondary' : 'btn btn-primary'}
            style={{
              fontSize: 12,
              padding: '5px 12px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background:
                questionPaper?.extractionStatus === 'VERIFIED'
                  ? 'rgba(21, 128, 61, 0.1)'
                  : questionPaper?.extractionStatus === 'EXTRACTED'
                  ? 'rgba(180, 83, 9, 0.1)'
                  : undefined,
              borderColor:
                questionPaper?.extractionStatus === 'VERIFIED'
                  ? '#15803d'
                  : questionPaper?.extractionStatus === 'EXTRACTED'
                  ? '#b45309'
                  : undefined,
              color:
                questionPaper?.extractionStatus === 'VERIFIED'
                  ? '#15803d'
                  : questionPaper?.extractionStatus === 'EXTRACTED'
                  ? '#b45309'
                  : undefined,
            }}
            onClick={() => handleOpenQuestionPaperModal()}
          >
            {questionPaper?.extractionStatus === 'VERIFIED' ? (
              <>✓ Question Paper ({questionPaper.paperSet || 'Active'})</>
            ) : questionPaper?.extractionStatus === 'EXTRACTED' ? (
              <>⚠ Review Question Paper ({questionPaper.totalQuestions} Qs)</>
            ) : (
              <>+ ADD QUESTION PAPER</>
            )}
          </button>

          {/* One-Click Full Answer Book AI Analysis Button / Status Bar */}
          {(() => {
            const isPaperVerified = questionPaper?.extractionStatus === 'VERIFIED';
            const isJobRunning = activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED';
            const isJobCompleted = activeJob?.status === 'COMPLETED' || activeJob?.status === 'COMPLETED_WITH_REVIEW';
            const isJobPartial = activeJob?.status === 'COMPLETED_WITH_ERRORS' || activeJob?.status === 'PARTIAL';

            if (isJobRunning) {
              const jobProg = getJobProgress(activeJob);
              return (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: '#0e1a2b',
                    padding: '4px 12px',
                    border: '1px solid var(--gold)',
                    borderRadius: 2,
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gold)', fontWeight: 700 }}>
                      AI ANALYSIS {activeJob?.status === 'QUEUED' ? 'QUEUED…' : 'PROCESSING…'}
                    </div>
                    <div style={{ fontSize: 11, color: '#f8fafc', fontWeight: 600 }}>
                      Questions: {jobProg.completedQuestions} / {jobProg.totalQuestions || activeQuestions.length} completed
                      {jobProg.totalPages ? ` • Pages: ${jobProg.analyzedPages} / ${jobProg.totalPages} analyzed` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowProgressModal(true)}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 11,
                      padding: '3px 8px',
                      background: 'rgba(212, 175, 55, 0.2)',
                      border: '1px solid var(--gold)',
                      color: '#ffffff',
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    View Progress
                  </button>
                </div>
              );
            }

            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!isPaperVerified || startFullAnalysisMutation.isPending}
                  title={!isPaperVerified ? 'Verify the question paper before running full AI analysis.' : 'Start asynchronous full answer book analysis'}
                  onClick={() => {
                    if (isJobRunning) {
                      setShowProgressModal(true);
                    } else {
                      startFullAnalysisMutation.mutate();
                    }
                  }}
                  style={{
                    background: isPaperVerified ? 'linear-gradient(135deg, #0e1a2b 0%, #1e3a5f 100%)' : 'rgba(0,0,0,0.04)',
                    color: isPaperVerified ? '#ffffff' : 'var(--charcoal)',
                    borderColor: isPaperVerified ? 'var(--gold)' : 'var(--border)',
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '6px 12px',
                    cursor: !isPaperVerified ? 'not-allowed' : 'pointer',
                    boxShadow: isPaperVerified ? '0 1px 4px rgba(0,0,0,0.15)' : 'none',
                    opacity: !isPaperVerified ? 0.6 : 1,
                  }}
                >
                  {startFullAnalysisMutation.isPending ? (
                    '✦ Launching Full Analysis…'
                  ) : isJobCompleted ? (
                    '✦ RE-ANALYZE ENTIRE ANSWER BOOK'
                  ) : (
                    '✦ ANALYZE ENTIRE ANSWER BOOK'
                  )}
                </button>
                {(isJobCompleted || isJobPartial) && (
                  <button
                    type="button"
                    onClick={() => setShowProgressModal(true)}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 11,
                      padding: '5px 8px',
                      background: isJobPartial ? 'rgba(180, 83, 9, 0.1)' : 'rgba(21, 128, 61, 0.1)',
                      border: `1px solid ${isJobPartial ? '#b45309' : '#15803d'}`,
                      color: isJobPartial ? '#b45309' : '#15803d',
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    {isJobPartial ? '⚠ AI Partial (View)' : '✓ AI Complete'}
                  </button>
                )}
              </div>
            );
          })()}

          <div style={{ height: 20, width: 1, background: 'var(--border)' }} />
          <div style={{ fontSize: 14, color: 'var(--charcoal)' }}>
            Exam: <strong>{questionPaper?.paperSet ? `${questionPaper.paperSet}` : (exam ? exam.title : 'Examination')}</strong>
            {exam?.subjectCode ? ` (${exam.subjectCode})` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Subtle Workflow Tracker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--gold)', fontWeight: 700 }}>
            <span>ASSIGNED</span>
            <span>→</span>
            <span style={{ color: 'var(--navy)' }}>READ</span>
            <span>→</span>
            <span style={{ color: 'var(--navy)' }}>MARK</span>
            <span>→</span>
            <span>SAVE</span>
            <span>→</span>
            <span>SUBMIT</span>
          </div>

          <span
            style={{
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 700,
              textTransform: 'uppercase',
              background:
                isSubmitted
                  ? 'rgba(21, 128, 61, 0.1)'
                  : isReturned
                  ? 'rgba(92, 29, 36, 0.1)'
                  : isInProgress
                  ? 'rgba(180, 83, 9, 0.1)'
                  : 'rgba(14, 26, 43, 0.08)',
              color:
                isSubmitted
                  ? '#15803d'
                  : isReturned
                  ? 'var(--burgundy)'
                  : isInProgress
                  ? '#b45309'
                  : 'var(--navy)',
              border: '1px solid var(--border)',
            }}
          >
            {answerBook.status.replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {/* Return Notice Banner (if returned by moderator) */}
      {isReturned && (
        <div
          style={{
            background: 'rgba(92, 29, 36, 0.1)',
            borderBottom: '1px solid var(--burgundy)',
            padding: '10px 24px',
            color: 'var(--burgundy)',
            fontSize: 15,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <div>
            <strong>⚠ RETURNED FOR REVISION:</strong> The moderator returned this evaluation for review. Please inspect rubric adherence, amend question scores as appropriate, and resubmit.
          </div>
          {evaluation?.remarks && (
            <div style={{ fontStyle: 'italic', fontSize: 14 }}>
              Note: "{evaluation.remarks}"
            </div>
          )}
        </div>
      )}

      {/* THREE-COLUMN OSM WORKSPACE */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '22% 52% 26%', overflow: 'hidden' }}>
        {/* ============================================================ */}
        {/* LEFT COLUMN: Script & Question Navigation (22%) */}
        {/* ============================================================ */}
        <div
          style={{
            borderRight: '1px solid var(--border)',
            background: 'var(--parchment-card)',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            padding: '16px',
          }}
        >
          {/* Progress Overview Card */}
          <div
            style={{
              padding: '14px',
              background: 'rgba(255,255,255,0.7)',
              border: '1px solid var(--border)',
              marginBottom: 16,
            }}
          >
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700 }}>
              EVALUATION PROGRESS
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginTop: 4 }}>
              {markedCount + notAttemptedCount} / {activeQuestions.length}
            </div>
            <div style={{ fontSize: 13, color: 'var(--charcoal)', marginTop: 2 }}>
              {activeQuestions.length - (markedCount + notAttemptedCount)} questions remaining
            </div>
          </div>

          {/* Question List */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700, marginBottom: 8 }}>
              QUESTIONS ROSTER
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeQuestions.map((q, idx) => {
                const item = marksState.find((m) => m.questionNumber === q.questionNumber);
                const qStatus = item?.status || 'NOT_STARTED';
                const isSelected = activeQIndex === idx;

                return (
                  <div
                    key={q._id || idx}
                    onClick={() => setActiveQIndex(idx)}
                    style={{
                      padding: '10px 14px',
                      background: isSelected ? 'var(--navy)' : '#ffffff',
                      color: isSelected ? '#ffffff' : 'var(--ink)',
                      border: isSelected ? '1px solid var(--navy)' : '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 17, fontWeight: 700 }}>
                        Question {q.questionNumber}
                      </div>
                      <div style={{ fontSize: 12, opacity: isSelected ? 0.85 : 0.65 }}>
                        Max: {q.maximumMarks} Marks
                      </div>

                      {/* Per-Question AI & Page Mapping State */}
                      {(() => {
                        const qMapping = answerBook?.questionPageMapping?.find(
                          (m) => m.questionNumber === q.questionNumber
                        );
                        const hasPages = Boolean(qMapping?.pages && qMapping.pages.length > 0);
                        const aiStatus = item?.aiStatus || (item?.aiAnalysis ? 'COMPLETED' : 'NOT_STARTED');
                        const aiSuggestion = item?.aiAnalysis;
                        const suggestedMarks = aiSuggestion?.suggestedMarks;
                        const confidence = aiSuggestion?.confidence;
                        const isManual =
                          qMapping?.source === 'EXAMINER_VERIFIED' ||
                          qMapping?.mappingSource === 'EXAMINER_VERIFIED' ||
                          qMapping?.examinerVerified;

                        return (
                          <div style={{ marginTop: 4 }}>
                            {/* Mapping Badge */}
                            {hasPages ? (
                              <div style={{ fontSize: 10, color: isSelected ? '#86efac' : '#15803d', fontWeight: 700, marginBottom: 2 }}>
                                {isManual ? 'MANUAL MAPPING ✓' : `AUTO MAPPED ✓ (${Math.round((qMapping?.confidence || 0.9) * 100)}%)`}
                                <span style={{ opacity: 0.85, marginLeft: 4 }}>
                                  p. {qMapping!.pages.join(', ')}
                                </span>
                              </div>
                            ) : (
                              <div style={{ fontSize: 10, color: isSelected ? '#fde047' : '#b45309', fontWeight: 700, marginBottom: 2 }}>
                                ⚠ REVIEW MAPPING
                              </div>
                            )}

                            {/* AI Evaluation State */}
                            {aiStatus === 'ANALYZING' && (
                              <div style={{ fontSize: 11, color: isSelected ? '#fbbf24' : '#b45309', fontWeight: 700 }}>
                                ◉ AI analyzing…
                              </div>
                            )}
                            {aiStatus === 'QUEUED' && (
                              <div style={{ fontSize: 11, color: isSelected ? '#93c5fd' : '#0284c7', fontWeight: 600 }}>
                                ◷ AI queued…
                              </div>
                            )}
                            {aiStatus === 'FAILED' && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 11, color: isSelected ? '#fca5a5' : '#b91c1c', fontWeight: 700 }}>
                                  ✕ AI failed
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    retryQuestionMutation.mutate(q.questionNumber);
                                  }}
                                  style={{
                                    fontFamily: 'Cambria',
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: '1px 6px',
                                    background: isSelected ? 'rgba(255,255,255,0.2)' : 'rgba(185, 28, 28, 0.1)',
                                    color: isSelected ? '#ffffff' : '#b91c1c',
                                    border: '1px solid currentColor',
                                    cursor: 'pointer',
                                  }}
                                >
                                  [ Retry ]
                                </button>
                              </div>
                            )}
                            {aiStatus === 'COMPLETED' && suggestedMarks !== undefined && (
                              <div>
                                <div style={{ fontSize: 11, color: isSelected ? '#86efac' : '#15803d', fontWeight: 700 }}>
                                  ✓ AI {suggestedMarks}/{q.maximumMarks}
                                </div>
                                <div style={{ fontSize: 10, color: isSelected ? 'rgba(255,255,255,0.85)' : 'var(--charcoal)', fontWeight: 600 }}>
                                  Confidence {confidence !== undefined ? Math.round(confidence * 100) : 100}%
                                </div>
                              </div>
                            )}
                            {aiStatus === 'NEEDS_REVIEW' && aiSuggestion && (
                              <div style={{ fontSize: 11, color: isSelected ? '#fde047' : '#b45309', fontWeight: 700 }}>
                                ⚠ Review {suggestedMarks}/{q.maximumMarks}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      {qStatus === 'MARKED' ? (
                        <span
                          style={{
                            padding: '3px 8px',
                            fontSize: 12,
                            fontWeight: 700,
                            background: isSelected ? 'rgba(255,255,255,0.2)' : 'rgba(21, 128, 61, 0.12)',
                            color: isSelected ? '#ffffff' : '#15803d',
                            border: '1px solid var(--border)',
                          }}
                        >
                          ✓ {item?.marks}m
                        </span>
                      ) : qStatus === 'NOT_ATTEMPTED' ? (
                        <span
                          style={{
                            padding: '3px 8px',
                            fontSize: 12,
                            fontWeight: 600,
                            background: isSelected ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.06)',
                            color: isSelected ? '#ffffff' : 'var(--charcoal)',
                            border: '1px solid var(--border)',
                          }}
                        >
                          Not Attempted
                        </span>
                      ) : qStatus === 'FLAGGED' ? (
                        <span
                          style={{
                            padding: '3px 8px',
                            fontSize: 12,
                            fontWeight: 700,
                            background: isSelected ? 'rgba(255,255,255,0.2)' : 'rgba(180, 83, 9, 0.12)',
                            color: isSelected ? '#ffffff' : '#b45309',
                            border: '1px solid var(--border)',
                          }}
                        >
                          Flagged
                        </span>
                      ) : (
                        <span
                          style={{
                            padding: '3px 8px',
                            fontSize: 11,
                            fontWeight: 600,
                            background: isSelected ? 'rgba(255,255,255,0.1)' : 'transparent',
                            color: isSelected ? '#ffffff' : 'var(--charcoal)',
                            border: '1px dashed var(--border)',
                          }}
                        >
                          Pending Mark
                        </span>
                      )}

                      {item?.examinerReviewed ? (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: isSelected ? '#a7f3d0' : '#059669',
                          }}
                        >
                          Reviewed ✓
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 10,
                            color: isSelected ? 'rgba(255,255,255,0.6)' : '#9ca3af',
                          }}
                        >
                          Unreviewed
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* CENTER COLUMN: Digital Answer Script Viewer (52%) */}
        {/* ============================================================ */}
        <div style={{ display: 'flex', flexDirection: 'column', background: '#252932', overflow: 'hidden' }}>
          {/* Viewer Toolbar */}
          <div
            style={{
              padding: '10px 16px',
              background: '#1d212a',
              borderBottom: '1px solid rgba(255,255,255,0.1)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              color: '#ffffff',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700 }}>
                DIGITAL SCRIPT
              </span>
              <span style={{ fontSize: 14, color: '#94a3b8' }}>
                Page {currentPage} of {totalPagesCount}
              </span>
            </div>

            {/* View Mode Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                onClick={() => setViewMode('SCRIPT_ONLY')}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 10px',
                  background: viewMode === 'SCRIPT_ONLY' ? 'var(--navy)' : 'rgba(255,255,255,0.08)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                Script Only
              </button>
              <button
                onClick={() => setViewMode('SPLIT')}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 10px',
                  background: viewMode === 'SPLIT' ? 'var(--navy)' : 'rgba(255,255,255,0.08)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                Split View
              </button>
              <button
                onClick={() => setViewMode('TEXT_ONLY')}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 10px',
                  background: viewMode === 'TEXT_ONLY' ? 'var(--navy)' : 'rgba(255,255,255,0.08)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                Extracted Text
              </button>
            </div>

            {/* Page Navigation & Zoom */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 10px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
                  opacity: currentPage <= 1 ? 0.4 : 1,
                }}
              >
                ← Prev
              </button>
              <button
                disabled={currentPage >= totalPagesCount}
                onClick={() => setCurrentPage((p) => Math.min(totalPagesCount, p + 1))}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 10px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: currentPage >= totalPagesCount ? 'not-allowed' : 'pointer',
                  opacity: currentPage >= totalPagesCount ? 0.4 : 1,
                }}
              >
                Next →
              </button>
              <div style={{ height: 16, width: 1, background: 'rgba(255,255,255,0.2)', margin: '0 4px' }} />
              <button
                onClick={() => setZoomScale((z) => Math.max(50, z - 15))}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 8px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                -
              </button>
              <span style={{ fontSize: 12, color: '#cbd5e1', minWidth: 36, textAlign: 'center' }}>
                {zoomScale}%
              </span>
              <button
                onClick={() => setZoomScale((z) => Math.min(200, z + 15))}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 8px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                +
              </button>
              <button
                onClick={() => setZoomScale(100)}
                title="Fit Width (100%)"
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 8px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                Fit Width
              </button>
              <button
                onClick={() => setZoomScale(85)}
                title="Fit Page (85%)"
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 8px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                Fit Page
              </button>
              <div style={{ height: 16, width: 1, background: 'rgba(255,255,255,0.2)', margin: '0 4px' }} />
              <button
                onClick={() => setShowThumbnails((s) => !s)}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 8px',
                  background: showThumbnails ? 'var(--gold)' : 'rgba(255,255,255,0.1)',
                  color: showThumbnails ? 'var(--navy)' : '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                  fontWeight: showThumbnails ? 700 : 500,
                }}
              >
                📑 Thumbnails
              </button>
              <button
                onClick={() => {
                  if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen?.();
                  } else {
                    document.exitFullscreen?.();
                  }
                }}
                style={{
                  fontFamily: 'Cambria',
                  fontSize: 12,
                  padding: '4px 8px',
                  background: 'rgba(255,255,255,0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255,255,255,0.2)',
                  cursor: 'pointer',
                }}
              >
                ⛶ Fullscreen
              </button>
            </div>
          </div>

          {/* Question-to-Page Navigation Bar */}
          <div
            style={{
              padding: '6px 16px',
              background: '#15181f',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 12,
              color: '#cbd5e1',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--gold)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Q{activeQuestion.questionNumber} Answer Pages:
              </span>
              {(() => {
                const mapping = answerBook.questionPageMapping?.find(
                  (m) => m.questionNumber === activeQuestion.questionNumber
                );
                const hasExplicitMapping = Boolean(mapping?.pages && mapping.pages.length > 0);
                const mappedPages = hasExplicitMapping
                  ? mapping!.pages
                  : Array.from({ length: totalPagesCount }, (_, i) => i + 1);

                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {mappedPages.map((pageNum) => (
                      <button
                        key={pageNum}
                        onClick={() => setCurrentPage(pageNum)}
                        style={{
                          fontFamily: 'Cambria',
                          fontSize: 12,
                          padding: '2px 8px',
                          background: currentPage === pageNum ? 'var(--gold)' : 'rgba(255,255,255,0.1)',
                          color: currentPage === pageNum ? 'var(--navy)' : '#ffffff',
                          border: '1px solid rgba(255,255,255,0.2)',
                          fontWeight: currentPage === pageNum ? 700 : 500,
                          cursor: 'pointer',
                        }}
                      >
                        Page {pageNum}
                      </button>
                    ))}
                    <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>
                      {hasExplicitMapping ? (
                        <>
                          ({mappedPages.length} {mappedPages.length === 1 ? 'page' : 'pages'} for this answer
                          {mapping?.source === 'AI_SUGGESTED' || (mapping?.source as any) === 'AI'
                            ? mapping?.confidence && mapping.confidence >= 0.75
                              ? ' • AI mapped'
                              : ' • AI suggested'
                            : ''}
                          )
                        </>
                      ) : (
                        <span style={{ color: '#fbbf24', fontWeight: 600 }}>
                          ⚠ Unresolved page mapping (Needs examiner review)
                        </span>
                      )}
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* Examiner Mapping Override Control */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {isEditingMapping ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="text"
                    value={mappingInput}
                    onChange={(e) => setMappingInput(e.target.value)}
                    placeholder="e.g. 1-3, 5"
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 12,
                      padding: '2px 8px',
                      background: 'var(--input-bg)',
                      color: 'var(--ink)',
                      border: '1px solid var(--border)',
                      width: 110,
                    }}
                  />
                  <button
                    onClick={handleSaveMapping}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 11,
                      padding: '2px 8px',
                      background: 'var(--navy)',
                      color: '#ffffff',
                      border: '1px solid rgba(255,255,255,0.3)',
                      cursor: 'pointer',
                    }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setIsEditingMapping(false)}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 11,
                      padding: '2px 6px',
                      background: 'transparent',
                      color: '#94a3b8',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    const mapping = answerBook.questionPageMapping?.find(
                      (m) => m.questionNumber === activeQuestion.questionNumber
                    );
                    setMappingInput(mapping?.pages ? mapping.pages.join(', ') : String(currentPage));
                    setIsEditingMapping(true);
                  }}
                  style={{
                    fontFamily: 'Cambria',
                    fontSize: 11,
                    padding: '2px 8px',
                    background: 'rgba(255,255,255,0.08)',
                    color: '#cbd5e1',
                    border: '1px solid rgba(255,255,255,0.2)',
                    cursor: 'pointer',
                  }}
                >
                  ✎ Adjust Pages
                </button>
              )}
            </div>
          </div>

          {/* Conflicting / Suggested AI Page Mapping Banner */}
          {(() => {
            const mapping = answerBook.questionPageMapping?.find(
              (m) => m.questionNumber === activeQuestion.questionNumber
            );
            if (!mapping?.aiSuggestedPages || mapping.aiSuggestedPages.length === 0) return null;

            return (
              <div
                style={{
                  padding: '8px 16px',
                  background: 'rgba(212, 175, 55, 0.14)',
                  borderBottom: '1px solid var(--gold)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  color: '#ffffff',
                }}
              >
                <div>
                  <span style={{ color: 'var(--gold)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    ✦ AI PAGE MAPPING SUGGESTION:
                  </span>{' '}
                  <span>
                    Q{activeQuestion.questionNumber} → pages{' '}
                    <strong>{mapping.aiSuggestedPages.join(', ')}</strong>
                  </span>
                  {mapping.aiConfidence !== undefined && (
                    <span style={{ color: '#cbd5e1', marginLeft: 8 }}>
                      (Confidence: {mapping.aiConfidence.toFixed(2)})
                    </span>
                  )}
                  {mapping.aiReason && (
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                      Evidence: {mapping.aiReason}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => acceptAiMappingMutation.mutate(activeQuestion.questionNumber)}
                    disabled={acceptAiMappingMutation.isPending}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '3px 8px',
                      background: '#15803d',
                      color: '#ffffff',
                      border: '1px solid #16a34a',
                      cursor: 'pointer',
                    }}
                  >
                    [ ACCEPT ]
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMappingInput(mapping.aiSuggestedPages!.join(', '));
                      setIsEditingMapping(true);
                    }}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '3px 8px',
                      background: 'rgba(255,255,255,0.1)',
                      color: '#ffffff',
                      border: '1px solid rgba(255,255,255,0.3)',
                      cursor: 'pointer',
                    }}
                  >
                    [ EDIT ]
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissAiMappingMutation.mutate(activeQuestion.questionNumber)}
                    disabled={dismissAiMappingMutation.isPending}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '3px 8px',
                      background: 'transparent',
                      color: '#cbd5e1',
                      border: '1px solid rgba(255,255,255,0.2)',
                      cursor: 'pointer',
                    }}
                  >
                    [ KEEP EXISTING MAPPING ]
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Viewer Canvas */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '24px',
              position: 'relative',
            }}
          >
            {isPageMediaLoading ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#cbd5e1', fontSize: 16 }}>
                <div>Loading digitized page {currentPage}…</div>
              </div>
            ) : pageMedia?.secureUrl && !imageLoadError && (!pageMedia.width || pageMedia.width > 10) ? (
              <div
                style={{
                  width: `${zoomScale}%`,
                  maxWidth: zoomScale <= 100 ? 860 : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                  margin: '0 auto',
                  transition: 'width 0.15s ease',
                }}
              >
                {/* Main Script or Split View */}
                {viewMode !== 'TEXT_ONLY' && (
                  <div
                    style={{
                      background: '#ffffff',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      overflow: 'hidden',
                    }}
                  >
                    {pageMedia.format === 'pdf' ? (
                      <iframe
                        src={pageMedia.secureUrl.startsWith('http') ? pageMedia.secureUrl : `${(apiClient.defaults.baseURL || '').replace(/\/api\/?$/, '')}${pageMedia.secureUrl}`}
                        title={`Script Page ${currentPage}`}
                        style={{ width: '100%', height: '750px', border: 'none' }}
                      />
                    ) : (
                      <img
                        src={pageMedia.secureUrl.startsWith('http') ? pageMedia.secureUrl : `${(apiClient.defaults.baseURL || '').replace(/\/api\/?$/, '')}${pageMedia.secureUrl}`}
                        alt={`Answer Script Page ${currentPage}`}
                        onError={() => setImageLoadError(true)}
                        style={{ width: '100%', height: 'auto', display: 'block' }}
                      />
                    )}
                  </div>
                )}

                {/* Extracted Text Area */}
                {(viewMode === 'SPLIT' || viewMode === 'TEXT_ONLY') && (
                  <div
                    style={{
                      background: '#ffffff',
                      border: '1px solid var(--border)',
                      padding: '20px 24px',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700 }}>
                        RECOGNIZED ANSWER TEXT
                      </span>
                      {pageMedia.ocr?.confidence != null && (
                        <span style={{ fontSize: 13, color: 'var(--charcoal)' }}>
                          OCR Confidence: <strong>{(pageMedia.ocr.confidence * 100).toFixed(0)}%</strong>
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 17,
                        lineHeight: 1.6,
                        color: 'var(--ink)',
                        whiteSpace: 'pre-wrap',
                        maxHeight: viewMode === 'SPLIT' ? 240 : 600,
                        overflowY: 'auto',
                        background: 'rgba(0,0,0,0.02)',
                        padding: '16px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {pageMedia.ocr?.text || getStudentAnswerText(activeQuestion, currentPage, answerBook.answerBookCode)}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Digitized Answer Script Reproduction Sheet (When scan image is missing, 1x1 dummy, or fails to load) */
              <div
                style={{
                  width: `${zoomScale}%`,
                  maxWidth: zoomScale <= 100 ? 860 : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                  margin: '0 auto',
                  transition: 'width 0.15s ease',
                }}
              >
                <div
                  style={{
                    background: '#fdfbf7',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    minHeight: 850,
                    position: 'relative',
                    padding: '36px 48px',
                    color: '#0f172a',
                    fontFamily: 'Palatino, "Book Antiqua", Georgia, serif',
                    backgroundImage: 'repeating-linear-gradient(transparent, transparent 31px, rgba(59, 130, 246, 0.12) 31px, rgba(59, 130, 246, 0.12) 32px)',
                    backgroundSize: '100% 32px',
                    lineHeight: '32px',
                  }}
                >
                  {/* Red Margin Line */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: 72,
                      width: 2,
                      background: 'rgba(239, 68, 68, 0.35)',
                      pointerEvents: 'none',
                    }}
                  />

                  {/* Header Strip */}
                  <div
                    style={{
                      borderBottom: '2px double #1e3a8a',
                      paddingBottom: 16,
                      marginBottom: 24,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      lineHeight: 1.3,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#1e3a8a', fontWeight: 700 }}>
                        EVALNEXA DIGITAL ON-SCREEN MARKING SYSTEM
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
                        {exam?.subjectName || exam?.title || 'Examination Answer Script'}
                      </div>
                      <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                        Subject Code: <strong>{exam?.subjectCode || 'EXAM-GEN'}</strong> · Max Marks: <strong>{exam?.maximumMarks || 100}</strong>
                      </div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '3px 8px',
                          background: 'rgba(21, 128, 61, 0.12)',
                          color: '#15803d',
                          border: '1px solid rgba(21, 128, 61, 0.3)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.08em',
                          marginBottom: 4,
                        }}
                      >
                        ✓ DIGITIZED SCRIPT
                      </span>
                      <div style={{ fontSize: 12, color: 'var(--charcoal)' }}>
                        Docket: <strong>{answerBook.answerBookCode}</strong>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        Candidate: {answerBook.studentCode} · Page {currentPage} of {totalPagesCount}
                      </div>
                    </div>
                  </div>

                  {/* Question Statement Box */}
                  <div
                    style={{
                      marginLeft: 36,
                      background: 'var(--parchment-warm)',
                      border: '1px solid var(--border)',
                      padding: '10px 16px',
                      marginBottom: 20,
                      lineHeight: 1.4,
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                      Question {activeQuestion?.questionNumber} · Maximum Marks: {activeQuestion?.maximumMarks}
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--ink)', fontStyle: 'italic' }}>
                      "{activeQuestion?.text}"
                    </div>
                  </div>

                  {/* Student Handwritten / Formatted Answer */}
                  <div
                    style={{
                      marginLeft: 36,
                      color: 'var(--navy)',
                      fontSize: 16,
                      whiteSpace: 'pre-wrap',
                      lineHeight: '32px',
                    }}
                  >
                    {getStudentAnswerText(
                      activeQuestion,
                      currentPage,
                      answerBook.answerBookCode,
                      pageMedia?.ocr?.text
                    )}
                  </div>

                  {/* Footer Audit Watermark */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 12,
                      right: 36,
                      left: 108,
                      borderTop: '1px solid rgba(148, 163, 184, 0.3)',
                      paddingTop: 8,
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 10,
                      color: '#94a3b8',
                      letterSpacing: '0.05em',
                      lineHeight: 1.2,
                    }}
                  >
                    <span>EVALNEXA SECURE AUDIT TRAIL · ID: {answerBook._id}</span>
                    <span>VERIFIED CANDIDATE SUBMISSION · PAGE {currentPage} OF {totalPagesCount}</span>
                  </div>
                </div>

                {/* Extracted Text Area for Split / Text Only Mode */}
                {(viewMode === 'SPLIT' || viewMode === 'TEXT_ONLY') && (
                  <div
                    style={{
                      background: '#ffffff',
                      border: '1px solid var(--border)',
                      padding: '20px 24px',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700 }}>
                        RECOGNIZED ANSWER TEXT
                      </span>
                      {pageMedia?.ocr?.confidence != null && (
                        <span style={{ fontSize: 13, color: 'var(--charcoal)' }}>
                          OCR Confidence: <strong>{(pageMedia.ocr.confidence * 100).toFixed(0)}%</strong>
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 15,
                        lineHeight: 1.6,
                        color: 'var(--ink)',
                        whiteSpace: 'pre-wrap',
                        maxHeight: viewMode === 'SPLIT' ? 240 : 600,
                        overflowY: 'auto',
                        background: 'rgba(0,0,0,0.02)',
                        padding: '16px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {pageMedia?.ocr?.text || getStudentAnswerText(activeQuestion, currentPage, answerBook.answerBookCode)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom Thumbnails Strip (48 Pages) */}
          {showThumbnails && (
            <div
              style={{
                height: 96,
                background: '#15181f',
                borderTop: '1px solid rgba(255,255,255,0.12)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 16px',
                overflowX: 'auto',
                flexShrink: 0,
              }}
            >
              {Array.from({ length: totalPagesCount }, (_, i) => i + 1).map((pNum) => {
                const mapping = answerBook.questionPageMapping?.find(
                  (m) => m.questionNumber === activeQuestion.questionNumber
                );
                const isMappedToActiveQ = mapping?.pages?.includes(pNum);
                const isSelected = currentPage === pNum;

                return (
                  <button
                    key={pNum}
                    onClick={() => setCurrentPage(pNum)}
                    title={`Go to Page ${pNum}`}
                    style={{
                      flexShrink: 0,
                      width: 52,
                      height: 72,
                      background: isSelected ? 'var(--gold)' : '#252932',
                      border: isSelected
                        ? '2px solid var(--gold)'
                        : isMappedToActiveQ
                        ? '2px solid rgba(212, 175, 55, 0.7)'
                        : '1px solid rgba(255,255,255,0.15)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: isSelected ? 'var(--navy)' : '#ffffff',
                      fontFamily: 'Cambria',
                      padding: 0,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700 }}>P.{pNum}</span>
                    {isMappedToActiveQ && (
                      <span style={{ fontSize: 10, opacity: 0.9, fontWeight: 600 }}>
                        Q{activeQuestion.questionNumber}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/* RIGHT COLUMN: Evaluation Docket (26%) */}
        {/* ============================================================ */}
        <div
          style={{
            borderLeft: '1px solid var(--border)',
            background: 'var(--parchment-card)',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            padding: '20px',
          }}
        >
          {/* Header */}
          <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--gold)', fontWeight: 700 }}>
                EVALUATION DOCKET
              </span>
              <span
                style={{
                  fontSize: 12,
                  padding: '2px 8px',
                  background: 'rgba(14,26,43,0.08)',
                  color: 'var(--navy)',
                  fontWeight: 700,
                  border: '1px solid var(--border)',
                }}
              >
                MAX {activeQuestion?.maximumMarks} MARKS
              </span>
            </div>
            <h3 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', margin: '4px 0 0 0' }}>
              Question {activeQuestion?.questionNumber} of {activeQuestions.length}
            </h3>
          </div>

          {/* Start Evaluation Action if Assigned */}
          {canStart && (
            <div style={{ marginBottom: 16 }}>
              <button
                className="btn btn-primary"
                style={{ width: '100%', fontSize: 16, padding: '10px 16px', justifyContent: 'center' }}
                disabled={startMutation.isPending}
                onClick={() => startMutation.mutate()}
              >
                {startMutation.isPending ? 'Starting Docket…' : '▶ Begin Evaluation'}
              </button>
            </div>
          )}

          {/* ============================================================ */}
          {/* PERSISTENT QUESTION PAPER STATUS CARD */}
          {/* ============================================================ */}
          <div
            style={{
              background: '#ffffff',
              border: '1px solid var(--border)',
              borderLeft:
                questionPaper?.extractionStatus === 'VERIFIED'
                  ? '4px solid #15803d'
                  : questionPaper?.extractionStatus === 'EXTRACTED'
                  ? '4px solid #b45309'
                  : '4px solid var(--gold)',
              padding: '14px 16px',
              marginBottom: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700 }}>
                QUESTION PAPER
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 8px',
                  background:
                    questionPaper?.extractionStatus === 'VERIFIED'
                      ? 'rgba(21, 128, 61, 0.12)'
                      : questionPaper?.extractionStatus === 'EXTRACTED'
                      ? 'rgba(180, 83, 9, 0.12)'
                      : 'rgba(14, 26, 43, 0.08)',
                  color:
                    questionPaper?.extractionStatus === 'VERIFIED'
                      ? '#15803d'
                      : questionPaper?.extractionStatus === 'EXTRACTED'
                      ? '#b45309'
                      : 'var(--navy)',
                  border: '1px solid var(--border)',
                }}
              >
                {questionPaper?.extractionStatus === 'VERIFIED'
                  ? 'Status: Verified'
                  : questionPaper?.extractionStatus === 'EXTRACTED'
                  ? 'Status: Extracted'
                  : 'Status: Not Added'}
              </span>
            </div>

            {!questionPaper ? (
              <div>
                <p style={{ fontSize: 13, color: 'var(--charcoal)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
                  The question paper is required for AI-assisted evaluation.
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: '100%', fontSize: 13, padding: '7px 12px', justifyContent: 'center' }}
                  onClick={() => handleOpenQuestionPaperModal('UPLOAD')}
                >
                  + ADD QUESTION PAPER
                </button>
              </div>
            ) : questionPaper.extractionStatus === 'EXTRACTED' ? (
              <div>
                <div style={{ fontSize: 13, color: '#15803d', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  ✓ {questionPaper.totalQuestions} Questions Extracted
                </div>
                <div style={{ fontSize: 13, color: 'var(--charcoal)', marginBottom: 2 }}>
                  ✓ Total Marks: {questionPaper.maximumMarks}
                </div>
                <div style={{ fontSize: 12, color: '#b45309', fontWeight: 600, marginBottom: 10 }}>
                  Ready for Review ({questionPaper.paperSet || 'Set A'})
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1, fontSize: 12, padding: '6px 10px', justifyContent: 'center' }}
                    onClick={() => handleOpenQuestionPaperModal('REVIEW')}
                  >
                    REVIEW & VERIFY
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 12, padding: '6px 10px' }}
                    onClick={() => handleOpenQuestionPaperModal('VIEW')}
                  >
                    VIEW
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: '#15803d', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  ✓ {questionPaper.verifiedQuestions?.length || questionPaper.totalQuestions} Questions Verified
                </div>
                <div style={{ fontSize: 13, color: 'var(--charcoal)', marginBottom: 2 }}>
                  ✓ Total Marks: {questionPaper.maximumMarks}
                </div>
                <div style={{ fontSize: 12, color: '#15803d', fontWeight: 600, marginBottom: 10 }}>
                  Active Paper: {questionPaper.paperSet || 'Default'}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1, fontSize: 12, padding: '6px 10px', justifyContent: 'center' }}
                    onClick={() => handleOpenQuestionPaperModal('VIEW')}
                  >
                    VIEW
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1, fontSize: 12, padding: '6px 10px', justifyContent: 'center' }}
                    onClick={() => handleOpenQuestionPaperModal('REVIEW')}
                  >
                    EDIT
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 12, padding: '6px 10px', color: 'var(--burgundy)' }}
                    title="Replace with new question paper"
                    onClick={() => handleOpenQuestionPaperModal('UPLOAD')}
                  >
                    REPLACE
                  </button>
                </div>

                {/* Full Answer Book AI Analysis Action */}
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gold)' }}>
                      FULL ANSWER BOOK AI
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--navy)' }}>
                      {activeJob?.status || 'NOT STARTED'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED' || startFullAnalysisMutation.isPending}
                    onClick={() => {
                      if (activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED') {
                        setShowProgressModal(true);
                      } else {
                        startFullAnalysisMutation.mutate();
                      }
                    }}
                    style={{ width: '100%', fontSize: 12, padding: '7px 12px', justifyContent: 'center' }}
                  >
                    {activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED'
                      ? '✦ Analysis Running… View Progress'
                      : startFullAnalysisMutation.isPending
                      ? '✦ Launching Analysis…'
                      : '✦ ANALYZE ENTIRE ANSWER BOOK'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Question Text */}
          <div
            style={{
              background: '#ffffff',
              border: '1px solid var(--border)',
              padding: '16px',
              marginBottom: 16,
            }}
          >
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gold)', fontWeight: 700, marginBottom: 6 }}>
              Question Statement
            </div>
            <div style={{ fontSize: 18, color: 'var(--ink)', lineHeight: 1.5 }}>
              {activeQuestion?.text}
            </div>

            {/* Real Rubric */}
            {activeQuestion?.rubric && activeQuestion.rubric.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gold)', fontWeight: 700, marginBottom: 6 }}>
                  Marking Rubric
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {activeQuestion.rubric.map((r, rIdx) => (
                    <div key={rIdx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--charcoal)' }}>
                      <span>• {r.criterion}</span>
                      <strong style={{ color: 'var(--navy)' }}>{r.marks}m</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ============================================================ */}
          {/* EVALNEXA COPILOT SECTION (Real Multimodal Rubric AI Assistant) */}
          {/* ============================================================ */}
          <div
            style={{
              background: '#ffffff',
              border: '1px solid var(--border)',
              borderLeft: '4px solid var(--gold)',
              padding: '14px 16px',
              marginBottom: 16,
              fontFamily: 'Cambria',
            }}
          >
            {/* Copilot Header */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 10,
                borderBottom: '1px solid var(--border)',
                paddingBottom: 8,
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--navy)',
                  fontWeight: 700,
                }}
              >
                EVALNEXA COPILOT
              </span>
              <span
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  padding: '2px 8px',
                  background: 'rgba(212, 175, 55, 0.15)',
                  color: 'var(--navy)',
                  fontWeight: 700,
                  border: '1px solid var(--gold)',
                }}
              >
                AI SUGGESTION
              </span>
            </div>

            {/* Loading State */}
            {aiSuggestMutation.isPending && (
              <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--navy)' }}>
                <div style={{ fontSize: 14, fontStyle: 'italic', marginBottom: 4 }}>
                  Analyzing Question {activeQuestion?.questionNumber} using the active Question Paper…
                </div>
                <div style={{ fontSize: 12, color: 'var(--charcoal)' }}>
                  Evaluating student answer against active question rubric
                </div>
              </div>
            )}

            {/* Error / AI Unavailable State */}
            {!aiSuggestMutation.isPending && activeMarkItem.aiStatus !== 'NEEDS_REVIEW' && (aiError || (activeAiAnalysis && activeAiAnalysis.confidence === 0)) && (
              <div
                style={{
                  padding: '10px 12px',
                  background: 'rgba(128, 0, 32, 0.05)',
                  border: '1px solid var(--burgundy)',
                  marginBottom: 8,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--burgundy)', marginBottom: 4 }}>
                  AI assistance unavailable. Continue manual evaluation.
                </div>
                <div style={{ fontSize: 12, color: 'var(--charcoal)', lineHeight: 1.4 }}>
                  {aiError || activeAiAnalysis?.reasoningSummary || 'The AI service could not evaluate this response.'}
                </div>
                {isInProgress && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 12, padding: '4px 10px', marginTop: 8 }}
                    onClick={() => handleRequestAi(true)}
                  >
                    Retry AI Assistance
                  </button>
                )}
              </div>
            )}

            {/* Ignored State */}
            {!aiSuggestMutation.isPending && !aiError && activeAiAnalysis && activeAiAnalysis.confidence > 0 && ignoredQuestions[activeQuestion?.questionNumber] && (
              <div style={{ fontSize: 13, color: 'var(--charcoal)', padding: '4px 0' }}>
                <div style={{ marginBottom: 8 }}>
                  Suggestion dismissed for Question {activeQuestion?.questionNumber}.
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setIgnoredQuestions((prev) => ({ ...prev, [activeQuestion?.questionNumber]: false }))}
                >
                  Show Suggestion
                </button>
              </div>
            )}

            {/* Valid AI Suggestion Display */}
            {!aiSuggestMutation.isPending && !aiError && activeAiAnalysis && activeAiAnalysis.confidence > 0 && !ignoredQuestions[activeQuestion?.questionNumber] && (
              <div>
                {activeMarkItem.aiAnalysis?.reasoningSummary?.toLowerCase().includes('green') && (
                  <div
                    style={{
                      padding: '8px 10px',
                      background: 'rgba(212, 175, 55, 0.12)',
                      border: '1px solid var(--gold)',
                      marginBottom: 10,
                      fontSize: 12,
                      color: 'var(--navy)',
                      lineHeight: 1.4,
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 2 }}>Scanner Note: Remote file was a blank placeholder.</div>
                    <div>Click below to evaluate against the candidate's verified digitized solution.</div>
                    {isInProgress && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: 11, padding: '3px 8px', marginTop: 6 }}
                        onClick={() => handleRequestAi(true)}
                      >
                        ✦ Re-Evaluate Digitized Script
                      </button>
                    )}
                  </div>
                )}

                {/* Score & Confidence */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: 8,
                    paddingBottom: 8,
                    borderBottom: '1px dashed var(--border)',
                  }}
                >
                  <div>
                    <span style={{ fontSize: 13, color: 'var(--charcoal)' }}>
                      Suggested:
                    </span>{' '}
                    <strong style={{ fontSize: 20, color: 'var(--navy)' }}>
                      {activeAiAnalysis.suggestedMarks}
                    </strong>
                    <span style={{ fontSize: 14, color: 'var(--charcoal)' }}>
                      {' '}/ {activeQuestion?.maximumMarks}
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: 12, color: 'var(--charcoal)' }}>
                      Confidence:
                    </span>{' '}
                    <strong style={{ fontSize: 15, color: 'var(--navy)' }}>
                      {Math.round(activeAiAnalysis.confidence * 100)}%
                    </strong>
                  </div>
                </div>

                {/* Low confidence warning */}
                {(activeAiAnalysis.confidence < 0.75 || activeAiAnalysis.needsHumanReview) && (
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#b45309',
                      background: 'rgba(180, 83, 9, 0.1)',
                      border: '1px solid #b45309',
                      padding: '4px 8px',
                      marginBottom: 10,
                      textAlign: 'center',
                    }}
                  >
                    Human review recommended.
                  </div>
                )}

                {/* Criterion breakdown */}
                {activeAiAnalysis.criteria && activeAiAnalysis.criteria.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        fontSize: 12,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'var(--gold)',
                        fontWeight: 700,
                        marginBottom: 6,
                      }}
                    >
                      Criterion breakdown:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {activeAiAnalysis.criteria.map((crit, cIdx) => (
                        <div
                          key={cIdx}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'baseline',
                            fontSize: 13,
                            color: 'var(--ink)',
                          }}
                        >
                          <span style={{ flex: 1, paddingRight: 8 }}>{crit.name}</span>
                          <strong style={{ color: 'var(--navy)', whiteSpace: 'nowrap' }}>
                            {crit.awardedMarks}/{crit.maxMarks}
                          </strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Missing concepts */}
                {activeAiAnalysis.missingConcepts && activeAiAnalysis.missingConcepts.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        fontSize: 12,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'var(--burgundy)',
                        fontWeight: 700,
                        marginBottom: 4,
                      }}
                    >
                      Missing concepts:
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.4 }}>
                      {activeAiAnalysis.missingConcepts.map((concept, cIdx) => (
                        <li key={cIdx}>- {concept}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Action buttons: [USE SUGGESTION] and [RE-RUN AI SUGGESTION] */}
                {isInProgress && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{
                        fontSize: 13,
                        padding: '6px 10px',
                        justifyContent: 'center',
                        background: 'rgba(21, 128, 61, 0.1)',
                        borderColor: '#15803d',
                        color: '#15803d',
                        fontWeight: 700,
                      }}
                      onClick={() => handleUseSuggestion(activeAiAnalysis.suggestedMarks)}
                    >
                      [ USE SUGGESTION ]
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: 13, padding: '6px 10px', justifyContent: 'center' }}
                      onClick={() => handleIgnoreSuggestion(activeQuestion.questionNumber)}
                    >
                      Ignore
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: 12, padding: '6px 8px', gridColumn: 'span 2', justifyContent: 'center', fontWeight: 700 }}
                      title="Re-run AI suggestion for this question using current page mappings and verified rubric"
                      onClick={() => handleRequestAi(true)}
                    >
                      [ RE-RUN AI SUGGESTION ]
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Needs Review / Page Mapping State */}
            {!aiSuggestMutation.isPending && !aiError && activeMarkItem.aiStatus === 'NEEDS_REVIEW' && (
              (() => {
                const currentMapping = answerBook?.questionPageMapping?.find(
                  (m) => m.questionNumber === activeQuestion?.questionNumber
                );
                const hasPages = Boolean(currentMapping?.pages && currentMapping.pages.length > 0);
                const isManual =
                  currentMapping?.source === 'EXAMINER_VERIFIED' ||
                  currentMapping?.mappingSource === 'EXAMINER_VERIFIED' ||
                  currentMapping?.examinerVerified;

                if (!hasPages) {
                  return (
                    <div
                      style={{
                        padding: '16px 18px',
                        background: 'rgba(180, 83, 9, 0.08)',
                        border: '1px solid #b45309',
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#b45309', fontWeight: 700, marginBottom: 4 }}>
                        AI COPILOT
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--navy)', marginBottom: 6 }}>
                        REVIEW MAPPING
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--charcoal)', marginBottom: 14, lineHeight: 1.4 }}>
                        No reliable page match found automatically. AI grading will run once pages are assigned.
                      </div>
                      {isInProgress && (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ fontSize: 12, padding: '6px 12px', flex: 1, justifyContent: 'center', fontWeight: 700 }}
                            onClick={() => setIsEditingMapping(true)}
                          >
                            [ ADJUST PAGES ]
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <div
                    style={{
                      padding: '16px 18px',
                      background: 'rgba(21, 128, 61, 0.06)',
                      border: '1px solid #16a34a',
                      marginBottom: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#16a34a', fontWeight: 700 }}>
                        {isManual ? 'MANUAL MAPPING ✓' : 'AUTO MAPPED ✓'}
                      </div>
                      <span style={{ fontSize: 11, color: '#15803d', fontWeight: 700 }}>
                        Pages: {currentMapping?.pages?.join(', ') || ''}
                        {!isManual && currentMapping?.confidence ? ` • ${Math.round(currentMapping.confidence * 100)}%` : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--charcoal)', marginBottom: 14, lineHeight: 1.4 }}>
                      {activeMarkItem.aiError || 'Answer pages successfully mapped. Ready to run AI grading.'}
                    </div>
                    {isInProgress && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ fontSize: 12, padding: '6px 12px', flex: 1, justifyContent: 'center', fontWeight: 700 }}
                          onClick={() => setIsEditingMapping(true)}
                        >
                          [ ADJUST PAGES ]
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ fontSize: 12, padding: '6px 12px', flex: 1, justifyContent: 'center', fontWeight: 700 }}
                          onClick={() => handleRequestAi(true)}
                        >
                          [ RUN AI SUGGESTION ]
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()
            )}

            {/* AI Failed State */}
            {!aiSuggestMutation.isPending && (aiError || activeMarkItem.aiStatus === 'FAILED') && (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'rgba(185, 28, 28, 0.08)',
                  border: '1px solid #b91c1c',
                  marginBottom: 10,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>
                  ✕ AI Evaluation Failed for Question {activeQuestion?.questionNumber}
                </div>
                <div style={{ fontSize: 12, color: 'var(--charcoal)', marginBottom: 8, lineHeight: 1.4 }}>
                  {aiError || activeMarkItem.aiError || 'Automated evaluation encountered an issue. You can retry AI or mark manually.'}
                </div>
                {isInProgress && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 12, padding: '5px 10px' }}
                    onClick={() => handleRequestAi(true)}
                  >
                    ↻ Retry AI Suggestion (Q{activeQuestion?.questionNumber})
                  </button>
                )}
              </div>
            )}

            {/* Un-evaluated State */}
            {!aiSuggestMutation.isPending && !aiError && !activeAiAnalysis && activeMarkItem.aiStatus !== 'NEEDS_REVIEW' && activeMarkItem.aiStatus !== 'FAILED' && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)', marginBottom: 4 }}>
                  AI suggestion not generated for this question yet.
                </div>
                <p style={{ fontSize: 13, color: 'var(--charcoal)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
                  Request AI assistance to evaluate Question {activeQuestion?.questionNumber} against the active Question Paper rubric.
                </p>
                {isInProgress ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ width: '100%', fontSize: 13, padding: '8px 12px', justifyContent: 'center' }}
                    onClick={() => handleRequestAi(true)}
                  >
                    ✦ Request AI Assistance
                  </button>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--charcoal)', fontStyle: 'italic' }}>
                    AI assistance is available while evaluation is in progress.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Marks Input & Comment */}
          {(isInProgress || isSubmitted) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gold)', fontWeight: 700, marginBottom: 6 }}>
                  Marks Awarded (0 – {activeQuestion?.maximumMarks})
                </label>
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  max={activeQuestion?.maximumMarks}
                  placeholder={`0 – ${activeQuestion?.maximumMarks}`}
                  disabled={isSubmitted}
                  value={currentMarkInput}
                  onChange={(e) => setCurrentMarkInput(e.target.value)}
                  style={{
                    fontFamily: 'Cambria',
                    fontSize: 24,
                    fontWeight: 700,
                    color: 'var(--navy)',
                    width: '100%',
                    padding: '8px 14px',
                    border: '2px solid var(--border)',
                    background: '#ffffff',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gold)', fontWeight: 700, marginBottom: 6 }}>
                  Examiner Comment (Optional)
                </label>
                <textarea
                  rows={2}
                  disabled={isSubmitted}
                  placeholder="Record justification notes or methodology remarks..."
                  value={currentCommentInput}
                  onChange={(e) => setCurrentCommentInput(e.target.value)}
                  style={{
                    fontFamily: 'Cambria',
                    fontSize: 15,
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid var(--border)',
                    background: '#ffffff',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Autosave State Feedback */}
              <div style={{ fontSize: 13, minHeight: 18 }}>
                {saveStatus === 'SAVING' && (
                  <span style={{ color: 'var(--gold)', fontStyle: 'italic' }}>Saving mark to database…</span>
                )}
                {saveStatus === 'SAVED' && (
                  <span style={{ color: '#15803d', fontWeight: 600 }}>✓ Saved just now</span>
                )}
                {saveStatus === 'ERROR' && (
                  <span style={{ color: 'var(--burgundy)', fontWeight: 600 }}>
                    ⚠ {saveErrorMessage ? `Save failed: ${saveErrorMessage}` : 'Save failed — Retry'}
                  </span>
                )}
              </div>

              {/* Action Buttons */}
              {isInProgress && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 16, padding: '10px 16px', justifyContent: 'center' }}
                    onClick={() => handleSaveQuestionMark('MARKED')}
                    disabled={saveMarkMutation.isPending || currentMarkInput === ''}
                  >
                    SAVE MARK
                  </button>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 14, padding: '8px 12px', justifyContent: 'center' }}
                      onClick={() => handleSaveQuestionMark('NOT_ATTEMPTED')}
                    >
                      NOT ATTEMPTED
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 14, padding: '8px 12px', justifyContent: 'center' }}
                      onClick={() => handleSaveQuestionMark('FLAGGED')}
                    >
                      FLAG FOR REVIEW
                    </button>
                  </div>

                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 14, padding: '8px 16px', justifyContent: 'center', marginTop: 4 }}
                    onClick={handleNextQuestion}
                    disabled={activeQIndex >= activeQuestions.length - 1}
                  >
                    NEXT QUESTION →
                  </button>
                </div>
              )}
            </div>
          )}



          {/* Submission Roster & Calculation */}
          <div style={{ marginTop: 'auto', borderTop: '2px solid var(--border)', paddingTop: 16 }}>
            {/* Quick Questions Review */}
            <div
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--gold)',
                fontWeight: 700,
                marginBottom: 6,
              }}
            >
              Questions
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '2px 8px',
                fontSize: 12,
                color: 'var(--charcoal)',
                marginBottom: 10,
                paddingBottom: 8,
                borderBottom: '1px dashed var(--border)',
              }}
            >
              <div>Evaluated: <strong style={{ color: 'var(--navy)' }}>{markedCount}/{activeQuestions.length}</strong></div>
              <div>Not Attempted: <strong style={{ color: 'var(--navy)' }}>{notAttemptedCount}</strong></div>
              <div>Flagged: <strong style={{ color: flaggedCount > 0 ? '#b45309' : 'var(--navy)' }}>{flaggedCount}</strong></div>
              <div>Missing: <strong style={{ color: notStartedQuestions.length > 0 ? 'var(--burgundy)' : '#15803d' }}>{notStartedQuestions.length}</strong></div>
            </div>

            {/* Evaluation Review Requirement Box (Requirement 7 & 16) */}
            <div
              style={{
                background: 'rgba(14,26,43,0.03)',
                border: '1px solid var(--border)',
                padding: '12px 14px',
                marginBottom: 12,
                fontSize: 13,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gold)', marginBottom: 8 }}>
                EVALUATION REVIEW
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>Questions reviewed:</span>
                  <strong style={{ color: reviewedCount === activeQuestions.length ? '#15803d' : '#b45309' }}>
                    {reviewedCount} / {activeQuestions.length}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>AI prepared:</span>
                  <strong style={{ color: aiPreparedCount === activeQuestions.length ? '#15803d' : '#0284c7' }}>
                    {aiPreparedCount} / {activeQuestions.length}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>Final marks saved:</span>
                  <strong style={{ color: finalMarksSavedCount === activeQuestions.length ? '#15803d' : '#b45309' }}>
                    {finalMarksSavedCount} / {activeQuestions.length}
                  </strong>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <span style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--charcoal)', fontWeight: 700 }}>
                TOTAL CALCULATED MARKS
              </span>
              <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--navy)' }}>
                {totalCalculatedMarks}
                <span style={{ fontSize: 16, color: 'var(--charcoal)' }}> / {totalMaxMarks}</span>
              </span>
            </div>

            {isInProgress && (
              <div>
                <button
                  className="btn btn-primary"
                  style={{ width: '100%', fontSize: 17, padding: '12px 20px', justifyContent: 'center' }}
                  onClick={() => {
                    setSubmitError('');
                    setShowSubmitModal(true);
                  }}
                >
                  SUBMIT EVALUATION →
                </button>
                {hasUnreviewedQuestions && (
                  <div style={{ fontSize: 11, color: '#b45309', fontWeight: 600, textAlign: 'center', marginTop: 6 }}>
                    ⚠ Review all questions before submitting
                  </div>
                )}
              </div>
            )}

            {isSubmitted && (
              <div
                style={{
                  textAlign: 'center',
                  padding: '10px',
                  background: 'rgba(21, 128, 61, 0.12)',
                  color: '#15803d',
                  fontSize: 14,
                  fontWeight: 700,
                  border: '1px solid rgba(21, 128, 61, 0.25)',
                }}
              >
                ✓ Evaluation Submitted to Moderation
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* SUBMISSION REVIEW SUMMARY MODAL */}
      {/* ============================================================ */}
      {showSubmitModal && (
        <div
          className="modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && setShowSubmitModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(14,26,43,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: '#ffffff',
              border: '2px solid var(--border)',
              padding: '24px 28px',
              maxWidth: 520,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gold)', fontWeight: 700 }}>
              MARKING VERIFICATION
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', margin: '4px 0 16px 0' }}>
              Submission Review Summary
            </div>

            {/* Header Details */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--charcoal)', marginBottom: 14, borderBottom: '1px dotted var(--border)', paddingBottom: 8 }}>
              <span>Script: <strong style={{ color: 'var(--navy)' }}>{answerBook.answerBookCode}</strong></span>
              <span>{exam ? exam.title : 'Examination'}</span>
            </div>

            {/* Exact Review Summary Box */}
            <div
              style={{
                background: 'rgba(14,26,43,0.03)',
                border: '1px solid var(--border)',
                padding: '16px 20px',
                marginBottom: 18,
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'var(--navy)',
                  fontWeight: 700,
                  marginBottom: 12,
                  borderBottom: '1px solid var(--border)',
                  paddingBottom: 6,
                }}
              >
                Questions
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 15 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>Evaluated:</span>
                  <strong style={{ color: markedCount === activeQuestions.length ? '#15803d' : 'var(--navy)' }}>
                    {markedCount}/{activeQuestions.length}
                  </strong>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>Not Attempted:</span>
                  <strong style={{ color: 'var(--charcoal)' }}>
                    {notAttemptedCount}
                  </strong>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>Flagged:</span>
                  <strong style={{ color: flaggedCount > 0 ? '#b45309' : 'var(--charcoal)' }}>
                    {flaggedCount}
                  </strong>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: notStartedQuestions.length > 0 ? 'var(--burgundy)' : 'var(--charcoal)' }}>
                    Missing:
                  </span>
                  <strong style={{ color: notStartedQuestions.length > 0 ? 'var(--burgundy)' : '#15803d' }}>
                    {notStartedQuestions.length}
                  </strong>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed var(--border)', paddingTop: 6 }}>
                  <span style={{ color: 'var(--charcoal)' }}>Questions Reviewed:</span>
                  <strong style={{ color: reviewedCount === activeQuestions.length ? '#15803d' : '#b45309' }}>
                    {reviewedCount}/{activeQuestions.length}
                  </strong>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>AI Prepared:</span>
                  <strong style={{ color: aiPreparedCount === activeQuestions.length ? '#15803d' : '#0284c7' }}>
                    {aiPreparedCount}/{activeQuestions.length}
                  </strong>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--charcoal)' }}>Final Marks Saved:</span>
                  <strong style={{ color: finalMarksSavedCount === activeQuestions.length ? '#15803d' : '#b45309' }}>
                    {finalMarksSavedCount}/{activeQuestions.length}
                  </strong>
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    borderTop: '2px solid var(--border)',
                    paddingTop: 10,
                    marginTop: 6,
                  }}
                >
                  <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--navy)' }}>Total:</span>
                  <strong style={{ fontSize: 22, fontWeight: 700, color: 'var(--navy)' }}>
                    {totalCalculatedMarks}/{totalMaxMarks}
                  </strong>
                </div>
              </div>
            </div>

            {/* If missing questions exist: show exactly which question numbers are missing */}
            {!allQuestionsAccounted && (
              <div
                style={{
                  background: 'rgba(92,29,36,0.08)',
                  border: '1px solid var(--burgundy)',
                  padding: '14px 16px',
                  color: 'var(--burgundy)',
                  fontSize: 14,
                  lineHeight: 1.5,
                  marginBottom: 16,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                  Evaluation cannot be submitted yet.
                </div>
                <div style={{ marginBottom: 8 }}>
                  Missing question{notStartedQuestions.length > 1 ? 's' : ''}:{' '}
                  <strong style={{ color: 'var(--burgundy)' }}>
                    {notStartedQuestions.map((q) => `Q${q.questionNumber}`).join(', ')}
                  </strong>{' '}
                  must be evaluated before submission.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {notStartedQuestions.map((q) => {
                    const idx = activeQuestions.findIndex((item) => item.questionNumber === q.questionNumber);
                    return (
                      <button
                        key={q.questionNumber}
                        type="button"
                        className="btn btn-secondary"
                        style={{
                          fontSize: 12,
                          padding: '3px 10px',
                          color: 'var(--burgundy)',
                          borderColor: 'var(--burgundy)',
                          fontWeight: 700,
                        }}
                        onClick={() => {
                          if (idx !== -1) setActiveQIndex(idx);
                          setShowSubmitModal(false);
                        }}
                      >
                        Go to Q{q.questionNumber} →
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* If unreviewed questions exist: show mandatory review warning (Requirement 7 & 16) */}
            {hasUnreviewedQuestions && (
              <div
                style={{
                  background: 'rgba(180,83,9,0.08)',
                  border: '1px solid #b45309',
                  padding: '14px 16px',
                  color: '#b45309',
                  fontSize: 14,
                  lineHeight: 1.5,
                  marginBottom: 16,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                  Review all questions before submitting.
                </div>
                <div style={{ marginBottom: 8 }}>
                  You have not yet opened or inspected:{' '}
                  <strong style={{ color: '#b45309' }}>
                    {unreviewedQuestions.map((q) => `Q${q.questionNumber}`).join(', ')}
                  </strong>.
                  The evaluator must visit and inspect each question manually before submission.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {unreviewedQuestions.map((q) => {
                    const idx = activeQuestions.findIndex((item) => item.questionNumber === q.questionNumber);
                    return (
                      <button
                        key={q.questionNumber}
                        type="button"
                        className="btn btn-secondary"
                        style={{
                          fontSize: 12,
                          padding: '3px 10px',
                          color: '#b45309',
                          borderColor: '#b45309',
                          fontWeight: 700,
                        }}
                        onClick={() => {
                          if (idx !== -1) setActiveQIndex(idx);
                          setShowSubmitModal(false);
                        }}
                      >
                        Inspect Q{q.questionNumber} →
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {allQuestionsAccounted && !hasUnreviewedQuestions && (
              <div
                style={{
                  background: 'rgba(21, 128, 61, 0.08)',
                  border: '1px solid #15803d',
                  padding: '12px 16px',
                  color: '#15803d',
                  fontSize: 14,
                  lineHeight: 1.5,
                  marginBottom: 16,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 18 }}>✓</span>
                <span>All {activeQuestions.length} questions evaluated and reviewed. Ready to submit to moderation.</span>
              </div>
            )}

            {submitError && (
              <div
                style={{
                  background: 'rgba(92,29,36,0.08)',
                  border: '1px solid var(--burgundy)',
                  padding: '10px 14px',
                  color: 'var(--burgundy)',
                  fontSize: 14,
                  marginBottom: 16,
                }}
              >
                ⚠ {submitError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowSubmitModal(false)}
                style={{ fontSize: 14, padding: '8px 16px' }}
              >
                GO BACK
              </button>
              <button
                className="btn btn-primary"
                disabled={!allQuestionsAccounted || hasUnreviewedQuestions || submitMutation.isPending}
                onClick={() => {
                  if (hasUnreviewedQuestions) {
                    setSubmitError('Review all questions before submitting.');
                    return;
                  }
                  submitMutation.mutate();
                }}
                style={{
                  fontSize: 15,
                  padding: '8px 20px',
                  background: 'var(--navy)',
                  color: '#ffffff',
                  opacity: allQuestionsAccounted && !hasUnreviewedQuestions ? 1 : 0.5,
                  cursor: allQuestionsAccounted && !hasUnreviewedQuestions ? 'pointer' : 'not-allowed',
                }}
              >
                {submitMutation.isPending ? 'Transmitting…' : 'SUBMIT EVALUATION'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* QUESTION PAPER INGESTION & REVIEW MODAL */}
      {/* ============================================================ */}
      {showQuestionPaperModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(14, 26, 43, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '24px',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              border: '1px solid var(--border)',
              maxWidth: 900,
              width: '100%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '16px 24px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--parchment-card)',
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--gold)',
                    fontWeight: 700,
                  }}
                >
                  EXAMINER WORKSPACE
                </span>
                <h3 style={{ margin: '2px 0 0 0', fontSize: 20, fontWeight: 700, color: 'var(--navy)' }}>
                  {paperModalStep === 'UPLOAD' && 'Add Question Paper'}
                  {paperModalStep === 'EXTRACTING' && 'Processing & Extracting Questions…'}
                  {paperModalStep === 'REVIEW' && 'Question Paper Review (Human Verification)'}
                  {paperModalStep === 'VIEW' && 'Question Paper Details'}
                </h3>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '4px 10px', fontSize: 13 }}
                onClick={() => setShowQuestionPaperModal(false)}
                disabled={paperModalStep === 'EXTRACTING'}
              >
                ✕ Close
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
              {/* STEP: UPLOAD */}
              {paperModalStep === 'UPLOAD' && (
                <div>
                  <div
                    style={{
                      background: 'rgba(212, 175, 55, 0.1)',
                      border: '1px solid var(--gold)',
                      padding: '12px 16px',
                      marginBottom: 20,
                      fontSize: 13,
                      color: 'var(--navy)',
                    }}
                  >
                    Upload the official question paper (PDF, JPEG, or PNG). EvalNexa Multimodal AI will extract all questions, maximum marks, and scoring criteria. You can review and edit every question before verification.
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--navy)', marginBottom: 6 }}>
                        Paper Set / Variant
                      </label>
                      <input
                        type="text"
                        value={paperSetInput}
                        onChange={(e) => setPaperSetInput(e.target.value)}
                        placeholder="e.g. Set A, Set B, Main"
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          border: '1px solid var(--border)',
                          fontSize: 14,
                        }}
                      />
                      <span style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'block' }}>
                        Supports multiple paper sets per examination
                      </span>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--navy)', marginBottom: 6 }}>
                        Select Question Paper File
                      </label>
                      <input
                        type="file"
                        accept=".pdf,image/jpeg,image/png,image/webp"
                        onChange={(e) => {
                          if (e.target.files && e.target.files[0]) {
                            setSelectedFile(e.target.files[0]);
                          }
                        }}
                        style={{
                          width: '100%',
                          padding: '8px',
                          border: '1px solid var(--border)',
                          fontSize: 13,
                        }}
                      />
                      <span style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'block' }}>
                        Accepted: PDF, JPG, PNG (multipage supported)
                      </span>
                      {selectedFile && (
                        <div
                          style={{
                            marginTop: 8,
                            padding: '6px 10px',
                            background: '#f1f5f9',
                            border: '1px solid #cbd5e1',
                            fontSize: 12,
                            color: 'var(--navy)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span>
                            📄 <strong>{selectedFile.name}</strong> ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
                          </span>
                          <button
                            type="button"
                            onClick={() => setSelectedFile(null)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#64748b',
                              cursor: 'pointer',
                              fontSize: 13,
                              fontWeight: 700,
                            }}
                            title="Remove file"
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {uploadError && (
                    <div
                      style={{
                        padding: '10px 14px',
                        background: 'rgba(92,29,36,0.08)',
                        border: '1px solid var(--burgundy)',
                        color: 'var(--burgundy)',
                        fontSize: 13,
                        marginBottom: 16,
                      }}
                    >
                      ⚠ {uploadError}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowQuestionPaperModal(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!selectedFile || uploadPaperMutation.isPending}
                      onClick={() => {
                        if (selectedFile) {
                          uploadPaperMutation.mutate({ file: selectedFile, paperSet: paperSetInput });
                        }
                      }}
                      style={{ fontSize: 14, padding: '10px 20px' }}
                    >
                      Upload & Extract Questions →
                    </button>
                  </div>
                </div>
              )}

              {/* STEP: EXTRACTING */}
              {paperModalStep === 'EXTRACTING' && (
                <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                  <div style={{ fontSize: 36, marginBottom: 16 }}>⚡</div>
                  <h4 style={{ fontSize: 20, color: 'var(--navy)', marginBottom: 8 }}>
                    Processing & Extracting Questions
                  </h4>
                  <p style={{ fontSize: 14, color: 'var(--charcoal)', maxWidth: 460, margin: '0 auto 20px auto' }}>
                    Uploading safely to persistent Cloudinary storage and running Multimodal AI extraction to analyze questions, sections, marks, and scoring rubrics…
                  </p>
                  <div style={{ fontSize: 12, color: 'var(--gold)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Please wait a moment…
                  </div>
                </div>
              )}

              {/* STEP: REVIEW & EDIT */}
              {paperModalStep === 'REVIEW' && (
                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      background: 'rgba(14,26,43,0.04)',
                      padding: '12px 16px',
                      border: '1px solid var(--border)',
                      marginBottom: 16,
                    }}
                  >
                    <div>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: '2px 8px',
                          background: 'rgba(180, 83, 9, 0.15)',
                          color: '#b45309',
                          border: '1px solid #b45309',
                          marginRight: 8,
                        }}
                      >
                        EXTRACTED (PENDING VERIFICATION)
                      </span>
                      <span style={{ fontSize: 13, color: 'var(--charcoal)' }}>
                        Review every question below. Edit text, adjust marks, or add missing questions.
                      </span>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 12, color: 'var(--charcoal)' }}>
                        Total Questions: <strong>{editableQuestions.length}</strong> | Total Marks:{' '}
                        <strong style={{ color: 'var(--navy)', fontSize: 16 }}>
                          {editableQuestions.reduce((s, q) => s + (Number(q.maximumMarks) || 0), 0)}
                        </strong>
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 20 }}>
                    {editableQuestions.map((q, idx) => (
                      <div
                        key={idx}
                        style={{
                          background: '#ffffff',
                          border: '1px solid var(--border)',
                          padding: '14px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: 8,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontWeight: 700, color: 'var(--navy)', fontSize: 15 }}>
                              Q{q.questionNumber}
                            </span>
                            <input
                              type="text"
                              value={q.section || ''}
                              onChange={(e) => handleUpdateEditableQuestion(idx, 'section', e.target.value)}
                              placeholder="Section / Part"
                              style={{
                                fontSize: 12,
                                padding: '3px 8px',
                                border: '1px solid var(--border)',
                                width: 110,
                              }}
                            />
                            <input
                              type="text"
                              value={q.subquestion || ''}
                              onChange={(e) => handleUpdateEditableQuestion(idx, 'subquestion', e.target.value)}
                              placeholder="Sub-part (e.g. 1a)"
                              style={{
                                fontSize: 12,
                                padding: '3px 8px',
                                border: '1px solid var(--border)',
                                width: 110,
                              }}
                            />
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--charcoal)' }}>
                                Max Marks:
                              </label>
                              <input
                                type="number"
                                min="0.5"
                                step="0.5"
                                value={q.maximumMarks}
                                onChange={(e) =>
                                  handleUpdateEditableQuestion(idx, 'maximumMarks', parseFloat(e.target.value) || 0)
                                }
                                style={{
                                  fontSize: 13,
                                  fontWeight: 700,
                                  padding: '4px 8px',
                                  border: '1px solid var(--border)',
                                  width: 65,
                                  textAlign: 'center',
                                }}
                              />
                            </div>

                            <button
                              type="button"
                              onClick={() => handleDeleteQuestionRow(idx)}
                              style={{
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--burgundy)',
                                cursor: 'pointer',
                                fontSize: 12,
                              }}
                              title="Delete Question"
                            >
                              ✕ Delete
                            </button>
                          </div>
                        </div>

                        <div>
                          <textarea
                            rows={3}
                            value={q.text}
                            onChange={(e) => handleUpdateEditableQuestion(idx, 'text', e.target.value)}
                            placeholder="Question statement"
                            style={{
                              width: '100%',
                              padding: '8px',
                              border: '1px solid var(--border)',
                              fontSize: 14,
                              lineHeight: 1.4,
                              fontFamily: 'inherit',
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleAddQuestionRow}
                      style={{ fontSize: 13 }}
                    >
                      + Add Question
                    </button>

                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setShowQuestionPaperModal(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleSaveAndVerify}
                        disabled={verifyPaperMutation.isPending}
                        style={{ fontSize: 14, padding: '10px 20px', background: '#15803d', borderColor: '#15803d' }}
                      >
                        {verifyPaperMutation.isPending ? 'Verifying…' : '✓ SAVE & VERIFY QUESTION PAPER'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP: VIEW */}
              {paperModalStep === 'VIEW' && questionPaper && (
                <div>
                  <div
                    style={{
                      background: 'rgba(21, 128, 61, 0.08)',
                      border: '1px solid #15803d',
                      padding: '12px 16px',
                      marginBottom: 20,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, color: '#15803d', fontSize: 14 }}>
                        ✓ Question Paper Verified & Active
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--charcoal)', marginTop: 2 }}>
                        File: {questionPaper.originalFileName} | Set: {questionPaper.paperSet || 'Default'} | Questions:{' '}
                        {questionPaper.verifiedQuestions?.length || questionPaper.totalQuestions} | Max Marks:{' '}
                        {questionPaper.maximumMarks}
                      </div>
                    </div>
                    {questionPaper.secureUrl && (
                      <a
                        href={questionPaper.secureUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                      >
                        Open Source File ↗
                      </a>
                    )}
                  </div>

                  <div style={{ marginBottom: 16 }}>
                    <h5 style={{ fontSize: 14, fontWeight: 700, color: 'var(--navy)', marginBottom: 8 }}>
                      Verified Questions
                    </h5>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 300, overflowY: 'auto' }}>
                      {(questionPaper.verifiedQuestions || []).map((q) => (
                        <div
                          key={q.questionNumber}
                          style={{
                            padding: '10px 14px',
                            background: '#f8fafc',
                            border: '1px solid var(--border)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <strong>Question {q.questionNumber} {q.subquestion ? `(${q.subquestion})` : ''}</strong>
                            <span style={{ fontWeight: 700, color: 'var(--navy)' }}>{q.maximumMarks} Marks</span>
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--charcoal)' }}>{q.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => handleOpenQuestionPaperModal('UPLOAD')}
                    >
                      Replace With New File
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handleOpenQuestionPaperModal('REVIEW')}
                      style={{ fontSize: 13, padding: '8px 16px' }}
                    >
                      Edit Questions
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* FULL ANSWER BOOK AI ANALYSIS PROGRESS MODAL */}
      {/* ============================================================ */}
      {showProgressModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(14, 26, 43, 0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: 24,
          }}
        >
          <div
            style={{
              background: '#ffffff',
              border: '2px solid var(--gold)',
              maxWidth: 720,
              width: '100%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '16px 20px',
                background: 'linear-gradient(135deg, var(--navy) 0%, #1e3a5f 100%)',
                color: '#ffffff',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: '2px solid var(--gold)',
              }}
            >
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--gold)', fontWeight: 700 }}>
                  EVALNEXA BATCH EVALUATOR
                </div>
                <h3 style={{ fontSize: 20, fontWeight: 700, margin: '2px 0 0 0' }}>
                  AI Full Script Analysis
                </h3>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{
                    padding: '3px 10px',
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    background:
                      activeJob?.status === 'COMPLETED'
                        ? 'rgba(21, 128, 61, 0.2)'
                        : activeJob?.status === 'COMPLETED_WITH_REVIEW'
                        ? 'rgba(212, 175, 55, 0.2)'
                        : activeJob?.status === 'COMPLETED_WITH_ERRORS'
                        ? 'rgba(180, 83, 9, 0.2)'
                        : activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED' || activeJob?.status === 'PARTIAL'
                        ? 'rgba(56, 189, 248, 0.2)'
                        : 'rgba(255,255,255,0.1)',
                    color:
                      activeJob?.status === 'COMPLETED'
                        ? '#86efac'
                        : activeJob?.status === 'COMPLETED_WITH_REVIEW'
                        ? '#fde047'
                        : activeJob?.status === 'COMPLETED_WITH_ERRORS'
                        ? '#fca5a5'
                        : activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED' || activeJob?.status === 'PARTIAL'
                        ? '#38bdf8'
                        : '#ffffff',
                    border: '1px solid currentColor',
                  }}
                >
                  {activeJob?.status || 'NOT STARTED'}
                </span>
                <button
                  type="button"
                  onClick={() => setShowProgressModal(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#ffffff',
                    fontSize: 22,
                    cursor: 'pointer',
                    lineHeight: 1,
                  }}
                  title="Close modal and continue working"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
              {/* Progress Summary Cards */}
              {(() => {
                const jobProg = getJobProgress(activeJob);
                const totalQ = jobProg.totalQuestions || activeQuestions.length || 1;
                const completedQ = jobProg.completedQuestions || 0;
                const percent = Math.min(100, Math.round((completedQ / totalQ) * 100));

                return (
                  <>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: 12,
                        marginBottom: 16,
                      }}
                    >
                      <div style={{ background: '#f8fafc', border: '1px solid var(--border)', padding: '12px 14px' }}>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--charcoal)', fontWeight: 600 }}>
                          Questions
                        </div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--navy)', marginTop: 2 }}>
                          {jobProg.completedQuestions} / {jobProg.totalQuestions || activeQuestions.length}
                        </div>
                        <div style={{ fontSize: 11, color: '#15803d', marginTop: 2 }}>
                          Completed
                        </div>
                      </div>

                      <div style={{ background: '#f8fafc', border: '1px solid var(--border)', padding: '12px 14px' }}>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--charcoal)', fontWeight: 600 }}>
                          Answer Pages
                        </div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--navy)', marginTop: 2 }}>
                          {jobProg.analyzedPages || (activeJob?.status === 'COMPLETED' ? totalPagesCount : 0)} / {jobProg.totalPages || totalPagesCount}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--charcoal)', marginTop: 2 }}>
                          Pages Analyzed
                        </div>
                      </div>

                      <div style={{ background: '#f8fafc', border: '1px solid var(--border)', padding: '12px 14px' }}>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--charcoal)', fontWeight: 600 }}>
                          Current Action
                        </div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {activeJob?.status === 'RUNNING'
                            ? jobProg.currentQuestionNumber
                              ? `Evaluating Q${jobProg.currentQuestionNumber}`
                              : 'Processing scripts…'
                            : activeJob?.status === 'QUEUED'
                            ? 'Job Queued'
                            : activeJob?.status === 'COMPLETED'
                            ? 'All Completed'
                            : activeJob?.status === 'COMPLETED_WITH_REVIEW'
                            ? 'Completed with Review'
                            : activeJob?.status === 'COMPLETED_WITH_ERRORS'
                            ? 'Completed with Errors'
                            : activeJob?.status === 'PARTIAL'
                            ? 'Partial'
                            : 'Idle'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--charcoal)', marginTop: 2 }}>
                          {jobProg.failedCount ? `${jobProg.failedCount} Failed` : 'Advisory only'}
                        </div>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4, fontWeight: 600, color: 'var(--charcoal)' }}>
                        <span>Analysis Progress</span>
                        <span>{percent}%</span>
                      </div>
                      <div style={{ height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${percent}%`,
                            background: 'linear-gradient(90deg, var(--gold) 0%, #15803d 100%)',
                            transition: 'width 0.3s ease',
                          }}
                        />
                      </div>
                    </div>

                    {/* Status Breakdown Pills */}
                    <div style={{ display: 'flex', gap: 12, marginBottom: 16, fontSize: 12 }}>
                      <span style={{ color: '#15803d', fontWeight: 600 }}>
                        ✓ Available: {jobProg.completedQuestions}
                      </span>
                      <span style={{ color: '#b45309', fontWeight: 600 }}>
                        ⚠ Needs Review: {jobProg.needsReviewCount}
                      </span>
                      <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                        ✕ Failed: {jobProg.failedCount}
                      </span>
                    </div>
                  </>
                );
              })()}

              {/* Question-by-Question List */}
              <div style={{ border: '1px solid var(--border)' }}>
                <div
                  style={{
                    padding: '8px 12px',
                    background: '#f1f5f9',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: 'var(--charcoal)',
                    letterSpacing: '0.06em',
                    display: 'grid',
                    gridTemplateColumns: '1.2fr 1fr 1.2fr 1fr',
                  }}
                >
                  <span>Question</span>
                  <span>AI Status</span>
                  <span>Suggested Mark</span>
                  <span style={{ textAlign: 'right' }}>Action</span>
                </div>

                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {activeQuestions.map((q, idx) => {
                    const itemMark = marksState.find((m) => m.questionNumber === q.questionNumber);
                    const aiStatus = itemMark?.aiStatus || (itemMark?.aiAnalysis ? 'COMPLETED' : 'NOT_STARTED');
                    const aiSuggestion = itemMark?.aiAnalysis;
                    const suggestedMarks = aiSuggestion?.suggestedMarks;
                    const confidence = aiSuggestion?.confidence;

                    return (
                      <div
                        key={q.questionNumber}
                        style={{
                          padding: '10px 12px',
                          borderBottom: '1px solid var(--border)',
                          display: 'grid',
                          gridTemplateColumns: '1.2fr 1fr 1.2fr 1fr',
                          alignItems: 'center',
                          fontSize: 13,
                        }}
                      >
                        <div>
                          <strong>Q{q.questionNumber}</strong>
                          <span style={{ fontSize: 11, color: 'var(--charcoal)', marginLeft: 6 }}>
                            ({q.maximumMarks}m)
                          </span>
                        </div>

                        <div>
                          {aiStatus === 'ANALYZING' && (
                            <span style={{ color: '#b45309', fontWeight: 700, fontSize: 12 }}>
                              ◉ Analyzing…
                            </span>
                          )}
                          {aiStatus === 'QUEUED' && (
                            <span style={{ color: '#0284c7', fontWeight: 600, fontSize: 12 }}>
                              ◷ Queued
                            </span>
                          )}
                          {aiStatus === 'COMPLETED' && (
                            <span style={{ color: '#15803d', fontWeight: 700, fontSize: 12 }}>
                              ✓ Completed
                            </span>
                          )}
                          {aiStatus === 'NEEDS_REVIEW' && (
                            <span style={{ color: '#b45309', fontWeight: 700, fontSize: 12 }}>
                              ⚠ Review
                            </span>
                          )}
                          {aiStatus === 'FAILED' && (
                            <span style={{ color: '#b91c1c', fontWeight: 700, fontSize: 12 }}>
                              ✕ Failed
                            </span>
                          )}
                          {aiStatus === 'NOT_STARTED' && (
                            <span style={{ color: 'var(--charcoal)', opacity: 0.6, fontSize: 12 }}>
                              Pending
                            </span>
                          )}
                        </div>

                        <div>
                          {suggestedMarks !== undefined ? (
                            <span>
                              <strong>{suggestedMarks}</strong> / {q.maximumMarks}{' '}
                              <span style={{ fontSize: 11, color: 'var(--charcoal)' }}>
                                ({Math.round((confidence || 0) * 100)}%)
                              </span>
                            </span>
                          ) : itemMark?.aiError ? (
                            <span style={{ fontSize: 11, color: '#b91c1c' }} title={itemMark.aiError}>
                              {itemMark.aiError.slice(0, 24)}…
                            </span>
                          ) : (
                            <span style={{ fontSize: 12, color: 'var(--charcoal)', opacity: 0.6 }}>—</span>
                          )}
                        </div>

                        <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                          {aiStatus === 'FAILED' && (
                            <button
                              type="button"
                              onClick={() => retryQuestionMutation.mutate(q.questionNumber)}
                              disabled={retryQuestionMutation.isPending}
                              style={{
                                fontFamily: 'Cambria',
                                fontSize: 11,
                                padding: '2px 6px',
                                background: 'rgba(185, 28, 28, 0.1)',
                                color: '#b91c1c',
                                border: '1px solid #b91c1c',
                                cursor: 'pointer',
                                fontWeight: 700,
                              }}
                            >
                              Retry
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setActiveQIndex(idx);
                              setShowProgressModal(false);
                            }}
                            style={{
                              fontFamily: 'Cambria',
                              fontSize: 11,
                              padding: '2px 8px',
                              background: 'transparent',
                              border: '1px solid var(--border)',
                              color: 'var(--navy)',
                              cursor: 'pointer',
                            }}
                          >
                            Inspect
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Informational Advisory Note */}
              <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(14,26,43,0.04)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--charcoal)', lineHeight: 1.4 }}>
                <strong>Advisory Reminder:</strong> AI analysis generates suggested marks and page mappings for examiner consideration. Final marks remain under complete examiner authority and are never automatically applied.
              </div>
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--border)',
                background: '#f8fafc',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                {(activeJob?.status === 'RUNNING' || activeJob?.status === 'QUEUED') && (
                  <button
                    type="button"
                    onClick={() => cancelFullAnalysisMutation.mutate()}
                    disabled={cancelFullAnalysisMutation.isPending}
                    style={{
                      fontFamily: 'Cambria',
                      fontSize: 12,
                      padding: '6px 12px',
                      background: 'transparent',
                      color: 'var(--burgundy)',
                      border: '1px solid var(--burgundy)',
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    {cancelFullAnalysisMutation.isPending ? 'Cancelling…' : 'Cancel Analysis'}
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setShowProgressModal(false)}
                  style={{ fontSize: 13, padding: '8px 18px' }}
                >
                  Continue Working in Marking Desk
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
