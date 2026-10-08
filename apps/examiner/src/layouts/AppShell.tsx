import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ThemeToggle } from '@evalnexa/ui';

const NAV_ITEMS = [
  { label: 'DASHBOARD', to: '/dashboard' },
  { label: 'MY SCRIPTS', to: '/papers' },
  { label: 'MARKING DESK', to: '/evaluate' },
  { label: 'ACTIVITY / HISTORY', to: '/activity' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell" style={{ fontFamily: 'Cambria' }}>
      <header className="app-topbar">
        <div className="app-topbar__brand">
          <div className="app-topbar__logo">æ</div>
          <div className="app-topbar__identity">
            <span className="app-topbar__name" style={{ fontFamily: 'Cambria', letterSpacing: '0.04em' }}>
              EvalNexa
            </span>
            <span className="app-topbar__sub" style={{ fontFamily: 'Cambria' }}>
              // Examiner Workspace
            </span>
          </div>
        </div>

        <nav className="app-topbar__nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              style={{
                fontFamily: 'Cambria',
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: '0.08em',
                padding: '6px 12px',
              }}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="app-topbar__right">
          <ThemeToggle />
          <div className="app-topbar__user" style={{ fontFamily: 'Cambria' }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{user?.name}</span>
            <span className="app-topbar__role-badge" style={{ fontFamily: 'Cambria', fontSize: 11, letterSpacing: '0.08em' }}>
              {user?.role}
            </span>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontFamily: 'Cambria', fontSize: 13 }}
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="app-content">
        <div className="watermark-overlay" aria-hidden="true" style={{ opacity: 0.025, pointerEvents: 'none' }}>
          <svg width="600" height="600" viewBox="0 0 400 400" fill="none">
            <circle cx="200" cy="200" r="190" stroke="currentColor" strokeDasharray="2 3" strokeWidth="0.75" />
            <circle cx="200" cy="200" r="165" stroke="currentColor" strokeWidth="1.25" />
            <circle cx="200" cy="200" r="135" stroke="currentColor" strokeDasharray="6 4" strokeWidth="0.5" />
            <circle cx="200" cy="200" r="85" stroke="currentColor" strokeWidth="0.5" />
            <line x1="200" x2="200" y1="5" y2="395" stroke="currentColor" strokeWidth="0.5" />
            <line x1="5" x2="395" y1="200" y2="200" stroke="currentColor" strokeWidth="0.5" />
          </svg>
        </div>
        <main className="app-main" style={{ padding: '32px 48px' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
