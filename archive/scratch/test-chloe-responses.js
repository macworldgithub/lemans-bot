const { LEMANS_SYSTEM_PROMPT } = require('../dist/voice/lemans-knowledge');
const https = require('https');
const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

async function askChloe(question) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LEMANS_SYSTEM_PROMPT },
      { role: 'user', content: question }
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

async function runTests() {
  const testQuestions = [
    "Could I get some information about karting?",
    "Do you guys do any food?",
    "What are your business hours?",
    "Can my 6-year-old and 13-year-old both race?"
  ];

  console.log("Testing Chloe's knowledge responses...\n");
  for (const q of testQuestions) {
    console.log(`Q: "${q}"`);
    const ans = await askChloe(q);
    console.log(`A: ${ans}\n-----------------------------------`);
  }
}

runTests();
