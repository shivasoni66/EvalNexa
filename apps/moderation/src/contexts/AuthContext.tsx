import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { User } from '@evalnexa/types';
import { apiClient } from '../lib/apiClient';
import { connectSocket, disconnectSocket } from '../lib/socket';

interface AuthState {
  user: User | null; token: string | null; isLoading: boolean;
  login: (email: string, password: string) => Promise<any>;
  logout: () => Promise<void>;
}
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('token');
    if (tokenFromUrl) {
      localStorage.setItem('evalnexa_token', tokenFromUrl);
      window.history.replaceState({}, '', window.location.pathname);
      return tokenFromUrl;
    }
    return localStorage.getItem('evalnexa_token');
  });
  const [isLoading, setIsLoading] = useState(true);
  const bootstrap = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/auth/me');
      if (data.success) { setUser(data.data); const t = localStorage.getItem('evalnexa_token'); if (t) connectSocket(t); }
    } catch { setUser(null); setToken(null); localStorage.removeItem('evalnexa_token'); }
    finally { setIsLoading(false); }
  }, []);
  useEffect(() => { bootstrap(); }, [bootstrap]);
  const login = useCallback(async (email: string, password: string) => {
    const { data } = await apiClient.post('/auth/login', { email, password });
    if (!data.success) throw new Error(data.message);
    setUser(data.data.user); setToken(data.data.token);
    localStorage.setItem('evalnexa_token', data.data.token); connectSocket(data.data.token);
    return data.data;
  }, []);
  const logout = useCallback(async () => {
    try { await apiClient.post('/auth/logout'); } catch { /* ignore */ }
    setUser(null); setToken(null); localStorage.removeItem('evalnexa_token'); disconnectSocket();
  }, []);
  return <AuthContext.Provider value={{ user, token, isLoading, login, logout }}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
