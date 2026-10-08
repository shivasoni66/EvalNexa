import React, { useState } from 'react';
import { ThemeToggle } from './ThemeToggle';

export type PortalType = 'ADMIN' | 'EXAMINER' | 'MODERATOR';

export interface PortalConfig {
  id: PortalType;
  label: string;
  role: string;
  port: number;
  eyebrow: string;
  title: string;
  subtitle: string;
  emailLabel: string;
  placeholder: string;
  submitText: string;
  accessLabel: string;
}

export const PORTAL_CONFIGS: Record<PortalType, PortalConfig> = {
  ADMIN: {
    id: 'ADMIN',
    label: 'Control Center',
    role: 'ADMIN',
    port: 5173,
    eyebrow: 'EvalNexa Archival Docket // Control Center',
    title: 'Administrative Access',
    subtitle: 'Authorised entry for accredited university administrators.',
    emailLabel: '1. Institutional Admin Email',
    placeholder: 'admin@institution.edu',
    submitText: 'Authorise & Open Control Center',
    accessLabel: 'Administrators Only',
  },
  EXAMINER: {
    id: 'EXAMINER',
    label: 'Examiner Workspace',
    role: 'EXAMINER',
    port: 5174,
    eyebrow: 'EvalNexa Archival Docket // Examiner Portal',
    title: 'Examiner Access',
    subtitle: 'Authorised entry for accredited faculty examiners.',
    emailLabel: '1. Institutional Faculty Email',
    placeholder: 'examiner@institution.edu',
    submitText: 'Authorise & Open Examiner Workspace',
    accessLabel: 'Accredited Examiners',
  },
  MODERATOR: {
    id: 'MODERATOR',
    label: 'Moderation Center',
    role: 'MODERATOR',
    port: 5175,
    eyebrow: 'EvalNexa Archival Docket // Moderation Portal',
    title: 'Moderation Access',
    subtitle: 'Authorised entry for accredited script moderators.',
    emailLabel: '1. Institutional Moderator Email',
    placeholder: 'moderator@institution.edu',
    submitText: 'Authorise & Open Moderation Center',
    accessLabel: 'Moderators Only',
  },
};

export interface UnifiedLoginPageProps {
  currentPortal: PortalType;
  onLogin: (email: string, password: string) => Promise<{ user?: any; token?: string } | void>;
  onNavigateDashboard: () => void;
}

