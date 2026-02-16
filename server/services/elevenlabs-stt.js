const EventEmitter = require('events');
const WebSocket = require('ws');
const logger = require('../utils/logger');

const TAG = 'STT';

class ElevenLabsSTT extends EventEmitter {
  constructor(apiKey) {
    super();
    this.apiKey = apiKey;
    this.ws = null;
    this.connected = false;
    this.shouldReconnect = false;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.ws) {
      logger.debug(TAG, 'Already connected, skipping');
      return;
    }

    this.shouldReconnect = true;

    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    url.searchParams.set('model_id', 'scribe_v2_realtime');
    url.searchParams.set('language_code', 'en');
    url.searchParams.set('audio_format', 'pcm_16000');
    url.searchParams.set('commit_strategy', 'vad');
    url.searchParams.set('vad_silence_threshold_secs', '0.5');

    logger.info(TAG, 'Connecting...');

    this.ws = new WebSocket(url.toString(), {
      headers: { 'xi-api-key': this.apiKey }
    });

    this.ws.on('open', () => {
      this.connected = true;
      logger.info(TAG, 'Connected');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.message_type) {
          case 'session_started':
            logger.info(TAG, `Session started: ${msg.session_id}`);
            break;
          case 'partial_transcript':
            if (msg.text) {
              this.emit('partial_transcript', msg.text);
            }
            break;
          case 'committed_transcript':
            if (msg.text) {
              logger.info(TAG, `Committed: "${msg.text}"`);
              this.emit('committed_transcript', msg.text);
            }
            break;
          case 'session_time_limit_exceeded':
            logger.warn(TAG, 'Session time limit exceeded - will reconnect');
            break;
          case 'error':
          case 'auth_error':
          case 'quota_exceeded':
          case 'input_error':
            logger.error(TAG, `API error (${msg.message_type}): ${msg.error || JSON.stringify(msg)}`);
            break;
          default:
            logger.debug(TAG, `Message: ${msg.message_type}`);
        }
      } catch (err) {
        logger.error(TAG, 'Failed to parse message:', err.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this.ws = null;
      logger.info(TAG, `Disconnected (${code}: ${reason || 'no reason'})`);

      // Auto-reconnect if we didn't explicitly disconnect
      if (this.shouldReconnect) {
        logger.info(TAG, 'Auto-reconnecting in 1s...');
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, 1000);
      }
    });

    this.ws.on('error', (err) => {
      logger.error(TAG, 'WebSocket error:', err.message);
    });
  }

  sendAudio(base64Audio) {
    if (!this.ws || !this.connected) return;

    try {
      this.ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64Audio
      }));
    } catch (err) {
      logger.error(TAG, 'Failed to send audio:', err.message);
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      logger.info(TAG, 'Disconnecting...');
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }
}

module.exports = ElevenLabsSTT;
