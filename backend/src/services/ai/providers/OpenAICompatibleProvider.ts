import { IAIEvaluator, SingleModelEvaluationResult } from '../types';
import {
  EvaluationAssistantInput,
  evaluationAssistantResultSchema,
  buildEvaluationPrompt,
} from '../../EvaluationAssistantService';

export class OpenAICompatibleProvider implements IAIEvaluator {
  public readonly id: string;
  public readonly name: string;
  public readonly supportsVision: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly temperature: number;

  constructor(options: {
    id: string;
    name: string;
    apiKey: string;
    baseUrl?: string;
    modelName: string;
    supportsVision?: boolean;
    temperature?: number;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.modelName = options.modelName;
    this.supportsVision = options.supportsVision ?? false;
    this.temperature = options.temperature ?? 0.1;
  }

  public async evaluate(
    input: EvaluationAssistantInput,
    signal?: AbortSignal
  ): Promise<SingleModelEvaluationResult> {
    const startTime = Date.now();
    const prompt = buildEvaluationPrompt(input);

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      {
        role: 'system',
        content:
          'You are an expert examination evaluation assistant for EvalNexa. Always return strictly valid JSON matching the requested schema without markdown fences or additional conversational prose.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const endpoint = `${this.baseUrl}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        messages,
        temperature: this.temperature,
        response_format: { type: 'json_object' },
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `OpenAI-compatible provider [${this.name}] error HTTP ${response.status}: ${errText.slice(0, 150)}`
      );
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) {
      throw new Error(`Empty completion content from ${this.name} (${this.modelName})`);
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(content);
    } catch {
      const cleaned = content
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();
      parsedRaw = JSON.parse(cleaned);
    }

    const validated = evaluationAssistantResultSchema.parse(parsedRaw);
    const latencyMs = Date.now() - startTime;

    const clampedSuggested = Math.max(0, Math.min(input.maximumMarks, validated.suggestedMarks));
    const clampedMin = Math.max(0, Math.min(clampedSuggested, validated.minMarks));
    const clampedMax = Math.max(clampedSuggested, Math.min(input.maximumMarks, validated.maxMarks));

    return {
      modelName: `${this.name} (${this.modelName})`,
      provider: 'openai-compatible',
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
      isMultimodal: false,
    };
  }
}
