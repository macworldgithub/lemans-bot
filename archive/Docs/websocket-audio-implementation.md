# WebSocket Audio Streaming Implementation for Asterisk ARI

## Overview

This document describes the implementation of WebSocket-based audio streaming for handling Asterisk calls through ARI (Asterisk REST Interface). The implementation extends the existing ARI service to use WebSocket externalMedia instead of RTP for audio transport.

## Architecture Changes

### Before (RTP-based)
```
Asterisk -> RTP UDP -> NestJS RTP Service -> AI Service -> RTP UDP -> Asterisk
```

### After (WebSocket-based)
```
Asterisk -> WebSocket -> NestJS WebSocket Gateway -> AI Service -> WebSocket -> Asterisk
```

## Files Modified/Created

### New Files
1. **`src/ari/ari-websocket.gateway.ts`** - WebSocket gateway for handling Asterisk externalMedia audio streaming

### Modified Files
1. **`src/ari/ari.service.ts`** - Extended to support WebSocket externalMedia
2. **`src/ari/ari.module.ts`** - Added WebSocket gateway to providers

## Key Features

### WebSocket Gateway (`AriWebSocketGateway`)
- **Port**: 9090 (configurable via `WEBSOCKET_PORT`)
- **Audio Format**: 8kHz, 16-bit signed PCM mono (slin)
- **Connection Management**: Maps WebSocket connections to call IDs
- **Error Handling**: Robust error handling with automatic cleanup
- **Health Monitoring**: Provides health status for monitoring

### Enhanced ARI Service (`AriService`)
- **Dual Mode Support**: Supports both WebSocket (primary) and RTP (fallback)
- **Audio Conversion**: Automatic conversion between slin and ulaw formats
- **Call Flow**: StasisStart -> bridge -> WebSocket externalMedia -> AI -> hangup
- **Cleanup**: Proper cleanup of both WebSocket and RTP resources

## Configuration

### Environment Variables

```dotenv
# Existing ARI Configuration
ASTERISK_ARI_URL=http://127.0.0.1:8088
ASTERISK_ARI_APP=ai-bridge
ASTERISK_ARI_USERNAME=ariuser
ASTERISK_ARI_PASSWORD=aripass
ASTERISK_ARI_AUTO_CONNECT=true

# New WebSocket Configuration
WEBSOCKET_PORT=9090

# Existing RTP Configuration (kept for compatibility)
ASTERISK_EXTERNAL_MEDIA_HOST=127.0.0.1:6000
ASTERISK_EXTERNAL_MEDIA_BIND_HOST=0.0.0.0
ASTERISK_EXTERNAL_MEDIA_BIND_PORT=6000

# AI Configuration
OPENAI_API_KEY=your-openai-api-key
OPENAI_REALTIME_MODEL=gpt-4o-mini-realtime-preview
```

## Call Flow

### 1. Incoming Call
1. Asterisk receives call and sends it to Stasis app "ai-bridge"
2. `AriService` receives `StasisStart` event
3. Service logs channel ID and caller ID

### 2. Bridge Setup
1. Answer the channel
2. Create mixing bridge (`bridge-{callId}`)
3. Add inbound channel to bridge

### 3. WebSocket External Media
1. Create externalMedia channel with WebSocket transport:
   ```
   POST /channels/externalMedia
   {
     app: "ai-bridge",
     channelId: "extmedia-{callId}",
     external_host: "ws://localhost:9090/?callId={callId}",
     format: "slin",
     direction: "both",
     transport: "wss"
   }
   ```
2. Add externalMedia channel to bridge
3. Asterisk connects to WebSocket gateway

### 4. Audio Processing
1. **Inbound Audio**: Asterisk sends slin audio via WebSocket
2. **Conversion**: slin → ulaw for OpenAI Realtime API
3. **AI Processing**: OpenAI processes audio and generates response
4. **Outbound Audio**: ulaw → slin conversion, sent back via WebSocket

### 5. Call Termination
1. AI indicates conversation complete
2. Service hangs up inbound channel
3. WebSocket connection closed
4. Bridge destroyed
5. Resources cleaned up

## Audio Format Conversion

### WebSocket (slin) ↔ OpenAI (ulaw)
```typescript
// slin to ulaw (16-bit PCM → 8-bit u-law)
slinBuffer (2 bytes per sample) → ulawBuffer (1 byte per sample)

// ulaw to slin (8-bit u-law → 16-bit PCM)
ulawBuffer (1 byte per sample) → slinBuffer (2 bytes per sample)
```

## Error Handling

### Connection Errors
- WebSocket connection failures are logged
- Automatic cleanup of partial connections
- Fallback to RTP if WebSocket fails (for compatibility)

