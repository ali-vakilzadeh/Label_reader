import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { TAXONOMY_KEYS } from '../utils/fuzzyMatcher';
import {
  storedApiKey,
  storedImageModel,
  storedVisionModel,
} from '../db/visionSettings';
import { classifyGeminiError } from './geminiErrors';
import type { GeminiRawExtraction } from '../types';

/**
 * Gemini access layer. The API key lives only in server process.env and never
 * reaches a device — this module is the single egress point to Google.
 */

let client: GoogleGenAI | null = null;

export function getClient(): GoogleGenAI {
  const apiKey = activeApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on this server.');
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

export function isGeminiReady(): boolean {
  return Boolean(activeApiKey());
}

/**
 * Live view of the credentials.
 *
 * Precedence: an operator-managed key stored (and validated) through the UI wins
 * over the .env bootstrap value. .env is how the server is first provisioned;
 * after that the UI is the source of truth.
 *
 * There is deliberately NO fallback to an older key when the current one is
 * absent or rejected. A cleared or bad key means "wait for a corrected key",
 * never "quietly keep using the previous one" — silently reverting would make
 * the operator believe a change took effect when it did not.
 */
export function activeApiKey(): string {
  const managed = storedApiKey();
  if (managed) return managed;
  return (process.env.GEMINI_API_KEY ?? '').trim();
}

export function activeVisionModel(): string {
  return (
    storedVisionModel() ??
    ((process.env.GEMINI_VISION_MODEL ?? '').trim() || env.geminiVisionModel)
  );
}

export function activeImageModel(): string {
  return (
    storedImageModel() ??
    ((process.env.GEMINI_IMAGE_MODEL ?? '').trim() || env.geminiImageModel)
  );
}

/** Where the key currently in force came from — surfaced to the UI. */
export function credentialSource(): 'UI' | 'ENV' | 'NONE' {
  if (storedApiKey()) return 'UI';
  if ((process.env.GEMINI_API_KEY ?? '').trim()) return 'ENV';
  return 'NONE';
}

/**
 * Validates a candidate key/model pair against the live API before it is
 * adopted. Returns null on success, or a classified failure.
 */
export type ProbeResult =
  /** The credentials work. */
  | { outcome: 'VALID' }
  /** The credentials are definitively wrong. */
  | { outcome: 'INVALID'; fault: string; detail: string }
  /**
   * Could not tell — the API was unreachable or busy. NOT a pass: adopting on an
   * inconclusive probe would defeat the entire point of validating, letting a
   * typo take extraction down during a momentary outage. The caller retries
   * later and the previous credentials stay in force meanwhile.
   */
  | { outcome: 'INCONCLUSIVE'; fault: string; detail: string };

export async function probeCredentials(
  apiKey: string,
  model: string,
): Promise<ProbeResult> {
  try {
    const probe = new GoogleGenAI({ apiKey });
    await probe.models.generateContent({
      model,
      contents: 'ping',
      config: { maxOutputTokens: 1 },
    });
    return { outcome: 'VALID' };
  } catch (error) {
    const classification = classifyGeminiError(error);
    const inconclusive =
      classification.fault === 'VISION_TRANSIENT' ||
      classification.fault === 'VISION_NETWORK' ||
      classification.fault === 'VISION_UNKNOWN' ||
      classification.fault === 'VISION_RATE_LIMIT_MINUTE';

    return {
      outcome: inconclusive ? 'INCONCLUSIVE' : 'INVALID',
      fault: classification.fault,
      detail: classification.detail,
    };
  }
}

/**
 * Re-reads .env and drops the cached client so the next call uses the new
 * credentials. Invoked by the UI command VISION_SETTINGS_UPDATED.
 */
export function reloadGeminiClient(): void {
  // `override` is required: dotenv leaves already-set variables alone by default,
  // which would make an edited key invisible to a running process.
  dotenv.config({ override: true });
  client = null;
  logger.info(
    `Gemini settings reloaded — vision model ${activeVisionModel()}, ` +
      `key ${activeApiKey() ? 'present' : 'MISSING'}.`,
  );
}

/** HTTP statuses worth retrying: rate limits and transient backend faults. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;
  // The SDK stringifies the API error envelope into `message`.
  if (typeof candidate.message === 'string') {
    try {
      const parsed = JSON.parse(candidate.message) as { error?: { code?: number } };
      if (typeof parsed.error?.code === 'number') return parsed.error.code;
    } catch {
      /* not a JSON envelope */
    }
  }
  return null;
}

