import React, { useState, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { Exam, AnswerBook, AuditLog } from '@evalnexa/types';
import { StatusBadge } from '../components/StatusBadge';
import { useSocketEvents } from '../hooks/useSocketEvents';

export function DashboardPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedExamId, setSelectedExamId] = useState<string>('');

  // 1. Fetch real Exams from MongoDB
  const { data: exams = [], isLoading: isLoadingExams } = useQuery<Exam[]>({
    queryKey: ['exams'],
    queryFn: async () => {
      const { data } = await apiClient.get('/exams');
      return data.data;
    },
  });

  // 2. Fetch real Answer Books from MongoDB
  const { data: allAnswerBooks = [], isLoading: isLoadingBooks } = useQuery<AnswerBook[]>({
    queryKey: ['dashboard-answer-books'],
    queryFn: async () => {
      const { data } = await apiClient.get('/answer-books');
      return data.data;
    },
    refetchInterval: 10000,
  });

  // 3. Fetch real recent audit events from MongoDB
  const { data: recentEvents = [], isLoading: isLoadingEvents } = useQuery<AuditLog[]>({
    queryKey: ['dashboard-audit'],
    queryFn: async () => {
      const { data } = await apiClient.get('/audit-logs?limit=8');
      return data.data;
    },
    refetchInterval: 8000,
  });

  // Real-time Socket.IO synchronization
  const handlers = useCallback(
    () => ({
      'exam.created': () => {
        queryClient.invalidateQueries({ queryKey: ['exams'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'exam.updated': () => {
        queryClient.invalidateQueries({ queryKey: ['exams'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'answerbook.created': () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'answerbook.assigned': () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'answerbook.status.changed': () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'script.finalized': () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'evaluation.started': () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'evaluation.submitted': () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
      'moderation.approved': () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-audit'] });
      },
    }),
    [queryClient]
  );
  useSocketEvents(handlers());

  // Determine active examination
  const activeExam = useMemo(() => {
    if (selectedExamId) {
      return exams.find((e) => e._id === selectedExamId) || null;
    }
    return exams.length > 0 ? exams[0] : null;
  }, [exams, selectedExamId]);

  // Filter answer books for current examination scope
  const scopedBooks = useMemo(() => {
    if (!activeExam) return allAnswerBooks;
    return allAnswerBooks.filter((b) => {
      const eid = typeof b.examId === 'object' ? (b.examId as any)._id : b.examId;
      return eid === activeExam._id;
    });
  }, [allAnswerBooks, activeExam]);

  // Section 3: Exact 8-Stage Real Operational Pipeline (All real MongoDB counts)
  const pipelineCounts = useMemo(() => {
    const scan = scopedBooks.length;
    const quality = scopedBooks.filter((b) =>
      ['QUALITY_REVIEW', 'VERIFIED', 'READY', 'PROCESSING'].includes(b.qualityStatus || 'PENDING')
    ).length;
    const ocr = scopedBooks.filter((b) =>
      b.pdfUrl || b.qualityStatus === 'VERIFIED' || b.processingStatus === 'OCR_PROCESSING'
    ).length;
    const finalized = scopedBooks.filter((b) =>
      b.status === 'READY' || b.processingStatus === 'READY_FOR_EVALUATION' || b.processingStatus === 'FINALIZED'
    ).length;
    const assigned = scopedBooks.filter((b) => b.status === 'ASSIGNED').length;
    const evaluating = scopedBooks.filter((b) => b.status === 'IN_PROGRESS').length;
    const submitted = scopedBooks.filter((b) => b.status === 'SUBMITTED' || b.status === 'UNDER_REVIEW').length;
    const approved = scopedBooks.filter((b) => b.status === 'APPROVED' || b.status === 'FINALIZED').length;

    return { scan, quality, ocr, finalized, assigned, evaluating, submitted, approved };
  }, [scopedBooks]);

  // Attention check for urgent operational items
  const rescanCount = scopedBooks.filter(
    (b) => b.qualityStatus === 'RESCAN_REQUIRED' || b.processingStatus === 'RESCAN_REQUIRED'
  ).length;
  const unassignedCount = scopedBooks.filter(
    (b) => b.status === 'READY' && (!b.assignedExaminerId || b.assignedExaminerId === '')
  ).length;

  return (
    <div>
      {/* Page Title (Section 3) */}
      <div className="page-header" style={{ marginBottom: 'var(--space-6)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
        <div>
          <div className="page-header__eyebrow">EVALNEXA · EXAMINATION OPERATIONS</div>
          <h1 className="page-header__title">Examination Control Center</h1>
          <p className="page-header__subtitle">
            Central console driving physical script scanning, quality verification, examiner allocation, and live evaluation telemetry.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <Link
            to="/timeline"
            className="btn btn-secondary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            <span>⏱</span>
            <span>Timeline Simulator</span>
          </Link>
        </div>
      </div>

      {/* CURRENT EXAMINATION (Section 3) */}
      <div className="folio-card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="label-caps" style={{ color: 'var(--gold)', letterSpacing: '0.1em' }}>
            Current Examination Context
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span className="label-caps" style={{ fontSize: 'var(--text-metadata)' }}>Select Exam:</span>
            <select
              className="form-select"
              style={{ fontSize: 'var(--text-body)', padding: '6px 12px', minWidth: 260 }}
              value={activeExam?._id || ''}
              onChange={(e) => setSelectedExamId(e.target.value)}
            >
              {exams.length === 0 ? (
                <option value="">No examinations active</option>
              ) : (
                exams.map((ex) => (
                  <option key={ex._id} value={ex._id}>
                    {ex.subjectCode} · {ex.title}
                  </option>
                ))
              )}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--parchment-panel)', border: '1px solid var(--parchment-border)', borderRadius: 'var(--radius-sm)' }}>
              <div className="live-dot" />
              <span className="label-mono" style={{ fontSize: '11px', fontWeight: 600 }}>SOCKET.IO LIVE</span>
            </div>
          </div>
        </div>

        <div className="folio-card__body">
          {isLoadingExams ? (
            <div className="state-container"><div className="spinner" /></div>
          ) : !activeExam ? (
            <div className="state-container" style={{ padding: 'var(--space-6)' }}>
              <div className="state-title">No examinations are currently active.</div>
              <div className="state-body">Create your first examination to begin digital scanning and evaluation.</div>
              <Link to="/exams" className="btn btn-primary state-action">+ Create Examination</Link>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr auto', gap: 'var(--space-4)', alignItems: 'center' }}>
              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Examination Title</div>
                <div style={{ fontSize: 'var(--text-card-title)', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {activeExam.title}
                </div>
              </div>

              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Subject & Code</div>
                <div style={{ fontSize: 'var(--text-body)', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {activeExam.subjectName} ({activeExam.subjectCode})
                </div>
              </div>

              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Session</div>
                <div style={{ fontSize: 'var(--text-body)', color: 'var(--text-secondary)' }}>
                  {activeExam.academicSession}
                </div>
              </div>

              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Status</div>
                <StatusBadge status={activeExam.status} />
              </div>

              <div>
                <Link to={`/exams/${activeExam._id}`} className="btn btn-secondary btn-sm">
                  View Exam Rubric →
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* REAL OPERATIONAL PIPELINE: 8 STAGES (Section 3 & 22) */}
      <div className="folio-card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className="folio-card__title">Examination Lifecycle Pipeline</span>
            <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
              Real-time script progression from physical intake to certified marks
            </div>
          </div>
          <span className="label-mono" style={{ fontSize: 'var(--text-metadata)' }}>
            {scopedBooks.length} Total Scripts In Scope
          </span>
        </div>

        <div className="folio-card__body">
          <div className="pipeline-track">
            <div className="pipeline-node">
              <div className="pipeline-node__count">{pipelineCounts.scan}</div>
              <div className="pipeline-node__label">1. SCAN</div>
              <div className="pipeline-node__sub">Ingested intake</div>
            </div>
            <div className="pipeline-arrow">→</div>

            <div className="pipeline-node">
              <div className="pipeline-node__count">{pipelineCounts.quality}</div>
              <div className="pipeline-node__label">2. QUALITY</div>
              <div className="pipeline-node__sub">Blur & clarity</div>
            </div>
            <div className="pipeline-arrow">→</div>

            <div className="pipeline-node">
              <div className="pipeline-node__count">{pipelineCounts.ocr}</div>
              <div className="pipeline-node__label">3. OCR / REC</div>
              <div className="pipeline-node__sub">Handwriting parse</div>
            </div>
            <div className="pipeline-arrow">→</div>

            <div className="pipeline-node">
              <div className="pipeline-node__count" style={{ color: 'var(--status-approved-text)' }}>
                {pipelineCounts.finalized}
              </div>
              <div className="pipeline-node__label">4. FINALIZED</div>
              <div className="pipeline-node__sub">Ready for docket</div>
            </div>
            <div className="pipeline-arrow">→</div>

            <div className="pipeline-node">
              <div className="pipeline-node__count">{pipelineCounts.assigned}</div>
              <div className="pipeline-node__label">5. ASSIGNED</div>
              <div className="pipeline-node__sub">Examiner allocated</div>
            </div>
            <div className="pipeline-arrow">→</div>

            <div className="pipeline-node">
              <div className="pipeline-node__count" style={{ color: 'var(--status-review-text)' }}>
                {pipelineCounts.evaluating}
              </div>
              <div className="pipeline-node__label">6. EVALUATING</div>
              <div className="pipeline-node__sub">Marking in session</div>
            </div>
            <div className="pipeline-arrow">→</div>

            <div className="pipeline-node">
              <div className="pipeline-node__count">{pipelineCounts.submitted}</div>
              <div className="pipeline-node__label">7. SUBMITTED</div>
              <div className="pipeline-node__sub">Awaiting moderation</div>
            </div>
            <div className="pipeline-arrow">→</div>

            <div className="pipeline-node">
              <div className="pipeline-node__count" style={{ color: 'var(--parchment-navy)' }}>
                {pipelineCounts.approved}
              </div>
              <div className="pipeline-node__label">8. APPROVED</div>
              <div className="pipeline-node__sub">Certified result</div>
            </div>
          </div>
        </div>
      </div>

      {/* DASHBOARD PRIMARY ACTION: ONE DOMINANT ACTION (Section 4) */}
      <div
        className="folio-card"
        style={{
          marginBottom: 'var(--space-6)',
          padding: 'var(--space-6)',
          background: 'var(--card-bg)',
          border: '2px solid var(--gold)',
          boxShadow: 'var(--card-shadow)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
          <div>
            <div className="label-caps" style={{ color: 'var(--gold)', letterSpacing: '0.12em', marginBottom: 4 }}>
              Primary Examination Operation
            </div>
            <div style={{ fontSize: '26px', fontWeight: 700, color: 'var(--ink)', fontFamily: '"Cambria"' }}>
              Digital Script Capture & Ingestion
            </div>
            <div style={{ fontSize: 'var(--text-body)', color: 'var(--text-muted)', marginTop: 4, maxWidth: 600 }}>
              Launch the Scan Center to access browser camera feeds, capture physical answer sheets, and run quality/blur verification.
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
            {/* ONE DOMINANT BUTTON (Section 4) */}
            <Link
              to="/scan-center"
              className="btn btn-primary"
              style={{
                fontSize: '18px',
                padding: '14px 28px',
                border: '1px solid var(--gold)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span>📷</span>
              <span>OPEN SCAN CENTER</span>
              <span>→</span>
            </Link>

            {/* Secondary Actions (Section 4) */}
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Link to="/exams" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
                + Create Examination
              </Link>
              <Link to="/assignments" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
                Assign Examiners
              </Link>
              <Link to="/monitoring" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
                Open Monitoring
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Operational Attention Alerts (if any real issues exist) */}
      {(rescanCount > 0 || unassignedCount > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: rescanCount > 0 && unassignedCount > 0 ? '1fr 1fr' : '1fr', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
          {rescanCount > 0 && (
            <div className="attention-item attention-item--critical">
              <div className="attention-item__icon">⚠</div>
              <div className="attention-item__content">
                <div className="attention-item__title">Rescan Required ({rescanCount} scripts)</div>
                <div className="attention-item__desc">
                  Clarity or blur verification flagged pages that require physical rescan before examiner allocation.
                </div>
              </div>
              <Link to="/scan-center" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
                Review In Scan Center
              </Link>
            </div>
          )}

          {unassignedCount > 0 && (
            <div className="attention-item attention-item--warning">
              <div className="attention-item__icon">📋</div>
              <div className="attention-item__content">
                <div className="attention-item__title">Unassigned Digital Scripts ({unassignedCount} ready)</div>
                <div className="attention-item__desc">
                  Scripts are verified and finalized. Allocate examiners to begin the marking session.
                </div>
              </div>
              <Link to="/assignments" className="btn btn-primary btn-sm" style={{ textDecoration: 'none' }}>
                Assign Now →
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Real Live Operational Activity Stream */}
      <div className="folio-card">
        <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className="folio-card__title">Recent Examination Activity</span>
            <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
              Real-time audit log stream from MongoDB & Socket.IO
            </div>
          </div>
          <Link to="/monitoring" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>
            View Full Live Monitoring →
          </Link>
        </div>

        <div className="folio-card__body" style={{ padding: 0 }}>
          {isLoadingEvents ? (
            <div className="state-container"><div className="spinner" /></div>
          ) : recentEvents.length === 0 ? (
            <div className="state-container" style={{ padding: 'var(--space-6)' }}>
              <div className="state-body">No recent examination events recorded in database.</div>
            </div>
          ) : (
            <div className="data-table-wrap" style={{ border: 'none', margin: 0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Identifier</th>
                    <th>Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEvents.map((evt) => {
                    const actor = typeof evt.actorId === 'object' && evt.actorId ? (evt.actorId as any).name : 'System Operations';
                    return (
                      <tr key={evt._id}>
                        <td className="label-mono" style={{ fontSize: 'var(--text-metadata)' }}>
                          {new Date(evt.createdAt).toLocaleTimeString()}
                        </td>
                        <td>
                          <span
                            className="label-mono"
                            style={{
                              fontSize: '11px',
                              padding: '2px 6px',
                              borderRadius: 2,
                              background: 'rgba(14, 26, 43, 0.05)',
                              color: 'var(--parchment-navy)',
                              fontWeight: 700,
                            }}
                          >
                            {evt.action}
                          </span>
                        </td>
                        <td>
                          <span className="data-table__code" style={{ fontSize: 'var(--text-table)' }}>
                            {evt.entityType}
                          </span>
                        </td>
                        <td className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
                          {evt.entityId}
                        </td>
                        <td style={{ fontSize: 'var(--text-table)', fontWeight: 600 }}>
                          {actor}
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
