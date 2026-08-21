import 'dotenv/config';

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

export const config = {
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? '',
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL ?? '',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'doubao-embedding-vision-251215',
  embeddingDim: positiveInteger('EMBEDDING_DIM', 2048),
} as const;
