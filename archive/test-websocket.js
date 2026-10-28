const WebSocket = require('ws');

console.log('Waiting for any call connection...');

// Connect to your WebSocket server without call ID first
const ws = new WebSocket('ws://localhost:9090/');

ws.on('open', () => {
  console.log('Connected to WebSocket server');

  // Send some test audio data (16-bit PCM, 8kHz)
  // This would normally be real audio from a microphone
  const testAudio = Buffer.alloc(160); // 20ms of silence

  // Send audio frames
  setInterval(() => {
    ws.send(testAudio);
  }, 20); // Send every 20ms (50fps)
});

ws.on('message', (data) => {
  console.log('Received audio response:', data.length, 'bytes');
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});
