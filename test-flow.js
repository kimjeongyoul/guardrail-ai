// Modern test script using native fetch
async function runTest() {
  const BASE_URL = 'http://localhost:3002';
  const API_KEY = 'test-key-123';

  console.log("=== 🔍 Step 1: Health Check ===");
  try {
    const health = await fetch(`${BASE_URL}/health`).then(r => r.json());
    console.log("Gateway Status:", health.status);
  } catch (e) {
    console.error("Gateway is not reachable. Is it running?");
    return;
  }

  const payload = {
    model: "gpt-3.5-turbo",
    messages: [
      { role: "user", content: "Tell me a short joke about AI." }
    ]
  };

  console.log("\n=== 🛡️ Step 2: First Request (Cache Miss) ===");
  const start1 = Date.now();
  const res1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(payload)
  });
  const data1 = await res1.json();
  console.log("Response 1:", data1.choices[0].message.content);
  console.log("Time taken:", Date.now() - start1, "ms");

  console.log("\n=== ⚡ Step 3: Second Request (Semantic Cache Hit) ===");
  const start2 = Date.now();
  const res2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(payload)
  });
  const data2 = await res2.json();
  console.log("Response 2 (Cached):", data2.choices[0].message.content);
  console.log("Time taken:", Date.now() - start2, "ms (Should be significantly faster)");

  console.log("\n=== 📊 Step 4: Metrics Verification ===");
  const metrics = await fetch(`${BASE_URL}/metrics`).then(r => r.text());
  const cacheHitMetric = metrics.split('\n').find(line => line.includes('semantic_cache_hits_total'));
  
  console.log("Cache Hit Metric:", cacheHitMetric || "0 (Expected 1)");

  console.log("\n✅ Semantic Cache Test Completed.");
}

runTest();
