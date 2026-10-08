/**
 * EvalNexa Unified Frontend Configuration - Control Center
 * Single source of truth for backend endpoints.
 * Production Target: https://evalnexa.onrender.com
 */

export const LIVE_BACKEND_URL = 'https://evalnexa.onrender.com';

function validateBackendOrigin(url: string | undefined, varName: string): string {
  const value = (url && url.trim()) || LIVE_BACKEND_URL;

  if (!value) {
    throw new Error(
      `[EvalNexa Configuration Error] Missing ${varName}. Set ${varName}=${LIVE_BACKEND_URL}`
    );
  }

  if (
    !import.meta.env.DEV &&
    (value.includes('localhost:5000') || value.includes('127.0.0.1:5000'))
  ) {
    throw new Error(
      `[EvalNexa Configuration Error] ${varName} cannot point to localhost:5000 in production.`
    );
  }

  return value.replace(/\/+$/, '');
}

// REST API Base URL: https://evalnexa.onrender.com/api
const rawApiUrl = import.meta.env.VITE_BACKEND_URL || import.meta.env.VITE_API_URL;
const validatedApiOrigin = validateBackendOrigin(rawApiUrl, 'VITE_API_URL');
export const API_BASE_URL = validatedApiOrigin.endsWith('/api')
  ? validatedApiOrigin
  : `${validatedApiOrigin}/api`;

// Socket.IO Server URL: https://evalnexa.onrender.com
const rawSocketUrl = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_BACKEND_URL;
const validatedSocketOrigin = validateBackendOrigin(rawSocketUrl || rawApiUrl, 'VITE_SOCKET_URL');
export const SOCKET_URL = validatedSocketOrigin.replace(/\/api$/, '');

// Cross-panel Moderation Link
export const MODERATION_PANEL_URL =
  import.meta.env.VITE_MODERATION_URL ||
  (import.meta.env.DEV ? 'http://localhost:5175' : 'https://moderation.shivasoni.me');

export interface ScanningServiceConfig {
  url: string | null;
  error?: string;
  isDev: boolean;
}

/**
 * Resolves and validates the scanning service URL.
 * - Development: Falls back to http://localhost:8000 only when DEV is true.
 * - Production: Requires VITE_SCANNING_SERVICE_URL; rejects missing, localhost, and insecure HTTP.
 */
export function getScanningServiceConfig(): ScanningServiceConfig {
  const isDev = Boolean(import.meta.env.DEV);
  const rawUrl = (import.meta.env.VITE_SCANNING_SERVICE_URL as string | undefined)?.trim();

  if (isDev) {
    const devFallback = 'http://localhost:8000';
    const devUrl = rawUrl || devFallback;
    return {
      url: devUrl ? devUrl.replace(/\/+$/, '') : null,
      isDev: true,
    };
  }

  // Production: VITE_SCANNING_SERVICE_URL is required; do not silently hardcode a fallback
  if (!rawUrl) {
    return {
      url: null,
      error: 'VITE_SCANNING_SERVICE_URL is not configured.',
      isDev: false,
    };
  }

  if (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1')) {
    return {
      url: null,
      error: 'VITE_SCANNING_SERVICE_URL cannot point to localhost in production.',
      isDev: false,
    };
  }

  if (!rawUrl.startsWith('https://')) {
    return {
      url: null,
      error: 'VITE_SCANNING_SERVICE_URL must use HTTPS in production. Insecure HTTP endpoints are blocked by browser Mixed Content security policy.',
      isDev: false,
    };
  }

  return {
    url: rawUrl.replace(/\/+$/, ''),
    isDev: false,
  };
}

/**
 * Convenience helper returning the scanning service URL or null if unconfigured/invalid in production.
 */
export function getScanningServiceUrl(): string | null {
  return getScanningServiceConfig().url;
}

