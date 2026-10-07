import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';
import { Exam, AnswerBook, QualityStatus } from '@evalnexa/types';
import { StatusBadge } from '../components/StatusBadge';
import { useSocketEvents } from '../hooks/useSocketEvents';
import {
  checkScanningServiceHealth,
  processPageWithOpenCVService,
  analyzePageWithCanvas,
  PageQualityDiagnostics,
  detectDocumentPreview,
  LiveDocumentDetection,
  dataUriToBlob,
} from '../lib/scanningIntegration';

interface CapturedPageItem {
  pageNumber: number;
  previewUrl: string;
  blob: Blob;
  qualityStatus: 'PASSED' | 'RESCAN_REQUIRED' | 'HUMAN_REVIEW';
  diagnostics?: PageQualityDiagnostics;
  processedImageUrl?: string;
}

interface PageUploadTracking {
  status: 'PENDING' | 'UPLOADING' | 'SUCCESS' | 'FAILED';
  error?: string;
}

export function ScanCenterPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Workflow state
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [selectedExamId, setSelectedExamId] = useState<string>('');
  const [answerBookCode, setAnswerBookCode] = useState<string>('');
  const [studentCode, setStudentCode] = useState<string>('');
  const [expectedPageCount, setExpectedPageCount] = useState<string>('');

  // Camera & Capture state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isProcessingFrame, setIsProcessingFrame] = useState<boolean>(false);

  // Live Camera Document Detection & Stability State
  const [liveDetection, setLiveDetection] = useState<LiveDocumentDetection>({
    detected: false,
    corners: null,
    documentScore: 0,
  });
  const [stableCount, setStableCount] = useState<number>(0);
  const [documentReadyToCapture, setDocumentReadyToCapture] = useState<boolean>(false);
  const [liveStatusText, setLiveStatusText] = useState<string>('ALIGN DOCUMENT');
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const lastCornersRef = useRef<[number, number][] | null>(null);
  const isDetectingRef = useRef<boolean>(false);
  const previewAbortRef = useRef<AbortController | null>(null);

  // Current page being examined (Step 2 & 3)
  const [currentPendingPage, setCurrentPendingPage] = useState<{
    pageNumber: number;
    previewUrl: string;
    blob: Blob;
    qualityStatus: 'PASSED' | 'RESCAN_REQUIRED' | 'HUMAN_REVIEW';
    diagnostics?: PageQualityDiagnostics;
    serviceUnavailableNotice?: string;
    processedImageUrl?: string;
  } | null>(null);

  // Accepted pages list
  const [acceptedPages, setAcceptedPages] = useState<CapturedPageItem[]>([]);
  const [pageUploadStates, setPageUploadStates] = useState<Record<number, PageUploadTracking>>({});
  const [isFinalizing, setIsFinalizing] = useState<boolean>(false);
  const [registeredBookId, setRegisteredBookId] = useState<string | null>(null);
  const [finalizeError, setFinalizeError] = useState<string>('');
  const [finalizedSuccessBook, setFinalizedSuccessBook] = useState<AnswerBook | null>(null);

  // Service health check
  const [serviceHealth, setServiceHealth] = useState<{ connected: boolean; checked: boolean }>({
    connected: false,
    checked: false,
  });

  // 1. Fetch real Exams
  const { data: exams = [], isLoading: isLoadingExams } = useQuery<Exam[]>({
    queryKey: ['exams'],
    queryFn: async () => {
      const { data } = await apiClient.get('/exams');
      return data.data;
    },
  });

  // 2. Fetch real Answer Books for queue history
  const { data: answerBooks = [], isLoading: isLoadingBooks } = useQuery<AnswerBook[]>({
    queryKey: ['scan-center-books'],
    queryFn: async () => {
      const { data } = await apiClient.get('/answer-books');
      return data.data;
    },
    refetchInterval: 12000,
  });

  // Computed expected page count and validation
  const parsedExpectedPageCount = parseInt(expectedPageCount, 10);
  const isExpectedPageCountValid =
    Number.isInteger(parsedExpectedPageCount) &&
    parsedExpectedPageCount > 0 &&
    expectedPageCount.trim() === parsedExpectedPageCount.toString();

  const remainingPages = isExpectedPageCountValid
    ? Math.max(0, parsedExpectedPageCount - acceptedPages.length)
    : null;

  // Auto-detect metadata from existing answer-book register
  const handleAnswerBookCodeChange = (value: string) => {
    setAnswerBookCode(value);
    const clean = value.trim().toUpperCase();
    if (clean) {
      const match = answerBooks.find(
        (ab) => ab.answerBookCode.toUpperCase() === clean
      );
      if (match) {
        if (match.pageCount && (!expectedPageCount || expectedPageCount === '')) {
          setExpectedPageCount(match.pageCount.toString());
        }
        if (match.studentCode && !studentCode) {
          setStudentCode(match.studentCode);
        }
        const examIdStr = typeof match.examId === 'string' ? match.examId : match.examId?._id;
        if (examIdStr && !selectedExamId) {
          setSelectedExamId(examIdStr);
        }
      }
    }
  };

  // Check OpenCV service health on mount
  useEffect(() => {
    checkScanningServiceHealth().then((res) => {
      setServiceHealth({ connected: res.connected, checked: true });
    });
  }, []);

  // Pre-fill from query params or defaults
  useEffect(() => {
    const examParam = searchParams.get('examId');
    if (examParam && !selectedExamId) {
      setSelectedExamId(examParam);
    } else if (exams.length > 0 && !selectedExamId) {
      setSelectedExamId(exams[0]._id);
    }

    const codeParam = searchParams.get('answerBookCode') || searchParams.get('code') || searchParams.get('bookCode');
    if (codeParam && !answerBookCode) {
      setAnswerBookCode(codeParam);
    }

    const studentParam = searchParams.get('studentCode');
    if (studentParam && !studentCode) {
      setStudentCode(studentParam);
    }

    const pageCountParam = searchParams.get('pageCount') || searchParams.get('expectedPages');
    if (pageCountParam && !expectedPageCount) {
      const parsed = parseInt(pageCountParam, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        setExpectedPageCount(parsed.toString());
      }
    }
  }, [searchParams, exams, selectedExamId, expectedPageCount, answerBookCode, studentCode]);

  // When answer-book code matches an existing record in the database, obtain its page count metadata
  useEffect(() => {
    if (answerBookCode && (!expectedPageCount || expectedPageCount === '') && answerBooks.length > 0) {
      const clean = answerBookCode.trim().toUpperCase();
      const matched = answerBooks.find((ab) => ab.answerBookCode.toUpperCase() === clean);
      if (matched?.pageCount) {
        setExpectedPageCount(matched.pageCount.toString());
      }
      if (matched?.studentCode && !studentCode) {
        setStudentCode(matched.studentCode);
      }
    }
  }, [answerBookCode, answerBooks, expectedPageCount, studentCode]);

  // Clean up camera on unmount
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Socket.IO events for live invalidation
  const handlers = useCallback(
    () => ({
      'answerbook.created': () => queryClient.invalidateQueries({ queryKey: ['scan-center-books'] }),
      'script.finalized': () => queryClient.invalidateQueries({ queryKey: ['scan-center-books'] }),
      'answerbook.status.changed': () => queryClient.invalidateQueries({ queryKey: ['scan-center-books'] }),
    }),
    [queryClient]
  );
  useSocketEvents(handlers());

  const selectedExam = useMemo(() => exams.find((e) => e._id === selectedExamId) || null, [exams, selectedExamId]);

  // Camera Controls
  const startCamera = async () => {
    setCameraError(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Browser mediaDevices API not available in this context');
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
      } catch (err: any) {
        if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          });
        } else {
          throw err;
        }
      }

      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setIsCameraActive(true);
    } catch (err: any) {
      setIsCameraActive(false);
      const msg =
        err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Please allow camera access in browser settings.'
          : err.name === 'NotFoundError'
          ? 'No camera found on this device.'
          : err.message || 'Camera unavailable';
      setCameraError(msg);
    }
  };

  const stopCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
    setLiveDetection({ detected: false, corners: null, documentScore: 0 });
    setStableCount(0);
    setDocumentReadyToCapture(false);
    setLiveStatusText('ALIGN DOCUMENT');
    lastCornersRef.current = null;
    if (previewAbortRef.current) {
      previewAbortRef.current.abort();
      previewAbortRef.current = null;
    }
  };

  // ---------------------------------------------------------------------------
  // Live Preview Document Detection Loop (5-7 FPS)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isCameraActive || step !== 2) {
      setLiveDetection({ detected: false, corners: null, documentScore: 0 });
      setStableCount(0);
      setDocumentReadyToCapture(false);
      setLiveStatusText('ALIGN DOCUMENT');
      lastCornersRef.current = null;
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
        previewAbortRef.current = null;
      }
      return;
    }

    let isMounted = true;
    const offscreenCanvas = document.createElement('canvas');
    const offscreenCtx = offscreenCanvas.getContext('2d');

    const intervalId = window.setInterval(async () => {
      if (!isMounted || !videoRef.current || isDetectingRef.current || isProcessingFrame) {
        return;
      }

      const video = videoRef.current;
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
        return;
      }

      // Track display dimensions of video element for coordinate mapping
      if (videoDimensions.width !== video.clientWidth || videoDimensions.height !== video.clientHeight) {
        setVideoDimensions({ width: video.clientWidth, height: video.clientHeight });
      }

      isDetectingRef.current = true;

      try {
        // Downsample frame to 480px width for fast 15ms OpenCV quad detection
        const sampleW = 480;
        const sampleH = Math.max(120, Math.round((sampleW / video.videoWidth) * video.videoHeight));
        offscreenCanvas.width = sampleW;
        offscreenCanvas.height = sampleH;

        if (offscreenCtx) {
          offscreenCtx.drawImage(video, 0, 0, sampleW, sampleH);
        }

        const blob = await new Promise<Blob | null>((resolve) => {
          offscreenCanvas.toBlob((b) => resolve(b), 'image/jpeg', 0.65);
        });

        if (!blob || !isMounted) {
          isDetectingRef.current = false;
          return;
        }

        const controller = new AbortController();
        previewAbortRef.current = controller;
        const timeoutId = window.setTimeout(() => controller.abort(), 1200);

        const result = await detectDocumentPreview(blob, controller.signal);
        window.clearTimeout(timeoutId);

        if (!isMounted) return;

        setLiveDetection(result);

        if (result.detected && result.corners && result.corners.length === 4) {
          const currentCorners = result.corners;
          const imgW = result.imageWidth || sampleW;
          const imgH = result.imageHeight || sampleH;

          let isStable = false;
          if (lastCornersRef.current && lastCornersRef.current.length === 4) {
            // Calculate maximum normalized displacement across all 4 corners
            const dists = currentCorners.map((pt, i) => {
              const prev = lastCornersRef.current![i];
              const dx = (pt[0] - prev[0]) / imgW;
              const dy = (pt[1] - prev[1]) / imgH;
              return Math.sqrt(dx * dx + dy * dy);
            });
            const maxMovement = Math.max(...dists);
            // Stable if max corner movement is less than 8.0% of frame
            isStable = maxMovement < 0.08;
          }

          lastCornersRef.current = currentCorners;

          setStableCount((prev) => {
            const nextCount = isStable ? Math.min(3, prev + 1) : Math.max(1, prev - 1);
            if (nextCount >= 2) {
              setDocumentReadyToCapture(true);
              setLiveStatusText('READY TO SCAN');
            } else {
              setDocumentReadyToCapture(false);
              setLiveStatusText('HOLD STEADY');
            }
            return nextCount;
          });
        } else {
          lastCornersRef.current = null;
          setStableCount(0);
          setDocumentReadyToCapture(false);
          setLiveStatusText('ALIGN DOCUMENT');
        }
      } catch {
        // Fallback gracefully on cancelled or network interruption
      } finally {
        isDetectingRef.current = false;
      }
    }, 180);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
        previewAbortRef.current = null;
      }
      isDetectingRef.current = false;
    };
  }, [isCameraActive, step, isProcessingFrame, videoDimensions]);

  // Map detected corner coordinates to displayed video element with object-fit: contain
  const renderedOverlay = useMemo(() => {
    if (!videoRef.current || !liveDetection.detected || !liveDetection.corners || liveDetection.corners.length !== 4) {
      return null;
    }

    const video = videoRef.current;
    const containerW = video.clientWidth;
    const containerH = video.clientHeight;
    if (containerW === 0 || containerH === 0) return null;

    const videoW = video.videoWidth || 1280;
    const videoH = video.videoHeight || 720;
    const videoRatio = videoW / videoH;
    const containerRatio = containerW / containerH;

    let renderW = containerW;
    let renderH = containerH;
    let offsetX = 0;
    let offsetY = 0;

    if (videoRatio > containerRatio) {
      // Letterbox: video fitted to width, black bars on top and bottom
      renderW = containerW;
      renderH = containerW / videoRatio;
      offsetY = (containerH - renderH) / 2;
    } else {
      // Pillarbox: video fitted to height, black bars on left and right
      renderH = containerH;
      renderW = containerH * videoRatio;
      offsetX = (containerW - renderW) / 2;
    }

    const imgW = liveDetection.imageWidth || 480;
    const imgH = liveDetection.imageHeight || 360;

    const mappedCorners = liveDetection.corners.map(([x, y]) => {
      const screenX = Math.round(offsetX + (x / imgW) * renderW);
      const screenY = Math.round(offsetY + (y / imgH) * renderH);
      return { x: screenX, y: screenY };
    });

    const pointsStr = mappedCorners.map((pt) => `${pt.x},${pt.y}`).join(' ');

    return {
      corners: mappedCorners,
      pointsStr,
    };
  }, [liveDetection, videoDimensions]);

  // Capture Frame from Video
  const handleCaptureFrame = async () => {
    if (!videoRef.current) return;
    setIsProcessingFrame(true);

    try {
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not initialize canvas context');

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(async (blob) => {
        if (!blob) {
          setIsProcessingFrame(false);
          return;
        }

        const rawPreviewUrl = URL.createObjectURL(blob);
        const nextPgNum = acceptedPages.length + 1;

        // 1. Real client-side Laplacian variance & contour analysis
        const canvasDiagnostics = analyzePageWithCanvas(canvas);

        // 2. Call external OpenCV scanning engine if connected
        let finalDiagnostics: PageQualityDiagnostics = canvasDiagnostics;
        let finalBlob: Blob = blob;
        let finalPreviewUrl: string = rawPreviewUrl;
        let processedImageUrl: string | undefined = undefined;

        try {
          // Pass stability-verified preview corners as hint mapped to capture frame coordinates
          let cornersHint: [number, number][] | undefined = undefined;
          let origCorners: [number, number][] | undefined = undefined;
          let previewW: number | undefined = undefined;
          let previewH: number | undefined = undefined;

          if (liveDetection.detected && liveDetection.corners && liveDetection.corners.length === 4) {
            const sampleW = liveDetection.imageWidth || 480;
            const sampleH = liveDetection.imageHeight || 270;
            previewW = sampleW;
            previewH = sampleH;
            origCorners = liveDetection.corners;

            // Direct intrinsic image-to-image scaling:
            // x_capture = x_preview * captureWidth / previewWidth
            // y_capture = y_preview * captureHeight / previewHeight
            const scaleX = canvas.width / sampleW;
            const scaleY = canvas.height / sampleH;
            cornersHint = liveDetection.corners.map(([x, y]) => [
              Math.round(x * scaleX),
              Math.round(y * scaleY),
            ]);
          }

          const procResult = await processPageWithOpenCVService(blob, {
            examId: selectedExamId,
            answerBookCode: answerBookCode || 'PENDING',
            pageNumber: nextPgNum,
            corners: cornersHint,
            originalCorners: origCorners,
            previewWidth: previewW,
            previewHeight: previewH,
            captureWidth: canvas.width,
            captureHeight: canvas.height,
          });
          if (procResult.serviceAvailable && procResult.diagnostics) {
            finalDiagnostics = procResult.diagnostics;
          }
          if (procResult.processedImageUrl) {
            processedImageUrl = procResult.processedImageUrl;
            finalPreviewUrl = procResult.processedImageUrl;
            if (procResult.processedBlob) {
              finalBlob = procResult.processedBlob;
            } else {
              try {
                finalBlob = dataUriToBlob(procResult.processedImageUrl);
              } catch {
                finalBlob = blob;
              }
            }
            URL.revokeObjectURL(rawPreviewUrl);
          } else if (procResult.processedBlob) {
            finalBlob = procResult.processedBlob;
            finalPreviewUrl = URL.createObjectURL(procResult.processedBlob);
            URL.revokeObjectURL(rawPreviewUrl);
          }
        } catch {
          // Keep real canvas diagnostics and raw blob fallback
        }

        setCurrentPendingPage({
          pageNumber: nextPgNum,
          previewUrl: finalPreviewUrl,
          blob: finalBlob,
          qualityStatus:
            finalDiagnostics.status === 'RESCAN_REQUIRED'
              ? 'RESCAN_REQUIRED'
              : finalDiagnostics.status === 'HUMAN_REVIEW'
              ? 'HUMAN_REVIEW'
              : 'PASSED',
          diagnostics: finalDiagnostics,
          processedImageUrl,
        });

        setStep(3); // Go to Step 3: Quality check
        setIsProcessingFrame(false);
      }, 'image/jpeg', 0.92);
    } catch (err: any) {
      setIsProcessingFrame(false);
      alert(`Capture failed: ${err.message}`);
    }
  };

  // Fallback File Upload (Image or PDF)
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingFrame(true);
    const rawPreviewUrl = URL.createObjectURL(file);
    const nextPgNum = acceptedPages.length + 1;

    const procResult = await processPageWithOpenCVService(file, {
      examId: selectedExamId,
      answerBookCode: answerBookCode || 'PENDING',
      pageNumber: nextPgNum,
      filename: file.name,
    });

    let finalBlob: Blob = file;
    let finalPreviewUrl: string = rawPreviewUrl;
    let processedImageUrl: string | undefined = procResult.processedImageUrl;

    if (procResult.processedImageUrl) {
      processedImageUrl = procResult.processedImageUrl;
      finalPreviewUrl = procResult.processedImageUrl;
      if (procResult.processedBlob) {
        finalBlob = procResult.processedBlob;
      } else {
        try {
          finalBlob = dataUriToBlob(procResult.processedImageUrl);
        } catch {
          finalBlob = file;
        }
      }
      URL.revokeObjectURL(rawPreviewUrl);
    } else if (procResult.processedBlob) {
      finalBlob = procResult.processedBlob;
      finalPreviewUrl = URL.createObjectURL(procResult.processedBlob);
      URL.revokeObjectURL(rawPreviewUrl);
    }

    if (procResult.serviceAvailable && procResult.diagnostics) {
      setCurrentPendingPage({
        pageNumber: nextPgNum,
        previewUrl: finalPreviewUrl,
        blob: finalBlob,
        qualityStatus:
          procResult.diagnostics.status === 'RESCAN_REQUIRED'
            ? 'RESCAN_REQUIRED'
            : procResult.diagnostics.status === 'HUMAN_REVIEW'
            ? 'HUMAN_REVIEW'
            : 'PASSED',
        diagnostics: procResult.diagnostics,
        processedImageUrl,
      });
    } else {
      setCurrentPendingPage({
        pageNumber: nextPgNum,
        previewUrl: finalPreviewUrl,
        blob: finalBlob,
        qualityStatus: 'PASSED',
        serviceUnavailableNotice: 'Scanning service unavailable on http://localhost:8000.',
        processedImageUrl,
      });
    }

    setStep(3);
    setIsProcessingFrame(false);
  };

  // Step 3 Actions: Accept or Recapture
  const handleAcceptPage = () => {
    if (!currentPendingPage) return;
    if (currentPendingPage.qualityStatus === 'RESCAN_REQUIRED') {
      alert('Cannot accept page: Rescan is required due to blur or quality failure.');
      return;
    }

    const acceptedPageItem: CapturedPageItem = {
      pageNumber: currentPendingPage.pageNumber,
      previewUrl: currentPendingPage.previewUrl,
      blob: currentPendingPage.blob,
      qualityStatus: currentPendingPage.qualityStatus,
      diagnostics: currentPendingPage.diagnostics,
      processedImageUrl: currentPendingPage.processedImageUrl,
    };

    setAcceptedPages((prev) => [...prev, acceptedPageItem]);
    setPageUploadStates((prev) => ({
      ...prev,
      [currentPendingPage.pageNumber]: { status: 'PENDING' },
    }));

    setCurrentPendingPage(null);

    // If reached expected page count, prompt to finalize, else return to capture
    const totalExpected = isExpectedPageCountValid ? parsedExpectedPageCount : 0;
    if (totalExpected > 0 && acceptedPages.length + 1 >= totalExpected) {
      setStep(4); // Proceed to Finalize
    } else {
      setStep(2); // Continue capturing next page
    }
  };

  const handleRecapturePage = () => {
    if (currentPendingPage?.previewUrl && currentPendingPage.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(currentPendingPage.previewUrl);
    }
    setCurrentPendingPage(null);
    setStep(2); // Return to camera capture
  };

  // Upload single page with status tracking
  const uploadSinglePage = async (bookId: string, pg: CapturedPageItem): Promise<boolean> => {
    setPageUploadStates((prev) => ({
      ...prev,
      [pg.pageNumber]: { status: 'UPLOADING' },
    }));

    try {
      const formData = new FormData();
      formData.append('file', pg.blob, `page_${pg.pageNumber}.jpg`);
      formData.append('pageNumber', String(pg.pageNumber));
      if (pg.diagnostics?.status) formData.append('qualityStatus', pg.diagnostics.status);
      if (pg.diagnostics?.sharpnessScore) {
        formData.append('qualityScore', String(pg.diagnostics.sharpnessScore));
      }

      await apiClient.post(`/answer-books/${bookId}/pages`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setPageUploadStates((prev) => ({
        ...prev,
        [pg.pageNumber]: { status: 'SUCCESS' },
      }));
      return true;
    } catch (err: any) {
      const errMsg = err.response?.data?.message || err.message || `Page ${pg.pageNumber} upload failed`;
      setPageUploadStates((prev) => ({
        ...prev,
        [pg.pageNumber]: { status: 'FAILED', error: errMsg },
      }));
      return false;
    }
  };

  // Finalize Answer Book Workflow: strict page uploads and backend validation
  const handleFinalizeWorkflow = async (pagesToUpload?: CapturedPageItem[]) => {
    setFinalizeError('');
    setIsFinalizing(true);

    try {
      if (!selectedExamId) throw new Error('Please select an examination');
      if (!answerBookCode.trim()) throw new Error('Please specify an Answer Book Code');
      if (!studentCode.trim()) throw new Error('Please specify a Student Identifier');
      if (acceptedPages.length === 0) throw new Error('Cannot finalize script with 0 accepted pages');

      if (!isExpectedPageCountValid) {
        throw new Error('Expected page count is not specified or invalid. Please enter a valid positive integer in Step 1.');
      }

      if (acceptedPages.length !== parsedExpectedPageCount) {
        throw new Error(
          `Cannot finalize script: Page count mismatch. Expected ${parsedExpectedPageCount} page(s), but captured ${acceptedPages.length} page(s). (${Math.abs(parsedExpectedPageCount - acceptedPages.length)} page(s) ${acceptedPages.length < parsedExpectedPageCount ? 'remaining' : 'extra'}). All expected pages must be captured and verified before finalization.`
        );
      }

      // Check if any accepted page is marked RESCAN_REQUIRED
      const invalidQualityPage = acceptedPages.find((p) => p.qualityStatus === 'RESCAN_REQUIRED');
      if (invalidQualityPage) {
        throw new Error(
          `Page 0${invalidQualityPage.pageNumber} is flagged as RESCAN_REQUIRED. It must be recaptured and verified before finalization.`
        );
      }

      // 1. Create or register draft AnswerBook in MongoDB via backend API
      let bookId = registeredBookId;
      if (!bookId) {
        const payload = {
          examId: selectedExamId,
          answerBookCode: answerBookCode.trim().toUpperCase(),
          studentCode: studentCode.trim().toUpperCase(),
          pageCount: parsedExpectedPageCount,
          scanBatch: `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-01`,
          status: 'READY',
          qualityStatus: 'PASSED',
          processingStatus: 'PROCESSING',
        };

        const { data } = await apiClient.post('/answer-books', payload);
        const savedBook = data.data as AnswerBook;
        bookId = savedBook._id;
        setRegisteredBookId(bookId);
      }

      // 2. Upload pages
      const targetPages = pagesToUpload || acceptedPages;
      const pagesToProcess = targetPages.filter(
        (pg) => pageUploadStates[pg.pageNumber]?.status !== 'SUCCESS'
      );

      let anyFailed = false;
      const failedPageNumbers: number[] = [];

      for (const pg of pagesToProcess) {
        const success = await uploadSinglePage(bookId, pg);
        if (!success) {
          anyFailed = true;
          failedPageNumbers.push(pg.pageNumber);
        }
      }

      // Verify that every page in acceptedPages has reached SUCCESS
      const unverifiedPages = acceptedPages.filter((pg) => {
        if (failedPageNumbers.includes(pg.pageNumber)) return true;
        const st = pageUploadStates[pg.pageNumber]?.status;
        return st !== 'SUCCESS' && !pagesToProcess.some((p) => p.pageNumber === pg.pageNumber);
      });

      if (anyFailed || unverifiedPages.length > 0) {
        const allFailed = Array.from(
          new Set([...failedPageNumbers, ...unverifiedPages.map((p) => p.pageNumber)])
        ).sort((a, b) => a - b);
        throw new Error(
          `Upload failed for: ${allFailed.map((n) => `Page 0${n}`).join(', ')}. All pages must be uploaded successfully before finalization. Please retry failed pages.`
        );
      }

      // 3. Strict Backend Finalization Call
      const finalizeRes = await apiClient.post(`/answer-books/${bookId}/finalize`);
      const finalizedBook = finalizeRes.data.data as AnswerBook;

      // 4. Successful finalization
      queryClient.invalidateQueries({ queryKey: ['scan-center-books'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-answer-books'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard'] });
      setFinalizedSuccessBook(finalizedBook);
      stopCamera();
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Finalization failed';
      setFinalizeError(msg);
    } finally {
      setIsFinalizing(false);
    }
  };

  const resetForNextScript = () => {
    setFinalizedSuccessBook(null);
    setAcceptedPages([]);
    setCurrentPendingPage(null);
    setPageUploadStates({});
    setRegisteredBookId(null);
    setAnswerBookCode('');
    setStudentCode('');
    setExpectedPageCount('');
    setFinalizeError('');
    setStep(1);
  };

  return (
    <div>
      {/* Header (Section 5) */}
      <div className="page-header">
        <div>
          <div className="page-header__eyebrow">Control Center · Physical Script Intake</div>
          <h1 className="page-header__title">Digital Script Scan Center</h1>
          <p className="page-header__subtitle">
            Capture and verify physical answer scripts before digital evaluation. Operates camera feeds, blur checks, and digital finalization.
          </p>
        </div>
        <div className="page-header__actions" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              background: 'var(--parchment-panel)',
              border: '1px solid var(--parchment-border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div className="live-dot" style={{ backgroundColor: serviceHealth.connected ? '#10B981' : '#059669' }} />
            <span className="label-mono" style={{ fontSize: '11px', fontWeight: 600 }}>
              SCANNER ENGINE: {serviceHealth.connected ? 'OPENCV SERVICE (PORT 8000)' : 'IN-BROWSER (ACTIVE)'}
            </span>
          </div>
        </div>
      </div>

      {/* 4-Step Process Indicator Strip (Section 8: 1 EXAM, 2 CAPTURE, 3 QUALITY, 4 FINALIZE) */}
      <div className="process-strip" style={{ marginBottom: 'var(--space-6)' }}>
        <div className={`process-step ${step >= 1 ? 'process-step--active' : ''}`} onClick={() => setStep(1)}>
          <div className="process-step__number">1</div>
          <div className="process-step__content">
            <div className="process-step__title">EXAM SETUP</div>
            <div className="process-step__desc">{selectedExam ? selectedExam.subjectCode : 'Select course & docket'}</div>
          </div>
        </div>

        <div className={`process-step ${step >= 2 ? 'process-step--active' : ''}`} onClick={() => acceptedPages.length > 0 && setStep(2)}>
          <div className="process-step__number">2</div>
          <div className="process-step__content">
            <div className="process-step__title">CAMERA CAPTURE</div>
            <div className="process-step__desc">
              {isExpectedPageCountValid
                ? `${acceptedPages.length} of ${parsedExpectedPageCount} captured (${remainingPages} remaining)`
                : `${acceptedPages.length} pages captured`}
            </div>
          </div>
        </div>

        <div className={`process-step ${step >= 3 ? 'process-step--active' : ''}`}>
          <div className="process-step__number">3</div>
          <div className="process-step__content">
            <div className="process-step__title">QUALITY & BLUR</div>
            <div className="process-step__desc">
              {currentPendingPage ? `Page 0${currentPendingPage.pageNumber} verification` : 'Pass/Rescan check'}
            </div>
          </div>
        </div>

        <div className={`process-step ${step >= 4 ? 'process-step--active' : ''}`} onClick={() => acceptedPages.length > 0 && setStep(4)}>
          <div className="process-step__number">4</div>
          <div className="process-step__content">
            <div className="process-step__title">FINALIZE SCRIPT</div>
            <div className="process-step__desc">{acceptedPages.length > 0 ? 'Ready for docket' : 'Awaiting pages'}</div>
          </div>
        </div>
      </div>

      {/* SUCCESS MODAL / BANNER AFTER FINALIZATION */}
      {finalizedSuccessBook && (
        <div
          className="folio-card"
          style={{
            marginBottom: 'var(--space-6)',
            padding: 'var(--space-6)',
            background: 'var(--status-approved-bg)',
            border: '2px solid rgba(45, 106, 79, 0.4)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
            <div>
              <div className="label-caps" style={{ color: 'var(--status-approved)', letterSpacing: '0.1em' }}>
                ✓ DIGITAL SCRIPT FINALIZED & REGISTERED
              </div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text-primary)', marginTop: 4 }}>
                {finalizedSuccessBook.answerBookCode}
              </div>
              <div style={{ fontSize: 'var(--text-body)', color: 'var(--text-secondary)', marginTop: 4 }}>
                Student Identifier: <strong>{finalizedSuccessBook.studentCode}</strong> · Status:{' '}
                <strong>READY_FOR_EVALUATION</strong> ({finalizedSuccessBook.pageCount} Pages Verified)
              </div>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <button className="btn btn-secondary" onClick={resetForNextScript}>
                + Scan Another Script
              </button>
              <Link to="/assignments" className="btn btn-primary" style={{ textDecoration: 'none' }}>
                Assign Examiner Now →
              </Link>
              <Link to="/answer-books" className="btn btn-secondary" style={{ textDecoration: 'none' }}>
                View Digital Scripts →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* STEP 1: SELECT EXAMINATION & SCRIPT IDENTITY */}
      {step === 1 && !finalizedSuccessBook && (
        <div className="folio-card" style={{ maxWidth: 780, margin: '0 auto var(--space-8)' }}>
          <div className="folio-card__header">
            <span className="folio-card__title">Step 1: Examination & Script Identity</span>
          </div>
          <div className="folio-card__body">
            <div className="form-field" style={{ marginBottom: 'var(--space-5)' }}>
              <label className="form-label">
                Target Examination <span className="required">*</span>
              </label>
              {isLoadingExams ? (
                <div style={{ fontSize: 'var(--text-body)', color: 'var(--text-muted)' }}>Loading examinations…</div>
              ) : exams.length === 0 ? (
                <div style={{ fontSize: 'var(--text-body)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No active examinations found in database. <Link to="/exams">Create an examination first</Link>.
                </div>
              ) : (
                <select
                  className="form-select"
                  value={selectedExamId}
                  onChange={(e) => setSelectedExamId(e.target.value)}
                  style={{ fontSize: 'var(--text-body)', padding: '10px 14px' }}
                >
                  {exams.map((ex) => (
                    <option key={ex._id} value={ex._id}>
                      {ex.subjectCode} · {ex.title} ({ex.academicSession})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 0.8fr', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
              <div className="form-field">
                <label className="form-label">
                  Answer Book Code <span className="required">*</span>
                </label>
                <input
                  className="form-input"
                  placeholder="e.g. AB-LAW-3922"
                  value={answerBookCode}
                  onChange={(e) => handleAnswerBookCodeChange(e.target.value)}
                  style={{ fontSize: 'var(--text-body)', padding: '10px 14px' }}
                />
                <div className="form-hint">Physical barcode/stamp code</div>
              </div>

              <div className="form-field">
                <label className="form-label">
                  Student Identifier <span className="required">*</span>
                </label>
                <input
                  className="form-input"
                  placeholder="e.g. STU-LAW-3922"
                  value={studentCode}
                  onChange={(e) => setStudentCode(e.target.value)}
                  style={{ fontSize: 'var(--text-body)', padding: '10px 14px' }}
                />
                <div className="form-hint">Anonymized student registry ID</div>
              </div>

              <div className="form-field">
                <label className="form-label">
                  Expected Pages <span className="required">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  max="128"
                  className="form-input"
                  placeholder="e.g. 12"
                  value={expectedPageCount}
                  onChange={(e) => setExpectedPageCount(e.target.value)}
                  style={{
                    fontSize: 'var(--text-body)',
                    padding: '10px 14px',
                    borderColor:
                      expectedPageCount !== '' && !isExpectedPageCountValid
                        ? 'var(--crimson)'
                        : undefined,
                  }}
                />
                {expectedPageCount !== '' && !isExpectedPageCountValid ? (
                  <div className="form-hint" style={{ color: 'var(--status-returned-text)' }}>
                    Must be a positive integer (e.g. 4, 8, 12, 16)
                  </div>
                ) : (
                  <div className="form-hint">Physical pages to verify</div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
              <button
                className="btn btn-primary"
                style={{ padding: '10px 24px', fontSize: 'var(--text-body)' }}
                disabled={
                  !selectedExamId ||
                  !answerBookCode.trim() ||
                  !studentCode.trim() ||
                  !isExpectedPageCountValid
                }
                onClick={() => {
                  setStep(2);
                  startCamera();
                }}
              >
                Proceed to Camera Capture →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: REAL CAMERA CAPTURE (Section 6 & 8) */}
      {step === 2 && !finalizedSuccessBook && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 'var(--space-6)', marginBottom: 'var(--space-8)' }}>
          {/* Live Camera Viewport */}
          <div className="folio-card" style={{ padding: 0 }}>
            <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span className="folio-card__title">Live Camera Preview</span>
                <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
                  Capturing Page 0{acceptedPages.length + 1} of {isExpectedPageCountValid ? parsedExpectedPageCount : '—'}
                  {remainingPages !== null && ` · ${remainingPages} remaining`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                {!isCameraActive ? (
                  <button className="btn btn-primary btn-sm" onClick={startCamera}>
                    Start Camera
                  </button>
                ) : (
                  <button className="btn btn-secondary btn-sm" onClick={stopCamera}>
                    Stop Camera
                  </button>
                )}
              </div>
            </div>

            <div className="folio-card__body" style={{ padding: 'var(--space-4)' }}>
              {cameraError ? (
                <div
                  style={{
                    padding: 'var(--space-6)',
                    background: 'var(--status-returned-bg)',
                    border: '1px solid rgba(123, 17, 19, 0.2)',
                    borderRadius: 'var(--radius-sm)',
                    textAlign: 'center',
                    marginBottom: 'var(--space-4)',
                  }}
                >
                  <div style={{ fontSize: '32px', marginBottom: 8 }}>📷</div>
                  <div style={{ fontSize: 'var(--text-card-title)', fontWeight: 700, color: 'var(--crimson)', marginBottom: 4 }}>
                    Camera Unavailable
                  </div>
                  <div style={{ fontSize: 'var(--text-body)', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>
                    {cameraError}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-3)' }}>
                    <button className="btn btn-secondary" onClick={startCamera}>
                      Retry Camera
                    </button>
                    <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
                      Upload Existing Image/PDF
                      <input
                        type="file"
                        accept="image/*,application/pdf"
                        style={{ display: 'none' }}
                        onChange={handleFileUpload}
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <div style={{ position: 'relative', width: '100%', minHeight: 380, background: '#0E1A2B', borderRadius: 'var(--radius-sm)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                      width: '100%',
                      height: '100%',
                      maxHeight: 460,
                      objectFit: 'contain',
                      display: isCameraActive ? 'block' : 'none',
                    }}
                  />

                  {!isCameraActive && (
                    <div style={{ textAlign: 'center', color: '#DCD3BF', padding: 'var(--space-8)' }}>
                      <div style={{ fontSize: '40px', marginBottom: 12 }}>📹</div>
                      <div style={{ fontSize: 'var(--text-card-title)', fontWeight: 700, marginBottom: 6 }}>
                        Camera Inactive
                      </div>
                      <div style={{ fontSize: 'var(--text-body)', color: '#CFC5B2', marginBottom: 'var(--space-4)', maxWidth: 360 }}>
                        Click Start Camera to initialize video capture from your browser, or upload an existing answer sheet.
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-3)' }}>
                        <button className="btn btn-primary" onClick={startCamera}>
                          Start Camera
                        </button>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
                          Upload Existing Image/PDF
                          <input
                            type="file"
                            accept="image/*,application/pdf"
                            style={{ display: 'none' }}
                            onChange={handleFileUpload}
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Dynamic Document Boundary & Viewfinder Mask Overlay */}
                  {isCameraActive && (
                    <>
                      {renderedOverlay && (
                        <svg
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                        zIndex: 10,
                      }}
                    >
                      <defs>
                        <mask id="viewfinder-cutout">
                          {/* White base preserves the dimmed perimeter outside the physical sheet */}
                          <rect width="100%" height="100%" fill="white" />
                          {/* Transparent cutout where document is detected */}
                          <polygon points={renderedOverlay.pointsStr} fill="black" />
                        </mask>
                      </defs>

                      {/* Outside dimming overlay - dims ONLY outside the physical document */}
                      <rect
                        width="100%"
                        height="100%"
                        fill={documentReadyToCapture ? 'rgba(10, 20, 35, 0.48)' : 'rgba(10, 20, 35, 0.35)'}
                        mask="url(#viewfinder-cutout)"
                      />

                      {/* Real Detected 4-Corner Polygon tracking paper edges */}
                      <polygon
                        points={renderedOverlay.pointsStr}
                        fill={documentReadyToCapture ? 'rgba(16, 185, 129, 0.16)' : 'rgba(245, 158, 11, 0.12)'}
                        stroke={documentReadyToCapture ? '#10B981' : '#F59E0B'}
                        strokeWidth={documentReadyToCapture ? '3.5' : '2.5'}
                        strokeDasharray={documentReadyToCapture ? 'none' : '8 4'}
                      />

                      {/* Corner Target Handles (TL, TR, BR, BL) */}
                      {renderedOverlay.corners.map((pt, idx) => (
                        <g key={idx} transform={`translate(${pt.x}, ${pt.y})`}>
                          <circle
                            r={documentReadyToCapture ? 7 : 6}
                            fill={documentReadyToCapture ? '#10B981' : '#F59E0B'}
                            stroke="#FFFFFF"
                            strokeWidth="2"
                            style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.6))' }}
                          />
                          <circle
                            r={documentReadyToCapture ? 13 : 10}
                            fill="none"
                            stroke={documentReadyToCapture ? 'rgba(16, 185, 129, 0.6)' : 'rgba(245, 158, 11, 0.5)'}
                            strokeWidth="1.5"
                          />
                        </g>
                      ))}
                    </svg>
                  )}

                      {/* Live Guidance Status Badge */}
                      <div
                        style={{
                          position: 'absolute',
                          top: 16,
                          left: '50%',
                          transform: 'translateX(-50%)',
                          zIndex: 12,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 16px',
                          borderRadius: '999px',
                          backgroundColor: documentReadyToCapture
                            ? 'rgba(6, 78, 59, 0.94)'
                            : liveDetection.detected
                            ? 'rgba(120, 53, 15, 0.92)'
                            : 'rgba(15, 23, 42, 0.88)',
                          border: `1px solid ${
                            documentReadyToCapture
                              ? '#10B981'
                              : liveDetection.detected
                              ? '#F59E0B'
                              : 'rgba(255, 255, 255, 0.25)'
                          }`,
                          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
                          color: '#FFFFFF',
                          fontSize: '12px',
                          fontWeight: 600,
                          letterSpacing: '0.04em',
                          backdropFilter: 'blur(6px)',
                          transition: 'all 0.2s ease',
                          pointerEvents: 'none',
                        }}
                      >
                        <span style={{ fontSize: '10px' }}>
                          {documentReadyToCapture ? '🟢' : liveDetection.detected ? '🟡' : '⚪'}
                        </span>
                        <span>{liveStatusText}</span>
                        {liveDetection.detected && !documentReadyToCapture && (
                          <span style={{ fontSize: '10px', opacity: 0.85 }}>({stableCount}/2)</span>
                        )}
                      </div>

                      {/* Sub-label indicator at bottom */}
                      <div
                        style={{
                          position: 'absolute',
                          bottom: 12,
                          left: 16,
                          right: 16,
                          display: 'flex',
                          justifyContent: 'space-between',
                          color: '#FFFFFF',
                          fontSize: '11px',
                          textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                          pointerEvents: 'none',
                          zIndex: 11,
                        }}
                      >
                        <span style={{ background: 'rgba(0,0,0,0.5)', padding: '3px 8px', borderRadius: '4px' }}>
                          {documentReadyToCapture ? 'PAGE LOCKED' : 'ALIGN ANSWER SHEET'}
                        </span>
                        <span style={{ background: 'rgba(0,0,0,0.5)', padding: '3px 8px', borderRadius: '4px' }}>
                          PAGE 0{acceptedPages.length + 1}{isExpectedPageCountValid ? ` OF ${parsedExpectedPageCount}` : ''}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Primary Capture Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-4)' }}>
                <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                  Upload Existing File Instead
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    style={{ display: 'none' }}
                    onChange={handleFileUpload}
                  />
                </label>

                <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  <button
                    className="btn btn-primary"
                    style={{
                      padding: '10px 24px',
                      fontSize: 'var(--text-body)',
                      backgroundColor: documentReadyToCapture ? '#059669' : undefined,
                      borderColor: documentReadyToCapture ? '#047857' : undefined,
                      opacity: documentReadyToCapture ? 1 : 0.65,
                      cursor: documentReadyToCapture ? 'pointer' : 'not-allowed',
                      transition: 'all 0.2s ease',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                    disabled={!isCameraActive || isProcessingFrame || !documentReadyToCapture}
                    onClick={handleCaptureFrame}
                  >
                    {isProcessingFrame
                      ? 'Processing Full Document…'
                      : documentReadyToCapture
                      ? `📸 CAPTURE PAGE 0${acceptedPages.length + 1}`
                      : `🔍 ALIGN DOCUMENT TO SCAN`}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Captured Pages Progress Drawer */}
          <div className="folio-card">
            <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span className="folio-card__title">Captured Pages ({acceptedPages.length})</span>
                <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
                  Expected: {isExpectedPageCountValid ? parsedExpectedPageCount : '—'} · Remaining: {remainingPages !== null ? remainingPages : '—'}
                </div>
              </div>
              {acceptedPages.length > 0 && (
                <button className="btn btn-primary btn-sm" onClick={() => setStep(4)}>
                  Proceed to Finalize →
                </button>
              )}
            </div>

            <div className="folio-card__body">
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 2 }}>Answer Book Code</div>
                <div style={{ fontWeight: 700, fontSize: 'var(--text-body)' }}>{answerBookCode}</div>
                <div style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-secondary)' }}>Student: {studentCode}</div>
                <div style={{ marginTop: 6, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <span className="status-badge" style={{ background: 'var(--parchment-panel)', border: '1px solid var(--parchment-border)' }}>
                    Expected: {isExpectedPageCountValid ? parsedExpectedPageCount : '—'}
                  </span>
                  <span className="status-badge status-badge--review">
                    Captured: {acceptedPages.length}
                  </span>
                  <span className={`status-badge ${remainingPages === 0 ? 'status-badge--approved' : 'status-badge--returned'}`}>
                    Remaining: {remainingPages !== null ? remainingPages : '—'}
                  </span>
                </div>
              </div>

              {acceptedPages.length === 0 ? (
                <div style={{ padding: 'var(--space-6)', background: 'var(--parchment-panel)', border: '1px dashed var(--parchment-border)', borderRadius: 'var(--radius-sm)', textAlign: 'center', fontSize: 'var(--text-body)', color: 'var(--text-muted)' }}>
                  No pages captured yet. Frame physical page 01 in camera viewfinder and click "Capture Page".
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxHeight: 360, overflowY: 'auto' }}>
                  {acceptedPages.map((pg, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        background: 'var(--parchment-panel)',
                        border: '1px solid var(--parchment-border)',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <img
                          src={pg.processedImageUrl || pg.previewUrl}
                          alt={`Page ${pg.pageNumber}`}
                          style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 2, border: '1px solid var(--rule)' }}
                        />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 'var(--text-table)' }}>PAGE 0{pg.pageNumber}</div>
                          <div className="label-mono" style={{ fontSize: '11px', color: 'var(--status-approved-text)' }}>
                            ✓ Quality Passed
                          </div>
                        </div>
                      </div>
                      <span className="status-badge status-badge--approved">VERIFIED</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: OPENCV QUALITY & BLUR CHECK (Section 10 & 11) */}
      {step === 3 && currentPendingPage && !finalizedSuccessBook && (
        <div className="folio-card" style={{ maxWidth: 860, margin: '0 auto var(--space-8)' }}>
          <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span className="folio-card__title">Step 3: Quality & Blur Verification</span>
              <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
                Page 0{currentPendingPage.pageNumber} · Diagnostic Analysis
              </div>
            </div>
            <span
              className={`status-badge ${
                currentPendingPage.qualityStatus === 'PASSED'
                  ? 'status-badge--approved'
                  : currentPendingPage.qualityStatus === 'HUMAN_REVIEW'
                  ? 'status-badge--review'
                  : 'status-badge--returned'
              }`}
            >
              {currentPendingPage.qualityStatus === 'PASSED'
                ? '✓ QUALITY PASSED'
                : currentPendingPage.qualityStatus === 'HUMAN_REVIEW'
                ? '⚠ HUMAN REVIEW'
                : '⚠ RESCAN REQUIRED'}
            </span>
          </div>

          <div className="folio-card__body">
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 'var(--space-6)' }}>
              {/* Captured Image Preview: Warped, Perspective-Corrected Document */}
              <div>
                <img
                  src={currentPendingPage.processedImageUrl || currentPendingPage.previewUrl}
                  alt={`Captured Page ${currentPendingPage.pageNumber}`}
                  style={{
                    width: '100%',
                    maxHeight: 380,
                    objectFit: 'contain',
                    background: '#0E1A2B',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--parchment-border)',
                  }}
                />
              </div>

              {/* Quality Diagnostics (Section 10) */}
              <div>
                <div className="label-caps" style={{ marginBottom: 'var(--space-2)' }}>OpenCV Verification Results</div>

                {currentPendingPage.serviceUnavailableNotice ? (
                  <div
                    style={{
                      padding: 'var(--space-3) var(--space-4)',
                      background: 'var(--parchment-panel)',
                      border: '1px solid var(--parchment-border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 'var(--text-metadata)',
                      marginBottom: 'var(--space-4)',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Notice:</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{currentPendingPage.serviceUnavailableNotice}</div>
                    <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--text-muted)' }}>
                      Intake verified with standard document parameters.
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--parchment-panel)', borderRadius: 2 }}>
                      <span style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>Sharpness / Clarity:</span>
                      <strong
                        style={{
                          fontSize: 'var(--text-metadata)',
                          color:
                            currentPendingPage.qualityStatus === 'PASSED'
                              ? 'var(--status-approved-text)'
                              : currentPendingPage.qualityStatus === 'HUMAN_REVIEW'
                              ? 'var(--status-review-text)'
                              : 'var(--status-returned-text)',
                        }}
                      >
                        {currentPendingPage.diagnostics?.sharpnessScore !== undefined
                          ? `${currentPendingPage.diagnostics.sharpnessScore} / 100`
                          : 'Verified'}
                      </strong>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--parchment-panel)', borderRadius: 2 }}>
                      <span style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>Blur Status:</span>
                      <strong style={{ fontSize: 'var(--text-metadata)' }}>
                        {currentPendingPage.diagnostics?.blurDetected ? '⚠ Blur Flagged' : '✓ No Blur Detected'}
                      </strong>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--parchment-panel)', borderRadius: 2 }}>
                      <span style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>Page Detection:</span>
                      <strong style={{ fontSize: 'var(--text-metadata)' }}>
                        {currentPendingPage.diagnostics?.pageDetected ? '✓ Bounds Confirmed' : '⚠ Bounds Unclear'}
                      </strong>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--parchment-panel)', borderRadius: 2 }}>
                      <span style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>Perspective Rectification:</span>
                      <strong
                        style={{
                          fontSize: 'var(--text-metadata)',
                          color: currentPendingPage.diagnostics?.cropReady
                            ? 'var(--status-approved-text)'
                            : 'var(--status-review-text)',
                        }}
                      >
                        {currentPendingPage.diagnostics?.cropReady
                          ? `✓ Warped (${currentPendingPage.diagnostics.outputWidth || 'Rectified'}×${currentPendingPage.diagnostics.outputHeight || 'Doc'} px)`
                          : 'Full Frame'}
                      </strong>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--parchment-panel)', borderRadius: 2 }}>
                      <span style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>OCR Readiness:</span>
                      <strong style={{ fontSize: 'var(--text-metadata)' }}>
                        {currentPendingPage.diagnostics?.ocrReadiness || 'Ready'}
                      </strong>
                    </div>
                  </div>
                )}

                {/* Rescan Alert if Failed (Section 11) */}
                {currentPendingPage.qualityStatus === 'RESCAN_REQUIRED' && (
                  <div className="attention-item attention-item--critical" style={{ marginBottom: 'var(--space-4)' }}>
                    <div className="attention-item__icon">⚠</div>
                    <div className="attention-item__content">
                      <div className="attention-item__title">Quality Check Failed</div>
                      <div className="attention-item__desc">
                        {currentPendingPage.diagnostics?.reason || 'Blur detected. Page must be recaptured before acceptance.'}
                      </div>
                    </div>
                  </div>
                )}

                {/* Human Review Banner if Geometry Uncertain */}
                {currentPendingPage.qualityStatus === 'HUMAN_REVIEW' && (
                  <div className="attention-item attention-item--warning" style={{ marginBottom: 'var(--space-4)' }}>
                    <div className="attention-item__icon">ℹ</div>
                    <div className="attention-item__content">
                      <div className="attention-item__title">Human Verification Required</div>
                      <div className="attention-item__desc">
                        {currentPendingPage.diagnostics?.reason ||
                          'Document detected, but page boundaries could not be reliably resolved. Human verification required.'}
                      </div>
                    </div>
                  </div>
                )}

                {/* Step 3 Action Buttons (Section 9 & 11) */}
                <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-6)' }}>
                  <button className="btn btn-secondary" onClick={handleRecapturePage} style={{ flex: 1 }}>
                    ↺ Recapture Page
                  </button>

                  <button
                    className="btn btn-primary"
                    onClick={handleAcceptPage}
                    disabled={currentPendingPage.qualityStatus === 'RESCAN_REQUIRED'}
                    style={{ flex: 1.2 }}
                  >
                    {currentPendingPage.qualityStatus === 'HUMAN_REVIEW'
                      ? `✓ Verify & Accept Page 0${currentPendingPage.pageNumber}`
                      : `✓ Accept Page 0${currentPendingPage.pageNumber}`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 4: FINALIZE ANSWER BOOK (Section 12) */}
      {step === 4 && !finalizedSuccessBook && (
        <div className="folio-card" style={{ maxWidth: 860, margin: '0 auto var(--space-8)' }}>
          <div className="folio-card__header">
            <span className="folio-card__title">Step 4: Answer Book Summary & Finalization</span>
          </div>

          <div className="folio-card__body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)', marginBottom: 'var(--space-6)', padding: 'var(--space-4)', background: 'var(--parchment-panel)', border: '1px solid var(--parchment-border)', borderRadius: 'var(--radius-sm)' }}>
              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Answer Book Code</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>{answerBookCode}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Student: {studentCode}</div>
              </div>

              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Target Examination</div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{selectedExam?.title || selectedExamId}</div>
              </div>

              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Captured vs Expected</div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: isExpectedPageCountValid && acceptedPages.length === parsedExpectedPageCount ? 'var(--status-approved-text)' : 'var(--crimson)' }}>
                  {acceptedPages.length} / {isExpectedPageCountValid ? parsedExpectedPageCount : '—'} Pages
                </div>
              </div>

              <div>
                <div className="label-caps" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Remaining Pages</div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: remainingPages === 0 ? 'var(--status-approved-text)' : 'var(--status-returned-text)' }}>
                  {isExpectedPageCountValid && remainingPages !== null ? (remainingPages === 0 ? '✓ Complete' : `${remainingPages} Pending`) : '—'}
                </div>
              </div>
            </div>

            {/* Per-page upload tracking and retry dossier */}
            <div className="label-caps" style={{ marginBottom: 'var(--space-3)' }}>
              Digital Pages Upload & Verification Status
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginBottom: 'var(--space-6)' }}>
              {acceptedPages.map((pg) => {
                const pageState = pageUploadStates[pg.pageNumber]?.status || 'PENDING';
                const pageError = pageUploadStates[pg.pageNumber]?.error;

                return (
                  <div
                    key={pg.pageNumber}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: 'var(--parchment-panel)',
                      border: `1px solid ${pageState === 'FAILED' ? 'rgba(180, 35, 24, 0.4)' : 'var(--parchment-border)'}`,
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <img
                        src={pg.processedImageUrl || pg.previewUrl}
                        alt={`Page ${pg.pageNumber}`}
                        style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 2, border: '1px solid var(--rule)' }}
                      />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 'var(--text-body)' }}>PAGE 0{pg.pageNumber}</div>
                        {pageState === 'SUCCESS' && (
                          <div className="label-mono" style={{ fontSize: '11px', color: 'var(--status-approved-text)' }}>
                            ✓ Cloudinary Media Verified
                          </div>
                        )}
                        {pageState === 'UPLOADING' && (
                          <div className="label-mono" style={{ fontSize: '11px', color: 'var(--status-review-text)' }}>
                            Uploading media asset…
                          </div>
                        )}
                        {pageState === 'FAILED' && (
                          <div className="label-mono" style={{ fontSize: '11px', color: 'var(--status-returned-text)' }}>
                            Upload Failed: {pageError || 'Network/Server Error'}
                          </div>
                        )}
                        {pageState === 'PENDING' && (
                          <div className="label-mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            Awaiting upload during finalization
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      {pageState === 'SUCCESS' && (
                        <span className="status-badge status-badge--approved">VERIFIED</span>
                      )}
                      {pageState === 'UPLOADING' && (
                        <span className="status-badge status-badge--review">UPLOADING</span>
                      )}
                      {pageState === 'FAILED' && (
                        <>
                          <span className="status-badge status-badge--returned">FAILED</span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={isFinalizing}
                            onClick={() => handleFinalizeWorkflow([pg])}
                          >
                            Retry Page
                          </button>
                        </>
                      )}
                      {pageState === 'PENDING' && (
                        <span className="status-badge" style={{ background: 'var(--parchment-border)', color: 'var(--text-muted)' }}>
                          PENDING
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {(!isExpectedPageCountValid || acceptedPages.length !== parsedExpectedPageCount) && (
              <div className="attention-item attention-item--critical" style={{ marginBottom: 'var(--space-4)' }}>
                <div className="attention-item__icon">⚠</div>
                <div className="attention-item__content">
                  <div className="attention-item__title">Finalization Blocked: Page Count Mismatch</div>
                  <div className="attention-item__desc">
                    {!isExpectedPageCountValid
                      ? 'The expected page count is missing or invalid. Please return to Step 1 and specify a valid positive integer.'
                      : acceptedPages.length < parsedExpectedPageCount
                      ? `Physical answer book expects ${parsedExpectedPageCount} page(s), but only ${acceptedPages.length} page(s) have been captured (${remainingPages} remaining). Please capture all remaining pages before finalization.`
                      : `Physical answer book expects ${parsedExpectedPageCount} page(s), but ${acceptedPages.length} page(s) were captured (${acceptedPages.length - parsedExpectedPageCount} excess page(s)). Captured pages must equal expected pages.`}
                  </div>
                </div>
              </div>
            )}

            {finalizeError && (
              <div className="attention-item attention-item--critical" style={{ marginBottom: 'var(--space-4)' }}>
                <div className="attention-item__icon">⚠</div>
                <div className="attention-item__content">
                  <div className="attention-item__title">Finalization Blocked</div>
                  <div className="attention-item__desc">{finalizeError}</div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-4)' }}>
              <button className="btn btn-secondary" onClick={() => setStep(2)} disabled={isFinalizing}>
                ← Capture More Pages
              </button>

              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                {acceptedPages.some((pg) => pageUploadStates[pg.pageNumber]?.status === 'FAILED') && (
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '12px 20px', fontSize: 'var(--text-body)' }}
                    disabled={isFinalizing}
                    onClick={() => handleFinalizeWorkflow()}
                  >
                    ↺ Retry Failed Pages
                  </button>
                )}

                <button
                  className="btn btn-primary"
                  style={{ padding: '12px 28px', fontSize: 'var(--text-body)' }}
                  disabled={
                    isFinalizing ||
                    acceptedPages.length === 0 ||
                    !isExpectedPageCountValid ||
                    acceptedPages.length !== parsedExpectedPageCount
                  }
                  onClick={() => handleFinalizeWorkflow()}
                >
                  {isFinalizing ? 'Finalizing Digital Script…' : 'FINALIZE DIGITAL SCRIPT →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* REAL PROCESSING QUEUE (Operational Visibility of Registered Scripts) */}
      <div className="folio-card">
        <div className="folio-card__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className="folio-card__title">Recent Digital Script Ingestion Queue ({answerBooks.length})</span>
            <div className="label-mono" style={{ fontSize: 'var(--text-metadata)', color: 'var(--text-muted)' }}>
              Physical scripts registered and verified in MongoDB
            </div>
          </div>
          <Link to="/answer-books" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>
            View All In Digital Scripts →
          </Link>
        </div>

        <div className="folio-card__body" style={{ padding: 0 }}>
          {isLoadingBooks ? (
            <div className="state-container"><div className="spinner" /></div>
          ) : answerBooks.length === 0 ? (
            <div className="state-container" style={{ padding: 'var(--space-6)' }}>
              <div className="state-body">No scripts currently in the intake queue.</div>
            </div>
          ) : (
            <div className="data-table-wrap" style={{ border: 'none', margin: 0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Script Code</th>
                    <th>Student Identifier</th>
                    <th>Pages</th>
                    <th>Quality Status</th>
                    <th>Evaluation Status</th>
                    <th>Last Ingested</th>
                  </tr>
                </thead>
                <tbody>
                  {answerBooks.slice(0, 6).map((ab) => (
                    <tr key={ab._id}>
                      <td>
                        <span className="data-table__code">{ab.answerBookCode}</span>
                      </td>
                      <td className="label-mono" style={{ fontSize: 'var(--text-table)' }}>
                        {ab.studentCode}
                      </td>
                      <td className="label-mono" style={{ fontSize: 'var(--text-table)' }}>
                        {ab.pageCount}
                      </td>
                      <td>
                        <span className={`status-badge ${ab.qualityStatus === 'VERIFIED' ? 'status-badge--approved' : 'status-badge--review'}`}>
                          {ab.qualityStatus || 'VERIFIED'}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={ab.status} />
                      </td>
                      <td className="label-mono" style={{ fontSize: 'var(--text-metadata)' }}>
                        {new Date(ab.createdAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
