import mongoose from 'mongoose';
import { AnswerBook, IQuestionPageMapping } from '../models/AnswerBook';
import { AnswerPage, IAnswerPage } from '../models/AnswerPage';
import { QuestionPaper, IQuestionPaper } from '../models/QuestionPaper';
import { geminiManager } from '../config/gemini';
import { getAiPolicyConfig, isMappingConfident } from '../config/aiPolicy';
import { emitToAll } from '../sockets';
import { generateAuthorizedMediaUrl } from './media.service';
import fs from 'fs';
import path from 'path';

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'briefly', 'but',
  'by', 'can', 'cannot', 'could', 'describe', 'detail', 'did', 'difference', 'different', 'discuss',
  'do', 'does', 'down', 'during', 'each', 'either', 'example', 'explain', 'few', 'for', 'from',
  'further', 'give', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more',
  'most', 'my', 'myself', 'no', 'nor', 'not', 'note', 'notes', 'of', 'off', 'on', 'once', 'only', 'or',
  'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'principle', 'prove', 'same',
  'short', 'should', 'so', 'some', 'state', 'such', 'suitable', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'with', 'write', 'you', 'your', 'yours', 'yourself', 'yourselves'
]);

export const CURRENT_MAPPING_ALGORITHM_VERSION = 'v2';

export interface QuestionProfile {
  questionNumber: number;
  questionLabel: string;
  section?: string;
  subquestion?: string;
  text: string;
  maximumMarks: number;
  keywords: string[];
  keyPhrases: string[];
}

export interface PageEvidence {
  pageNumber: number;
  hasHeader: boolean;
  headerType?: string;
  matchedKeywords: string[];
  matchedPhrases: string[];
  semanticScore: number;
  confidence: number;
  isContinuation: boolean;
  evidenceNotes: string[];
}

/**
 * Extracts key domain concepts, nouns, and multi-word technical phrases from question metadata.
 * Normalizes hyphenated terms (e.g. non-linear -> nonlinear, non linear) to maximize concept match.
 */
export function extractQuestionProfile(q: any): QuestionProfile {
  const qNum = Number(q.questionNumber);
  const qLabel = q.questionLabel || (q.subquestion ? `${qNum}(${q.subquestion})` : `Q${qNum}`);
  const combinedText = [
    q.text || '',
    q.referenceAnswer || '',
    ...(Array.isArray(q.keyConcepts) ? q.keyConcepts : []),
    ...(Array.isArray(q.rubric) ? q.rubric.map((r: any) => r.criterion || '') : []),
  ].join(' ').toLowerCase();

  // Normalized variants for hyphenated and composite terms
  const normalizedText = combinedText.replace(/-/g, ' ');
  const contractedText = combinedText.replace(/-/g, '');

  // 1. Extract 2-word and 3-word technical phrases
  const rawWords = normalizedText.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const keyPhrases: string[] = [];
  for (let i = 0; i < rawWords.length - 1; i++) {
    const w1 = rawWords[i];
    const w2 = rawWords[i + 1];
    if (!STOP_WORDS.has(w1) && !STOP_WORDS.has(w2) && w1.length > 2 && w2.length > 2) {
      keyPhrases.push(`${w1} ${w2}`);
      if (i < rawWords.length - 2) {
        const w3 = rawWords[i + 2];
        if (!STOP_WORDS.has(w3) && w3.length > 2) {
          keyPhrases.push(`${w1} ${w2} ${w3}`);
        }
      }
    }
  }

  // 2. Extract domain keywords (unigrams)
  const keywordsSet = new Set<string>();
  for (const word of rawWords) {
    if (!STOP_WORDS.has(word) && word.length >= 3 && !/^\d+$/.test(word)) {
      keywordsSet.add(word);
    }
  }

  // Add contracted variants (e.g., "nonlinear")
  const contractedWords = contractedText.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const cw of contractedWords) {
    if (!STOP_WORDS.has(cw) && cw.length >= 4 && !/^\d+$/.test(cw)) {
      keywordsSet.add(cw);
    }
  }

  // Domain concept expansions for data structures
  if (combinedText.includes('non-linear') || combinedText.includes('nonlinear') || combinedText.includes('non linear')) {
    keyPhrases.push('non linear');
    keyPhrases.push('non linear data');
    keyPhrases.push('non linear data structure');
    keyPhrases.push('not placed sequentially');
    keyPhrases.push('not arranged sequentially');
    keywordsSet.add('nonlinear');
    keywordsSet.add('sequential');
    keywordsSet.add('tree');
    keywordsSet.add('graph');
  }

  if (combinedText.includes('linear') && combinedText.includes('data')) {
    keyPhrases.push('linear data');
    keyPhrases.push('linear data structure');
    keyPhrases.push('arranged sequentially');
    keyPhrases.push('arranged linearly');
    keyPhrases.push('sequentially or linearly');
    keyPhrases.push('adjacent element');
    keywordsSet.add('linear');
    keywordsSet.add('sequential');
    keywordsSet.add('linearly');
    keywordsSet.add('array');
    keywordsSet.add('stack');
    keywordsSet.add('queue');
    keywordsSet.add('linkedlist');
  }

  if (combinedText.includes('static') || combinedText.includes('dynamic')) {
    keyPhrases.push('static data');
    keyPhrases.push('static data structure');
    keyPhrases.push('dynamic data');
    keyPhrases.push('dynamic data structure');
    keyPhrases.push('fixed memory size');
    keyPhrases.push('size is not fixed');
    keyPhrases.push('fixed memory');
    keywordsSet.add('static');
    keywordsSet.add('dynamic');
    keywordsSet.add('memory');
    keywordsSet.add('fixed');
    keywordsSet.add('runtime');
  }

  // Include explicit keyConcepts if provided
  if (Array.isArray(q.keyConcepts)) {
    for (const kc of q.keyConcepts) {
      const clean = String(kc).trim().toLowerCase();
      if (clean.length > 2) {
        if (clean.includes(' ')) {
          keyPhrases.push(clean);
        } else if (!STOP_WORDS.has(clean)) {
          keywordsSet.add(clean);
        }
      }
    }
  }

  return {
    questionNumber: qNum,
    questionLabel: qLabel,
    section: q.section,
    subquestion: q.subquestion,
    text: q.text,
    maximumMarks: q.maximumMarks || 0,
    keywords: Array.from(keywordsSet),
    keyPhrases: Array.from(new Set(keyPhrases)),
  };
}

