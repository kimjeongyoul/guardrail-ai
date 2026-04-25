import Fastify from 'fastify';
import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenv.config();
const fastify = Fastify({
    logger: true
});
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const PRIVACY_ENGINE_URL = process.env.PRIVACY_ENGINE_URL || 'http://localhost:8000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Health Check
fastify.get('/health', async () => {
    return { status: 'OK', service: 'Gateway Core', version: '1.0.0' };
});
// Privacy Engine Integration
const checkPrivacy = async (content) => {
    try {
        const response = await fetch(`${PRIVACY_ENGINE_URL}/mask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: content })
        });
        if (!response.ok) {
            throw new Error(`Privacy Engine error: ${response.statusText}`);
        }
        const data = await response.json();
        return {
            masked: data.masked,
            itemsFound: data.items_found || 0
        };
    }
    catch (err) {
        fastify.log.error({ err }, 'Privacy check failed, falling back to original content');
        return { masked: content, itemsFound: 0 };
    }
};
// LLM Proxy Route (OpenAI Style)
fastify.post('/v1/chat/completions', async (request, reply) => {
    const startTime = Date.now();
    const body = request.body;
    let totalItemsMasked = 0;
    if (!OPENAI_API_KEY) {
        reply.status(500).send({ error: 'OpenAI API Key not configured' });
        return;
    }
    // 1. Privacy Check (Masking)
    if (body.messages && Array.isArray(body.messages)) {
        fastify.log.info('Applying Privacy Shield to incoming messages...');
        for (const msg of body.messages) {
            if (msg.content && typeof msg.content === 'string') {
                const result = await checkPrivacy(msg.content);
                msg.content = result.masked;
                totalItemsMasked += result.itemsFound;
            }
        }
    }
    // 2. Forward to OpenAI
    try {
        fastify.log.info('Forwarding masked request to OpenAI...');
        const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify(body)
        });
        const data = await openAiResponse.json();
        const duration = Date.now() - startTime;
        // 3. Asynchronous Audit Logging (Background)
        const maskedPrompt = JSON.stringify(body.messages);
        prisma.auditLog.create({
            data: {
                endpoint: '/v1/chat/completions',
                masked_prompt: maskedPrompt,
                items_masked: totalItemsMasked,
                provider: 'openai',
                model: body.model || 'unknown',
                latency_ms: duration,
                status_code: openAiResponse.status,
            }
        }).catch(err => fastify.log.error({ err }, 'Failed to save audit log'));
        return reply.status(openAiResponse.status).send(data);
    }
    catch (err) {
        fastify.log.error({ err }, 'Failed to proxy request to OpenAI');
        return reply.status(500).send({ error: 'Failed to reach LLM provider' });
    }
});
const start = async () => {
    try {
        await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
        console.log(`Gateway Core is running on http://localhost:${PORT}`);
    }
    catch (err) {
        fastify.log.error({ err }, 'Failed to start Gateway Core');
        process.exit(1);
    }
};
start();
//# sourceMappingURL=index.js.map