/** Network-level failures ("fetch failed") are retryable too. */
function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== null) return RETRYABLE_STATUS.has(status);
  return error instanceof TypeError || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` against the primary model, retrying transient failures with
 * exponential backoff plus jitter, then falls back to GEMINI_FALLBACK_MODEL for
 * one final try. Non-retryable errors (bad key, malformed request) fail fast.
 */
export async function withModelRetry<T>(
  attempt: (model: string) => Promise<T>,
  primaryModel: string,
  label: string,
): Promise<T> {
  const attempts = Math.max(1, env.geminiMaxAttempts);
  let lastError: unknown;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attempt(primaryModel);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || i === attempts - 1) break;
      // 500ms, 1s, 2s... plus up to 250ms of jitter to desynchronise devices.
      const backoff = 500 * 2 ** i + Math.floor(Math.random() * 250);
      logger.warn(
        `${label}: ${describe(error)} on ${primaryModel} (attempt ${i + 1}/${attempts}); ` +
          `retrying in ${backoff} ms.`,
      );
      await sleep(backoff);
    }
  }

  const fallback = env.geminiFallbackModel;
  if (fallback && fallback !== primaryModel && isRetryable(lastError)) {
    logger.warn(`${label}: falling back to ${fallback} after ${attempts} failed attempt(s).`);
    try {
      return await attempt(fallback);
    } catch (error) {
      logger.error(`${label}: fallback model ${fallback} also failed.`, error);
      throw error;
    }
  }

  throw lastError;
}

function describe(error: unknown): string {
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { error?: { status?: string } };
    if (parsed.error?.status) return `${status ?? '?'} ${parsed.error.status}`;
  } catch {
    /* plain message */
  }
  return status !== null ? `HTTP ${status}` : message.slice(0, 80);
}

/**
 * Two kinds of field, deliberately handled differently.
 *
 * REPORTED fields (brand_name, country_of_origin, sub_category, material) are
 * transcription tasks: the model reports what it can actually read on the label,
 * verbatim. Their reference tables run to hundreds of entries (295 sub-categories,
 * 839 brands) and are NEVER sent to the model — listing them would bloat every
 * request, cost tokens on every scan, and push the model toward guessing a
 * plausible-looking option instead of reading the label. A local matcher maps the
 * reported text onto the table afterwards.
 *
 * CONSTRAINED fields (category, color, gender, season) are short judgement calls
 * where the allowed set is small enough to state, so the model picks from it and
 * the answer is used exactly as returned. Those lists come from the same taxonomy
 * files the matcher indexes, so prompt and server can never disagree.
 */
export const SYSTEM_INSTRUCTION = [
  'Analyze apparel label and scale display images.',
  'Report EXACTLY what is printed on the labels for these fields, transcribing',
  'the text as it appears and never substituting a similar word:',
  'brand_name, country_of_origin, sub_category (the garment type named on the',
  'label or clearly visible in the photo), and material (the fibre composition).',
  'If one of these is not legible, return an empty string rather than a guess.',
  'Extract size and original_price as printed.',
  'Read weights from scale displays into an array.',
  'For the following fields choose exactly one option from the list given:',
  `color from [${TAXONOMY_KEYS.color}];`,
  `category from [${TAXONOMY_KEYS.category}];`,
  `gender from [${TAXONOMY_KEYS.gender}];`,
  `season from [${TAXONOMY_KEYS.season}].`,
  'Do not invent values outside those four lists.',
  'RULE: Return a confidence score between 0.0 and 1.0 for EVERY field.',
  'If a field is missing, guess ONLY if confidence > 0.50.',
  'Otherwise return empty string with 0.0 confidence.',
].join(' ');

/** {value, confidence} leaf shared by every extracted field. */
function confidenceField(description: string): Schema {
  return {
    type: Type.OBJECT,
    properties: {
      value: { type: Type.STRING, description },
      confidence: {
        type: Type.NUMBER,
        description: 'Confidence between 0.0 and 1.0.',
      },
    },
    required: ['value', 'confidence'],
  };
}

export const EXTRACTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    brand_name: confidenceField('Brand name exactly as printed on the label.'),
    country_of_origin: confidenceField(
      'Country of manufacture exactly as printed, e.g. "Made in Viet Nam".',
    ),
    size: confidenceField('Size as printed, e.g. "XL", "EU 42", "32W x 34L".'),
    color: confidenceField(`Dominant color, one of: ${TAXONOMY_KEYS.color}.`),
    material: confidenceField(
      'Fibre composition exactly as printed, e.g. "80% Cotton 20% Polyester".',
    ),
    original_price: confidenceField('Retail price including currency symbol.'),
    category: confidenceField(`One of: ${TAXONOMY_KEYS.category}.`),
    sub_category: confidenceField(
      'Garment type named on the label or clearly visible, in your own words. ' +
        'Do not force it into a category list.',
    ),
    gender: confidenceField(`One of: ${TAXONOMY_KEYS.gender}.`),
    season: confidenceField(`One of: ${TAXONOMY_KEYS.season}.`),
    weights: {
      type: Type.ARRAY,
      description:
        'Every distinct weight reading visible on scale displays, in capture order, with units.',
      items: confidenceField('Weight reading exactly as displayed, e.g. "240g".'),
    },
  },
  required: [
    'brand_name',
    'country_of_origin',
    'size',
    'color',
    'material',
    'original_price',
    'category',
    'sub_category',
    'gender',
    'season',
    'weights',
  ],
};

export interface InlineImage {
  mimeType: string;
  /** Base64-encoded image bytes. */
  data: string;
}

/**
 * Sends all images in a single multimodal prompt so Gemini can correlate facts
 * across tags (brand on photo 1, composition on photo 2, price on photo 3).
 */
export async function extractApparelData(
  images: InlineImage[],
): Promise<GeminiRawExtraction> {
  if (images.length === 0) {
    throw new Error('At least one image is required for extraction.');
  }

  const started = Date.now();
  const response = await withModelRetry(
    (model) =>
      getClient().models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          ...images.map((image) => ({
            inlineData: { mimeType: image.mimeType, data: image.data },
          })),
          {
            text:
              'Extract the structured apparel record from these images. ' +
              'Report every visible scale reading in the weights array.',
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: EXTRACTION_SCHEMA,
      temperature: 0,
    },
      }),
    activeVisionModel(),
    'Vision extraction',
  );

  const text = response.text;
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  logger.debug(`Gemini vision call completed in ${Date.now() - started} ms`);

  try {
    return JSON.parse(text) as GeminiRawExtraction;
  } catch {
    throw new Error(`Gemini returned malformed JSON: ${text.slice(0, 300)}`);
  }
}

/**
 * Studio re-render of the key product photo. Returns raw image bytes, or null
 * when the model declined to produce an image part.
 */
export async function renderStudioImage(
  image: InlineImage,
  prompt: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const response = await withModelRetry(
    (model) =>
      getClient().models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: image.mimeType, data: image.data } },
              { text: prompt },
            ],
          },
        ],
      }),
    activeImageModel(),
    'Studio render',
  );

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data) {
      return {
        buffer: Buffer.from(inline.data, 'base64'),
        mimeType: inline.mimeType ?? 'image/jpeg',
      };
    }
  }
  return null;
}
