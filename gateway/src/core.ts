import crypto from 'crypto';
import pg from 'pg';

export interface GuardRailConfig {
  privacyEngineUrl: string;
  qdrantUrl: string;
  databaseUrl: string;
  openaiApiKey?: string;
  mockLlm?: boolean;
  cacheEnabled?: boolean;
}

export interface ProcessResult {
  responseData: any;
  statusCode: number;
  traceId: string;
  cached: boolean;
}

export class GuardRailProcessor {
  private config: GuardRailConfig;
  private pool: pg.Pool;

  constructor(config: GuardRailConfig) {
    this.config = config;
    this.pool = new pg.Pool({ connectionString: config.databaseUrl });
  }

  // --- Internal Helpers ---

  private async getEmbedding(text: string, traceId: string): Promise<number[]> {
    try {
      const res = await fetch(`${this.config.privacyEngineUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-ID': traceId },
        body: JSON.stringify({ text })
      });
      const data: any = await res.json();
      return data.embedding || [];
    } catch (err) { return []; }
  }

  private async checkPrivacy(content: string, traceId: string) {
    try {
      const response = await fetch(`${this.config.privacyEngineUrl}/mask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-ID': traceId },
        body: JSON.stringify({ text: content })
      });
      const data: any = await response.json();
      return { masked: data.masked, itemsFound: data.items_found || 0 };
    } catch (err) { return { masked: content, itemsFound: 0 }; }
  }

  private async searchCache(vector: number[], traceId: string) {
    if (!this.config.cacheEnabled || vector.length === 0) return null;
    try {
      const res = await fetch(`${this.config.qdrantUrl}/collections/semantic_cache/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector, limit: 1, with_payload: true, score_threshold: 0.90 })
      });
      const data: any = await res.json();
      if (data.result?.length > 0) return data.result[0].payload.response;
    } catch (err) {}
    return null;
  }

  // --- Public API (The Module Interface) ---

  async processChat(body: any, traceId: string = crypto.randomUUID()): Promise<ProcessResult> {
    const startTime = Date.now();
    const userPrompt = body.messages?.find((m: any) => m.role === 'user')?.content || '';
    
    let promptVector: number[] = [];
    if (this.config.cacheEnabled && userPrompt) {
      promptVector = await this.getEmbedding(userPrompt, traceId);
      const cachedResponse = await this.searchCache(promptVector, traceId);
      if (cachedResponse) {
        return { responseData: cachedResponse, statusCode: 200, traceId, cached: true };
      }
    }

    let itemsMasked = 0;
    if (body.messages) {
      for (const msg of body.messages) {
        if (msg.content) {
          const result = await this.checkPrivacy(msg.content, traceId);
          msg.content = result.masked;
          itemsMasked += result.itemsFound;
        }
      }
    }

    let responseData: any;
    let statusCode: number;
    
    if (this.config.mockLlm) {
      responseData = { choices: [{ message: { role: 'assistant', content: 'HYBRID MODULE MOCK.' } }] };
      statusCode = 200;
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${this.config.openaiApiKey}` 
        },
        body: JSON.stringify(body)
      });
      responseData = await res.json();
      statusCode = res.status;
    }

    const duration = Date.now() - startTime;

    const auditQuery = `
      INSERT INTO "AuditLog" (id, trace_id, endpoint, masked_prompt, items_masked, provider, model, latency_ms, status_code)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `;
    this.pool.query(auditQuery, [
      crypto.randomUUID(), traceId, '/v1/chat/completions', JSON.stringify(body.messages), 
      itemsMasked, this.config.mockLlm ? 'mock' : 'openai', body.model || 'unknown', duration, statusCode
    ]).catch(() => {});

    return { responseData, statusCode, traceId, cached: false };
  }

  async validateKey(key: string): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT * FROM "ApiKey" WHERE key = $1 AND "isActive" = true', [key]);
      return res.rows.length > 0;
    } catch (e) { return true; }
  }
}
