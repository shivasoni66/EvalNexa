import dotenv from 'dotenv';
import path from 'path';

dotenv.config();
if (!process.env.CLOUDINARY_CLOUD_NAME && !process.env.MONGODB_URI) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

function cleanOrigin(url: string | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

const clientControlCenter =
  cleanOrigin(process.env.CLIENT_CONTROL_CENTER_URL || process.env.CONTROL_CENTER_ORIGIN) ||
  'http://localhost:5173';
const clientExaminer =
  cleanOrigin(process.env.CLIENT_EXAMINER_URL || process.env.EXAMINER_ORIGIN) ||
  'http://localhost:5174';
const clientModeration =
  cleanOrigin(process.env.CLIENT_MODERATION_URL || process.env.MODERATION_ORIGIN) ||
  'http://localhost:5175';

const explicitOrigins: string[] = [
  clientControlCenter,
  clientExaminer,
  clientModeration,
  cleanOrigin(process.env.CLIENT_CONTROL_CENTER_URL),
  cleanOrigin(process.env.CLIENT_EXAMINER_URL),
  cleanOrigin(process.env.CLIENT_MODERATION_URL),
  cleanOrigin(process.env.CONTROL_CENTER_ORIGIN),
  cleanOrigin(process.env.EXAMINER_ORIGIN),
  cleanOrigin(process.env.MODERATION_ORIGIN),
  'https://control.shivasoni.me',
  'https://examiner.shivasoni.me',
  'https://moderation.shivasoni.me',
].filter((o): o is string => Boolean(o));

if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').forEach((o) => {
    const cleaned = cleanOrigin(o);
    if (cleaned) explicitOrigins.push(cleaned);
  });
}

const localDevOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:5178',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
  'http://127.0.0.1:5176',
  'http://127.0.0.1:5177',
  'http://127.0.0.1:5178',
];

const resolvedAllowedOrigins = Array.from(new Set([...explicitOrigins, ...localDevOrigins]));

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || '',
  jwtSecret: process.env.JWT_SECRET || 'evalnexa-dev-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clients: {
    controlCenter: clientControlCenter,
    examiner: clientExaminer,
    moderation: clientModeration,
  },
  allowedOrigins: resolvedAllowedOrigins,
  cloudinary: {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME || '').trim().replace(/^["']|["']$/g, ''),
    apiKey: (process.env.CLOUDINARY_API_KEY || '').trim().replace(/^["']|["']$/g, ''),
    apiSecret: (process.env.CLOUDINARY_API_SECRET || '').trim().replace(/^["']|["']$/g, ''),
  },
  ingestionApiKey: process.env.INGESTION_API_KEY || '',
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    isConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0),
  },
};

export { geminiManager } from './gemini';
export * from './aiPolicy';
