import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { UserRole } from '@evalnexa/types';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: UserRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="state-container">
        <div className="spinner" />
        <p className="state-body" style={{ marginTop: 16 }}>Authenticating…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px',
        textAlign: 'center',
        backgroundColor: '#0f0e0d',
        color: '#e0dedb',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{ fontSize: '40px', marginBottom: '16px' }}>🔒</div>
        <h2 style={{ fontSize: '22px', fontWeight: 600, color: '#d4af37', margin: '0 0 12px 0' }}>
          Access Restricted
        </h2>
        <p style={{ maxWidth: '440px', fontSize: '14px', lineHeight: '1.6', color: '#a09d98', margin: '0 0 24px 0' }}>
          You are currently signed in as <strong>{user.name}</strong> ({user.role}). This workspace requires an <strong>{allowedRoles.join(' or ')}</strong> account.
        </p>
        <button
          onClick={() => {
            localStorage.removeItem('evalnexa_token');
            window.location.href = '/login';
          }}
          style={{
            padding: '10px 24px',
            backgroundColor: '#8b263e',
            color: '#ffffff',
            border: '1px solid rgba(212, 175, 55, 0.4)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          Sign Out & Switch to Admin
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
