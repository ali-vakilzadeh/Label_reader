import { GoogleGenAI, Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { GeminiRawExtraction } from '../types';

/**
 * Gemini access layer. The API key lives only in server process.env and never
 * reaches a device — this module is the single egress point to Google.
 */

let client: GoogleGenAI | null = null;

export function getClient(): GoogleGenAI {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured on this server.');
  }
  if (!client) client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

export function isGeminiReady(): boolean {
  return Boolean(env.geminiApiKey);
}

export const SYSTEM_INSTRUCTION = [
  'Analyze apparel label and scale display images.',
  'Extract brand_name, country_of_origin, size, material, and original_price.',
  'Read weights from scale displays into an array.',
  'Infer dominant color from [black, white, blue, red, orange, yellow, brown, green, gray],',
  'category from [shoe, clothing, accessories],',
  'sub_category from [shirt, pants, all-body, coat, jacket, pullover, scarf, shorts, underwear, cap, hat, shawl, sunglasses, others],',
  'gender from [male, female, unisex, kids-boy, kids-girl, newborn],',
  'and season from [spring, summer, fall, winter, all-seasons].',
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
    brand_name: confidenceField('Brand or designer name printed on the label.'),
    country_of_origin: confidenceField('Country of manufacture, e.g. "Vietnam".'),
    size: confidenceField('Size as printed, e.g. "XL", "EU 42", "32W x 34L".'),
    color: confidenceField('Dominant color, one of the allowed color keys.'),
    material: confidenceField('Fabric composition, e.g. "100% Polyester".'),
    original_price: confidenceField('Retail price including currency symbol.'),
    category: confidenceField('One of: shoe, clothing, accessories.'),
    sub_category: confidenceField('Garment type key.'),
    gender: confidenceField('One of: male, female, unisex, kids-boy, kids-girl, newborn.'),
    season: confidenceField('One of: spring, summer, fall, winter, all-seasons.'),
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
  const response = await getClient().models.generateContent({
    model: env.geminiVisionModel,
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
  });

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
  const response = await getClient().models.generateContent({
    model: env.geminiImageModel,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: image.mimeType, data: image.data } },
          { text: prompt },
        ],
      },
    ],
  });

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
