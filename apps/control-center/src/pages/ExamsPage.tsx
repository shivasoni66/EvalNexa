import React, { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { Exam, AnswerBook, ExamStatus } from '@evalnexa/types';
import { StatusBadge } from '../components/StatusBadge';
import { useSocketEvents } from '../hooks/useSocketEvents';

interface ExamForm {
  title: string;
  subjectCode: string;
  subjectName: string;
  academicSession: string;
  maximumMarks: string;
  totalQuestions: string;
}

const EMPTY_FORM: ExamForm = {
  title: '',
  subjectCode: '',
  subjectName: '',
  academicSession: '',
  maximumMarks: '',
  totalQuestions: '',
};

export function ExamsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showModal, setShowModal] = useState(false);
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [form, setForm] = useState<ExamForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  // Filters (Requirement 17)
  const [sessionFilter, setSessionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Auto-open modal if ?action=create is present
  useEffect(() => {
    if (searchParams.get('action') === 'create') {
      setShowModal(true);
      searchParams.delete('action');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const { data: exams = [], isLoading, isError } = useQuery<Exam[]>({
    queryKey: ['exams'],
    queryFn: async () => {
      const { data } = await apiClient.get('/exams');
      return data.data;
    },
  });

  const { data: answerBooks = [] } = useQuery<AnswerBook[]>({
    queryKey: ['answer-books'],
    queryFn: async () => {
      const { data } = await apiClient.get('/answer-books');
      return data.data;
    },
  });

  const handlers = useCallback(
    () => ({
      'exam.created': () => {
        queryClient.invalidateQueries({ queryKey: ['exams'] });
        queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
      },
      'exam.updated': () => {
        queryClient.invalidateQueries({ queryKey: ['exams'] });
        queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
      },
      'answerbook.created': () => queryClient.invalidateQueries({ queryKey: ['answer-books'] }),
      'answerbook.status.changed': () => queryClient.invalidateQueries({ queryKey: ['answer-books'] }),
      'evaluation.submitted': () => queryClient.invalidateQueries({ queryKey: ['answer-books'] }),
      'moderation.approved': () => queryClient.invalidateQueries({ queryKey: ['answer-books'] }),
    }),
    [queryClient]
  );
  useSocketEvents(handlers());

  const saveMutation = useMutation({
    mutationFn: async (payload: object) => {
      if (editingExamId) {
        const { data } = await apiClient.patch(`/exams/${editingExamId}`, payload);
        return data;
      }
      const { data } = await apiClient.post('/exams', payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exams'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
      setShowModal(false);
      setEditingExamId(null);
      setForm(EMPTY_FORM);
      setFormError('');
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        'Failed to save examination';
      setFormError(msg);
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ExamStatus }) => {
      const { data } = await apiClient.patch(`/exams/${id}`, { status });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exams'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
    },
  });

  const openCreateModal = () => {
    setEditingExamId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowModal(true);
  };

  const openEditModal = (exam: Exam) => {
    setEditingExamId(exam._id);
    setForm({
      title: exam.title,
      subjectCode: exam.subjectCode,
      subjectName: exam.subjectName,
      academicSession: exam.academicSession,
      maximumMarks: String(exam.maximumMarks),
      totalQuestions: String(exam.totalQuestions),
    });
    setFormError('');
    setShowModal(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    saveMutation.mutate({
      ...form,
      maximumMarks: parseInt(form.maximumMarks, 10),
      totalQuestions: parseInt(form.totalQuestions, 10),
    });
  };

  // Distinct sessions for filter dropdown
  const sessions = Array.from(new Set(exams.map((e) => e.academicSession).filter(Boolean)));

  // Filtered exams
  const filteredExams = exams.filter((e) => {
    if (sessionFilter && e.academicSession !== sessionFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    return true;
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-header__eyebrow">Control Center · Examination Operations</div>
          <h1 className="page-header__title">Examination Register</h1>
          <p className="page-header__subtitle">
            Configure institutional courses, define question scoring rubrics, and administer active marking sessions.
          </p>
        </div>
        <div className="page-header__actions">
          <button className="btn btn-primary" onClick={openCreateModal}>
            + New Examination
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="folio-card" style={{ marginBottom: 'var(--sp-6)', padding: '16px 20px' }}>
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--charcoal)' }}>
              Session:
            </span>
            <select
              className="form-select"
              style={{ width: 190, height: 40 }}
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
            >
              <option value="">All Sessions</option>
              {sessions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--charcoal)' }}>
              Status:
            </span>
            <select
              className="form-select"
              style={{ width: 210, height: 40 }}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All Statuses</option>
              <option value="DRAFT">DRAFT</option>
              <option value="READY">READY</option>
              <option value="EVALUATION_OPEN">EVALUATION_OPEN</option>
              <option value="EVALUATION_CLOSED">EVALUATION_CLOSED</option>
              <option value="MODERATION">MODERATION</option>
              <option value="FINALIZED">FINALIZED</option>
            </select>
          </div>

          {(sessionFilter || statusFilter) && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSessionFilter('');
                setStatusFilter('');
              }}
            >
              Reset Filters
            </button>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="live-dot" />
            <span className="label-mono" style={{ fontSize: 11 }}>SOCKET.IO LIVE</span>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="state-container"><div className="spinner" /></div>
      ) : isError ? (
        <div className="state-container">
          <div className="state-title">Failed to load examinations</div>
          <button className="btn btn-secondary state-action" onClick={() => queryClient.invalidateQueries({ queryKey: ['exams'] })}>
            Retry
          </button>
        </div>
      ) : filteredExams.length === 0 ? (
        <div className="state-container">
          <div className="state-icon">📋</div>
          <div className="state-title">No examinations registered.</div>
          <div className="state-body">
            {exams.length > 0
              ? 'No examinations match the applied filters.'
              : 'Register an examination to begin question configuration, script intake, and marking workflows.'}
          </div>
          {exams.length === 0 && (
            <div className="state-action">
              <button className="btn btn-primary" onClick={openCreateModal}>
                Register First Examination
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Examination</th>
                <th>Subject</th>
                <th>Session</th>
                <th>Scripts</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Last Updated</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredExams.map((exam) => {
                const examBooks = answerBooks.filter((ab) => {
                  const eid = typeof ab.examId === 'object' ? (ab.examId as any)._id : ab.examId;
                  return eid === exam._id;
                });
                const totalScripts = examBooks.length;
                const evaluatedScripts = examBooks.filter(
                  (ab) => ab.status === 'SUBMITTED' || ab.status === 'APPROVED' || ab.status === 'FINALIZED'
                ).length;
                const pct = totalScripts > 0 ? Math.round((evaluatedScripts / totalScripts) * 100) : 0;

                return (
                  <tr key={exam._id}>
                    <td>
                      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--navy)' }}>{exam.title}</div>
                      <div className="label-mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        ID: {exam._id.slice(-8).toUpperCase()} · Max Marks: {exam.maximumMarks}
                      </div>
                    </td>
                    <td>
                      <span className="data-table__code">{exam.subjectCode}</span>
                      <div style={{ fontSize: 13, marginTop: 3, color: 'var(--charcoal)' }}>{exam.subjectName}</div>
                    </td>
                    <td style={{ fontWeight: 600 }}>{exam.academicSession}</td>
                    <td>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{totalScripts}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>scripts</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>
                          {evaluatedScripts}/{totalScripts} ({pct}%)
                        </span>
                      </div>
                      <div style={{ width: 100, height: 4, background: '#E5DDD0', marginTop: 4 }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: '#2D6A4F' }} />
                      </div>
                    </td>
                    <td><StatusBadge status={exam.status} /></td>
                    <td className="label-mono" style={{ fontSize: 12 }}>
                      {new Date(exam.updatedAt || exam.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Link to={`/exams/${exam._id}`} className="btn btn-secondary btn-sm">
                          Open
                        </Link>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEditModal(exam)}>
                          Edit
                        </button>
                        <Link to={`/exams/${exam._id}?tab=rubrics`} className="btn btn-ghost btn-sm">
                          Manage
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Exam Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setShowModal(false)}>
          <div className="modal modal--lg">
            <div className="modal__header">
              <div>
                <div className="modal__eyebrow">Examination Register</div>
                <div className="modal__title">
                  {editingExamId ? 'Edit Examination Record' : 'Register New Examination'}
                </div>
              </div>
              <button className="modal__close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal__body">
                <div className="form-grid" style={{ marginBottom: 'var(--space-4)' }}>
                  <div className="form-field form-field--full">
                    <label className="form-label">Examination Title <span className="required">*</span></label>
                    <input
                      className="form-input"
                      type="text"
                      required
                      placeholder="e.g. Advanced Calculus & Analytic Geometry Examination"
                      value={form.title}
                      onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Subject Code <span className="required">*</span></label>
                    <input
                      className="form-input"
                      type="text"
                      required
                      placeholder="e.g. MATH-301"
                      value={form.subjectCode}
                      onChange={(e) => setForm((f) => ({ ...f, subjectCode: e.target.value.toUpperCase() }))}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Subject Name <span className="required">*</span></label>
                    <input
                      className="form-input"
                      type="text"
                      required
                      placeholder="e.g. Pure Mathematics"
                      value={form.subjectName}
                      onChange={(e) => setForm((f) => ({ ...f, subjectName: e.target.value }))}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Academic Session <span className="required">*</span></label>
                    <input
                      className="form-input"
                      type="text"
                      required
                      placeholder="e.g. 2024-2025 Michaelmas"
                      value={form.academicSession}
                      onChange={(e) => setForm((f) => ({ ...f, academicSession: e.target.value }))}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Maximum Marks <span className="required">*</span></label>
                    <input
                      className="form-input"
                      type="number"
                      min="1"
                      required
                      placeholder="e.g. 100"
                      value={form.maximumMarks}
                      onChange={(e) => setForm((f) => ({ ...f, maximumMarks: e.target.value }))}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">Total Questions <span className="required">*</span></label>
                    <input
                      className="form-input"
                      type="number"
                      min="1"
                      required
                      placeholder="e.g. 10"
                      value={form.totalQuestions}
                      onChange={(e) => setForm((f) => ({ ...f, totalQuestions: e.target.value }))}
                    />
                  </div>
                </div>

                {formError && (
                  <div
                    style={{
                      padding: 'var(--space-2) var(--space-3)',
                      background: 'rgba(92,29,36,0.08)',
                      border: '1px solid var(--parchment-burgundy)',
                      color: 'var(--parchment-burgundy)',
                      fontSize: 12,
                      borderRadius: 2,
                    }}
                  >
                    {formError}
                  </div>
                )}
              </div>
              <div className="modal__footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving...' : editingExamId ? 'Update Examination' : 'Register Examination'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
