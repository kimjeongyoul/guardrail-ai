import Fastify from 'fastify';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import fastifyMetrics from 'fastify-metrics';
import { Counter, Histogram } from 'prom-client';
import crypto from 'crypto';
import pg from 'pg';

dotenv.config();

const fastify = Fastify({ logger: true });

// --- Database Connection (Direct & Lightweight) ---
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- Custom Metrics ---
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

// --- API Routes ---

fastify.get('/health', async () => {
  let dbStatus = 'UP';
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
  } catch (e) { dbStatus = 'DOWN'; }
  
  return { 
    status: 'ALIVE', 
    version: '4.0.0-PG-DIRECT',
    database_check: dbStatus,
    infra: { privacy_engine: PRIVACY_ENGINE_URL, qdrant: QDRANT_URL }
  };
});

fastify.post('/v1/chat/completions', async (request, reply) => {
  const startTime = Date.now();
  const body: any = request.body;
  const userPrompt = body.messages?.find((m: any) => m.role === 'user')?.content || '';
  let promptVector: number[] = [];

  // 0. API Key Verification via Direct SQL
  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey) return reply.status(401).send({ error: 'API Key missing' });
  
  try {
    const res = await pool.query('SELECT * FROM "ApiKey" WHERE key = $1 AND "isActive" = true', [apiKey]);
    if (res.rows.length === 0) return reply.status(403).send({ error: 'Invalid API Key' });
  } catch (err) {
    console.error('Auth DB Error:', err);
    // Continue if DB is temporarily down to maintain service availability
  }

  // 1. Semantic Cache Lookup
  if (CACHE_ENABLED && userPrompt) {
    promptVector = await getEmbedding(userPrompt);
    const cachedResponse = await searchCache(promptVector);
    if (cachedResponse) {
      cacheHitCounter.inc({ endpoint: '/v1/chat/completions' });
      return reply.status(200).send(cachedResponse);
    }
  }

  // 2. Privacy Check
  let itemsMasked = 0;
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.content) {
        const result = await checkPrivacy(msg.content);
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
      responseData = { choices: [{ message: { role: 'assistant', content: 'DIRECT PG MOCK.' } }] };
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

    // 4. Save Cache
    if (CACHE_ENABLED && statusCode === 200 && promptVector.length > 0) {
      saveCache(promptVector, userPrompt, responseData).catch(() => {});
    }

    // 5. Metrics & Audit Logging via Direct SQL
    if (itemsMasked > 0) piiDetectedCounter.inc({ endpoint: '/v1/chat/completions' }, itemsMasked);
    llmLatencyHistogram.observe({ provider: MOCK_LLM ? 'mock' : 'openai', model: body.model || 'unknown', status_code: statusCode }, duration);

    // Persist to DB (Non-blocking)
    const auditQuery = `
      INSERT INTO "AuditLog" (id, endpoint, masked_prompt, items_masked, provider, model, latency_ms, status_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    const auditValues = [
      crypto.randomUUID(),
      '/v1/chat/completions',
      JSON.stringify(body.messages),
      itemsMasked,
      MOCK_LLM ? 'mock' : 'openai',
      body.model || 'unknown',
      duration,
      statusCode
    ];
    pool.query(auditQuery, auditValues).catch(err => console.error('Audit Log DB Error:', err));

    return reply.status(statusCode).send(responseData);
  } catch (err) { return reply.status(500).send({ error: 'LLM failed' }); }
});

const start = async () => {
  try {
    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`Gateway DIRECT-PG on ${PORT}`);

    // Seed Key if DB is empty (Direct SQL)
    try {
      const checkKey = await pool.query('SELECT count(*) FROM "ApiKey"');
      if (parseInt(checkKey.rows[0].count) === 0) {
        await pool.query('INSERT INTO "ApiKey" (id, key, name, owner_email) VALUES ($1, $2, $3, $4)', 
                         [crypto.randomUUID(), 'test-key-123', 'Default', 'admin@ex.com']);
        console.log('🔑 [SEED] Default API Key created via SQL.');
      }
    } catch (e) { console.warn('Seeding skipped (DB may not be ready)'); }

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
