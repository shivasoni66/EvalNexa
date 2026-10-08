import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import { config } from '../config';
import { CloudinaryAssetMetadata } from '@evalnexa/types';

// Ensure Cloudinary is initialized on load if config is available
try {
  ensureCloudinaryConfig();
} catch {
  // Ignored on initial module load; validated strictly upon operation invocation
}

export function ensureCloudinaryConfig(): { cloudName: string; apiKey: string; apiSecret: string } {
  const cloudName = (config.cloudinary.cloudName || process.env.CLOUDINARY_CLOUD_NAME || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  const apiKey = (config.cloudinary.apiKey || process.env.CLOUDINARY_API_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  const apiSecret = (config.cloudinary.apiSecret || process.env.CLOUDINARY_API_SECRET || '')
    .trim()
    .replace(/^["']|["']$/g, '');

  if (!cloudName || !apiKey || !apiSecret) {
    const missing: string[] = [];
    if (!cloudName) missing.push('CLOUDINARY_CLOUD_NAME');
    if (!apiKey) missing.push('CLOUDINARY_API_KEY');
    if (!apiSecret) missing.push('CLOUDINARY_API_SECRET');
    throw new Error(
      `Cloudinary configuration incomplete. Missing required environment variable(s): ${missing.join(', ')}`
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return { cloudName, apiKey, apiSecret };
}

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

/**
 * Validates file MIME type, size, and magic bytes if available
 */
export function validateMediaFile(file: {
  mimetype: string;
  size: number;
  originalname?: string;
  buffer?: Buffer;
}): { isValid: boolean; error?: string } {
  if (!file) {
    return { isValid: false, error: 'No media file provided' };
  }

  if (!ALLOWED_MIME_TYPES.includes(file.mimetype.toLowerCase())) {
    return {
      isValid: false,
      error: `Unsupported file format '${file.mimetype}'. Supported formats: JPEG, PNG, WEBP, PDF`,
    };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      error: `File size (${(file.size / (1024 * 1024)).toFixed(2)}MB) exceeds limit of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`,
    };
  }

  // Validate file signature/magic numbers if buffer is present
  if (file.buffer && file.buffer.length >= 4) {
    const header = file.buffer.subarray(0, 4);
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    const isPdf = header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46; // %PDF
    const isRiff = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46; // RIFF (for WEBP)

    if (!isJpeg && !isPng && !isPdf && !isRiff) {
      return {
        isValid: false,
        error: 'File content does not match allowed media signatures (JPEG, PNG, WEBP, PDF)',
      };
    }
  }

  return { isValid: true };
}

/**
 * Builds predictable, stable public ID without student PII
 * Format: evalnexa/exams/{examId}/answer-books/{answerBookId}/pages/page-{pageNumber}
 */
export function buildPagePublicId(
  examId: string,
  answerBookId: string,
  pageNumber: number
): string {
  const paddedPage = String(pageNumber).padStart(4, '0');
  return `evalnexa/exams/${examId}/answer-books/${answerBookId}/pages/page-${paddedPage}`;
}

/**
 * Builds predictable public ID for answer-book documents (e.g. combined PDF)
 */
export function buildDocumentPublicId(
  examId: string,
  answerBookId: string,
  docType = 'complete-booklet'
): string {
  return `evalnexa/exams/${examId}/answer-books/${answerBookId}/documents/${docType}`;
}

/**
 * Builds predictable public ID for question-paper documents
 */
export function buildQuestionPaperPublicId(
  examId: string,
  paperSet: string = 'Default'
): string {
  const safeSet = paperSet.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `evalnexa/exams/${examId}/question-papers/set-${safeSet}-${Date.now()}`;
}

/**
 * Uploads a buffer directly to Cloudinary using upload_stream
 */
export async function uploadMediaBuffer(
  buffer: Buffer,
  options: {
    publicId: string;
    resourceType?: 'image' | 'raw' | 'auto';
    deliveryType?: 'upload' | 'authenticated' | 'private';
    overwrite?: boolean;
    format?: string;
  }
): Promise<CloudinaryAssetMetadata> {
  ensureCloudinaryConfig();

  const resourceType = options.resourceType || 'auto';
  const deliveryType = options.deliveryType || 'upload';

  // Construct upload parameters:
  // - public_id: unique asset identifier
  // - resource_type: 'image', 'raw', or 'auto'
  // - overwrite & invalidate: ensure fresh upload & flush CDN cache
  // - type: Cloudinary defaults to 'upload'. Do NOT send type='upload' as it adds an unnecessary signed parameter.
  //   Only include type if deliveryType is explicitly non-default ('authenticated' or 'private').
  const uploadParams: Record<string, any> = {
    public_id: options.publicId,
    resource_type: resourceType,
    overwrite: options.overwrite !== undefined ? options.overwrite : true,
    invalidate: true,
  };

  if (deliveryType !== 'upload') {
    uploadParams.type = deliveryType;
  }

  if (options.format) {
    uploadParams.format = options.format;
  }

  // Safe diagnostic logging: report parameter names and status without exposing credentials
  const signedParamNames = Object.keys(uploadParams)
    .filter((k) => k !== 'resource_type')
    .sort();
  console.log(`[MediaService] Preparing signed Cloudinary upload for public_id: "${options.publicId}"`);
  console.log(
    `[MediaService] Signed parameters: [${signedParamNames.join(', ')}] | deliveryType: ${deliveryType} | timestamp: auto-generated`
  );

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      uploadParams,
      (error, result: UploadApiResponse | undefined) => {
        if (error || !result) {
          console.error(
            `[MediaService] Cloudinary upload failed for public_id: "${options.publicId}". Error: ${error?.message || 'No result returned'}`
          );
          return reject(error || new Error('Cloudinary upload returned no result'));
        }

        console.log(
          `[MediaService] Cloudinary upload succeeded for public_id: "${result.public_id}" (${result.bytes} bytes, format: ${result.format})`
        );

        resolve({
          publicId: result.public_id,
          assetId: result.asset_id,
          resourceType: result.resource_type,
          deliveryType: result.type,
          format: result.format,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
        });
      }
    );

    const stream = Readable.from(buffer);
    stream.pipe(uploadStream);
  });
}

/**
 * Generates an authorized, time-limited, cryptographically signed Cloudinary delivery URL.
 * Does not expose API secrets.
 */
export function generateAuthorizedMediaUrl(
  publicId: string,
  options: {
    resourceType?: string;
    deliveryType?: string;
    format?: string;
    expiresInSeconds?: number;
  } = {}
): { secureUrl: string; expiresAt: string } {
  const expiresInSeconds = options.expiresInSeconds || 3600; // 1 hour default
  const expiresTimestamp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const expiresAt = new Date(expiresTimestamp * 1000).toISOString();

  const resourceType = options.resourceType || 'image';
  const deliveryType = options.deliveryType || 'upload';

  ensureCloudinaryConfig();

  // Generate signed secure URL
  const urlOptions: Record<string, any> = {
    resource_type: resourceType,
    format: options.format,
    sign_url: true,
    secure: true,
    expires_at: expiresTimestamp,
  };
  if (deliveryType !== 'upload') {
    urlOptions.type = deliveryType;
  }

  const secureUrl = cloudinary.url(publicId, urlOptions);

  return {
    secureUrl,
    expiresAt,
  };
}

/**
 * Safely replaces a media asset:
 * 1. Uploads replacement asset
 * 2. Deletes old asset only after new asset is successfully stored
 */
export async function replaceMediaAsset(
  oldPublicId: string,
  newBuffer: Buffer,
  options: {
    newPublicId: string;
    resourceType?: 'image' | 'raw' | 'auto';
    deliveryType?: 'upload' | 'authenticated' | 'private';
    format?: string;
  }
): Promise<CloudinaryAssetMetadata> {
  // Step 1: Upload new asset
  const newAsset = await uploadMediaBuffer(newBuffer, {
    publicId: options.newPublicId,
    resourceType: options.resourceType || 'auto',
    deliveryType: options.deliveryType || 'upload',
    overwrite: true,
    format: options.format,
  });

  // Step 2: Delete old asset only if publicId changed
  if (oldPublicId && oldPublicId !== options.newPublicId) {
    try {
      await deleteMediaAsset(oldPublicId, options.resourceType || 'auto');
    } catch (delError) {
      console.warn(`[MediaService] Warning: Failed to cleanup old asset ${oldPublicId}:`, delError);
    }
  }

  return newAsset;
}

/**
 * Deletes an asset from Cloudinary
 */
export async function deleteMediaAsset(
  publicId: string,
  resourceType: 'image' | 'raw' | 'auto' = 'image',
  deliveryType = 'upload'
): Promise<boolean> {
  ensureCloudinaryConfig();
  try {
    const destroyParams: Record<string, any> = {
      resource_type: resourceType,
      invalidate: true,
    };
    if (deliveryType !== 'upload') {
      destroyParams.type = deliveryType;
    }
    const result = await cloudinary.uploader.destroy(publicId, destroyParams);
    return result.result === 'ok' || result.result === 'not found';
  } catch (error) {
    console.error(`[MediaService] Failed to delete asset ${publicId}:`, error);
    throw error;
  }
}
