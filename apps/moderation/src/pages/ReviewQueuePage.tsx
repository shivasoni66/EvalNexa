import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/apiClient';
import { Evaluation, AnswerBook, Exam, User } from '@evalnexa/types';
import { StatusBadge } from '../components/StatusBadge';
import { getSocket } from '../lib/socket';

export function ReviewQueuePage() {
  const queryClient = useQueryClient();

  // Filters state
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [examFilter, setExamFilter] = useState<string>('ALL');
  const [flaggedOnly, setFlaggedOnly] = useState<boolean>(false);
  const [examinerSearch, setExaminerSearch] = useState<string>('');

  const { data: evaluations = [], isLoading, isError } = useQuery<Evaluation[]>({
    queryKey: ['moderation-queue', statusFilter],
    queryFn: async () => {
      // Note: Remote Render backend handles status parameter; omitting or SUBMITTED returns pending
      const url =
        statusFilter === 'ALL' || !statusFilter
          ? '/moderation'
          : `/moderation?status=${statusFilter}`;
      const { data } = await apiClient.get(url);
      return data.data;
    },
    refetchInterval: 5000,
  });

  // Real-time synchronization
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      queryClient.invalidateQueries({ queryKey: ['moderation-stats'] });
    };

    socket.on('evaluation.submitted', handler);
    socket.on('evaluation.updated', handler);
    socket.on('moderation.approved', handler);
    socket.on('moderation.returned', handler);
    socket.on('answerbook.status.changed', handler);

    return () => {
      socket.off('evaluation.submitted', handler);
      socket.off('evaluation.updated', handler);
      socket.off('moderation.approved', handler);
      socket.off('moderation.returned', handler);
      socket.off('answerbook.status.changed', handler);
    };
  }, [queryClient]);

  // Extract distinct exams for the filter dropdown
  const distinctExams = Array.from(
    new Map(
      evaluations
        .map((ev) => {
          const ab = typeof ev.answerBookId === 'object' ? (ev.answerBookId as unknown as AnswerBook) : null;
          const exam = ab && typeof ab.examId === 'object' ? (ab.examId as unknown as Exam) : null;
          return exam ? [exam._id, exam] : null;
        })
        .filter((entry): entry is [string, Exam] => entry !== null)
    ).values()
  );

  // Client-side filtering for exam, flagged, examiner search
  const filteredEvaluations = evaluations.filter((ev) => {
    const ab = typeof ev.answerBookId === 'object' ? (ev.answerBookId as unknown as AnswerBook) : null;
    const exam = ab && typeof ab.examId === 'object' ? (ab.examId as unknown as Exam) : null;
    const examiner = typeof ev.examinerId === 'object' ? (ev.examinerId as unknown as User) : null;

    if (examFilter !== 'ALL') {
      const currentExamId = exam?._id || (typeof ab?.examId === 'string' ? ab.examId : '');
      if (currentExamId !== examFilter) return false;
    }

    const flagCount = ev.questionMarks?.filter((q) => q.status === 'FLAGGED').length || 0;
    if (flaggedOnly && flagCount === 0) return false;

    if (examinerSearch.trim()) {
      const term = examinerSearch.toLowerCase();
      const examinerName = examiner?.name?.toLowerCase() || '';
      const scriptCode = ab?.answerBookCode?.toLowerCase() || '';
      if (!examinerName.includes(term) && !scriptCode.includes(term)) return false;
    }

    return true;
  });

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div className="page-header" style={{ marginBottom: 'var(--space-6)' }}>
        <div>
          <div className="page-header__eyebrow" style={{ fontSize: 13, letterSpacing: '0.08em', color: 'var(--parchment-gold)' }}>
            MODERATION & QUALITY CENTER · WORKFLOW DOCKET
          </div>
          <h1 className="page-header__title" style={{ fontSize: 38, fontWeight: 700, margin: '6px 0 8px 0', fontFamily: 'Cambria, serif' }}>
            Moderation Review Queue
          </h1>
          <p className="page-header__subtitle" style={{ fontSize: 16, color: 'var(--text-muted)' }}>
            Primary operational docket of submitted scripts requiring second-examiner clearance and binding certification.
          </p>
        </div>
        <div className="page-header__actions">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              background: 'rgba(14,26,43,0.05)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--parchment-border)',
            }}
          >
            <div className="live-dot" />
            <span className="label-mono" style={{ fontSize: 11, letterSpacing: '0.08em', fontWeight: 700 }}>
              SOCKET.IO REAL-TIME
            </span>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div
        className="folio-card"
        style={{
          marginBottom: 'var(--space-6)',
          background: 'rgba(255,255,255,0.7)',
          padding: 'var(--space-4)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'flex-end' }}>
          {/* Status Filter */}
          <div style={{ minWidth: 160 }}>
            <label className="form-label" style={{ fontSize: 11, marginBottom: 4 }}>
              Status
            </label>
            <select
              className="form-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ fontSize: 13, padding: '6px 10px', height: 38 }}
            >
              <option value="ALL">All Statuses</option>
              <option value="SUBMITTED">SUBMITTED (Pending)</option>
              <option value="UNDER_REVIEW">UNDER_REVIEW</option>
              <option value="RETURNED">RETURNED</option>
              <option value="APPROVED">APPROVED</option>
            </select>
          </div>

          {/* Exam Filter */}
          <div style={{ minWidth: 200 }}>
            <label className="form-label" style={{ fontSize: 11, marginBottom: 4 }}>
              Examination
            </label>
            <select
              className="form-input"
              value={examFilter}
              onChange={(e) => setExamFilter(e.target.value)}
              style={{ fontSize: 13, padding: '6px 10px', height: 38 }}
            >
              <option value="ALL">All Examinations</option>
              {distinctExams.map((exam) => (
                <option key={exam._id} value={exam._id}>
                  {exam.subjectCode} · {exam.title}
                </option>
              ))}
            </select>
          </div>

          {/* Examiner / Script Search */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="form-label" style={{ fontSize: 11, marginBottom: 4 }}>
              Examiner / Script Search
            </label>
            <input
              type="text"
              className="form-input"
              placeholder="Search script code or examiner name…"
              value={examinerSearch}
              onChange={(e) => setExaminerSearch(e.target.value)}
              style={{ fontSize: 13, padding: '6px 12px', height: 38 }}
            />
          </div>

          {/* Flagged Only Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', height: 38, paddingBottom: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={flaggedOnly}
                onChange={(e) => setFlaggedOnly(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span>⚠ Flagged Only</span>
            </label>
          </div>

          {/* Reset Filters */}
          {(statusFilter !== 'ALL' || examFilter !== 'ALL' || flaggedOnly || examinerSearch) && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setStatusFilter('ALL');
                setExamFilter('ALL');
                setFlaggedOnly(false);
                setExaminerSearch('');
              }}
              style={{ height: 38, fontSize: 12 }}
            >
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* Queue Content */}
      <div className="folio-card">
        <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className="folio-card__title" style={{ fontSize: 18, fontFamily: 'Cambria, serif' }}>
              Pending & Active Evaluations ({filteredEvaluations.length})
            </span>
          </div>
          <span className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            MONGODB ARCHIVAL LEDGER
          </span>
        </div>

        <div className="folio-card__body" style={{ padding: 0 }}>
          {isLoading ? (
            <div className="state-container" style={{ padding: 'var(--space-10)' }}>
              <div className="spinner" />
              <div style={{ marginTop: 'var(--space-3)', fontSize: 14 }}>Loading moderation queue…</div>
            </div>
          ) : isError ? (
            <div className="state-container" style={{ padding: 'var(--space-8)' }}>
              <div className="state-title" style={{ fontSize: 18 }}>Failed to load moderation queue</div>
              <button
                className="btn btn-secondary state-action"
                onClick={() => queryClient.invalidateQueries({ queryKey: ['moderation-queue'] })}
                style={{ marginTop: 'var(--space-3)', fontSize: 13 }}
              >
                Retry
              </button>
            </div>
          ) : filteredEvaluations.length === 0 ? (
            <div className="state-container" style={{ padding: 'var(--space-10)' }}>
              <div className="state-icon" style={{ fontSize: 32 }}>✓</div>
              <div className="state-title" style={{ fontSize: 20, fontFamily: 'Cambria, serif', marginTop: 8 }}>
                No evaluations match queue criteria.
              </div>
              <div className="state-body" style={{ fontSize: 14, color: 'var(--text-muted)', maxWidth: 440, marginTop: 4 }}>
                {evaluations.length === 0
                  ? 'No evaluations are currently pending moderation. When examiners submit completed markings from their workspace, scripts appear here in real time.'
                  : 'Try clearing your status or search filters to see all available scripts.'}
              </div>
            </div>
          ) : (
            <div className="data-table-wrap" style={{ border: 'none', margin: 0 }}>
              <table className="data-table" style={{ width: '100%', fontSize: 14 }}>
                <thead>
                  <tr>
                    <th style={{ fontSize: 12 }}>Script Code</th>
                    <th style={{ fontSize: 12 }}>Examination</th>
                    <th style={{ fontSize: 12 }}>Examiner</th>
                    <th style={{ fontSize: 12 }}>Marks</th>
                    <th style={{ fontSize: 12 }}>Flags</th>
                    <th style={{ fontSize: 12 }}>Anomaly</th>
                    <th style={{ fontSize: 12 }}>Submitted</th>
                    <th style={{ fontSize: 12 }}>Status</th>
                    <th style={{ fontSize: 12, textAlign: 'right' }}>Docket Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvaluations.map((ev) => {
                    const ab = typeof ev.answerBookId === 'object' ? (ev.answerBookId as unknown as AnswerBook) : null;
                    const exam = ab && typeof ab.examId === 'object' ? (ab.examId as unknown as Exam) : null;
                    const examiner = typeof ev.examinerId === 'object' ? (ev.examinerId as unknown as User) : null;

                    const flagsCount = ev.questionMarks?.filter((q) => q.status === 'FLAGGED').length || 0;
                    const isReturned = ev.status === 'RETURNED';
                    const isApproved = ev.status === 'APPROVED';
                    const isUnderReview = ev.status === 'UNDER_REVIEW';

                    // Action label determination
                    const actionLabel = isReturned
                      ? 'REVIEW AGAIN →'
                      : isUnderReview
                      ? 'CONTINUE REVIEW →'
                      : isApproved
                      ? 'VIEW CERTIFIED →'
                      : 'OPEN REVIEW →';

                    return (
                      <tr key={ev._id}>
                        <td>
                          <span className="data-table__code" style={{ fontSize: 14, fontWeight: 700 }}>
                            {ab?.answerBookCode || '—'}
                          </span>
                          {ab?.studentCode && (
                            <div className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              Ref: {ab.studentCode}
                            </div>
                          )}
                        </td>
                        <td>
                          {exam ? (
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600 }}>{exam.title}</div>
                              <div className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {exam.subjectCode}
                              </div>
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {examiner ? (
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 500 }}>{examiner.name}</div>
                              <div className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {examiner.email}
                              </div>
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <span style={{ fontFamily: 'Cambria, serif', fontSize: 16, fontWeight: 700, color: 'var(--parchment-navy)' }}>
                            {ev.totalMarks ?? 0}
                          </span>
                          {(ev.totalPossibleMarks || exam?.maximumMarks) && (
                            <span className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {' '}/ {ev.totalPossibleMarks || exam?.maximumMarks}
                            </span>
                          )}
                        </td>
                        <td>
                          {flagsCount > 0 ? (
                            <span
                              className="label-mono"
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: 2,
                                background: 'var(--status-returned-bg)',
                                color: 'var(--status-returned-text)',
                              }}
                            >
                              ⚠ {flagsCount} FLAGGED
                            </span>
                          ) : (
                            <span className="label-mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              ✓ None
                            </span>
                          )}
                        </td>
                        <td>
                          {(() => {
                            const sum = (ev.questionMarks || []).reduce((acc, q) => acc + (q.marks || 0), 0);
                            const arithmeticMismatch = Math.abs(sum - (ev.totalMarks ?? 0)) > 0.01;
                            const maxExceeded = exam?.maximumMarks !== undefined && (ev.totalMarks ?? 0) > exam.maximumMarks;
                            const hasAnomaly = arithmeticMismatch || maxExceeded || ab?.qualityStatus === 'RESCAN_REQUIRED';
                            return hasAnomaly ? (
                              <span
                                className="label-mono"
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '2px 6px',
                                  borderRadius: 2,
                                  background: 'var(--status-returned-bg)',
                                  color: 'var(--status-returned-text)',
                                }}
                              >
                                ⚠ ANOMALY
                              </span>
                            ) : (
                              <span className="label-mono" style={{ fontSize: 11, color: 'var(--status-approved-text)' }}>
                                ✓ Normal
                              </span>
                            );
                          })()}
                        </td>
                        <td className="label-mono" style={{ fontSize: 12 }}>
                          {ev.submittedAt ? new Date(ev.submittedAt).toLocaleString() : '—'}
                        </td>
                        <td>
                          <StatusBadge status={ev.status} />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Link
                            to={`/review/${ev._id}`}
                            className={`btn ${isApproved ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                            style={{ fontSize: 12, padding: '6px 12px', fontWeight: 600 }}
                          >
                            {actionLabel}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
