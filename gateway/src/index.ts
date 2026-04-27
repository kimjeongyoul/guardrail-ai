import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import fastifyMetrics from 'fastify-metrics';
import { Counter, Histogram } from 'prom-client';
import crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

// Ensure DATABASE_URL is present before anything else
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is missing from environment.');
  process.exit(1);
}

const fastify = Fastify({ logger: true });

/**
 * [PRISMA 7 ULTIMATE FIX]
 * Using Zero-Option constructor. Prisma 7 is extremely sensitive to constructor objects.
 * It will automatically use the DATABASE_URL from process.env.
 */
const prisma = new PrismaClient();

const piiDetectedCounter = new Counter({
  name: 'pii_entities_detected_total',
  help: 'Total PII masked',
  labelNames: ['endpoint']
});

const cacheHitCounter = new Counter({
  name: 'semantic_cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['endpoint']
});

const llmLatencyHistogram = new Histogram({
  name: 'llm_request_duration_ms',
  help: 'LLM latency',
  labelNames: ['provider', 'model', 'status_code'],
  buckets: [100, 500, 1000, 2000, 5000, 10000]
});

fastify.register(fastifyMetrics, { endpoint: '/metrics' });

const PORT = process.env.PORT || 3000;
const PRIVACY_ENGINE_URL = process.env.PRIVACY_ENGINE_URL || 'http://localhost:8000';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MOCK_LLM = process.env.MOCK_LLM === 'true';
const CACHE_ENABLED = process.env.CACHE_ENABLED === 'true';

// --- Helpers ---
const getEmbedding = async (text: string) => {
  try {
    const res = await fetch(`${PRIVACY_ENGINE_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data: any = await res.json();
    return data.embedding || [];
  } catch (err) { return []; }
};

const searchCache = async (vector: number[]) => {
  if (!CACHE_ENABLED || vector.length === 0) return null;
  try {
    const res = await fetch(`${QDRANT_URL}/collections/semantic_cache/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, limit: 1, with_payload: true, score_threshold: 0.90 })
    });
    const data: any = await res.json();
    if (data.result?.length > 0) return data.result[0].payload.response;
  } catch (err) {}
  return null;
};

const saveCache = async (vector: number[], prompt: string, response: any) => {
  if (!CACHE_ENABLED || vector.length === 0) return;
  try {
    await fetch(`${QDRANT_URL}/collections/semantic_cache/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [{ id: crypto.randomUUID(), vector, payload: { prompt, response } }]
      })
    });
  } catch (err) {}
};

// --- Routes ---
fastify.get('/health', async () => {
  let dbStatus = 'UNKNOWN';
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'CONNECTED_AND_STABLE';
  } catch (e) {
    dbStatus = `ERROR: ${e.message}`;
  }
  return { 
    status: 'ALIVE', 
    version: '1.9.9-ULTIMATE',
    database_check: dbStatus,
    infra: { privacy_engine: PRIVACY_ENGINE_URL, qdrant: QDRANT_URL }
  };
});

const checkPrivacy = async (content: string) => {
  try {
    const response = await fetch(`${PRIVACY_ENGINE_URL}/mask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content })
    });
    const data: any = await response.json();
    return { masked: data.masked, itemsFound: data.items_found || 0 };
  } catch (err) { return { masked: content, itemsFound: 0 }; }
};

fastify.post('/v1/chat/completions', {
  preHandler: async (request, reply) => {
    const apiKey = request.headers['x-api-key'] as string;
    if (!apiKey) return reply.status(401).send({ error: 'Key missing' });
    try {
      const keyRecord = await prisma.apiKey.findUnique({ where: { key: apiKey } });
      if (!keyRecord || !keyRecord.isActive) return reply.status(403).send({ error: 'Invalid Key' });
    } catch (err) { return reply.status(500).send({ error: 'Auth failed' }); }
  }
}, async (request, reply) => {
  const startTime = Date.now();
  const body: any = request.body;
  const userPrompt = body.messages?.find((m: any) => m.role === 'user')?.content || '';
  let promptVector: number[] = [];

  if (CACHE_ENABLED && userPrompt) {
    promptVector = await getEmbedding(userPrompt);
    const cachedResponse = await searchCache(promptVector);
    if (cachedResponse) {
      cacheHitCounter.inc({ endpoint: '/v1/chat/completions' });
      return reply.status(200).send(cachedResponse);
    }
  }

  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.content) {
        const result = await checkPrivacy(msg.content);
        msg.content = result.masked;
      }
    }
  }

  try {
    let responseData: any;
    let statusCode: number;
    if (MOCK_LLM) {
      responseData = { choices: [{ message: { role: 'assistant', content: 'ULTIMATE STABLE MOCK.' } }] };
      statusCode = 200;
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify(body)
      });
      responseData = await res.json();
      statusCode = res.status;
    }

    const duration = Date.now() - startTime;
    if (CACHE_ENABLED && statusCode === 200 && promptVector.length > 0) {
      saveCache(promptVector, userPrompt, responseData).catch(() => {});
    }

    llmLatencyHistogram.observe({ provider: MOCK_LLM ? 'mock' : 'openai', model: body.model || 'unknown', status_code: statusCode }, duration);
    
    // Non-blocking Audit Logging
    prisma.auditLog.create({
      data: {
        endpoint: '/v1/chat/completions',
        masked_prompt: JSON.stringify(body.messages),
        items_masked: 0,
        provider: MOCK_LLM ? 'mock' : 'openai',
        model: body.model || 'unknown',
        latency_ms: duration,
        status_code: statusCode,
      }
    }).catch(() => {});

    return reply.status(statusCode).send(responseData);
  } catch (err) { return reply.status(500).send({ error: 'Failed' }); }
});

const start = async () => {
  try {
    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`Gateway ULTIMATE on ${PORT}`);
    
    // Optional Seed with failure handling
    await prisma.apiKey.count().then(async count => {
      if (count === 0) {
        await prisma.apiKey.create({ data: { key: 'test-key-123', name: 'Default', owner_email: 'admin@ex.com' } });
      }
    }).catch(() => console.log('DB not ready for seeding yet.'));

    if (CACHE_ENABLED) {
      await fetch(`${QDRANT_URL}/collections/semantic_cache`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } })
      }).catch(() => {});
    }
  } catch (err) { process.exit(1); }
};
start();
