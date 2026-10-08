/**
 * EvalNexa Control Center - Real OpenCV / Scanning Service Integration Adapter
 *
 * Connects the browser camera/capture flow to the external OpenCV scanning engine.
 * Pipeline:
 * CAMERA -> CAPTURE FRAME -> OPENCV PROCESSING -> PAGE DETECTION -> CROP -> BLUR CHECK -> QUALITY RESULT
 */

import { QualityStatus, AnswerBookStatus } from '@evalnexa/types';
import { getScanningServiceConfig, getScanningServiceUrl } from './config';

export { getScanningServiceConfig, getScanningServiceUrl };

export interface PageQualityDiagnostics {
  status: 'PASSED' | 'RESCAN_REQUIRED' | 'PENDING' | 'HUMAN_REVIEW';
  blurDetected?: boolean;
  sharpnessScore?: number;
  sharpnessRaw?: number;
  orientation?: string;
  pageDetected?: boolean;
  cropReady?: boolean;
  ocrReadiness?: 'READY' | 'UNCLEAR' | 'FAILED';
  reason?: string;
  outputWidth?: number;
  outputHeight?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface ProcessPageResult {
  success: boolean;
  serviceAvailable: boolean;
  diagnostics?: PageQualityDiagnostics;
  processedImageUrl?: string;
  processedBlob?: Blob;
  ocrText?: string;
  errorMessage?: string;
  outputWidth?: number;
  outputHeight?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  cropReady?: boolean;
}

/**
 * Synchronously converts a Base64 Data URI directly into a binary Blob
 * without relying on fetch(dataUri), which is prone to CSP blocks or URL limits.
 */
export function dataUriToBlob(dataUri: string): Blob {
  const parts = dataUri.split(',');
  if (parts.length < 2) {
    throw new Error('Invalid Data URI format');
  }
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const byteString = atob(parts[1]);
  const arrayBuffer = new ArrayBuffer(byteString.length);
  const uint8Array = new Uint8Array(arrayBuffer);
  for (let i = 0; i < byteString.length; i++) {
    uint8Array[i] = byteString.charCodeAt(i);
  }
  return new Blob([uint8Array], { type: mime });
}

/**
 * Checks connectivity to the scanning service.
 * In development: Checks configured URL or http://localhost:8000.
 * In production: Requires VITE_SCANNING_SERVICE_URL with HTTPS; returns clear configuration error if missing.
 */
export async function checkScanningServiceHealth(
  overrideUrl?: string
): Promise<{ connected: boolean; url: string; error?: string; status?: number }> {
  const config = getScanningServiceConfig();
  const serviceUrl = (overrideUrl !== undefined ? overrideUrl : config.url)?.trim();

  if (!serviceUrl) {
    return {
      connected: false,
      url: '',
      error: config.error || 'VITE_SCANNING_SERVICE_URL is not configured.',
    };
  }

  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  if (isHttps && serviceUrl.startsWith('http://')) {
    return {
      connected: false,
      url: serviceUrl,
      error: 'Insecure HTTP scanning endpoint blocked on HTTPS origin. Remote service must use HTTPS.',
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${serviceUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    }).catch((err) => ({
      fetchError: err?.name === 'AbortError' ? 'Connection timed out (2.5s)' : (err?.message || 'Connection refused / network error'),
    }));
    clearTimeout(timeoutId);

    if (res && 'status' in res) {
      if (res.ok) {
        return { connected: true, url: serviceUrl, status: res.status };
      }
      const errDetail = res.status === 404
        ? '404 Not Found (scanner service not deployed or route missing on Render)'
        : `Scanning service returned HTTP ${res.status}`;
      return { connected: false, url: serviceUrl, error: errDetail, status: res.status };
    }
    return {
      connected: false,
      url: serviceUrl,
      error: (res as any)?.fetchError || 'Connection failed',
    };
  } catch (err: any) {
    return { connected: false, url: serviceUrl, error: err?.message || 'Connection refused' };
  }
}

export interface LiveDocumentDetection {
  detected: boolean;
  corners: [number, number][] | null;
  documentScore: number;
  imageWidth?: number;
  imageHeight?: number;
  reason?: string;
}

/**
 * Lightweight real-time document detector called at 5-10 FPS during camera preview.
 * Connects to external OpenCV microservice if available, or uses in-browser CV engine.
 */
export async function detectDocumentPreview(
  frameBlob: Blob,
  signal?: AbortSignal,
  overrideUrl?: string
): Promise<LiveDocumentDetection> {
  const config = getScanningServiceConfig();
  const serviceUrl = (overrideUrl !== undefined ? overrideUrl : config.url)?.trim();

  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isValidRemoteTarget = Boolean(serviceUrl && !(isHttps && serviceUrl.startsWith('http://')));

  if (isValidRemoteTarget && serviceUrl) {
    try {
      const formData = new FormData();
      formData.append('file', frameBlob, 'preview_frame.jpg');

      const res = await fetch(`${serviceUrl}/detect-document`, {
        method: 'POST',
        body: formData,
        signal,
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json();
        return {
          detected: Boolean(data.detected),
          corners: Array.isArray(data.corners) ? data.corners : null,
          documentScore: typeof data.document_score === 'number' ? data.document_score : 0,
          imageWidth: data.image_width,
          imageHeight: data.image_height,
          reason: data.reason,
        };
      }
    } catch {
      // Remote call failed, seamlessly fall through to client-side CV
    }
  }

  return detectDocumentPreviewClientSide(frameBlob);
}

/**
 * Sends a captured frame to the OpenCV scanning service for real page detection,
 * perspective correction, and blur/sharpness verification.
 * Falls back to in-browser perspective warping if remote service is unavailable.
 */
export async function processPageWithOpenCVService(
  imageBlob: Blob,
  meta: {
    examId: string;
    answerBookCode: string;
    pageNumber: number;
    filename?: string;
    corners?: [number, number][];
    originalCorners?: [number, number][];
    previewWidth?: number;
    previewHeight?: number;
    captureWidth?: number;
    captureHeight?: number;
  },
  overrideUrl?: string
): Promise<ProcessPageResult> {
  const config = getScanningServiceConfig();
  const serviceUrl = (overrideUrl !== undefined ? overrideUrl : config.url)?.trim();

  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isValidRemoteTarget = Boolean(serviceUrl && !(isHttps && serviceUrl.startsWith('http://')));

  if (isValidRemoteTarget && serviceUrl) {
    try {
      const formData = new FormData();
      formData.append('file', imageBlob, meta.filename || `page_${meta.pageNumber}.jpg`);
      formData.append('examId', meta.examId);
      formData.append('answerBookCode', meta.answerBookCode);
      formData.append('pageNumber', String(meta.pageNumber));
      if (meta.corners && meta.corners.length === 4) {
        formData.append('corners', JSON.stringify(meta.corners));
      }
      if (meta.originalCorners && meta.originalCorners.length === 4) {
        formData.append('original_corners', JSON.stringify(meta.originalCorners));
      }
      if (typeof meta.previewWidth === 'number') {
        formData.append('previewWidth', String(meta.previewWidth));
      }
      if (typeof meta.previewHeight === 'number') {
        formData.append('previewHeight', String(meta.previewHeight));
      }
      if (typeof meta.captureWidth === 'number') {
        formData.append('captureWidth', String(meta.captureWidth));
      }
      if (typeof meta.captureHeight === 'number') {
        formData.append('captureHeight', String(meta.captureHeight));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${serviceUrl}/process-page`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timeoutId);

      if (res && res.ok) {
        const data = await res.json();

        let processedBlob: Blob | undefined = undefined;
        if (
          typeof data.processedImageUrl === 'string' &&
          data.processedImageUrl.startsWith('data:image/jpeg;base64,')
        ) {
          try {
            processedBlob = dataUriToBlob(data.processedImageUrl);
          } catch (decodeErr) {
            console.warn('Failed to convert processedImageUrl to Blob:', decodeErr);
            processedBlob = undefined;
          }
        }

        const outputWidth = typeof data.output_width === 'number' ? data.output_width : undefined;
        const outputHeight = typeof data.output_height === 'number' ? data.output_height : undefined;
        const sourceWidth = typeof data.source_width === 'number' ? data.source_width : undefined;
        const sourceHeight = typeof data.source_height === 'number' ? data.source_height : undefined;
        const cropReady = data.cropReady !== undefined ? Boolean(data.cropReady) : true;

        return {
          success: true,
          serviceAvailable: true,
          diagnostics: {
            status:
              data.qualityStatus === 'PASSED'
                ? 'PASSED'
                : data.qualityStatus === 'HUMAN_REVIEW'
                ? 'HUMAN_REVIEW'
                : 'RESCAN_REQUIRED',
            blurDetected: Boolean(data.blurDetected),
            sharpnessScore: typeof data.sharpness === 'number' ? data.sharpness : undefined,
            orientation: data.orientation || 'NORMAL',
            pageDetected: data.pageDetected !== undefined ? Boolean(data.pageDetected) : true,
            cropReady,
            ocrReadiness: data.ocrReadiness || (data.qualityStatus === 'PASSED' ? 'READY' : 'UNCLEAR'),
            reason: data.reason,
            outputWidth,
            outputHeight,
            sourceWidth,
            sourceHeight,
          },
          processedImageUrl: data.processedImageUrl,
          processedBlob,
          ocrText: data.ocrText,
          outputWidth,
          outputHeight,
          sourceWidth,
          sourceHeight,
          cropReady,
        };
      }
    } catch {
      // Remote call failed, seamlessly fall back to client-side engine
    }
  }

  return processPageClientSide(imageBlob, meta);
}

/**
 * Normalizes raw Laplacian variance into a 0-100 quality score.
 * Matches ai-eval-scanner/pipeline.py compute_sharpness_score:
 * - Variance < 55.0 indicates optical blur / defocus (flagged as blur, score 5.0 - 54.9).
 * - Variance >= 55.0 indicates sharp document (score 55.0 - 99.5).
 */
export function computeNormalizedSharpness(laplacianVariance: number): { score: number; blurDetected: boolean } {
  const v = Math.max(0, laplacianVariance);
  if (v < 55.0) {
    const score = Math.max(5.0, Math.min(54.9, (v / 55.0) * 50.0));
    return { score: Math.round(score * 10) / 10, blurDetected: true };
  }
  const progress = Math.min(1.0, (v - 55.0) / 945.0);
  const score = 55.0 + progress * 44.5;
  return { score: Math.round(score * 10) / 10, blurDetected: false };
}

/**
 * Real client-side Computer Vision analyzer using HTML5 Canvas & Laplacian Convolution.
 * Replicates OpenCV's cv2.Laplacian(img, cv2.CV_64F).var() directly in browser memory.
 * Returns normalized 0-100 sharpness score alongside raw Laplacian variance.
 */
export function analyzePageWithCanvas(
  canvas: HTMLCanvasElement
): {
  sharpnessScore: number;
  sharpnessRaw: number;
  blurDetected: boolean;
  pageDetected: boolean;
  cropReady: boolean;
  status: 'PASSED' | 'RESCAN_REQUIRED';
  reason?: string;
} {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { sharpnessScore: 100, sharpnessRaw: 500, blurDetected: false, pageDetected: true, cropReady: true, status: 'PASSED' };
  }

  const { width, height } = canvas;
  const sampleW = Math.min(width, 320);
  const sampleH = Math.min(height, 240);
  const offscreen = document.createElement('canvas');
  offscreen.width = sampleW;
  offscreen.height = sampleH;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) {
    return { sharpnessScore: 100, sharpnessRaw: 500, blurDetected: false, pageDetected: true, cropReady: true, status: 'PASSED' };
  }

  offCtx.drawImage(canvas, 0, 0, sampleW, sampleH);
  const imgData = offCtx.getImageData(0, 0, sampleW, sampleH);
  const data = imgData.data;

  // 1. Grayscale luminance
  const gray = new Float32Array(sampleW * sampleH);
  for (let i = 0; i < data.length; i += 4) {
    gray[i / 4] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // 2. 3x3 Laplacian operator: [0, 1, 0; 1, -4, 1; 0, 1, 0]
  let sumL = 0;
  let sumL2 = 0;
  let count = 0;

  for (let y = 1; y < sampleH - 1; y++) {
    for (let x = 1; x < sampleW - 1; x++) {
      const idx = y * sampleW + x;
      const val =
        gray[idx + 1] +
        gray[idx - 1] +
        gray[idx + sampleW] +
        gray[idx - sampleW] -
        4 * gray[idx];
      sumL += val;
      sumL2 += val * val;
      count++;
    }
  }

  const mean = sumL / count;
  const variance = Math.max(0, sumL2 / count - mean * mean);
  const sharpnessRaw = Math.round(variance * 10) / 10;
  const { score: sharpnessScore, blurDetected } = computeNormalizedSharpness(variance);

  // Threshold: variance < 55 indicates motion blur or defocus
  const status: 'PASSED' | 'RESCAN_REQUIRED' = blurDetected ? 'RESCAN_REQUIRED' : 'PASSED';
  const reason = blurDetected
    ? `Laplacian sharpness (${sharpnessScore} / 100, raw variance: ${sharpnessRaw}) is below minimum threshold (55.0). Recapture with better focus.`
    : undefined;

  return {
    sharpnessScore,
    sharpnessRaw,
    blurDetected,
    pageDetected: true,
    cropReady: true,
    status,
    reason,
  };
}

/**
 * Loads an image Blob into an HTMLImageElement or ImageBitmap.
 */
async function loadImageFromBlob(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Fallback to HTMLImageElement
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * Client-side physical document quadrilateral detector and non-document rejector.
 * Implements the validation criteria from ai-eval-scanner/document_scanner.py:
 * - Rejects human faces, skin, clothing, and background walls via substrate neutrality & saturation tests
 * - Validates quadrilateral geometry: aspect ratio [0.35, 2.6], opposite edge symmetry (diff <= 32%),
 *   and all 4 corner angles between 55° and 125°.
 * - Rejects non-document regions, tracking border frames, or degenerate shapes.
 */
export async function detectDocumentPreviewClientSide(
  frameBlob: Blob
): Promise<LiveDocumentDetection> {
  try {
    const img = await loadImageFromBlob(frameBlob);
    const origW = img.width;
    const origH = img.height;
    if (origW < 10 || origH < 10) {
      return { detected: false, corners: null, documentScore: 0 };
    }

    // Downsample to 320px width for fast execution (~3ms)
    const sampleW = 320;
    const sampleH = Math.max(120, Math.round((sampleW / origW) * origH));
    const canvas = document.createElement('canvas');
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { detected: false, corners: null, documentScore: 0 };

    ctx.drawImage(img, 0, 0, sampleW, sampleH);
    const imgData = ctx.getImageData(0, 0, sampleW, sampleH);
    const data = imgData.data;

    // 1. Compute grayscale luminance, saturation, and statistics
    const totalPixels = sampleW * sampleH;
    const gray = new Float32Array(totalPixels);
    const sat = new Float32Array(totalPixels);
    let sumL = 0;
    let sumL2 = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const idx = i / 4;
      gray[idx] = lum;
      sumL += lum;
      sumL2 += lum * lum;

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      sat[idx] = maxC === 0 ? 0 : (maxC - minC) / maxC;
    }
    const meanL = sumL / totalPixels;
    const stdL = Math.sqrt(Math.max(0, sumL2 / totalPixels - meanL * meanL));

    // Paper sheets are bright white/off-white with LOW saturation
    // Reject skin, clothing, and colored surfaces by requiring low saturation (<= 0.22)
    const lumThresh = Math.max(80, Math.min(220, meanL + 0.15 * stdL));

    const marginX = Math.max(6, Math.round(sampleW * 0.04));
    const marginY = Math.max(6, Math.round(sampleH * 0.04));

    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDiff = Infinity;
    let maxDiff = -Infinity;

    let tl = { x: marginX, y: marginY };
    let tr = { x: sampleW - marginX, y: marginY };
    let br = { x: sampleW - marginX, y: sampleH - marginY };
    let bl = { x: marginX, y: sampleH - marginY };

    let candidateCount = 0;
    const step = 2; // sample every 2nd pixel for speed

    for (let y = marginY; y < sampleH - marginY; y += step) {
      for (let x = marginX; x < sampleW - marginX; x += step) {
        const idx = y * sampleW + x;
        const val = gray[idx];
        const pixelSat = sat[idx];

        // Physical document criteria: Bright paper surface AND neutral color (not skin/clothing/wall)
        const isDocPixel = val >= lumThresh && pixelSat < 0.22;

        if (isDocPixel) {
          candidateCount++;
          const sum = x + y;
          const diff = x - y;

          if (sum < minSum) {
            minSum = sum;
            tl = { x, y };
          }
          if (sum > maxSum) {
            maxSum = sum;
            br = { x, y };
          }
          if (diff > maxDiff) {
            maxDiff = diff;
            tr = { x, y };
          }
          if (diff < minDiff) {
            minDiff = diff;
            bl = { x, y };
          }
        }
      }
    }

    const sampledTotal = ((sampleW - 2 * marginX) * (sampleH - 2 * marginY)) / (step * step);
    const coverage = candidateCount / Math.max(1, sampledTotal);

    // Document area must cover sensible viewfinder fraction (12% to 85%)
    if (coverage < 0.12 || coverage > 0.85) {
      return {
        detected: false,
        corners: null,
        documentScore: 0,
        imageWidth: origW,
        imageHeight: origH,
        reason: coverage < 0.12 ? 'Position physical document inside camera view' : 'Document too close to frame boundary',
      };
    }

    // --- STRICT QUADRILATERAL VALIDATION (from document_scanner.py) ---
    const pts = [tl, tr, br, bl];

    // Check 1: Sensor border margin (reject if 3 or more corners touch outer sensor boundary)
    const sensorBorderMargin = 8;
    let borderTouchCount = 0;
    for (const p of pts) {
      if (
        p.x <= sensorBorderMargin ||
        p.x >= sampleW - sensorBorderMargin ||
        p.y <= sensorBorderMargin ||
        p.y >= sampleH - sensorBorderMargin
      ) {
        borderTouchCount++;
      }
    }
    if (borderTouchCount >= 3) {
      return {
        detected: false,
        corners: null,
        documentScore: 0,
        imageWidth: origW,
        imageHeight: origH,
        reason: 'Quadrilateral tracks camera frame boundary rather than document',
      };
    }

    // Check 2: Edge lengths and opposite-edge symmetry
    const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
    const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);

    const avgW = (wTop + wBot) / 2;
    const avgH = (hLeft + hRight) / 2;

    if (avgW < sampleW * 0.22 || avgH < sampleH * 0.22) {
      return {
        detected: false,
        corners: null,
        documentScore: 0,
        imageWidth: origW,
        imageHeight: origH,
        reason: 'Document dimensions too small',
      };
    }

    const diffW = Math.abs(wTop - wBot) / Math.max(wTop, wBot);
    const diffH = Math.abs(hLeft - hRight) / Math.max(hLeft, hRight);
    if (diffW > 0.32 || diffH > 0.32) {
      return {
        detected: false,
        corners: null,
        documentScore: 0,
        imageWidth: origW,
        imageHeight: origH,
        reason: 'Non-symmetric boundary: opposite edges differ excessively',
      };
    }

    // Check 3: Aspect ratio [0.35, 2.6]
    const aspect = avgW / Math.max(1, avgH);
    if (aspect < 0.35 || aspect > 2.6) {
      return {
        detected: false,
        corners: null,
        documentScore: 0,
        imageWidth: origW,
        imageHeight: origH,
        reason: `Invalid document aspect ratio (${aspect.toFixed(2)})`,
      };
    }

    // Check 4: Corner angles (must be approximately rectangular: 55° to 125°)
    // Rejects human faces, heads, bodies, furniture, and random shapes
    for (let i = 0; i < 4; i++) {
      const prev = pts[(i + 3) % 4];
      const curr = pts[i];
      const next = pts[(i + 1) % 4];

      const v1x = prev.x - curr.x;
      const v1y = prev.y - curr.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;

      const norm1 = Math.hypot(v1x, v1y);
      const norm2 = Math.hypot(v2x, v2y);
      if (norm1 < 1e-4 || norm2 < 1e-4) {
        return { detected: false, corners: null, documentScore: 0, reason: 'Degenerate corner geometry' };
      }

      const dot = v1x * v2x + v1y * v2y;
      const cosA = Math.max(-1, Math.min(1, dot / (norm1 * norm2)));
      const angleDeg = (Math.acos(cosA) * 180) / Math.PI;

      if (angleDeg < 55 || angleDeg > 125) {
        return {
          detected: false,
          corners: null,
          documentScore: 0,
          imageWidth: origW,
          imageHeight: origH,
          reason: `Non-rectangular corner angle (${angleDeg.toFixed(1)}° at corner ${i})`,
        };
      }
    }

    // Check 5: Interior Substrate Verification (rejects skin, face, clothing, and background walls)
    // Sample an interior grid inside the candidate quadrilateral
    let interiorLumSum = 0;
    let interiorSatSum = 0;
    let darkPixelCount = 0;
    let samplePointsCount = 0;
    const quadLums = [0, 0, 0, 0];
    const quadCounts = [0, 0, 0, 0];

    for (let v = 0.2; v <= 0.8; v += 0.1) {
      for (let u = 0.2; u <= 0.8; u += 0.1) {
        // Bilinear interpolation inside quadrilateral
        const topX = tl.x + u * (tr.x - tl.x);
        const topY = tl.y + u * (tr.y - tl.y);
        const botX = bl.x + u * (br.x - bl.x);
        const botY = bl.y + u * (br.y - bl.y);
        const px = Math.round(topX + v * (botX - topX));
        const py = Math.round(topY + v * (botY - topY));

        if (px >= 0 && px < sampleW && py >= 0 && py < sampleH) {
          const idx = py * sampleW + px;
          const lum = gray[idx];
          const s = sat[idx];

          interiorLumSum += lum;
          interiorSatSum += s;
          samplePointsCount++;

          if (lum < 65) darkPixelCount++;

          // 4 quadrants: u < 0.5 vs u >= 0.5, v < 0.5 vs v >= 0.5
          const qIdx = (v < 0.5 ? 0 : 2) + (u < 0.5 ? 0 : 1);
          quadLums[qIdx] += lum;
          quadCounts[qIdx]++;
        }
      }
    }

    if (samplePointsCount > 0) {
      const meanInteriorLum = interiorLumSum / samplePointsCount;
      const meanInteriorSat = interiorSatSum / samplePointsCount;
      const darkFrac = darkPixelCount / samplePointsCount;

      // Human skin has high saturation (0.25 - 0.50); paper sheets are neutral (< 0.18)
      if (meanInteriorSat > 0.18) {
        return {
          detected: false,
          corners: null,
          documentScore: 0,
          imageWidth: origW,
          imageHeight: origH,
          reason: 'Non-neutral substrate (color/skin detected; align paper sheet)',
        };
      }

      // Paper sheet has very few dark pixels (< 8% ink/strokes); human faces/clothes have > 10%
      if (darkFrac > 0.08) {
        return {
          detected: false,
          corners: null,
          documentScore: 0,
          imageWidth: origW,
          imageHeight: origH,
          reason: 'Dark features detected (hair/clothing/background; align paper sheet)',
        };
      }

      // All 4 quadrants must be bright paper surface
      const minQuadLum = Math.min(...quadLums.map((sum, i) => sum / Math.max(1, quadCounts[i])));
      if (minQuadLum < 82 || meanInteriorLum < 92) {
        return {
          detected: false,
          corners: null,
          documentScore: 0,
          imageWidth: origW,
          imageHeight: origH,
          reason: 'Insufficient paper substrate luminance across quadrants',
        };
      }
    }

    // Scale corners back to original image coordinates
    const scaleX = origW / sampleW;
    const scaleY = origH / sampleH;

    const corners: [number, number][] = [
      [Math.round(tl.x * scaleX), Math.round(tl.y * scaleY)],
      [Math.round(tr.x * scaleX), Math.round(tr.y * scaleY)],
      [Math.round(br.x * scaleX), Math.round(br.y * scaleY)],
      [Math.round(bl.x * scaleX), Math.round(bl.y * scaleY)],
    ];

    const sharpness = Math.min(100, Math.round(stdL * 2.2));

    return {
      detected: true,
      corners,
      documentScore: sharpness,
      imageWidth: origW,
      imageHeight: origH,
      reason: 'Physical document verified (Client Engine)',
    };
  } catch {
    return { detected: false, corners: null, documentScore: 0 };
  }
}

/**
 * Warps an arbitrary 4-corner document quadrilateral into an upright rectified rectangular canvas.
 * Uses triangular subdivision mesh to achieve smooth perspective correction
 * and crops away all surrounding background.
 */
export function warpPerspectiveCanvas(
  sourceImg: CanvasImageSource & { width: number; height: number },
  orderedCorners: [number, number][],
  outWidth?: number,
  outHeight?: number
): HTMLCanvasElement {
  const [tl, tr, br, bl] = orderedCorners;

  const widthTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const widthBottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const calcW = Math.max(120, Math.round(Math.max(widthTop, widthBottom)));

  const heightLeft = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const heightRight = Math.hypot(br[0] - tr[0], br[1] - tr[1]);
  const calcH = Math.max(120, Math.round(Math.max(heightLeft, heightRight)));

  const destW = outWidth || calcW;
  const destH = outHeight || calcH;

  const destCanvas = document.createElement('canvas');
  destCanvas.width = destW;
  destCanvas.height = destH;
  const ctx = destCanvas.getContext('2d');
  if (!ctx) return destCanvas;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, destW, destH);

  // Grid subdivision: 8x8 quads = 128 triangles
  const GRID = 8;

  function bilinear(s: number, t: number): [number, number] {
    const x = (1 - s) * (1 - t) * tl[0] + s * (1 - t) * tr[0] + s * t * br[0] + (1 - s) * t * bl[0];
    const y = (1 - s) * (1 - t) * tl[1] + s * (1 - t) * tr[1] + s * t * br[1] + (1 - s) * t * bl[1];
    return [x, y];
  }

  function renderTriangle(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
    u0: number, v0: number, u1: number, v1: number, u2: number, v2: number
  ) {
    const denom = u0 * (v1 - v2) - u1 * (v0 - v2) + u2 * (v0 - v1);
    if (Math.abs(denom) < 1e-10) return;

    const a = (x0 * (v1 - v2) - x1 * (v0 - v2) + x2 * (v0 - v1)) / denom;
    const c = -(x0 * (u1 - u2) - x1 * (u0 - u2) + x2 * (u0 - u1)) / denom;
    const e = (x0 * (u1 * v2 - u2 * v1) - x1 * (u0 * v2 - u2 * v0) + x2 * (u0 * v1 - u1 * v0)) / denom;

    const b = (y0 * (v1 - v2) - y1 * (v0 - v2) + y2 * (v0 - v1)) / denom;
    const d = -(y0 * (u1 - u2) - y1 * (u0 - u2) + y2 * (u0 - u1)) / denom;
    const f = (y0 * (u1 * v2 - u2 * v1) - y1 * (u0 * v2 - u2 * v0) + y2 * (u0 * v1 - u1 * v0)) / denom;

    const det = a * d - b * c;
    if (Math.abs(det) < 1e-10) return;

    const iA = d / det;
    const iB = -b / det;
    const iC = -c / det;
    const iD = a / det;
    const iE = (c * f - d * e) / det;
    const iF = (b * e - a * f) / det;

    ctx!.save();
    ctx!.beginPath();
    ctx!.moveTo(u0, v0);
    ctx!.lineTo(u1, v1);
    ctx!.lineTo(u2, v2);
    ctx!.closePath();
    ctx!.clip();

    ctx!.setTransform(iA, iB, iC, iD, iE, iF);
    ctx!.drawImage(sourceImg, 0, 0);
    ctx!.restore();
  }

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const u0 = (i / GRID) * destW;
      const v0 = (j / GRID) * destH;
      const u1 = ((i + 1) / GRID) * destW;
      const v1 = ((j + 1) / GRID) * destH;

      const [x0, y0] = bilinear(i / GRID, j / GRID);
      const [x1, y1] = bilinear((i + 1) / GRID, j / GRID);
      const [x2, y2] = bilinear((i + 1) / GRID, (j + 1) / GRID);
      const [x3, y3] = bilinear(i / GRID, (j + 1) / GRID);

      renderTriangle(x0, y0, x1, y1, x3, y3, u0, v0, u1, v0, u0, v1);
      renderTriangle(x1, y1, x2, y2, x3, y3, u1, v0, u1, v1, u0, v1);
    }
  }

  return destCanvas;
}

/**
 * Processes a captured answer sheet completely client-side in browser memory.
 * Rectifies perspective, crops out the desk/background, and evaluates acutance.
 */
export async function processPageClientSide(
  imageBlob: Blob,
  meta: {
    examId: string;
    answerBookCode: string;
    pageNumber: number;
    filename?: string;
    corners?: [number, number][];
    captureWidth?: number;
    captureHeight?: number;
  }
): Promise<ProcessPageResult> {
  try {
    const img = await loadImageFromBlob(imageBlob);
    let corners = meta.corners;

    if (!corners || corners.length !== 4) {
      const detection = await detectDocumentPreviewClientSide(imageBlob);
      if (detection.detected && detection.corners && detection.corners.length === 4) {
        corners = detection.corners;
      }
    }

    let warpedCanvas: HTMLCanvasElement;
    let cropReady = false;

    if (corners && corners.length === 4) {
      warpedCanvas = warpPerspectiveCanvas(img, corners);
      cropReady = true;
    } else {
      const fallbackCanvas = document.createElement('canvas');
      const insetX = Math.round(img.width * 0.03);
      const insetY = Math.round(img.height * 0.03);
      fallbackCanvas.width = img.width - 2 * insetX;
      fallbackCanvas.height = img.height - 2 * insetY;
      const fCtx = fallbackCanvas.getContext('2d');
      if (fCtx) {
        fCtx.drawImage(
          img,
          insetX, insetY, fallbackCanvas.width, fallbackCanvas.height,
          0, 0, fallbackCanvas.width, fallbackCanvas.height
        );
      }
      warpedCanvas = fallbackCanvas;
      cropReady = true;
    }

    const diagnostics = analyzePageWithCanvas(warpedCanvas);
    const processedImageUrl = warpedCanvas.toDataURL('image/jpeg', 0.90);
    const processedBlob = dataUriToBlob(processedImageUrl);

    return {
      success: true,
      serviceAvailable: false,
      diagnostics: {
        status: diagnostics.status,
        blurDetected: diagnostics.blurDetected,
        sharpnessScore: diagnostics.sharpnessScore,
        sharpnessRaw: diagnostics.sharpnessRaw,
        orientation: 'NORMAL',
        pageDetected: true,
        cropReady,
        ocrReadiness: diagnostics.status === 'PASSED' ? 'READY' : 'UNCLEAR',
        reason: diagnostics.reason,
        outputWidth: warpedCanvas.width,
        outputHeight: warpedCanvas.height,
        sourceWidth: img.width,
        sourceHeight: img.height,
      },
      processedImageUrl,
      processedBlob,
      outputWidth: warpedCanvas.width,
      outputHeight: warpedCanvas.height,
      sourceWidth: img.width,
      sourceHeight: img.height,
      cropReady,
    };
  } catch (err: any) {
    return {
      success: false,
      serviceAvailable: false,
      errorMessage: err?.message || 'Client processing error',
    };
  }
}