export function UnifiedLoginPage({
  currentPortal,
  onLogin,
  onNavigateDashboard,
}: UnifiedLoginPageProps) {
  const [selectedPortal, setSelectedPortal] = useState<PortalType>(currentPortal);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const activeConfig = PORTAL_CONFIGS[selectedPortal];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const result = await onLogin(email, password);
      const user = result && 'user' in result ? result.user : null;
      const token = result && 'token' in result ? result.token : localStorage.getItem('evalnexa_token');

      // Determine target portal based on user role or selected tab
      let targetPortal: PortalType = selectedPortal;
      if (user?.role === 'ADMIN' && selectedPortal === 'ADMIN') targetPortal = 'ADMIN';
      else if (user?.role === 'EXAMINER') targetPortal = 'EXAMINER';
      else if (user?.role === 'MODERATOR') targetPortal = 'MODERATOR';
      else if (user?.role === 'ADMIN') targetPortal = selectedPortal; // admin can access all portals

      const targetConfig = PORTAL_CONFIGS[targetPortal];
      const currentPort = window.location.port ? parseInt(window.location.port, 10) : 80;

      if (currentPort === targetConfig.port) {
        onNavigateDashboard();
      } else {
        const destUrl = `http://${window.location.hostname}:${targetConfig.port}/?token=${encodeURIComponent(token || '')}`;
        window.location.href = destUrl;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setError(
        msg.includes('400') || msg.includes('401')
          ? 'Invalid credentials — verify your institutional email and passkey.'
          : msg
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Theme Toggle in top right */}
      <div style={{ position: 'fixed', top: 20, right: 24, zIndex: 100 }}>
        <ThemeToggle />
      </div>

      {/* LEFT — Editorial Hero */}
      <div className="login-hero">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          {/* Prominent EvalNexa Header Mark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
            <div
              style={{
                width: 38,
                height: 38,
                background: 'var(--btn-primary-bg)',
                border: '1.5px solid var(--gold)',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--gold)',
                fontWeight: 800,
                fontSize: '18px',
                boxShadow: 'var(--glow-gold)',
                flexShrink: 0,
              }}
            >
              ✦
            </div>
            <div>
              <div
                style={{
                  fontFamily: '"Cambria", Georgia, serif',
                  fontSize: '26px',
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--ink)',
                  lineHeight: 1.1,
                }}
              >
                EvalNexa
              </div>
              <div
                style={{
                  fontFamily: '"Cambria"',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--gold)',
                }}
              >
                Digital Examination Platform
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 10px',
              background: 'var(--parchment-warm)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              fontFamily: '"Cambria"',
              fontSize: '12px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--ink)',
              width: 'fit-content',
            }}
          >
            <span style={{ color: 'var(--gold)' }}>✦</span>
            <span>EvalNexa Archival Docket // Unified Portal</span>
          </div>

          <h1 className="login-hero__headline">
            Digital Examination
            <br />
            Engineered for
            <em>Sovereign Accuracy.</em>
          </h1>
          <p className="login-hero__description">
            Orchestrate the complete examination lifecycle — from script registration
            and examiner assignment through on-screen evaluation, moderation, and result
            finalisation — within a single governed workflow.
          </p>
        </div>

        <div className="copperplate-rule" />

        <div className="login-hero__meta">
          <div className="login-hero__meta-item">
            <span className="login-hero__meta-label" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Platform
            </span>
            <span
              className="login-hero__meta-value"
              style={{ fontSize: '14px', fontWeight: 700, color: 'var(--ink)' }}
            >
              EvalNexa v1.0
            </span>
          </div>
          <div className="login-hero__meta-item">
            <span className="login-hero__meta-label" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Active Portal
            </span>
            <span className="login-hero__meta-value" style={{ fontSize: '14px' }}>
              {activeConfig.label}
            </span>
          </div>
          <div className="login-hero__meta-item">
            <span className="login-hero__meta-label" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Access Clearance
            </span>
            <span className="login-hero__meta-value" style={{ fontSize: '14px' }}>
              {activeConfig.accessLabel}
            </span>
          </div>
        </div>
      </div>

      {/* RIGHT — Archival Folio Panel */}
      <div className="login-panel">
        {/* Navigation with 3 options inside the login card */}
        <div className="role-tabs" style={{ marginBottom: 'var(--sp-5)' }}>
          {(['ADMIN', 'EXAMINER', 'MODERATOR'] as PortalType[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`role-tab ${selectedPortal === p ? 'active' : ''}`}
              onClick={() => {
                setSelectedPortal(p);
                setError('');
              }}
            >
              {PORTAL_CONFIGS[p].label}
            </button>
          ))}
        </div>

        <div
          className="login-panel__eyebrow"
          style={{
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: 'var(--ink)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginBottom: '8px',
          }}
        >
          <span style={{ color: 'var(--gold)' }}>✦</span>
          <span style={{ color: 'var(--gold)', fontWeight: 800 }}>EvalNexa</span>
          <span style={{ color: 'var(--text-muted)' }}>//</span>
          <span>{activeConfig.label}</span>
        </div>

        <h2 className="login-panel__title">{activeConfig.title}</h2>
        <p className="login-panel__subtitle">{activeConfig.subtitle}</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-field">
            <label className="form-label" htmlFor="portal-email">
              {activeConfig.emailLabel}
            </label>
            <input
              id="portal-email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={activeConfig.placeholder}
              required
              autoComplete="email"
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="portal-password">
              2. Security Passkey
            </label>
            <input
              id="portal-password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••••••"
              required
              autoComplete="current-password"
              style={{
                fontFamily: '"Cambria"',
                letterSpacing: '0.12em',
                color: 'var(--burgundy)',
              }}
            />
          </div>

          {error && (
            <div
              style={{
                padding: '10px 14px',
                background: 'rgba(92,29,36,0.06)',
                border: '1px solid rgba(92,29,36,0.2)',
                fontFamily: '"Cambria"',
                fontSize: '11px',
                color: 'var(--burgundy)',
                letterSpacing: '0.04em',
              }}
            >
              ⚠ {error}
            </div>
          )}

          <button type="submit" className="login-submit" disabled={isLoading}>
            <span>{isLoading ? 'Authorising Syndicate Folio…' : activeConfig.submitText}</span>
            <span className="login-submit__bracket">[↵ ENTER]</span>
          </button>
        </form>
      </div>
    </div>
  );
}