### Audio Processing Errors
- Processing errors are logged with context
- Repeated failures trigger connection cleanup
- Graceful degradation to maintain service stability

### ARI Connection Errors
- Exponential backoff reconnection logic
- Health check endpoint for monitoring
- Automatic recovery from temporary failures

## Testing Instructions

### Prerequisites
1. Asterisk server with ARI enabled
2. ARI user with permissions for Stasis app "ai-bridge"
3. NestJS application running with updated configuration

### Test Call Origination

#### Using Asterisk CLI
```bash
# Originate a test call to the Stasis app
channel originate local/100@default application stasis ai-bridge

# Or originate from a real channel
channel originate SIP/provider/5551234@context application stasis ai-bridge
```

#### Using ARI curl command
```bash
curl -X POST "http://127.0.0.1:8088/ari/channels" \
  -u ariuser:aripass \
  -d "endpoint=local/100@default" \
  -d "app=ai-bridge" \
  -d "appArgs=optional-args"
```

### Monitoring

#### Health Check
```bash
curl http://localhost:3000/ari/health
```

Expected response:
```json
{
  "status": "connected",
  "app": "ai-bridge",
  "ariUrl": "http://127.0.0.1:8088",
  "activeSessions": 1,
  "rtp": {
    "listening": true,
    "bindHost": "0.0.0.0",
    "bindPort": 6000,
    "activeRtpSessions": 0
  },
  "websocket": {
    "listening": true,
    "port": 9090,
    "activeConnections": 1,
    "activeCalls": 1
  },
  "lastEventAt": "2024-01-01T12:00:00.000Z",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

#### Log Monitoring
```bash
# Watch for WebSocket connection logs
tail -f logs/application.log | grep "WebSocket"

# Watch for ARI events
tail -f logs/application.log | grep "StasisStart"

# Watch for audio processing
tail -f logs/application.log | grep "audio"
```

### Expected Log Sequence
1. `WebSocket server listening on port 9090`
2. `ARI event socket connected`
3. `StasisStart received. channel=... caller=...`
4. `Created WebSocket externalMedia channel for call=...`
5. `WebSocket connected for call=...`
6. `ARI bridge ready. call=...`
7. `AI Realtime connected for call=...`
8. Audio processing logs during conversation
9. `Cleaning up ARI session for call=...`

## Troubleshooting

### Common Issues

#### WebSocket Connection Fails
- Check if port 9090 is available
- Verify firewall settings
- Check WebSocket URL format in externalMedia creation

#### Audio Not Flowing
- Verify audio format conversion (slin ↔ ulaw)
- Check OpenAI API key and model configuration
- Monitor for audio processing errors in logs

#### ARI Connection Issues
- Verify ARI credentials and permissions
- Check Asterisk ARI configuration
- Ensure Stasis app "ai-bridge" is properly configured

#### Call Drops Immediately
- Check for missing environment variables
- Verify OpenAI API connectivity
- Monitor for early cleanup in logs

### Debug Mode
Enable debug logging by updating the logger level:
```typescript
private readonly logger = new Logger(AriService.name, true);
```

## Performance Considerations

### Resource Usage
- Each call maintains one WebSocket connection
- Audio conversion is CPU-intensive but optimized
- Memory usage scales with active calls

### Scaling
- WebSocket gateway can handle multiple concurrent calls
- Consider load balancing for high-volume scenarios
- Monitor WebSocket connection limits

## Security Considerations

### WebSocket Security
- Localhost connections only (default configuration)
- No authentication required for local Asterisk connections
- Consider adding authentication for remote deployments

### ARI Security
- Use strong passwords for ARI users
- Limit ARI user permissions to required operations
- Consider HTTPS for ARI connections in production

## Migration Notes

### From RTP to WebSocket
- Existing RTP functionality preserved for compatibility
- Gradual migration possible by enabling WebSocket per-call
- Monitor both RTP and WebSocket metrics during transition

### Backward Compatibility
- RTP service remains functional
- Existing configuration variables respected
- Graceful fallback to RTP if WebSocket fails

## Future Enhancements

### Potential Improvements
1. **WebSocket Security**: Add WSS support for secure connections
2. **Audio Codecs**: Support for additional audio formats
3. **Load Balancing**: Multiple WebSocket gateway instances
4. **Metrics**: Detailed performance metrics and monitoring
5. **Testing**: Automated integration tests

### API Extensions
1. **Dynamic Configuration**: Runtime configuration changes
2. **Call Control**: Additional call manipulation features
3. **Audio Processing**: On-the-fly audio effects and processing
4. **Integration**: Third-party AI service integrations

## Conclusion

This implementation provides a robust, scalable WebSocket-based audio streaming solution for Asterisk ARI integration. The architecture maintains backward compatibility while offering improved reliability and performance for real-time audio processing applications.