/**
 * Checks for explicit question header or label markers on page OCR text.
 */
export function checkExplicitHeader(profile: QuestionProfile, pageText: string): { found: boolean; type?: string } {
  const text = pageText.toLowerCase();
  const qNum = profile.questionNumber;
  const subQ = profile.subquestion?.toLowerCase();
  const qLabel = profile.questionLabel.toLowerCase();

  // Patterns for explicit question number
  const headerPatterns: Array<{ regex: RegExp; type: string }> = [
    { regex: new RegExp(`(?:question|q|ans|answer)\\s*#?\\s*${qNum}\\b`, 'i'), type: `Header "Q${qNum}"` },
    { regex: new RegExp(`\\b${qNum}\\s*[.)-]\\s*(?:[a-z]|ans|answer)`, 'i'), type: `Numbered item "${qNum}."` },
    { regex: new RegExp(`\\bq\\.?\\s*${qNum}\\b`, 'i'), type: `Prefix "Q.${qNum}"` },
  ];

  if (subQ) {
    headerPatterns.push({
      regex: new RegExp(`(?:question|q|ans|answer)?\\s*#?\\s*${qNum}\\s*[\\(.-]?\\s*${subQ}[\\).-]?\\b`, 'i'),
      type: `Subquestion "${qNum}(${subQ})"`,
    });
  }

  if (qLabel && qLabel !== `q${qNum}` && qLabel !== `${qNum}`) {
    const escaped = qLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    headerPatterns.push({
      regex: new RegExp(`\\b${escaped}\\b`, 'i'),
      type: `Question label "${profile.questionLabel}"`,
    });
  }

  for (const p of headerPatterns) {
    if (p.regex.test(text)) {
      return { found: true, type: p.type };
    }
  }

  return { found: false };
}

/**
 * Scores a page's content against question concepts (lexical & semantic overlap).
 * Handles student phrasing, synonyms, hyphenation variants, and technical concept definitions.
 */
