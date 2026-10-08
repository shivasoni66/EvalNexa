import React, { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { Evaluation, AnswerBook, Exam, User, ModeratorDashboardStats } from '@evalnexa/types';
import { StatusBadge } from '../components/StatusBadge';
import { useSocketEvents } from '../hooks/useSocketEvents';
import { MODERATION_PANEL_URL } from '../lib/config';

export function ModerationOverviewPage() {
  const queryClient = useQueryClient();

  const { data: stats, isLoading: statsLoading } = useQuery<ModeratorDashboardStats>({
    queryKey: ['moderation-overview-stats'],
    queryFn: async () => {
      const { data } = await apiClient.get('/moderation/stats');
      return data.data;
    },
    refetchInterval: 15000,
  });

  const { data: queue = [], isLoading: queueLoading } = useQuery<Evaluation[]>({
    queryKey: ['moderation-overview-queue'],
    queryFn: async () => {
      const { data } = await apiClient.get('/moderation/queue');
      return data.data;
    },
    refetchInterval: 15000,
  });

  const handlers = useCallback(
    () => ({
      'evaluation.submitted': () => {
        queryClient.invalidateQueries({ queryKey: ['moderation-overview-stats'] });
        queryClient.invalidateQueries({ queryKey: ['moderation-overview-queue'] });
      },
      'moderation.approved': () => {
        queryClient.invalidateQueries({ queryKey: ['moderation-overview-stats'] });
        queryClient.invalidateQueries({ queryKey: ['moderation-overview-queue'] });
      },
      'moderation.returned': () => {
        queryClient.invalidateQueries({ queryKey: ['moderation-overview-stats'] });
        queryClient.invalidateQueries({ queryKey: ['moderation-overview-queue'] });
      },
    }),
    [queryClient]
  );
  useSocketEvents(handlers());

  const pendingCount = stats?.submitted ?? 0;
  const underReviewCount = stats?.underReview ?? 0;
  const returnedCount = stats?.returned ?? 0;
  const approvedCount = stats?.approved ?? 0;

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-header__eyebrow">Control Center · Quality Governance</div>
          <h1 className="page-header__title">Moderation & Quality Oversight</h1>
          <p className="page-header__subtitle">
            Administrative oversight of evaluation clearances, return dockets, and moderation queue telemetry. Detailed grading reviews take place in the Moderation Center.
          </p>
        </div>
        <div className="page-header__actions">
          <a
            href={MODERATION_PANEL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Open Moderation Center ↗
          </a>
        </div>
      </div>

      {/* Top 4 Operational Metrics (Prompt Section 18: Pending, Under Review, Returned, Approved) */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 'var(--space-6)' }}>
        <div className="stat-card">
          <div className="stat-card__eyebrow">PENDING MODERATION</div>
          <div className="stat-card__value" style={{ color: pendingCount > 0 ? 'var(--status-review-text)' : 'inherit' }}>
            {statsLoading ? '—' : pendingCount}
          </div>
          <div className="stat-card__sub">Awaiting moderator inspection</div>
        </div>

        <div className="stat-card">
          <div className="stat-card__eyebrow">UNDER ACTIVE REVIEW</div>
          <div className="stat-card__value">
            {statsLoading ? '—' : underReviewCount}
          </div>
          <div className="stat-card__sub">Currently on review consoles</div>
        </div>

        <div className="stat-card">
          <div className="stat-card__eyebrow">RETURNED FOR REVISION</div>
          <div className="stat-card__value" style={{ color: returnedCount > 0 ? 'var(--status-returned-text)' : 'inherit' }}>
            {statsLoading ? '—' : returnedCount}
          </div>
          <div className="stat-card__sub">Returned to examiners with notes</div>
        </div>

        <div className="stat-card">
          <div className="stat-card__eyebrow">APPROVED / CERTIFIED</div>
          <div className="stat-card__value" style={{ color: 'var(--status-approved-text)' }}>
            {statsLoading ? '—' : approvedCount}
          </div>
          <div className="stat-card__sub">Cleared for official result publishing</div>
        </div>
      </div>

      {/* Moderation Queue Docket */}
      <div className="folio-card">
        <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className="folio-card__title">Moderation Review Docket ({queue.length})</span>
            <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
              Completed evaluations submitted for institutional verification
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="live-dot" />
            <span className="label-mono" style={{ fontSize: 'var(--text-metadata)', letterSpacing: '0.06em', color: 'var(--text-primary)', fontWeight: 600 }}>
              SOCKET.IO TELEMETRY ACTIVE
            </span>
          </div>
        </div>

        <div className="folio-card__body" style={{ padding: 0 }}>
          {queueLoading ? (
            <div className="state-container"><div className="spinner" /></div>
          ) : queue.length === 0 ? (
            <div className="state-container" style={{ padding: 'var(--space-10)' }}>
              <div className="state-icon">⚖</div>
              <div className="state-title">No Scripts Awaiting Moderation</div>
              <div className="state-body">
                The moderation docket is clear. Submitted examiner evaluations will appear here in real time.
              </div>
            </div>
          ) : (
            <div className="data-table-wrap" style={{ border: 'none', margin: 0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Script Code</th>
                    <th>Examination</th>
                    <th>Examiner</th>
                    <th>Awarded Marks</th>
                    <th>Status</th>
                    <th>Submitted At</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((ev) => {
                    const ab = ev.answerBookId as unknown as AnswerBook;
                    const exam = typeof ab?.examId === 'object' ? (ab.examId as unknown as Exam) : null;
                    const examiner = typeof ev.examinerId === 'object' ? (ev.examinerId as unknown as User) : null;

                    return (
                      <tr key={ev._id}>
                        <td>
                          <span className="data-table__code">{ab?.answerBookCode || '—'}</span>
                          <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
                            {ab?.studentCode || '—'}
                          </div>
                        </td>
                        <td>
                          {exam ? (
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 'var(--text-table)' }}>{exam.title}</div>
                              <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>{exam.subjectCode}</div>
                            </div>
                          ) : '—'}
                        </td>
                        <td style={{ fontSize: 'var(--text-table)' }}>
                          {examiner ? examiner.name : <span style={{ color: 'var(--text-faint)' }}>Unassigned</span>}
                        </td>
                        <td>
                          <span className="label-mono" style={{ fontWeight: 700, fontSize: 'var(--text-body)' }}>
                            {ev.totalMarks ?? '—'}
                          </span>
                          {exam && (
                            <span style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)', marginLeft: 4 }}>
                              / {exam.maximumMarks}
                            </span>
                          )}
                        </td>
                        <td><StatusBadge status={ev.status} /></td>
                        <td className="label-mono" style={{ fontSize: 'var(--text-metadata)' }}>
                          {ev.submittedAt ? new Date(ev.submittedAt).toLocaleTimeString() : '—'} ·{' '}
                          {ev.submittedAt ? new Date(ev.submittedAt).toLocaleDateString() : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <a
                            href={MODERATION_PANEL_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-secondary btn-sm"
                            style={{ textDecoration: 'none' }}
                          >
                            Review in Moderator Panel ↗
                          </a>
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
