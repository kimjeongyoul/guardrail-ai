import Fastify from 'fastify';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import fastifyMetrics from 'fastify-metrics';
import { Counter, Histogram } from 'prom-client';
import crypto from 'crypto';
import pg from 'pg';

dotenv.config();

const fastify = Fastify({ logger: true });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// --- Metrics ---
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
const PRIVACY_ENGINE_URL = process.env.PRIVACY_ENGINE_URL || 'http://privacy-engine:8000';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MOCK_LLM = process.env.MOCK_LLM === 'true';
const CACHE_ENABLED = process.env.CACHE_ENABLED === 'true';

// --- Helpers with Trace Correlation ---

const getEmbedding = async (text: string, traceId: string) => {
  try {
    const res = await fetch(`${PRIVACY_ENGINE_URL}/embed`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Trace-ID': traceId
      },
      body: JSON.stringify({ text })
    });
    const data: any = await res.json();
    return data.embedding || [];
  } catch (err) {
    fastify.log.error({ trace_id: traceId, err }, 'Embedding correlation failed');
    return [];
  }
};

const checkPrivacy = async (content: string, traceId: string) => {
  try {
    const response = await fetch(`${PRIVACY_ENGINE_URL}/mask`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Trace-ID': traceId
      },
      body: JSON.stringify({ text: content })
    });
    const data: any = await response.json();
    return { masked: data.masked, itemsFound: data.items_found || 0 };
  } catch (err) {
    fastify.log.error({ trace_id: traceId, err }, 'Privacy correlation failed');
    return { masked: content, itemsFound: 0 };
  }
};

const searchCache = async (vector: number[], traceId: string) => {
  if (!CACHE_ENABLED || vector.length === 0) return null;
  try {
    const res = await fetch(`${QDRANT_URL}/collections/semantic_cache/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, limit: 1, with_payload: true, score_threshold: 0.90 })
    });
    const data: any = await res.json();
    if (data.result?.length > 0) {
      fastify.log.info({ trace_id: traceId }, 'Semantic cache correlation: HIT');
      return data.result[0].payload.response;
    }
  } catch (err) {
    fastify.log.error({ trace_id: traceId, err }, 'Cache search correlation failed');
  }
  return null;
};

// --- API Routes ---

fastify.get('/health', async () => {
  return { status: 'ALIVE', version: '5.0.0-OBSERVABILITY-INTEGRATED' };
});

fastify.post('/v1/chat/completions', async (request, reply) => {
  const startTime = Date.now();
  const traceId = (request.headers['x-trace-id'] as string) || crypto.randomUUID();
  const body: any = request.body;
  const userPrompt = body.messages?.find((m: any) => m.role === 'user')?.content || '';
  
  fastify.log.info({ trace_id: traceId, method: 'POST', url: '/v1/chat/completions' }, 'Incoming request initiated');

  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey) {
    fastify.log.warn({ trace_id: traceId }, 'Missing API Key');
    return reply.status(401).send({ error: 'API Key missing' });
  }

  // 1. Semantic Cache with Correlation
  let promptVector: number[] = [];
  if (CACHE_ENABLED && userPrompt) {
    promptVector = await getEmbedding(userPrompt, traceId);
    const cachedResponse = await searchCache(promptVector, traceId);
    if (cachedResponse) {
      cacheHitCounter.inc({ endpoint: '/v1/chat/completions' });
      return reply.status(200).header('X-Trace-ID', traceId).send(cachedResponse);
    }
  }

  // 2. Privacy Shield with Correlation
  let itemsMasked = 0;
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.content) {
        const result = await checkPrivacy(msg.content, traceId);
        msg.content = result.masked;
        itemsMasked += result.itemsFound;
      }
    }
  }

  // 3. LLM Request
  try {
    let responseData: any;
    let statusCode: number;
    if (MOCK_LLM) {
      responseData = { choices: [{ message: { role: 'assistant', content: 'CORRELATED MOCK.' } }] };
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
    llmLatencyHistogram.observe({ provider: MOCK_LLM ? 'mock' : 'openai', model: body.model || 'unknown', status_code: statusCode }, duration);

    // 4. Correlated Audit Logging (DB)
    const auditQuery = `
      INSERT INTO "AuditLog" (id, trace_id, endpoint, masked_prompt, items_masked, provider, model, latency_ms, status_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    pool.query(auditQuery, [
      crypto.randomUUID(), traceId, '/v1/chat/completions', JSON.stringify(body.messages), 
      itemsMasked, MOCK_LLM ? 'mock' : 'openai', body.model || 'unknown', duration, statusCode
    ]).catch(err => fastify.log.error({ trace_id: traceId, err }, 'Audit DB Save failed'));

    fastify.log.info({ trace_id: traceId, duration_ms: duration, status: statusCode }, 'Request completed');
    
    return reply.status(statusCode).header('X-Trace-ID', traceId).send(responseData);
  } catch (err) {
    fastify.log.error({ trace_id: traceId, err }, 'Fatal proxy error');
    return reply.status(500).send({ error: 'LLM failed' });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`Gateway OBSERVABILITY-READY on ${PORT}`);
    
    // Auto-migrate schema (Simple way for demo)
    await pool.query('ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "trace_id" TEXT').catch(() => {});
    
  } catch (err) { process.exit(1); }
};
start();
