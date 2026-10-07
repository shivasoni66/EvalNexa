import { GoogleGenAI } from '@google/genai';
import { IAIEvaluator, SingleModelEvaluationResult } from '../types';
import {
  EvaluationAssistantInput,
  evaluationAssistantResultSchema,
  buildEvaluationPrompt,
} from '../../EvaluationAssistantService';

export class GeminiProvider implements IAIEvaluator {
  public readonly id: string;
  public readonly name: string;
  public readonly supportsVision: boolean = true;
  private readonly client: GoogleGenAI;
  private readonly modelName: string;
  private readonly temperature: number;

  constructor(options: {
    id: string;
    name: string;
    client: GoogleGenAI;
    modelName: string;
    temperature?: number;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.client = options.client;
    this.modelName = options.modelName;
    this.temperature = options.temperature ?? 0.1;
  }

  public async evaluate(
    input: EvaluationAssistantInput,
    signal?: AbortSignal
  ): Promise<SingleModelEvaluationResult> {
    const startTime = Date.now();
    const prompt = buildEvaluationPrompt(input);
    const contents: Array<any> = [prompt];

    // Attach student images if provided
    const imagesToAttach: Array<string | Buffer> = [];
    if (input.studentAnswerImages && input.studentAnswerImages.length > 0) {
      imagesToAttach.push(...input.studentAnswerImages);
    } else if (input.studentAnswerImage) {
      imagesToAttach.push(input.studentAnswerImage);
    }

    for (const img of imagesToAttach) {
      const part = await this.resolveImagePart(img, input.studentAnswerImageMimeType);
      if (part) {
        contents.push(part);
      }
    }

    if (signal?.aborted) {
      throw new Error(`Evaluation aborted before dispatch to ${this.name}`);
    }

    // Call Gemini API
    const response = await this.client.models.generateContent({
      model: this.modelName,
      contents,
      config: {
        responseMimeType: 'application/json',
        temperature: this.temperature,
      },
    });

    const responseText = response.text || '';
    if (!responseText) {
      throw new Error(`Empty response from Gemini model ${this.modelName}`);
    }

    // Parse JSON
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(responseText);
    } catch {
      const cleaned = responseText
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
      parsedRaw = JSON.parse(cleaned);
    }

    const validated = evaluationAssistantResultSchema.parse(parsedRaw);
    const latencyMs = Date.now() - startTime;

    // Clamp marks to question maximum
    const clampedSuggested = Math.max(0, Math.min(input.maximumMarks, validated.suggestedMarks));
    const clampedMin = Math.max(0, Math.min(clampedSuggested, validated.minMarks));
    const clampedMax = Math.max(clampedSuggested, Math.min(input.maximumMarks, validated.maxMarks));

    return {
      modelName: `${this.name} (${this.modelName})`,
      provider: 'gemini',
      suggestedMarks: clampedSuggested,
      minMarks: clampedMin,
      maxMarks: clampedMax,
      confidence: Math.max(0, Math.min(1, validated.confidence)),
      needsHumanReview: validated.needsHumanReview,
      criteria: validated.criteria.map((c) => ({
        name: c.name,
        maxMarks: c.maxMarks,
        awardedMarks: Math.max(0, Math.min(c.maxMarks, c.awardedMarks)),
        evidence: c.evidence || '',
      })),
      missingConcepts: validated.missingConcepts || [],
      reasoningSummary: validated.reasoningSummary || '',
      latencyMs,
      isMultimodal: imagesToAttach.length > 0,
    };
  }

  private async resolveImagePart(
    imageInput: string | Buffer,
    fallbackMimeType = 'image/jpeg'
  ): Promise<{ inlineData: { data: string; mimeType: string } } | null> {
    try {
      if (Buffer.isBuffer(imageInput)) {
        return {
          inlineData: {
            data: imageInput.toString('base64'),
            mimeType: fallbackMimeType,
          },
        };
      }

      if (typeof imageInput === 'string') {
        if (imageInput.startsWith('data:')) {
          const matches = imageInput.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            return {
              inlineData: {
                mimeType: matches[1],
                data: matches[2],
              },
            };
          }
        }

        if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);
          try {
            const res = await fetch(imageInput, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!res.ok) return null;
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = res.headers.get('content-type') || fallbackMimeType;
            return {
              inlineData: {
                data: buffer.toString('base64'),
                mimeType: contentType,
              },
            };
          } catch {
            return null;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