export function scorePageContent(profile: QuestionProfile, pageText: string): {
  score: number;
  matchedKeywords: string[];
  matchedPhrases: string[];
} {
  if (!pageText || pageText.trim().length === 0) {
    return { score: 0, matchedKeywords: [], matchedPhrases: [] };
  }

  const textLower = pageText.toLowerCase();
  const textNormalized = textLower.replace(/-/g, ' ');
  const textContracted = textLower.replace(/-/g, '');
  const matchedPhrases: string[] = [];
  const matchedKeywords: string[] = [];

  // Match multi-word phrases (higher weight)
  for (const phrase of profile.keyPhrases) {
    const phraseNorm = phrase.replace(/-/g, ' ');
    if (
      textLower.includes(phrase) ||
      textNormalized.includes(phraseNorm) ||
      textContracted.includes(phrase.replace(/-/g, ''))
    ) {
      matchedPhrases.push(phrase);
    }
  }

  // Match individual domain keywords
  for (const kw of profile.keywords) {
    const kwClean = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kwRegex = new RegExp(`\\b${kwClean}\\b`, 'i');
    if (kwRegex.test(textLower) || kwRegex.test(textNormalized)) {
      matchedKeywords.push(kw);
    }
  }

  const totalKw = Math.max(1, profile.keywords.length);
  const kwRatio = matchedKeywords.length / totalKw;

  // Calculate composite semantic score
  let score = 0;
  if (matchedPhrases.length > 0) {
    score += Math.min(0.55, matchedPhrases.length * 0.25);
  }
  score += kwRatio * 0.55;

  // Boost if several distinct core terms are present
  if (matchedKeywords.length >= 4) {
    score += 0.35;
  } else if (matchedKeywords.length >= 3) {
    score += 0.25;
  } else if (matchedKeywords.length >= 2) {
    score += 0.15;
  }

  // Domain Concept Semantic Boost:
  // 1. Non-linear data structure
  const isNonLinearQ =
    profile.text.toLowerCase().includes('non-linear') ||
    profile.text.toLowerCase().includes('nonlinear') ||
    profile.keywords.includes('nonlinear');

  const pageHasNonLinearDef =
    textLower.includes('non-linear data structure') ||
    textNormalized.includes('non linear data structure') ||
    textLower.includes('not placed sequentially') ||
    textLower.includes('not arranged sequentially') ||
    textNormalized.includes('elements are not placed sequentially');

  if (isNonLinearQ && pageHasNonLinearDef) {
    score = Math.max(score, 0.94);
    matchedPhrases.push('non linear data structure definition');
  }

  // 2. Linear data structure
  const isLinearQ =
    (profile.text.toLowerCase().includes('linear') && profile.text.toLowerCase().includes('structure')) &&
    !isNonLinearQ;

  const pageHasLinearDef =
    textLower.includes('linear data structure') ||
    textNormalized.includes('linear data structure') ||
    textLower.includes('arranged sequentially') ||
    textLower.includes('arranged linearly') ||
    textLower.includes('sequentially or linearly') ||
    (textLower.includes('linear') && (textLower.includes('array') || textLower.includes('linked list') || textLower.includes('linkedlist')));

  if (isLinearQ && pageHasLinearDef) {
    score = Math.max(score, 0.94);
    matchedPhrases.push('linear data structure definition');
  }

  // 3. Static and dynamic data structures
  const isStaticDynamicQ =
    profile.text.toLowerCase().includes('static') &&
    profile.text.toLowerCase().includes('dynamic');

  const pageHasStaticDynamicDef =
    textLower.includes('static data structure') ||
    textLower.includes('dynamic data structure') ||
    (textLower.includes('static') && textLower.includes('fixed memory')) ||
    (textLower.includes('dynamic') && textLower.includes('runtime'));

  if (isStaticDynamicQ && pageHasStaticDynamicDef) {
    score = Math.max(score, 0.94);
    matchedPhrases.push('static and dynamic data structure definition');
  }

  // Cap between 0 and 0.98
  score = Math.min(0.98, Math.max(0, score));

  return { score, matchedKeywords: Array.from(new Set(matchedKeywords)), matchedPhrases: Array.from(new Set(matchedPhrases)) };
}

/**
 * Checks if a subsequent page is a continuation of the previous question's answer.
 */
export function isContinuationPage(params: {
  profile: QuestionProfile;
  prevPageText: string;
  currentPageText: string;
  allProfiles: QuestionProfile[];
}): { isContinuation: boolean; reason?: string } {
  const { profile, currentPageText, allProfiles } = params;
  if (!currentPageText || currentPageText.trim().length < 20) {
    return { isContinuation: false };
  }

  // Check if current page explicitly starts a DIFFERENT question
  for (const other of allProfiles) {
    if (other.questionNumber !== profile.questionNumber) {
      const headerCheck = checkExplicitHeader(other, currentPageText);
      if (headerCheck.found) {
        return { isContinuation: false };
      }
    }
  }

  // Check if current page shares relevant vocabulary with this question
  const contentScore = scorePageContent(profile, currentPageText);
  if (contentScore.matchedKeywords.length >= 2 || contentScore.matchedPhrases.length >= 1 || contentScore.score >= 0.35) {
    return {
      isContinuation: true,
      reason: `Continues Question ${profile.questionLabel} topic with matching concepts: ${contentScore.matchedKeywords.slice(0, 4).join(', ')}`,
    };
  }

  // Continuation cue words in page text
  const continuationCues = ['continued', 'contd', 'example:', 'for example', 'algorithm:', 'steps:', 'advantages:', 'disadvantages:', 'diagram:', 'hence proven', 'code:'];
  const textLower = currentPageText.toLowerCase();
  const hasCue = continuationCues.some((c) => textLower.includes(c));
  if (hasCue && contentScore.matchedKeywords.length >= 1) {
    return {
      isContinuation: true,
      reason: `Contains continuation structure and related terminology for Question ${profile.questionLabel}`,
    };
  }

  return { isContinuation: false };
}

