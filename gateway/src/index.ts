import Fastify from 'fastify';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import fastifyMetrics from 'fastify-metrics';
import { Counter, Histogram } from 'prom-client';
import crypto from 'crypto';

dotenv.config();

const fastify = Fastify({
  logger: true
});

// --- Custom Metrics ---
const piiDetectedCounter = new Counter({
  name: 'pii_entities_detected_total',
  help: 'Total number of PII entities detected and masked',
  labelNames: ['endpoint']
});

const cacheHitCounter = new Counter({
  name: 'semantic_cache_hits_total',
  help: 'Total number of semantic cache hits',
  labelNames: ['endpoint']
});

const llmLatencyHistogram = new Histogram({
  name: 'llm_request_duration_ms',
  help: 'Latency of LLM provider requests in milliseconds',
  labelNames: ['provider', 'model', 'status_code'],
  buckets: [100, 500, 1000, 2000, 5000, 10000]
});

// Register Metrics Plugin
fastify.register(fastifyMetrics, { endpoint: '/metrics' });

const PORT = process.env.PORT || 3000;
const PRIVACY_ENGINE_URL = process.env.PRIVACY_ENGINE_URL || 'http://localhost:8000';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MOCK_LLM = process.env.MOCK_LLM === 'true';
const CACHE_ENABLED = process.env.CACHE_ENABLED === 'true';

// --- Semantic Cache Helpers ---

const getEmbedding = async (text: string): Promise<number[]> => {
  try {
    const res = await fetch(`${PRIVACY_ENGINE_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('Embedding service error');
    const data: any = await res.json();
    return data.embedding;
  } catch (err) {
    console.error('Embedding failed:', err);
    return [];
  }
};

const searchCache = async (vector: number[]): Promise<any | null> => {
  if (!CACHE_ENABLED || vector.length === 0) return null;
  try {
    const res = await fetch(`${QDRANT_URL}/collections/semantic_cache/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit: 1,
        with_payload: true,
        score_threshold: 0.90
      })
    });
    const data: any = await res.json();
    if (data.result && data.result.length > 0) {
      return data.result[0].payload.response;
    }
  } catch (err) {
    console.error('Cache search failed:', err);
  }
  return null;
};

const saveCache = async (vector: number[], prompt: string, response: any) => {
  if (!CACHE_ENABLED || vector.length === 0) return;
  try {
    await fetch(`${QDRANT_URL}/collections/semantic_cache/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [{
          id: crypto.randomUUID(),
          vector,
          payload: { prompt, response }
        }]
      })
    });
  } catch (err) {
    console.error('Cache save failed:', err);
  }
};

// Health Check
fastify.get('/health', async () => {
  return { status: 'OK', service: 'Gateway Core', version: '1.0.0' };
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
  } catch (err) {
    return { masked: content, itemsFound: 0 };
  }
};

// LLM Proxy Route
fastify.post('/v1/chat/completions', async (request, reply) => {
  const startTime = Date.now();
  const body: any = request.body;
  let totalItemsMasked = 0;

  // Temporary Bypass Auth for Demo
  const userPrompt = body.messages?.find((m: any) => m.role === 'user')?.content || '';
  let promptVector: number[] = [];
  
  if (CACHE_ENABLED && userPrompt) {
    promptVector = await getEmbedding(userPrompt);
    const cached = await searchCache(promptVector);
    if (cached) {
      cacheHitCounter.inc({ endpoint: '/v1/chat/completions' });
      return reply.status(200).send(cached);
    }
  }
  
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.content && typeof msg.content === 'string') {
        const result = await checkPrivacy(msg.content);
        msg.content = result.masked;
        totalItemsMasked += result.itemsFound;
      }
    }
  }

  try {
    let responseData: any;
    let statusCode: number;

    if (MOCK_LLM) {
      responseData = {
        id: 'mock-123',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'mock-gpt-3.5',
        choices: [{ message: { role: 'assistant', content: 'Mock response.' }, finish_reason: 'stop' }]
      };
      statusCode = 200;
    } else {
      const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify(body)
      });
      responseData = await openAiResponse.json();
      statusCode = openAiResponse.status;
    }

    const duration = Date.now() - startTime;
    if (CACHE_ENABLED && statusCode === 200 && promptVector.length > 0) {
      saveCache(promptVector, userPrompt, responseData).catch(() => {});
    }

    if (totalItemsMasked > 0) piiDetectedCounter.inc({ endpoint: '/v1/chat/completions' }, totalItemsMasked);
    llmLatencyHistogram.observe({ provider: MOCK_LLM ? 'mock' : 'openai', model: body.model || 'unknown', status_code: statusCode }, duration);

    return reply.status(statusCode).send(responseData);
  } catch (err) {
    return reply.status(500).send({ error: 'LLM failed' });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`Gateway running on ${PORT}`);

    if (CACHE_ENABLED) {
      await fetch(`${QDRANT_URL}/collections/semantic_cache`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } })
      }).catch(() => {});
    }
  } catch (err) {
    process.exit(1);
  }
};

start();
