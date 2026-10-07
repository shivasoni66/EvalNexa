import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { Evaluation, AnswerBook, Exam, User, Question, QuestionMarkItem, QuestionPaper } from '@evalnexa/types';
import { StatusBadge } from '../components/StatusBadge';
import { getSocket } from '../lib/socket';

interface ModerationDetailResponse {
  evaluation: Evaluation;
  moderationHistory: Array<{
    _id: string;
    decision: 'APPROVE' | 'RETURN';
    reason?: string;
    createdAt: string;
    moderatorId?: { name: string; email: string };
  }>;
  secondEvaluation?: {
    _id: string;
    totalMarks: number;
    examinerId?: { name: string; email: string };
    questionMarks?: QuestionMarkItem[];
  } | null;
  questionPaper?: QuestionPaper | null;
}

interface ActiveQuestion {
  questionNumber: number;
  questionLabel?: string;
  section?: string;
  subquestion?: string;
  text: string;
  maximumMarks: number;
  rubric?: Array<{ criterion: string; marks: number }>;
  referenceAnswer?: string;
}

export function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // State
  const [selectedQuestionNumber, setSelectedQuestionNumber] = useState<number | null>(null);
  const [viewingPage, setViewingPage] = useState<number>(1);
  const [zoomScale, setZoomScale] = useState<number>(100);
  const [viewMode, setViewMode] = useState<'SCRIPT_ONLY' | 'SCRIPT_AND_TEXT'>('SCRIPT_ONLY');
  const [showApproveModal, setShowApproveModal] = useState<boolean>(false);
  const [showReturnModal, setShowReturnModal] = useState<boolean>(false);
  const [returnReason, setReturnReason] = useState<string>('');
  const [actionError, setActionError] = useState<string>('');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // 1. Fetch Evaluation and Moderation Details with Polling Fallback
  const { data: detailData, isLoading, isError } = useQuery<ModerationDetailResponse>({
    queryKey: ['moderation-detail', id],
    queryFn: async () => {
      const { data } = await apiClient.get(`/moderation/${id}`);
      return {
        evaluation: data.data,
        moderationHistory: data.history || [],
        secondEvaluation: data.secondEvaluation || null,
        questionPaper: data.questionPaper || null,
      };
    },
    // Polling fallback: refresh every 3 seconds while evaluation is active (SUBMITTED / UNDER_REVIEW)
    refetchInterval: (query) => {
      const status = query.state.data?.evaluation?.status;
      if (status === 'SUBMITTED' || status === 'UNDER_REVIEW') {
        return 3000;
      }
      return false;
    },
  });

  const evaluation = detailData?.evaluation;
  const moderationHistory = detailData?.moderationHistory || [];
  const secondEvaluation = detailData?.secondEvaluation;
  const initialQuestionPaper = detailData?.questionPaper;

  const ab = typeof evaluation?.answerBookId === 'object' ? (evaluation.answerBookId as unknown as AnswerBook) : null;
  const exam = ab && typeof ab.examId === 'object' ? (ab.examId as unknown as Exam) : null;
  const examiner = typeof evaluation?.examinerId === 'object' ? (evaluation.examinerId as unknown as User) : null;
  const examId = exam?._id || (typeof ab?.examId === 'string' ? ab.examId : '');

  // 2. Fallback fetch QuestionPaper if not returned in detailData
  const { data: fallbackQuestionPaper } = useQuery<QuestionPaper | null>({
    queryKey: ['mod-question-paper', ab?._id],
    queryFn: async () => {
      if (!ab?._id) return null;
      try {
        const { data } = await apiClient.get(`/question-papers/answer-book/${ab._id}`);
        return data.data;
      } catch {
        return null;
      }
    },
    enabled: Boolean(ab?._id && !initialQuestionPaper),
  });

  const questionPaper = initialQuestionPaper || fallbackQuestionPaper || null;

  // 3. Fallback fetch Questions & Rubrics for context if needed
  const { data: questions = [] } = useQuery<Question[]>({
    queryKey: ['exam-questions', examId],
    queryFn: async () => {
      const { data } = await apiClient.get(`/exams/${examId}/questions`);
      return data.data;
    },
    enabled: Boolean(examId && (!questionPaper?.verifiedQuestions || questionPaper.verifiedQuestions.length === 0)),
  });

  // 4. Fetch Answer Book Pages list
  const { data: pagesList = [] } = useQuery<{ pageNumber: number }[]>({
    queryKey: ['mod-paper-pages', ab?._id],
    queryFn: async () => {
      if (!ab?._id) return [];
      try {
        const { data } = await apiClient.get(`/answer-books/${ab._id}/pages`);
        return data.data.pages || [];
      } catch {
        return [];
      }
    },
    enabled: Boolean(ab?._id),
  });

  const totalPages = Math.max(pagesList.length, ab?.pageCount || 1);

  // 5. Fetch Secure Page Media for the viewingPage
  const { data: pageMedia, isLoading: isPageLoading } = useQuery<{
    pageNumber: number;
    secureUrl?: string;
    ocr?: { text?: string; confidence?: number | null };
    quality?: { status?: string; blurScore?: number };
    format?: string;
  } | null>({
    queryKey: ['mod-paper-page-media', ab?._id, viewingPage],
    queryFn: async () => {
      if (!ab?._id) return null;
      try {
        const { data } = await apiClient.get(`/answer-books/${ab._id}/pages/${viewingPage}`);
        return data.data;
      } catch {
        return null;
      }
    },
    enabled: Boolean(ab?._id),
  });

  // Real-time synchronization with Socket.IO
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleRealtimeUpdate = (payload?: any) => {
      const payloadEvalId = payload?.evaluation?._id || payload?.evaluationId || payload?.id;
      const payloadAbId = payload?.answerBook?._id || payload?.answerBookId;
      const currentAbId = ab?._id?.toString();

      if (
        !payload ||
        !payloadEvalId ||
        payloadEvalId === id ||
        payloadEvalId === evaluation?._id?.toString() ||
        (payloadAbId && currentAbId && payloadAbId === currentAbId)
      ) {
        queryClient.invalidateQueries({ queryKey: ['moderation-detail', id] });
        queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
        queryClient.invalidateQueries({ queryKey: ['moderation-stats'] });
        if (ab?._id) {
          queryClient.invalidateQueries({ queryKey: ['mod-paper-pages', ab._id] });
          queryClient.invalidateQueries({ queryKey: ['mod-paper-page-media', ab._id] });
          queryClient.invalidateQueries({ queryKey: ['mod-question-paper', ab._id] });
        }
      }
    };

    socket.on('evaluation.submitted', handleRealtimeUpdate);
    socket.on('evaluation.updated', handleRealtimeUpdate);
    socket.on('evaluation.started', handleRealtimeUpdate);
    socket.on('moderation.approved', handleRealtimeUpdate);
    socket.on('moderation.returned', handleRealtimeUpdate);
    socket.on('answerbook.status.changed', handleRealtimeUpdate);
    socket.on('answerbook.mapping.updated', handleRealtimeUpdate);
    socket.on('evaluation.ai.updated', handleRealtimeUpdate);
    socket.on('evaluation.question.reviewed', handleRealtimeUpdate);

    return () => {
      socket.off('evaluation.submitted', handleRealtimeUpdate);
      socket.off('evaluation.updated', handleRealtimeUpdate);
      socket.off('evaluation.started', handleRealtimeUpdate);
      socket.off('moderation.approved', handleRealtimeUpdate);
      socket.off('moderation.returned', handleRealtimeUpdate);
      socket.off('answerbook.status.changed', handleRealtimeUpdate);
      socket.off('answerbook.mapping.updated', handleRealtimeUpdate);
      socket.off('evaluation.ai.updated', handleRealtimeUpdate);
      socket.off('evaluation.question.reviewed', handleRealtimeUpdate);
    };
  }, [id, evaluation?._id, ab?._id, queryClient]);

  // Canonical Authoritative Question Roster (Question-Paper Driven)
  const activeQuestions: ActiveQuestion[] = useMemo(() => {
    // 1. Authoritative: QuestionPaper verified questions
    if (questionPaper?.verifiedQuestions && questionPaper.verifiedQuestions.length > 0) {
      return questionPaper.verifiedQuestions.map((vq) => ({
        questionNumber: vq.questionNumber,
        questionLabel: vq.questionLabel || `Q${vq.questionNumber}`,
        section: vq.section,
        subquestion: vq.subquestion,
        text: vq.text || `Question ${vq.questionNumber}`,
        maximumMarks: vq.maximumMarks,
        rubric: vq.rubric,
        referenceAnswer: vq.referenceAnswer,
      }));
    }

    // 2. From evaluation.questionMarks if recorded
    if (evaluation?.questionMarks && evaluation.questionMarks.length > 0) {
      return evaluation.questionMarks.map((qm) => {
        const matchQ = questions.find((q) => q.questionNumber === qm.questionNumber);
        return {
          questionNumber: qm.questionNumber,
          questionLabel: qm.questionLabel || `Q${qm.questionNumber}`,
          section: qm.section,
          subquestion: qm.subquestion,
          text: matchQ?.text || `Question ${qm.questionNumber}`,
          maximumMarks: matchQ?.maximumMarks || qm.aiAnalysis?.questionMaxMarks || 5,
          rubric: matchQ?.rubric,
          referenceAnswer: matchQ?.referenceAnswer,
        };
      });
    }

    // 3. From QuestionPaper extracted questions (if unverified)
    if (questionPaper?.extractedQuestions && questionPaper.extractedQuestions.length > 0) {
      return questionPaper.extractedQuestions.map((eq) => ({
        questionNumber: eq.questionNumber,
        questionLabel: eq.questionLabel || `Q${eq.questionNumber}`,
        section: eq.section,
        subquestion: eq.subquestion,
        text: eq.text || `Question ${eq.questionNumber}`,
        maximumMarks: eq.maximumMarks,
        rubric: eq.rubric,
        referenceAnswer: eq.referenceAnswer,
      }));
    }

    // 4. From Exam questions collection
    if (questions.length > 0) {
      return questions.map((q) => ({
        questionNumber: q.questionNumber,
        questionLabel: q.questionLabel || `Q${q.questionNumber}`,
        section: q.section,
        subquestion: q.subquestion,
        text: q.text,
        maximumMarks: q.maximumMarks,
        rubric: q.rubric,
      }));
    }

    return [];
  }, [questionPaper, evaluation?.questionMarks, questions]);

  // Dynamic Total Possible Marks (Never hardcoded 100!)
  const totalPossibleMarks = useMemo(() => {
    if (typeof evaluation?.totalPossibleMarks === 'number' && evaluation.totalPossibleMarks > 0) {
      return evaluation.totalPossibleMarks;
    }
    if (activeQuestions.length > 0) {
      return activeQuestions.reduce((sum, q) => sum + (Number(q.maximumMarks) || 0), 0);
    }
    return exam?.maximumMarks || 0;
  }, [evaluation?.totalPossibleMarks, activeQuestions, exam?.maximumMarks]);

  // Question Marks Map for O(1) lookup
  const questionMarksMap = useMemo(() => {
    const map = new Map<number, QuestionMarkItem>();
    (evaluation?.questionMarks || []).forEach((qm) => {
      map.set(qm.questionNumber, qm);
    });
    return map;
  }, [evaluation?.questionMarks]);

  // Selected Question Details
  const selectedQuestion = useMemo(() => {
    if (selectedQuestionNumber === null) return null;
    return activeQuestions.find((q) => q.questionNumber === selectedQuestionNumber) || null;
  }, [selectedQuestionNumber, activeQuestions]);

  const selectedQuestionMarks = useMemo(() => {
    if (selectedQuestionNumber === null) return null;
    return questionMarksMap.get(selectedQuestionNumber) || null;
  }, [selectedQuestionNumber, questionMarksMap]);

  // Persisted question-to-page mapping from AnswerBook
  const currentMapping = useMemo(() => {
    if (!selectedQuestionNumber || !ab?.questionPageMapping) return null;
    return ab.questionPageMapping.find((m) => m.questionNumber === selectedQuestionNumber) || null;
  }, [selectedQuestionNumber, ab?.questionPageMapping]);

  const mappedPages = useMemo(() => {
    if (!currentMapping || !currentMapping.pages || currentMapping.pages.length === 0) {
      return [];
    }
    return [...currentMapping.pages].sort((a, b) => a - b);
  }, [currentMapping]);

  // When a question is clicked, auto-navigate to its first mapped page if available
  const handleSelectQuestion = (qNum: number) => {
    if (selectedQuestionNumber === qNum) {
      setSelectedQuestionNumber(null);
    } else {
      setSelectedQuestionNumber(qNum);
      const qMap = ab?.questionPageMapping?.find((m) => m.questionNumber === qNum);
      if (qMap?.pages && qMap.pages.length > 0) {
        setViewingPage(qMap.pages[0]);
      }
    }
  };

  // Approval Mutation
  const approveMutation = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/moderation/${id}/approve`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      queryClient.invalidateQueries({ queryKey: ['moderation-stats'] });
      queryClient.invalidateQueries({ queryKey: ['moderation-detail', id] });
      setShowApproveModal(false);
      navigate('/review');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Approval failed';
      setActionError(msg);
    },
  });

  // Return Mutation
  const returnMutation = useMutation({
    mutationFn: async (reason: string) => {
      await apiClient.post(`/moderation/${id}/return`, { reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      queryClient.invalidateQueries({ queryKey: ['moderation-stats'] });
      queryClient.invalidateQueries({ queryKey: ['moderation-detail', id] });
      setShowReturnModal(false);
      navigate('/review');
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Return failed';
      setActionError(msg);
    },
  });

  // ============================================================
  // Deterministic Quality Gates (Question-Aware & Dynamic)
  // ============================================================
  const { deterministicIssues, isDeterministicValid, evaluatedCount } = useMemo(() => {
    const issues: string[] = [];
    let count = 0;

    if (activeQuestions.length === 0) {
      issues.push('No question roster found for this examination.');
      return { deterministicIssues: issues, isDeterministicValid: false, evaluatedCount: 0 };
    }

    // 1. Check every question has a valid evaluation state
    const unEvaluatedQuestions: number[] = [];
    const unreviewedQuestions: number[] = [];
    const outOfBoundsQuestions: string[] = [];
    const unmappedQuestions: number[] = [];

    let computedSum = 0;

    activeQuestions.forEach((q) => {
      const qm = questionMarksMap.get(q.questionNumber);
      if (!qm || qm.status === 'NOT_STARTED') {
        unEvaluatedQuestions.push(q.questionNumber);
      } else {
        count++;
        computedSum += qm.marks || 0;

        // Marks bounds check
        if (qm.marks < 0) {
          outOfBoundsQuestions.push(`Q${q.questionNumber} has negative marks (${qm.marks})`);
        }
        if (qm.marks > q.maximumMarks) {
          outOfBoundsQuestions.push(`Q${q.questionNumber} marks (${qm.marks}) exceed maximum (${q.maximumMarks})`);
        }
        if (qm.status === 'NOT_ATTEMPTED' && qm.marks > 0) {
          outOfBoundsQuestions.push(`Q${q.questionNumber} marked as NOT_ATTEMPTED has non-zero marks (${qm.marks})`);
        }

        // Examiner review check
        if (!qm.examinerReviewed) {
          unreviewedQuestions.push(q.questionNumber);
        }

        // Page mapping check (for attempted questions)
        if (qm.status !== 'NOT_ATTEMPTED') {
          const mapping = ab?.questionPageMapping?.find((m) => m.questionNumber === q.questionNumber);
          if (!mapping?.pages || mapping.pages.length === 0) {
            unmappedQuestions.push(q.questionNumber);
          }
        }
      }
    });

    if (unEvaluatedQuestions.length > 0) {
      issues.push(`Questions missing evaluation: ${unEvaluatedQuestions.map((q) => `Q${q}`).join(', ')}.`);
    }

    if (outOfBoundsQuestions.length > 0) {
      outOfBoundsQuestions.forEach((msg) => issues.push(msg));
    }

    if (unreviewedQuestions.length > 0) {
      issues.push(`Examiner review pending on: ${unreviewedQuestions.map((q) => `Q${q}`).join(', ')}.`);
    }

    if (unmappedQuestions.length > 0) {
      issues.push(`No reliable answer pages mapped for: ${unmappedQuestions.map((q) => `Q${q}`).join(', ')}.`);
    }

    // Arithmetic sum check against evaluation total
    const recordedTotal = evaluation?.totalMarks ?? 0;
    if (Math.abs(computedSum - recordedTotal) > 0.01) {
      issues.push(`Arithmetic discrepancy: Question sum (${computedSum}) ≠ Awarded total (${recordedTotal}).`);
    }

    // Total cannot exceed dynamic maximum
    if (totalPossibleMarks > 0 && recordedTotal > totalPossibleMarks) {
      issues.push(`Total marks (${recordedTotal}) exceed paper maximum allowed (${totalPossibleMarks}).`);
    }

    // Digital answer script custody check
    if (ab?.qualityStatus === 'RESCAN_REQUIRED') {
      issues.push("Answer script is flagged 'RESCAN_REQUIRED' by scanning pipeline.");
    }

    return {
      deterministicIssues: issues,
      isDeterministicValid: issues.length === 0,
      evaluatedCount: count,
    };
  }, [activeQuestions, questionMarksMap, evaluation?.totalMarks, totalPossibleMarks, ab]);

  // Loading and Error states
  if (isLoading) {
    return (
      <div className="state-container" style={{ padding: 'var(--space-10)' }}>
        <div className="spinner" />
        <div className="state-title" style={{ fontSize: 18, marginTop: 'var(--space-3)' }}>
          Loading moderation docket…
        </div>
      </div>
    );
  }

  if (isError || !evaluation) {
    return (
      <div className="state-container" style={{ padding: 'var(--space-10)' }}>
        <div className="state-title" style={{ fontSize: 22, fontFamily: 'Cambria, serif' }}>Evaluation Not Found</div>
        <div className="state-body" style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 4 }}>
          The requested evaluation docket could not be retrieved from MongoDB.
        </div>
        <Link to="/review" className="btn btn-secondary state-action" style={{ marginTop: 'var(--space-4)', fontSize: 14 }}>
          ← Return to Review Queue
        </Link>
      </div>
    );
  }

  const canAct = ['SUBMITTED', 'UNDER_REVIEW'].includes(evaluation.status);
  const flaggedQuestions = (evaluation.questionMarks || []).filter((q) => q.status === 'FLAGGED');

  // Modal Handlers
  const handleOpenApproveModal = () => {
    if (!isDeterministicValid) return;
    setActionError('');
    setShowApproveModal(true);
  };

  const handleCloseApproveModal = () => {
    if (approveMutation.isPending) return;
    setActionError('');
    setShowApproveModal(false);
  };

  const handleOpenReturnModal = () => {
    setActionError('');
    setShowReturnModal(true);
  };

  const handleCloseReturnModal = () => {
    if (returnMutation.isPending) return;
    setActionError('');
    setShowReturnModal(false);
  };

  const handleReturnSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const reasonTrimmed = returnReason.trim();
    if (reasonTrimmed.length < 5) {
      setActionError('Please provide a substantive return reason (at least 5 characters).');
      return;
    }
    returnMutation.mutate(reasonTrimmed);
  };

  return (
    <div style={{ maxWidth: 1600, margin: '0 auto', paddingBottom: 'var(--space-8)' }}>
      {/* Navigation Breadcrumb */}
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <Link to="/review" className="btn btn-ghost btn-sm" style={{ fontSize: 13, padding: '4px 8px' }}>
          ← All Moderation Scripts
        </Link>
      </div>

      {/* Header Docket Strip */}
      <div className="page-header" style={{ marginBottom: 'var(--space-4)' }}>
        <div>
          <div className="label-mono" style={{ fontSize: 11, color: 'var(--parchment-gold)', fontWeight: 700 }}>
            MODERATION & QUALITY ASSURANCE DOCKET · SCRIPT {ab?.answerBookCode}
          </div>
          <h1 className="page-header__title" style={{ fontSize: 30, fontWeight: 700, margin: '4px 0 6px 0', fontFamily: 'Cambria, serif' }}>
            {questionPaper?.paperSet ? `${questionPaper.paperSet} · ` : ''}{exam?.title || 'Examination Review'}
          </h1>
          <p className="page-header__subtitle" style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>
            Subject: <strong style={{ color: 'var(--parchment-navy)' }}>{exam?.subjectCode} · {exam?.subjectName}</strong> | 
            Verified Questions: <strong style={{ color: 'var(--parchment-navy)' }}>{activeQuestions.length}</strong> | 
            Paper Total: <strong style={{ color: 'var(--parchment-navy)' }}>{totalPossibleMarks} Marks</strong>
          </p>
        </div>
        <div className="page-header__actions" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ textAlign: 'right' }}>
            <div className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>Status</div>
            <StatusBadge status={evaluation.status} />
          </div>
        </div>
      </div>

      {actionError && (
        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--status-returned-bg)',
            color: 'var(--status-returned-text)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid rgba(180,40,40,0.3)',
            marginBottom: 'var(--space-4)',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          ⚠ {actionError}
        </div>
      )}

      {/* ============================================================ */}
      {/* THREE-COLUMN MODERATION WORKSPACE (24% / 48% / 28%) */}
      {/* ============================================================ */}
      <div style={{ display: 'grid', gridTemplateColumns: '24% 48% 28%', gap: 'var(--space-4)', alignItems: 'start' }}>
        
        {/* ============================================================ */}
        {/* LEFT COLUMN: Review Navigation */}
        {/* ============================================================ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          
          {/* Script Dossier Card */}
          <div className="folio-card">
            <div className="folio-card__header">
              <span className="folio-card__title" style={{ fontSize: 15, fontFamily: 'Cambria, serif' }}>
                Script Information
              </span>
            </div>
            <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                <div>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>Script Docket</div>
                  <div style={{ fontFamily: 'Cambria, serif', fontSize: 17, fontWeight: 700, color: 'var(--parchment-navy)' }}>
                    {ab?.answerBookCode}
                  </div>
                  {ab?.studentCode && (
                    <div className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Student Ref: {ab.studentCode}
                    </div>
                  )}
                </div>

                <div>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>Examiner</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{examiner?.name || 'Unassigned'}</div>
                  <div className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{examiner?.email}</div>
                </div>

                <div>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>Question Paper</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#15803d' }}>
                    {questionPaper ? `✓ ${questionPaper.paperSet || 'Active'} (${questionPaper.verifiedQuestions?.length || activeQuestions.length} Qs, ${totalPossibleMarks}m)` : 'Default Specification'}
                  </div>
                </div>

                <div>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>Document Custody</div>
                  <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span>{totalPages} Scanned Pages</span>
                    <span
                      className="label-mono"
                      style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 2,
                        background: ab?.qualityStatus === 'RESCAN_REQUIRED' ? 'var(--status-returned-bg)' : 'var(--status-approved-bg)',
                        color: ab?.qualityStatus === 'RESCAN_REQUIRED' ? 'var(--status-returned-text)' : 'var(--status-approved-text)',
                      }}
                    >
                      {ab?.qualityStatus || 'VERIFIED'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Complete Question Navigation Card (All verified questions) */}
          <div className="folio-card">
            <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="folio-card__title" style={{ fontSize: 15, fontFamily: 'Cambria, serif' }}>
                Question Navigation
              </span>
              <span className="label-mono" style={{ fontSize: 10, color: evaluatedCount === activeQuestions.length ? '#15803d' : 'var(--text-muted)', fontWeight: 700 }}>
                {evaluatedCount} / {activeQuestions.length} EVALUATED
              </span>
            </div>

            <div className="folio-card__body" style={{ padding: 'var(--space-2)', maxHeight: 520, overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {activeQuestions.map((q) => {
                  const qNum = q.questionNumber;
                  const qm = questionMarksMap.get(qNum);
                  const isSelected = selectedQuestionNumber === qNum;
                  const qMapping = ab?.questionPageMapping?.find((m) => m.questionNumber === qNum);

                  const status = qm?.status || 'NOT_STARTED';
                  const isMarked = status === 'MARKED';
                  const isFlagged = status === 'FLAGGED';
                  const isNotAttempted = status === 'NOT_ATTEMPTED';
                  const isNotEvaluated = status === 'NOT_STARTED';

                  const badgeBg = isMarked
                    ? 'var(--status-approved-bg)'
                    : isFlagged
                    ? 'var(--status-returned-bg)'
                    : isNotAttempted
                    ? 'rgba(14,26,43,0.06)'
                    : 'rgba(255,100,50,0.12)';

                  const badgeColor = isMarked
                    ? 'var(--status-approved-text)'
                    : isFlagged
                    ? 'var(--status-returned-text)'
                    : isNotAttempted
                    ? 'var(--text-muted)'
                    : 'rgb(200,60,20)';

                  return (
                    <button
                      key={qNum}
                      type="button"
                      onClick={() => handleSelectQuestion(qNum)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 10px',
                        background: isSelected ? 'rgba(14,26,43,0.08)' : 'transparent',
                        border: isSelected ? '1px solid var(--parchment-navy)' : '1px solid transparent',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontFamily: 'Cambria, serif', fontWeight: 700, fontSize: 13, color: isSelected ? 'var(--parchment-navy)' : 'inherit' }}>
                            {q.questionLabel || `Q${qNum}`}
                          </span>
                          <span className="label-mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            /{q.maximumMarks}m
                          </span>
                        </div>
                        {qMapping?.pages && qMapping.pages.length > 0 ? (
                          <span style={{ fontSize: 10, color: '#15803d', fontWeight: 600 }}>
                            p. {qMapping.pages.join(', ')}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: '#b45309' }}>
                            ⚠ No pages
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                        <span style={{ fontFamily: 'Cambria, serif', fontSize: 14, fontWeight: 700, color: 'var(--parchment-navy)' }}>
                          {qm ? `${qm.marks}m` : '—'}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {qm?.examinerReviewed && (
                            <span style={{ fontSize: 9, color: '#15803d', fontWeight: 700 }}>
                              ✓
                            </span>
                          )}
                          <span
                            className="label-mono"
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: 2,
                              background: badgeBg,
                              color: badgeColor,
                            }}
                          >
                            {isNotEvaluated ? 'UNMARKED' : status}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* CENTER COLUMN: Digital Answer Script Viewer */}
        {/* ============================================================ */}
        <div className="folio-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 740, border: '1px solid var(--parchment-border)' }}>
          
          {/* Question-Aware Page Toolbar */}
          <div
            className="folio-card__header"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'rgba(14,26,43,0.04)',
              padding: '10px 14px',
            }}
          >
            {/* Top Toolbar Row: Question Association & Mapped Pages */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              {selectedQuestion ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: 'Cambria, serif',
                      fontSize: 13,
                      fontWeight: 700,
                      background: 'var(--parchment-navy)',
                      color: '#ffffff',
                      padding: '2px 8px',
                      borderRadius: 2,
                    }}
                  >
                    TARGETING {selectedQuestion.questionLabel || `Q${selectedQuestion.questionNumber}`}
                  </span>
                  
                  {mappedPages.length > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 2 }}>
                        Answer Pages:
                      </span>
                      {mappedPages.map((pageNum) => (
                        <button
                          key={pageNum}
                          type="button"
                          onClick={() => setViewingPage(pageNum)}
                          style={{
                            fontFamily: 'Cambria, serif',
                            fontSize: 11,
                            fontWeight: viewingPage === pageNum ? 700 : 500,
                            padding: '2px 8px',
                            background: viewingPage === pageNum ? '#15803d' : 'rgba(21, 128, 61, 0.1)',
                            color: viewingPage === pageNum ? '#ffffff' : '#15803d',
                            border: '1px solid #15803d',
                            borderRadius: 2,
                            cursor: 'pointer',
                          }}
                        >
                          Page {pageNum} {viewingPage === pageNum ? '✓' : ''}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: 11, color: '#b45309', fontWeight: 600 }}>
                      ⚠ No answer pages mapped for this question
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  Select a question from the left navigation to inspect its mapped answer pages.
                </div>
              )}

              {/* View Mode Toggle: SCRIPT ONLY vs SCRIPT + OCR */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,0,0,0.06)', padding: 2, borderRadius: 4 }}>
                <button
                  type="button"
                  onClick={() => setViewMode('SCRIPT_ONLY')}
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    fontFamily: 'Cambria, serif',
                    fontWeight: viewMode === 'SCRIPT_ONLY' ? 700 : 500,
                    background: viewMode === 'SCRIPT_ONLY' ? '#fff' : 'transparent',
                    border: 'none',
                    borderRadius: 3,
                    cursor: 'pointer',
                    boxShadow: viewMode === 'SCRIPT_ONLY' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  }}
                >
                  SCRIPT ONLY
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('SCRIPT_AND_TEXT')}
                  style={{
                    padding: '3px 8px',
                    fontSize: 11,
                    fontFamily: 'Cambria, serif',
                    fontWeight: viewMode === 'SCRIPT_AND_TEXT' ? 700 : 500,
                    background: viewMode === 'SCRIPT_AND_TEXT' ? '#fff' : 'transparent',
                    border: 'none',
                    borderRadius: 3,
                    cursor: 'pointer',
                    boxShadow: viewMode === 'SCRIPT_AND_TEXT' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  }}
                >
                  SCRIPT + OCR
                </button>
              </div>
            </div>

            {/* Bottom Toolbar Row: Page Navigation and Zoom Controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 6 }}>
              {/* Script-Wide Page Navigation */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={viewingPage <= 1}
                  onClick={() => setViewingPage((p) => Math.max(1, p - 1))}
                  style={{ fontSize: 11, padding: '3px 8px' }}
                >
                  ← Prev
                </button>
                <span className="label-mono" style={{ fontSize: 12, fontWeight: 700, padding: '0 4px' }}>
                  Page {viewingPage} of {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={viewingPage >= totalPages}
                  onClick={() => setViewingPage((p) => Math.min(totalPages, p + 1))}
                  style={{ fontSize: 11, padding: '3px 8px' }}
                >
                  Next →
                </button>
              </div>

              {/* Zoom & Fullscreen Controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setZoomScale((z) => Math.max(60, z - 15))}
                  style={{ fontSize: 12, padding: '3px 8px' }}
                  title="Zoom Out"
                >
                  –
                </button>
                <span className="label-mono" style={{ fontSize: 11 }}>{zoomScale}%</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setZoomScale((z) => Math.min(200, z + 15))}
                  style={{ fontSize: 12, padding: '3px 8px' }}
                  title="Zoom In"
                >
                  +
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setZoomScale(100)}
                  style={{ fontSize: 11, padding: '3px 6px' }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setIsFullscreen(!isFullscreen)}
                  style={{ fontSize: 11, padding: '3px 6px' }}
                >
                  {isFullscreen ? 'Exit Full' : 'Fit'}
                </button>
              </div>
            </div>
          </div>

          {/* Viewer Canvas Area */}
          <div
            className="folio-card__body"
            style={{
              flex: 1,
              background: '#2b2e33',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
              padding: 'var(--space-4)',
              overflowY: 'auto',
              maxHeight: isFullscreen ? '85vh' : '650px',
              position: 'relative',
            }}
          >
            {isPageLoading ? (
              <div className="state-container" style={{ color: '#fff', margin: 'auto' }}>
                <div className="spinner" />
                <div style={{ marginTop: 8, fontSize: 14 }}>Loading authenticated page scan…</div>
              </div>
            ) : pageMedia?.secureUrl ? (
              <div
                style={{
                  width: `${zoomScale}%`,
                  maxWidth: zoomScale <= 100 ? '760px' : 'none',
                  background: '#fff',
                  boxShadow: '0 6px 24px rgba(0,0,0,0.6)',
                  borderRadius: 2,
                  overflow: 'hidden',
                  transition: 'width 0.15s ease',
                }}
              >
                {pageMedia.format === 'pdf' ? (
                  <iframe
                    src={pageMedia.secureUrl}
                    title={`Page ${viewingPage}`}
                    style={{ width: '100%', height: '600px', border: 'none' }}
                  />
                ) : (
                  <img
                    src={pageMedia.secureUrl}
                    alt={`Scanned Answer Sheet Page ${viewingPage}`}
                    style={{ width: '100%', height: 'auto', display: 'block' }}
                  />
                )}
              </div>
            ) : ab?.pdfUrl ? (
              <div style={{ width: '100%', height: 600 }}>
                <iframe src={ab.pdfUrl} title="Script PDF" style={{ width: '100%', height: '100%', border: 'none' }} />
              </div>
            ) : (
              <div className="state-container" style={{ color: '#94a3b8', margin: 'auto' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', marginBottom: 4, fontFamily: 'Cambria, serif' }}>
                  Digital answer script scan unavailable.
                </div>
                <div style={{ fontSize: 13, maxWidth: 360 }}>
                  No authenticated page images currently mapped for Page {viewingPage}.
                </div>
              </div>
            )}

            {/* OCR / Extracted Text Drawer */}
            {viewMode === 'SCRIPT_AND_TEXT' && (
              <div
                style={{
                  marginTop: 'var(--space-4)',
                  width: '100%',
                  maxWidth: '760px',
                  background: '#1e2227',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 4,
                  padding: 'var(--space-3)',
                  color: '#e2e8f0',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--parchment-gold)' }}>
                    OCR & HANDWRITING TEXT EXTRACTION (ASSISTANCE ONLY)
                  </div>
                  {pageMedia?.ocr?.confidence !== undefined && pageMedia?.ocr?.confidence !== null ? (
                    <span className="label-mono" style={{ fontSize: 10, color: '#94a3b8' }}>
                      Confidence: {Math.round(pageMedia.ocr.confidence * 100)}%
                    </span>
                  ) : null}
                </div>
                <div
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 200,
                    overflowY: 'auto',
                    background: '#15181c',
                    padding: 'var(--space-2)',
                    borderRadius: 2,
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  {pageMedia?.ocr?.text || 'No transcribed handwritten text available for this page.'}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ============================================================ */}
        {/* RIGHT COLUMN: Question Detail Card + Docket Certification */}
        {/* ============================================================ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          
          {/* Question-Specific Moderation Detail Card */}
          {selectedQuestion && (
            <div className="folio-card" style={{ border: '2px solid var(--parchment-gold)', background: 'rgba(255,255,255,0.95)' }}>
              <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--parchment-gold)' }}>QUESTION DETAIL</div>
                  <span className="folio-card__title" style={{ fontSize: 17, fontFamily: 'Cambria, serif', fontWeight: 700 }}>
                    {selectedQuestion.questionLabel || `Question ${selectedQuestion.questionNumber}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSelectedQuestionNumber(null)}
                  style={{ fontSize: 11, padding: '2px 6px' }}
                >
                  ✕ Close
                </button>
              </div>

              <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
                {/* Statement & Max Marks */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                    <span className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>STATEMENT</span>
                    <span className="label-mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--parchment-navy)' }}>
                      Maximum: {selectedQuestion.maximumMarks} Marks
                    </span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.4, fontFamily: 'Cambria, serif', color: 'var(--parchment-navy)', background: 'rgba(14,26,43,0.03)', padding: 8, borderRadius: 2 }}>
                    {selectedQuestion.text}
                  </div>
                </div>

                {/* Examiner Awarded Decision */}
                <div style={{ marginBottom: 12, padding: 8, background: 'rgba(255,255,255,0.9)', border: '1px solid var(--parchment-border)', borderRadius: 2 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>EXAMINER DECISION</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: selectedQuestionMarks?.examinerReviewed ? '#15803d' : '#b45309' }}>
                      {selectedQuestionMarks?.examinerReviewed ? 'Reviewed ✓' : '⚠ Unreviewed'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'Cambria, serif', color: 'var(--parchment-navy)' }}>
                      {selectedQuestionMarks ? `${selectedQuestionMarks.marks} / ${selectedQuestion.maximumMarks}` : '—'}
                    </div>
                    <span
                      className="label-mono"
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 2,
                        background: selectedQuestionMarks?.status === 'MARKED' ? 'var(--status-approved-bg)' : 'var(--status-returned-bg)',
                        color: selectedQuestionMarks?.status === 'MARKED' ? 'var(--status-approved-text)' : 'var(--status-returned-text)',
                      }}
                    >
                      {selectedQuestionMarks?.status || 'NOT_STARTED'}
                    </span>
                  </div>
                  {selectedQuestionMarks?.comment && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      Comment: "{selectedQuestionMarks.comment}"
                    </div>
                  )}
                </div>

                {/* AI Copilot Suggestion (Advisory Only) */}
                {selectedQuestionMarks?.aiAnalysis ? (
                  <div style={{ marginBottom: 12, padding: 8, background: 'rgba(14,26,43,0.02)', border: '1px solid var(--parchment-border)', borderRadius: 2 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span className="label-caps" style={{ fontSize: 10, color: 'var(--parchment-gold)' }}>AI COPILOT (ADVISORY)</span>
                      <span className="label-mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        Confidence: {Math.round(selectedQuestionMarks.aiAnalysis.confidence * 100)}%
                      </span>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--parchment-navy)', marginBottom: 4 }}>
                      Suggested: {selectedQuestionMarks.aiAnalysis.suggestedMarks} / {selectedQuestion.maximumMarks}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.3, marginBottom: 6 }}>
                      {selectedQuestionMarks.aiAnalysis.reasoningSummary}
                    </div>

                    {/* Rubric Criteria Breakdown */}
                    {selectedQuestionMarks.aiAnalysis.criteria && selectedQuestionMarks.aiAnalysis.criteria.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div className="label-caps" style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>RUBRIC CRITERIA</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {selectedQuestionMarks.aiAnalysis.criteria.map((c, cIdx) => (
                            <div key={cIdx} style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', background: 'rgba(255,255,255,0.7)', padding: '2px 4px', borderRadius: 2 }}>
                              <span>{c.name}</span>
                              <strong>{c.awardedMarks}/{c.maxMarks}m</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, fontStyle: 'italic' }}>
                    No AI suggestions generated for this question.
                  </div>
                )}

                {/* Answer Pages Mapping */}
                <div>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>MAPPED ANSWER PAGES</div>
                  {mappedPages.length > 0 ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {mappedPages.map((p) => (
                        <button
                          key={p}
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setViewingPage(p)}
                          style={{ fontSize: 11, padding: '3px 8px' }}
                        >
                          View Page {p} →
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#b45309' }}>
                      No scanned pages mapped for this question.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Docket Score Formulation Card */}
          <div className="folio-card">
            <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="folio-card__title" style={{ fontSize: 15, fontFamily: 'Cambria, serif' }}>
                Certification Score Formulation
              </span>
              <span className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)' }}>Authoritative</span>
            </div>

            <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
              {/* Dynamic Total Awarded Marks Display */}
              <div style={{ textAlign: 'center', marginBottom: 'var(--space-3)', padding: 'var(--space-3)', background: 'rgba(14,26,43,0.03)', borderRadius: 'var(--radius-sm)' }}>
                <div className="label-caps" style={{ fontSize: 11, color: 'var(--text-muted)' }}>TOTAL AWARDED MARKS</div>
                <div style={{ fontSize: 32, fontWeight: 700, fontFamily: 'Cambria, serif', color: 'var(--parchment-navy)', marginTop: 2 }}>
                  {evaluation.totalMarks ?? 0}
                  <span style={{ fontSize: 18, color: 'var(--text-muted)', fontWeight: 400 }}> / {totalPossibleMarks}</span>
                </div>
              </div>

              {/* Complete Question Marks Breakdown Table (All questions) */}
              <div className="label-caps" style={{ fontSize: 10, marginBottom: 4 }}>Question Marks Breakdown</div>
              <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--parchment-border)', borderRadius: 2 }}>
                <table className="data-table" style={{ width: '100%', fontSize: 12, margin: 0 }}>
                  <tbody>
                    {activeQuestions.map((q) => {
                      const qm = questionMarksMap.get(q.questionNumber);
                      const isSelected = selectedQuestionNumber === q.questionNumber;
                      return (
                        <tr
                          key={q.questionNumber}
                          onClick={() => handleSelectQuestion(q.questionNumber)}
                          style={{
                            cursor: 'pointer',
                            background: isSelected ? 'rgba(14,26,43,0.08)' : 'transparent',
                          }}
                        >
                          <td style={{ fontWeight: 600 }}>{q.questionLabel || `Q${q.questionNumber}`}</td>
                          <td style={{ fontFamily: 'Cambria, serif', fontWeight: 700 }}>
                            {qm?.marks ?? 0}
                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>/{q.maximumMarks}</span>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span className="label-mono" style={{ fontSize: 9 }}>{qm?.status || 'UNMARKED'}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Deterministic Quality Gate Card */}
          <div className="folio-card">
            <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="folio-card__title" style={{ fontSize: 15, fontFamily: 'Cambria, serif' }}>
                Deterministic Quality Gate
              </span>
              <span
                className="label-mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 2,
                  background: isDeterministicValid ? 'var(--status-approved-bg)' : 'var(--status-returned-bg)',
                  color: isDeterministicValid ? 'var(--status-approved-text)' : 'var(--status-returned-text)',
                }}
              >
                {isDeterministicValid ? '✓ PASSED' : '⚠ BLOCKING'}
              </span>
            </div>

            <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
              {isDeterministicValid ? (
                <div style={{ fontSize: 13, color: 'var(--status-approved-text)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div>✓ All {activeQuestions.length} questions evaluated</div>
                  <div>✓ All marks within maximum boundaries (Total: {evaluation.totalMarks ?? 0} / {totalPossibleMarks})</div>
                  <div>✓ Arithmetic total sum verified</div>
                  <div>✓ Examiner review completed for all questions</div>
                  <div>✓ Digital script custody confirmed</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--status-returned-text)' }}>
                    Approval blocked due to {deterministicIssues.length} rule violation(s):
                  </div>
                  {deterministicIssues.map((issue, idx) => (
                    <div key={idx} style={{ fontSize: 12, color: 'var(--status-returned-text)', background: 'rgba(180,40,40,0.06)', padding: '4px 6px', borderRadius: 2 }}>
                      • {issue}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Examiner Commentary & Flags */}
          <div className="folio-card">
            <div className="folio-card__header">
              <span className="folio-card__title" style={{ fontSize: 14, fontFamily: 'Cambria, serif' }}>
                Examiner Commentary & Flags
              </span>
            </div>
            <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
              {flaggedQuestions.length > 0 && (
                <div style={{ marginBottom: 'var(--space-3)' }}>
                  <div className="label-caps" style={{ fontSize: 10, color: 'var(--status-returned-text)' }}>EXAMINER FLAGS</div>
                  {flaggedQuestions.map((q) => (
                    <div key={q.questionNumber} style={{ fontSize: 12, background: 'var(--status-returned-bg)', color: 'var(--status-returned-text)', padding: 6, borderRadius: 2, marginTop: 4 }}>
                      <strong>Q{q.questionNumber}:</strong> {q.comment || 'Flagged for moderation review'}
                    </div>
                  ))}
                </div>
              )}

              <div>
                <div className="label-caps" style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>General Remarks</div>
                <div style={{ fontSize: 13, fontFamily: 'Cambria, serif', background: 'rgba(255,255,255,0.7)', padding: 8, borderRadius: 2, border: '1px solid var(--parchment-border)' }}>
                  {evaluation.remarks || 'No general commentary recorded by examiner.'}
                </div>
              </div>
            </div>
          </div>

          {/* Double Evaluation Section (if available) */}
          <div className="folio-card">
            <div className="folio-card__header">
              <span className="folio-card__title" style={{ fontSize: 14, fontFamily: 'Cambria, serif' }}>
                Double Evaluation Comparison
              </span>
            </div>
            <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
              {secondEvaluation ? (
                <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div><strong>Examiner 1 ({examiner?.name || 'Primary'}):</strong> {evaluation.totalMarks ?? 0}m</div>
                  <div><strong>Examiner 2 ({secondEvaluation.examinerId?.name || 'Second'}):</strong> {secondEvaluation.totalMarks}m</div>
                  <div style={{ fontWeight: 700, color: Math.abs((evaluation.totalMarks ?? 0) - secondEvaluation.totalMarks) > 5 ? 'var(--status-returned-text)' : 'inherit' }}>
                    Score Discrepancy: {Math.abs((evaluation.totalMarks ?? 0) - secondEvaluation.totalMarks)} marks
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Single evaluation — no second evaluation docket recorded.
                </div>
              )}
            </div>
          </div>

          {/* Moderation Decision Area */}
          <div className="folio-card" style={{ border: '2px solid var(--parchment-border)', background: 'rgba(255,255,255,0.7)' }}>
            <div className="folio-card__header">
              <span className="folio-card__title" style={{ fontSize: 15, fontFamily: 'Cambria, serif' }}>
                Moderation Decision
              </span>
            </div>

            <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
              {canAct ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!isDeterministicValid || approveMutation.isPending}
                    onClick={handleOpenApproveModal}
                    style={{
                      width: '100%',
                      justifyContent: 'center',
                      fontSize: 15,
                      fontWeight: 700,
                      fontFamily: 'Cambria, serif',
                      padding: '11px',
                    }}
                  >
                    ✓ APPROVE EVALUATION
                  </button>

                  {!isDeterministicValid && (
                    <div style={{ fontSize: 11, color: 'var(--status-returned-text)', textAlign: 'center' }}>
                      ⚠ Resolve deterministic quality gate issues before approval can be granted.
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleOpenReturnModal}
                    style={{
                      width: '100%',
                      justifyContent: 'center',
                      fontSize: 14,
                      fontWeight: 600,
                      padding: '9px',
                      color: 'var(--status-returned-text)',
                      borderColor: 'rgba(180,40,40,0.4)',
                    }}
                  >
                    ↩ RETURN FOR REVISION
                  </button>

                  <div className="form-hint" style={{ fontSize: 11, textAlign: 'center', color: 'var(--text-muted)' }}>
                    Returns remand the script back to the examiner's workspace with documented revision instructions.
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 'var(--space-2) 0' }}>
                  <div style={{ fontSize: 26, marginBottom: 4 }}>
                    {evaluation.status === 'APPROVED' ? '✓' : '↩'}
                  </div>
                  <div style={{ fontFamily: 'Cambria, serif', fontSize: 15, fontWeight: 700 }}>
                    {evaluation.status === 'APPROVED' ? 'Evaluation Certified & Approved' : 'Evaluation Remanded to Examiner'}
                  </div>
                  <div className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Recorded in permanent MongoDB ledger.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Decision History Log */}
          {moderationHistory.length > 0 && (
            <div className="folio-card">
              <div className="folio-card__header">
                <span className="folio-card__title" style={{ fontSize: 13, fontFamily: 'Cambria, serif' }}>
                  Docket Decision History
                </span>
              </div>
              <div className="folio-card__body" style={{ padding: 'var(--space-3)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {moderationHistory.map((h) => (
                    <div key={h._id} style={{ fontSize: 11, borderBottom: '1px solid var(--parchment-border)', paddingBottom: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                        <span>{h.decision === 'APPROVE' ? '✓ Approved' : '↩ Returned'} by {h.moderatorId?.name || 'Moderator'}</span>
                        <span className="label-mono">{new Date(h.createdAt).toLocaleDateString()}</span>
                      </div>
                      {h.reason && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{h.reason}</div>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/* APPROVE CONFIRMATION MODAL */}
      {/* ============================================================ */}
      {showApproveModal && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && handleCloseApproveModal()}>
          <div className="modal" style={{ maxWidth: 500 }}>
            <div className="modal__header">
              <div>
                <div className="modal__eyebrow" style={{ fontSize: 11, color: 'var(--parchment-gold)' }}>BINDING CERTIFICATION</div>
                <div className="modal__title" style={{ fontSize: 20, fontFamily: 'Cambria, serif', fontWeight: 700 }}>
                  Approve this evaluation?
                </div>
              </div>
              <button className="modal__close" onClick={handleCloseApproveModal}>✕</button>
            </div>
            <div className="modal__body">
              {actionError && (
                <div
                  style={{
                    background: 'var(--status-returned-bg)',
                    color: 'var(--status-returned-text)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid rgba(180,40,40,0.3)',
                    fontSize: 13,
                    marginBottom: 'var(--space-3)',
                    fontWeight: 600,
                  }}
                >
                  ⚠ {actionError}
                </div>
              )}

              {flaggedQuestions.length > 0 && (
                <div
                  style={{
                    background: 'rgba(255, 180, 0, 0.12)',
                    border: '1px solid rgba(200, 140, 0, 0.4)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 'var(--space-2) var(--space-3)',
                    fontSize: 12,
                    color: 'rgb(140, 90, 0)',
                    marginBottom: 'var(--space-3)',
                  }}
                >
                  <strong>Advisory Notice:</strong> The examiner flagged{' '}
                  <strong>{flaggedQuestions.map((q) => `Q${q.questionNumber}`).join(', ')}</strong> for moderation review.
                  By approving, you certify that these questions have been inspected and confirmed.
                </div>
              )}

              <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 'var(--space-4)' }}>
                Approving this evaluation will certify the awarded marks, finalize custody in MongoDB, and synchronize with the University Control Center and Results ledger.
              </p>

              <div style={{ background: 'rgba(14,26,43,0.04)', padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                <div><strong>Script Code:</strong> {ab?.answerBookCode}</div>
                <div><strong>Examiner:</strong> {examiner?.name}</div>
                <div><strong>Total Certified Marks:</strong> {evaluation.totalMarks ?? 0} {totalPossibleMarks ? `/ ${totalPossibleMarks}` : ''}</div>
                <div><strong>Quality Checks:</strong> <span style={{ color: 'var(--status-approved-text)', fontWeight: 600 }}>✓ All deterministic quality checks passed</span></div>
              </div>
            </div>
            <div className="modal__footer">
              <button type="button" className="btn btn-secondary" disabled={approveMutation.isPending} onClick={handleCloseApproveModal}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={approveMutation.isPending || !isDeterministicValid}
                onClick={() => approveMutation.mutate()}
                style={{ fontWeight: 700, fontFamily: 'Cambria, serif' }}
              >
                {approveMutation.isPending ? 'Certifying Evaluation…' : 'CONFIRM APPROVAL'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* RETURN FOR REVISION MODAL */}
      {/* ============================================================ */}
      {showReturnModal && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && handleCloseReturnModal()}>
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal__header">
              <div>
                <div className="modal__eyebrow" style={{ fontSize: 11, color: 'var(--status-returned-text)' }}>REMAND EVALUATION</div>
                <div className="modal__title" style={{ fontSize: 20, fontFamily: 'Cambria, serif', fontWeight: 700 }}>
                  Return Evaluation to Examiner
                </div>
              </div>
              <button className="modal__close" onClick={handleCloseReturnModal}>✕</button>
            </div>
            <form onSubmit={handleReturnSubmit}>
              <div className="modal__body">
                {actionError && (
                  <div
                    style={{
                      background: 'var(--status-returned-bg)',
                      color: 'var(--status-returned-text)',
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid rgba(180,40,40,0.3)',
                      fontSize: 13,
                      marginBottom: 'var(--space-3)',
                      fontWeight: 600,
                    }}
                  >
                    ⚠ {actionError}
                  </div>
                )}

                <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}>
                  Returning this evaluation resets its status to <strong>RETURNED</strong>. The examiner will be required to review your documented instructions and re-submit.
                </p>

                <div className="form-group">
                  <label className="form-label" style={{ fontSize: 12, fontWeight: 700 }}>
                    Detailed Reason / Revision Instructions <span style={{ color: 'var(--status-returned-text)' }}>*</span>
                  </label>
                  <textarea
                    className="form-textarea"
                    rows={4}
                    value={returnReason}
                    onChange={(e) => {
                      setReturnReason(e.target.value);
                      if (actionError) setActionError('');
                    }}
                    placeholder="Specify exactly why this script is being returned (e.g. Q4 marking inconsistent with rubric, missing justification on Q7, or review requested for flagged items)..."
                    style={{ fontSize: 13, width: '100%', boxSizing: 'border-box' }}
                    required
                  />
                  <div className="form-hint" style={{ fontSize: 11, marginTop: 4 }}>
                    Minimum 5 characters required.
                  </div>
                </div>
              </div>
              <div className="modal__footer">
                <button type="button" className="btn btn-secondary" disabled={returnMutation.isPending} onClick={handleCloseReturnModal}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-secondary"
                  disabled={returnMutation.isPending || returnReason.trim().length < 5}
                  style={{
                    color: 'var(--status-returned-text)',
                    borderColor: 'rgba(180,40,40,0.4)',
                    fontWeight: 700,
                  }}
                >
                  {returnMutation.isPending ? 'Returning Script…' : 'CONFIRM RETURN'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