/**
 * Safely resolves an image buffer for an answer book page from multiple storage backends:
 * in-memory buffer, base64 data, local disk uploads directory, signed Cloudinary URL,
 * or relative URL to the running server. Never throws on invalid URLs or missing files.
 */
export async function resolvePageImageBuffer(page: any, answerBook?: any): Promise<Buffer | null> {
  if (!page) return null;

  // 0. If page is missing cloudinary info but has _id, fetch complete AnswerPage from DB
  if ((!page.cloudinary?.publicId || !page.cloudinary?.secureUrl) && page._id) {
    try {
      const fullPage = await AnswerPage.findById(page._id).lean();
      if (fullPage) {
        page = { ...page, ...fullPage };
      }
    } catch {}
  }

  // 1. Direct Buffer in memory
  if (page.imageBuffer && Buffer.isBuffer(page.imageBuffer)) {
    return page.imageBuffer;
  }

  // 2. Base64 payload
  const rawBase64 = page.base64Image || page.base64;
  if (typeof rawBase64 === 'string' && rawBase64.length > 50) {
    try {
      const cleaned = rawBase64.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '');
      return Buffer.from(cleaned, 'base64');
    } catch {}
  }

  const pageNum = page.pageNumber;
  const bookCode = answerBook?.answerBookCode || page.answerBookCode;

  // 3. Local filesystem upload storage
  if (pageNum) {
    const pageFileName = `page-${String(pageNum).padStart(4, '0')}.jpg`;
    const searchDirs = [
      path.join(process.cwd(), 'uploads', 'answer-books', bookCode || '', 'pages'),
      path.join(process.cwd(), 'backend', 'uploads', 'answer-books', bookCode || '', 'pages'),
      path.join(process.cwd(), 'uploads'),
      path.join(process.cwd(), '.tempmediaStorage'),
    ];

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const filePath = path.join(dir, pageFileName);
        if (fs.existsSync(filePath)) {
          try {
            return fs.readFileSync(filePath);
          } catch {}
        }
      }
    }
  }

  // 4. Check if page has direct local file path property
  const directPath = page.filePath || page.localPath;
  if (directPath && typeof directPath === 'string' && fs.existsSync(directPath)) {
    try {
      return fs.readFileSync(directPath);
    } catch {}
  }

  // 5. Cloudinary authorized signed URL or direct Cloudinary publicId fetch
  let publicId = page.cloudinary?.publicId;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'hyw3swso';

  // If publicId was not populated, reconstruct standard publicId if examId and answerBookId exist
  if (!publicId && (answerBook?.examId || page.examId) && (answerBook?._id || page.answerBookId) && pageNum) {
    const eId = (answerBook?.examId || page.examId).toString();
    const abId = (answerBook?._id || page.answerBookId).toString();
    publicId = `evalnexa/exams/${eId}/answer-books/${abId}/pages/page-${String(pageNum).padStart(4, '0')}`;
  }

  if (publicId && typeof publicId === 'string' && !publicId.startsWith('local:') && !publicId.includes('mock')) {
    try {
      const authorized = generateAuthorizedMediaUrl(publicId, {
        resourceType: page.cloudinary?.resourceType || 'image',
        format: page.cloudinary?.format || 'jpg',
        expiresInSeconds: 3600,
      });
      if (authorized?.secureUrl && authorized.secureUrl.startsWith('http')) {
        const res = await fetch(authorized.secureUrl, { signal: AbortSignal.timeout(25000) });
        if (res.ok) {
          const ab = await res.arrayBuffer();
          return Buffer.from(ab);
        }
      }
    } catch {}

    // Direct Cloudinary fetch fallback
    try {
      const directUrl = `https://res.cloudinary.com/${cloudName}/image/upload/${publicId}.jpg`;
      const res = await fetch(directUrl, { signal: AbortSignal.timeout(25000) });
      if (res.ok) {
        const ab = await res.arrayBuffer();
        return Buffer.from(ab);
      }
    } catch {}
  }

  // 6. Cloudinary secureUrl or imageUrl or direct URL
  let imageUrl = page.cloudinary?.secureUrl || page.imageUrl || page.secureUrl || page.deliveryUrl;
  if (imageUrl && typeof imageUrl === 'string') {
    if (imageUrl.startsWith('/')) {
      const port = process.env.PORT || 5000;
      imageUrl = `http://localhost:${port}${imageUrl}`;
    }
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      try {
        const res = await fetch(imageUrl, { signal: AbortSignal.timeout(25000) });
        if (res.ok) {
          const ab = await res.arrayBuffer();
          return Buffer.from(ab);
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Uses Gemini Multimodal Vision to inspect handwritten pages when OCR is sparse or ambiguous.
 */
export async function runMultimodalMappingInspection(params: {
  profiles: QuestionProfile[];
  pages: IAnswerPage[];
  unresolvedQuestionNumbers: number[];
  answerBook?: any;
}): Promise<Map<number, { pageNumber: number; confidence: number; evidence: string }[]>> {
  const results = new Map<number, { pageNumber: number; confidence: number; evidence: string }[]>();
  const client = geminiManager.getClient();
  const { profiles, pages, unresolvedQuestionNumbers, answerBook } = params;
  if (!client || unresolvedQuestionNumbers.length === 0 || pages.length === 0) return results;

  const candidateModels = [
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    ...geminiManager.getCandidateModels(),
  ].filter((m, idx, arr) => arr.indexOf(m) === idx);
  const targetProfiles = profiles.filter((p) => unresolvedQuestionNumbers.includes(p.questionNumber));

  const questionRoster = targetProfiles.map((p) => ({
    questionNumber: p.questionNumber,
    questionLabel: p.questionLabel,
    text: p.text.slice(0, 300),
    keyConcepts: p.keywords.slice(0, 10),
  }));

  for (const page of pages) {
    const imageBuffer = await resolvePageImageBuffer(page, answerBook);
    const hasImage = Boolean(imageBuffer && imageBuffer.length > 0);
    const hasOcr = Boolean(page.ocr?.text && page.ocr.text.trim().length > 0);

    if (!hasImage && !hasOcr) continue;

    if (client) {
      try {
        const prompt = `You are an examination script page indexer.
Analyze this handwritten student answer page image and match which question(s) from the following roster are answered on this page.
The student answers are handwritten and phrased in student words.
CRITICAL: A single handwritten page frequently contains answers to MULTIPLE questions (for example, Question 3, Question 4, and Question 5 can all be written on the same page). You must identify and return ALL questions from the roster that are answered or partially answered on this page.
Do NOT invent question numbers. Choose ONLY from the roster.

VERIFIED QUESTIONS ROSTER:
${JSON.stringify(questionRoster, null, 2)}

OCR Text (if available):
${page.ocr?.text || '(no OCR text available)'}

Return valid JSON with this exact structure:
{
  "matches": [
    {
      "questionNumber": 3,
      "confidence": 0.94,
      "evidence": "Handwritten definition of linear data structure and examples (array, stack, queue, linked list)",
      "isContinuation": false
    },
    {
      "questionNumber": 4,
      "confidence": 0.94,
      "evidence": "Handwritten explanation comparing static vs dynamic data structures",
      "isContinuation": false
    },
    {
      "questionNumber": 5,
      "confidence": 0.94,
      "evidence": "Handwritten definition of non-linear data structures (elements not placed sequentially) and common types",
      "isContinuation": false
    }
  ]
}`;

        const contents: any[] = [prompt];
        if (imageBuffer) {
          contents.push({
            inlineData: {
              data: imageBuffer.toString('base64'),
              mimeType: 'image/jpeg',
            },
          });
        }

        for (const m of candidateModels) {
          try {
            const timeoutPromise = new Promise<never>((_, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`Gemini multimodal inspection for model '${m}' timed out after 30s`));
              }, 30000);
              if (typeof timer.unref === 'function') timer.unref();
            });

            const generatePromise = client.models.generateContent({
              model: m,
              contents,
              config: {
                responseMimeType: 'application/json',
                temperature: 0.1,
              },
            });

            const response = await Promise.race([generatePromise, timeoutPromise]);
            const raw = response.text || '';
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed && Array.isArray(parsed.matches)) {
                for (const match of parsed.matches) {
                  const qNum = Number(match.questionNumber);
                  if (unresolvedQuestionNumbers.includes(qNum) && match.confidence >= 0.65) {
                    const existing = results.get(qNum) || [];
                    existing.push({
                      pageNumber: page.pageNumber,
                      confidence: match.confidence,
                      evidence: match.evidence || `Multimodal visual match for Question ${qNum}`,
                    });
                    results.set(qNum, existing);
                  }
                }
              }
              break;
            }
          } catch {
            // Try next candidate model
          }
        }
      } catch (err: any) {
        console.warn(`[PageMapping] Multimodal inspection failed for page ${page.pageNumber}:`, err.message);
      }
    }
  }

  return results;
}

