import Fastify from 'fastify';
import * as dotenv from 'dotenv';
import fastifyMetrics from 'fastify-metrics';
import { Counter } from 'prom-client';
import crypto from 'crypto';
import { GuardRailProcessor } from './core.js';

dotenv.config();

const fastify = Fastify({ logger: true });

// --- Instantiate the Core Module ---
const processor = new GuardRailProcessor({
  privacyEngineUrl: process.env.PRIVACY_ENGINE_URL || 'http://privacy-engine:8000',
  qdrantUrl: process.env.QDRANT_URL || 'http://qdrant:6333',
  databaseUrl: process.env.DATABASE_URL!,
  openaiApiKey: process.env.OPENAI_API_KEY,
  mockLlm: process.env.MOCK_LLM === 'true',
  cacheEnabled: process.env.CACHE_ENABLED === 'true',
});

// Metrics Integration (Gateway specific)
const cacheHitCounter = new Counter({
  name: 'semantic_cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['endpoint']
});

fastify.register(fastifyMetrics as any, { endpoint: '/metrics' });

// --- API Routes ---

fastify.get('/health', async () => {
  return { status: 'ALIVE', mode: 'HYBRID-GATEWAY', version: '6.0.0-MODULAR' };
});

fastify.post('/v1/chat/completions', async (request, reply) => {
  const traceId = (request.headers['x-trace-id'] as string) || crypto.randomUUID();
  const body: any = request.body;

  // 1. Module-based Authentication
  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey) return reply.status(401).send({ error: 'API Key missing' });
  
  const isValid = await processor.validateKey(apiKey);
  if (!isValid) return reply.status(403).send({ error: 'Invalid API Key' });

  // 2. Core Processing (The "Module" call)
  const result = await processor.processChat(body, traceId);

  // Update Gateway Metrics
  if (result.cached) cacheHitCounter.inc({ endpoint: '/v1/chat/completions' });

  return reply
    .status(result.statusCode)
    .header('X-Trace-ID', result.traceId)
    .send(result.responseData);
});

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Modular Gateway running on ${port}`);
  } catch (err) {
    process.exit(1);
  }
};

start();
