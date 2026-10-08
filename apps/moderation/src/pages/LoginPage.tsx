import React from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { UnifiedLoginPage } from '@evalnexa/ui';

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();

  if (user && (user.role === 'MODERATOR' || user.role === 'ADMIN')) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <UnifiedLoginPage
      currentPortal="MODERATOR"
      onLogin={login}
      onNavigateDashboard={() => navigate('/dashboard', { replace: true })}
    />
  );
}