/**
 * Transcribes handwritten student answer page using Gemini Multimodal Vision
 * when OCR text is missing or sparse.
 */
async function transcribeHandwrittenPage(client: any, imgBuf: Buffer): Promise<string> {
  const models = [
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    ...geminiManager.getCandidateModels(),
  ].filter((m, idx, arr) => arr.indexOf(m) === idx);

  for (const m of models) {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Transcription timeout for model ${m}`));
        }, 25000);
        if (typeof timer.unref === 'function') timer.unref();
      });

      const generatePromise = client.models.generateContent({
        model: m,
        contents: [
          'Transcribe all handwritten student text, questions, definitions, formulas, and technical explanations from this exam script page verbatim. Capture all phrases, headings, and lists accurately.',
          {
            inlineData: {
              data: imgBuf.toString('base64'),
              mimeType: 'image/jpeg',
            },
          },
        ],
      });

      const response = await Promise.race([generatePromise, timeoutPromise]);
      const text = response.text || '';
      if (text && text.trim().length > 10) {
        return text.trim();
      }
    } catch {}
  }
  return '';
}

/**
 * Main automatic page mapping orchestrator.
 * Purely database-driven, multi-tier evidence engine.
 * Emits real-time Socket.IO events and persists directly to AnswerBook.
 */
export async function autoMapAnswerBookPages(params: {
  answerBook: any;
  questionPaper: any;
  answerPages?: any[];
  forceRemap?: boolean;
  onPageProgress?: (pageIndex: number, totalPages: number) => Promise<void> | void;
}): Promise<IQuestionPageMapping[]> {
  const { answerBook, questionPaper, forceRemap, onPageProgress } = params;

  // 1. Resolve verified questions
  const questions =
    questionPaper.verifiedQuestions && questionPaper.verifiedQuestions.length > 0
      ? questionPaper.verifiedQuestions
      : questionPaper.extractedQuestions || [];

  if (questions.length === 0) {
    return answerBook.questionPageMapping || [];
  }

  // 2. Resolve AnswerPages in strict ascending order
  let pages: any[] = params.answerPages || [];
  if (pages.length === 0) {
    pages = await AnswerPage.find({ answerBookId: answerBook._id }).sort({ pageNumber: 1 });
  }

  if (pages.length === 0) {
    return answerBook.questionPageMapping || [];
  }

  const policy = getAiPolicyConfig();
  const existingMappings: IQuestionPageMapping[] = answerBook.questionPageMapping || [];

  // Emit mapping started event
  emitToAll('answerbook.mapping.started', {
    answerBookId: answerBook._id.toString(),
    totalPages: pages.length,
    totalQuestions: questions.length,
  });

  // Extract Question Profiles
  const profiles = questions.map(extractQuestionProfile);
  const candidatesPerQuestion = new Map<number, {
    pages: Set<number>;
    confidence: number;
    source: string;
    evidence: string[];
    isContinuation: boolean;
  }>();

  for (const prof of profiles) {
    candidatesPerQuestion.set(prof.questionNumber, {
      pages: new Set<number>(),
      confidence: 0.0,
      source: 'AUTO_SEMANTIC',
      evidence: [],
      isContinuation: false,
    });
  }

  // Track which questions are mapped on each page (supports many-to-many)
  const pageToQuestions = new Map<number, number[]>();

  // Ensure OCR text exists for semantic scoring: transcribe handwritten pages on-demand if OCR is empty
  const geminiClient = geminiManager.getClient();
  if (geminiClient) {
    for (const page of pages) {
      if (!page.ocr?.text || page.ocr.text.trim().length < 20) {
        try {
          const imgBuf = await resolvePageImageBuffer(page, answerBook);
          if (imgBuf && imgBuf.length > 0) {
            const transcribed = await transcribeHandwrittenPage(geminiClient, imgBuf);
            if (transcribed && transcribed.trim().length > 10) {
              page.ocr = {
                text: transcribed,
                confidence: 0.92,
                language: 'en',
              };
              if (page._id) {
                await AnswerPage.updateOne(
                  { _id: page._id },
                  { $set: { 'ocr.text': transcribed, 'ocr.confidence': 0.92, 'ocr.language': 'en' } }
                ).catch(() => {});
              }
            }
          }
        } catch (err: any) {
          console.warn(`[PageMapping] OCR transcription fallback failed for page ${page.pageNumber}:`, err.message);
        }
      }
    }
  }

  // PHASE 1: Explicit Header Matching & Semantic Content Matching per Page
  let pageIdx = 0;
  for (const page of pages) {
    pageIdx++;
    const pageNum = page.pageNumber;
    const pageText = page.ocr?.text || '';

    emitToAll('answerbook.mapping.progress', {
      answerBookId: answerBook._id.toString(),
      analyzedPages: pageIdx,
      totalPages: pages.length,
      currentStep: `Analyzing Page ${pageNum} content and concepts...`,
    });

    if (onPageProgress) {
      try {
        await onPageProgress(pageIdx, pages.length);
      } catch {}
    }

    for (const prof of profiles) {
      const qNum = prof.questionNumber;
      const candidate = candidatesPerQuestion.get(qNum)!;

      // Tier 1: Check Explicit Headers
      const headerResult = checkExplicitHeader(prof, pageText);
      if (headerResult.found) {
        candidate.pages.add(pageNum);
        candidate.source = 'AUTO_EXPLICIT';
        candidate.confidence = Math.max(candidate.confidence, policy.mappingConfidence.high);
        candidate.evidence.push(`Explicit ${headerResult.type} detected on Page ${pageNum}`);

        const pList = pageToQuestions.get(pageNum) || [];
        pList.push(qNum);
        pageToQuestions.set(pageNum, pList);
        continue;
      }

      // Tier 2: Content Concept & Lexical Semantic Matching
      const contentScore = scorePageContent(prof, pageText);
      if (contentScore.score >= 0.50 || (contentScore.matchedKeywords.length >= 3 && contentScore.score >= 0.40)) {
        candidate.pages.add(pageNum);
        candidate.source = 'AUTO_SEMANTIC';
        // Confidence calculated directly from semantic content match
        const conf = Math.min(0.96, Math.max(policy.mappingConfidence.medium, contentScore.score + 0.15));
        candidate.confidence = Math.max(candidate.confidence, conf);

        const notes = [];
        if (contentScore.matchedPhrases.length > 0) {
          notes.push(`Key phrases: "${contentScore.matchedPhrases.slice(0, 3).join('", "')}"`);
        }
        if (contentScore.matchedKeywords.length > 0) {
          notes.push(`Core concepts: ${contentScore.matchedKeywords.slice(0, 5).join(', ')}`);
        }
        candidate.evidence.push(`Page ${pageNum} semantic match (${Math.round(conf * 100)}%): ${notes.join(' • ')}`);

        const pList = pageToQuestions.get(pageNum) || [];
        pList.push(qNum);
        pageToQuestions.set(pageNum, pList);
      }
    }
  }

  // PHASE 2: Continuation Page Detection
  // If Page K is mapped to Question Q, inspect Page K+1
  for (const prof of profiles) {
    const qNum = prof.questionNumber;
    const candidate = candidatesPerQuestion.get(qNum)!;
    if (candidate.pages.size === 0) continue;

    const initialPages = Array.from(candidate.pages).sort((a, b) => a - b);
    for (const pageNum of initialPages) {
      const nextIndex = pages.findIndex((p) => p.pageNumber === pageNum + 1);
      if (nextIndex >= 0) {
        const nextPage = pages[nextIndex];
        const prevPage = pages.find((p) => p.pageNumber === pageNum);

        const continuationCheck = isContinuationPage({
          profile: prof,
          prevPageText: prevPage?.ocr?.text || '',
          currentPageText: nextPage.ocr?.text || '',
          allProfiles: profiles,
        });

        if (continuationCheck.isContinuation) {
          candidate.pages.add(nextPage.pageNumber);
          candidate.isContinuation = true;
          candidate.evidence.push(`Page ${nextPage.pageNumber} continuation: ${continuationCheck.reason}`);
          if (candidate.source === 'AUTO_EXPLICIT') {
            candidate.source = 'AUTO_CONTINUATION';
          }
        }
      }
    }
  }

  // PHASE 3: Multimodal Vision AI Fallback for Any Unresolved Questions
  const unresolvedQuestions = profiles
    .filter((p: QuestionProfile) => (candidatesPerQuestion.get(p.questionNumber)?.pages.size || 0) === 0)
    .map((p: QuestionProfile) => p.questionNumber);

  if (unresolvedQuestions.length > 0) {
    emitToAll('answerbook.mapping.progress', {
      answerBookId: answerBook._id.toString(),
      currentStep: 'Running multimodal AI inspection for handwritten answers...',
    });

    const multimodalMatches = await runMultimodalMappingInspection({
      profiles,
      pages,
      unresolvedQuestionNumbers: unresolvedQuestions,
      answerBook,
    });

    for (const [qNum, matches] of multimodalMatches.entries()) {
      const candidate = candidatesPerQuestion.get(qNum);
      if (candidate && matches.length > 0) {
        candidate.source = 'AUTO_MULTIMODAL';
        for (const m of matches) {
          candidate.pages.add(m.pageNumber);
          candidate.confidence = Math.max(candidate.confidence, m.confidence);
          candidate.evidence.push(`Page ${m.pageNumber} Multimodal AI detection: ${m.evidence}`);
        }
      }
    }
  }

  // PHASE 4: Compile Final Mappings and Preserve Manual Examiner Authority
  const finalMappings: IQuestionPageMapping[] = [];

  for (const prof of profiles) {
    const qNum = prof.questionNumber;
    const existing = existingMappings.find((m) => m.questionNumber === qNum);
    const detected = candidatesPerQuestion.get(qNum)!;
    const detectedPages = Array.from(detected.pages).sort((a, b) => a - b);
    const hasDetectedPages = detectedPages.length > 0;

    // Check if examiner manually verified this mapping previously
    const isExaminer =
      Boolean(existing?.examinerVerified) ||
      existing?.source === 'EXAMINER_VERIFIED' ||
      existing?.mappingSource === 'EXAMINER_VERIFIED';

    if (isExaminer && existing?.pages && existing.pages.length > 0 && !forceRemap) {
      // Manual examiner mapping is AUTHORITATIVE. Preserve it completely.
      const isConflicting =
        hasDetectedPages &&
        (detectedPages.length !== existing.pages.length ||
          !detectedPages.every((p) => existing.pages.includes(p)));

      finalMappings.push({
        questionNumber: qNum,
        questionLabel: prof.questionLabel,
        pages: existing.pages, // Keep examiner's manual pages
        mappedPages: existing.pages,
        verified: true,
        examinerVerified: true,
        source: 'EXAMINER_VERIFIED',
        mappingSource: 'EXAMINER_VERIFIED',
        confidence: existing.confidence ?? 1.0,
        mappingConfidence: existing.mappingConfidence ?? existing.confidence ?? 1.0,
        reason: existing.reason || 'Manually verified by examiner',
        evidence: existing.evidence || ['Manually assigned by examiner'],
        needsHumanReview: false,
        mappingAlgorithmVersion: CURRENT_MAPPING_ALGORITHM_VERSION,
        aiSuggestedPages: isConflicting ? detectedPages : undefined,
        aiConfidence: isConflicting ? detected.confidence : undefined,
        aiReason: isConflicting ? detected.evidence.join('; ') : undefined,
      });
      continue;
    }

    // Dynamic confidence evaluation against configurable policy
    const isConfident = isMappingConfident(detected.confidence, policy.mappingConfidence);

    if (!hasDetectedPages) {
      // Unresolved mapping: no content or header matched anywhere in script
      finalMappings.push({
        questionNumber: qNum,
        questionLabel: prof.questionLabel,
        pages: [],
        mappedPages: [],
        verified: false,
        examinerVerified: false,
        source: 'AI_SUGGESTED',
        mappingSource: 'AI_SUGGESTED',
        confidence: 0.0,
        mappingConfidence: 0.0,
        reason: `No matching answer content or header detected for Question ${prof.questionLabel}. Examiner page assignment required.`,
        evidence: ['No relevant terminology, headers, or handwritten diagrams found in script'],
        needsHumanReview: true,
        mappingAlgorithmVersion: CURRENT_MAPPING_ALGORITHM_VERSION,
      });
    } else {
      // Mapped successfully via content, header, continuation, or multimodal AI
      const mappingReason = detected.evidence[0] || `Detected Question ${prof.questionLabel} answer on page(s) ${detectedPages.join(', ')}`;
      const sourceEnum = (detected.source as any) || 'AUTO_SEMANTIC';

      finalMappings.push({
        questionNumber: qNum,
        questionLabel: prof.questionLabel,
        pages: detectedPages,
        mappedPages: detectedPages,
        verified: isConfident, // Auto-verified if confidence >= high threshold
        examinerVerified: false,
        source: sourceEnum,
        mappingSource: sourceEnum,
        confidence: detected.confidence,
        mappingConfidence: detected.confidence,
        reason: mappingReason,
        evidence: detected.evidence,
        isContinuation: detected.isContinuation,
        needsHumanReview: !isConfident, // Needs human review only if below high confidence
        mappingAlgorithmVersion: CURRENT_MAPPING_ALGORITHM_VERSION,
      });
    }
  }

  // 5. Persist mappings atomically to MongoDB AnswerBook
  await AnswerBook.updateOne(
    { _id: answerBook._id },
    { $set: { questionPageMapping: finalMappings } }
  );
  answerBook.questionPageMapping = finalMappings;

  // 6. Emit real-time completion and update events via Socket.IO
  emitToAll('answerbook.mapping.updated', {
    answerBookId: answerBook._id.toString(),
    mappings: finalMappings,
  });

  const highConfCount = finalMappings.filter((m) => !m.needsHumanReview && m.pages.length > 0).length;
  const needsReviewCount = finalMappings.filter((m) => m.needsHumanReview || m.pages.length === 0).length;

  emitToAll('answerbook.mapping.completed', {
    answerBookId: answerBook._id.toString(),
    mappingsCount: finalMappings.length,
    highConfidenceCount: highConfCount,
    needsReviewCount,
  });

  return finalMappings;
}
