/**
 * EvalNexa Unified Frontend Configuration - Moderation & Quality Center
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
      `[EvalNexa Configuration Error] ${varName} cannot point to localhost:5000. All panels must connect to ${LIVE_BACKEND_URL}`
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
