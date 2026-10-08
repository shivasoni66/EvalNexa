import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './layouts/AppShell';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { ExamsPage } from './pages/ExamsPage';
import { ExamDetailPage } from './pages/ExamDetailPage';
import { AnswerBooksPage } from './pages/AnswerBooksPage';
import { ScanCenterPage } from './pages/ScanCenterPage';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { ModerationOverviewPage } from './pages/ModerationOverviewPage';
import { ResultsPage } from './pages/ResultsPage';
import { AuditPage } from './pages/AuditPage';
import { UsersPage } from './pages/UsersPage';
import { TimelineSimulatorPage } from './pages/TimelineSimulatorPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/*"
        element={
          <ProtectedRoute allowedRoles={['ADMIN']}>
            <AppShell>
              <Routes>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="timeline" element={<TimelineSimulatorPage />} />
                <Route path="exams" element={<ExamsPage />} />
                <Route path="exams/:id" element={<ExamDetailPage />} />
                <Route path="answer-books" element={<AnswerBooksPage />} />
                <Route path="scan-center" element={<ScanCenterPage />} />
                <Route path="scan" element={<Navigate to="/scan-center" replace />} />
                <Route path="assignments" element={<AssignmentsPage />} />
                <Route path="monitoring" element={<MonitoringPage />} />
                <Route path="moderation" element={<ModerationOverviewPage />} />
                <Route path="results" element={<ResultsPage />} />
                <Route path="audit" element={<AuditPage />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </AppShell>
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
