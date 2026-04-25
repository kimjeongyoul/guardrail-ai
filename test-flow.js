const fetch = require('node-fetch');

async function runTest() {
  const payload = {
    messages: [
      { role: "user", content: "My email is john.doe@example.com and my phone is 555-1234. Please help me." }
    ]
  };

  console.log("Sending request to Gateway...");
  try {
    const response = await fetch('http://localhost:3000/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("Response received:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Test failed (make sure services are running):", err.message);
  }
}

runTest();
