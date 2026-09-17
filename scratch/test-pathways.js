const { LEMANS_SYSTEM_PROMPT } = require('../dist/voice/lemans-knowledge');
const https = require('https');
const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

async function askChloe(messages) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LEMANS_SYSTEM_PROMPT },
      ...messages
    ],
    temperature: 0.7
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.choices[0].message.content);
        } catch (e) {
          reject(new Error(data));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runPathwayTests() {
  console.log("=== Testing Client Specific Pathways ===\n");

  // Test 1: Kids birthday party inquiry
  console.log("--- Test 1: Kids Birthday Party ---");
  const r1 = await askChloe([
    { role: 'user', content: "I'd like to know more about having a kid's birthday party with you." }
  ]);
  console.log(`Chloe: ${r1}\n`);

  // Test 2: Pricing inquiry on birthday party
  console.log("--- Test 2: Kids Party Pricing ---");
  const r2 = await askChloe([
    { role: 'user', content: "I'd like to know more about having a kid's birthday party with you." },
    { role: 'assistant', content: r1 },
    { role: 'user', content: "How much is it per kid?" }
  ]);
  console.log(`Chloe: ${r2}\n`);

  // Test 3: Corporate Event (over 40)
  console.log("--- Test 3: Corporate Event (> 40 people) ---");
  const r3_1 = await askChloe([
    { role: 'user', content: "Hi Chloe, we're looking to plan a corporate event for our company." }
  ]);
  console.log(`Chloe: ${r3_1}\n`);

  const r3_2 = await askChloe([
    { role: 'user', content: "Hi Chloe, we're looking to plan a corporate event for our company." },
    { role: 'assistant', content: r3_1 },
    { role: 'user', content: "We'll have around 60 people coming." }
  ]);
  console.log(`Chloe: ${r3_2}\n`);

  // Test 4: Corporate Event (<= 40)
  console.log("--- Test 4: Corporate Event (<= 40 people) ---");
  const r4 = await askChloe([
    { role: 'user', content: "Hi Chloe, we're looking to plan a corporate event for about 25 people." }
  ]);
  console.log(`Chloe: ${r4}\n`);
}

runPathwayTests();
