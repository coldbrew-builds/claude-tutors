const EventEmitter = require('events');
const WebSocket = require('ws');
const logger = require('../utils/logger');

const TAG = 'TTS';

class ElevenLabsTTS extends EventEmitter {
  constructor(apiKey, voiceId, voiceSettings = {}) {
    super();
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.voiceSettings = {
      stability: voiceSettings.stability ?? 0.5,
      similarity_boost: voiceSettings.similarity ?? 0.75
    };
    this.ws = null;
    this.connected = false;
    this.connecting = false;
  }

  async connect() {
    if (this.ws && this.connected) return;
    if (this.connecting) {
      await this._waitForConnection();
      return;
    }

    this.connecting = true;

    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000`;

    logger.info(TAG, 'Connecting to ElevenLabs TTS...');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { 'xi-api-key': this.apiKey }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this.connecting = false;
        logger.info(TAG, 'Connected');

        // Send init message with voice settings
        this.ws.send(JSON.stringify({
          text: ' ',
          voice_settings: this.voiceSettings,
          generation_config: { chunk_length_schedule: [50, 120, 160, 250] }
        }));

        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.audio) {
            logger.debug(TAG, 'Audio chunk received');
            this.emit('audio_chunk', msg.audio);
          }

          if (msg.isFinal) {
            logger.debug(TAG, 'Generation complete');
            this.emit('generation_complete');
          }
        } catch (err) {
          logger.error(TAG, 'Failed to parse message:', err.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this.connecting = false;
        this.ws = null;
        logger.info(TAG, `Disconnected (${code}: ${reason || 'no reason'})`);
      });

      this.ws.on('error', (err) => {
        this.connected = false;
        this.connecting = false;
        logger.error(TAG, 'WebSocket error:', err.message);
        reject(err);
      });
    });
  }

  _waitForConnection() {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.connected) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      // Timeout after 10s
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 10000);
    });
  }

  async sendText(text) {
    await this._ensureConnected();
    if (!this.ws || !this.connected) return;

    logger.debug(TAG, `Sending text (${text.length} chars)`);

    try {
      // Send text with trailing space and flush to force immediate generation
      this.ws.send(JSON.stringify({ text: text + ' ', flush: true }));
    } catch (err) {
      logger.error(TAG, 'Failed to send text:', err.message);
    }
  }

  async sendTextChunk(chunk) {
    await this._ensureConnected();
    if (!this.ws || !this.connected) return;

    logger.debug(TAG, `Sending chunk: "${chunk.substring(0, 50)}..."`);

    try {
      this.ws.send(JSON.stringify({ text: chunk }));
    } catch (err) {
      logger.error(TAG, 'Failed to send chunk:', err.message);
    }
  }

  async flush() {
    if (!this.ws || !this.connected) return;

    logger.debug(TAG, 'Flushing');
    try {
      // flush: true forces generation of any buffered text
      this.ws.send(JSON.stringify({ text: ' ', flush: true }));
    } catch (err) {
      logger.error(TAG, 'Failed to flush:', err.message);
    }
  }

  async closeStream() {
    if (!this.ws || !this.connected) return;

    logger.debug(TAG, 'Closing stream (EOS)');
    try {
      // Empty string signals end of stream
      this.ws.send(JSON.stringify({ text: '' }));
    } catch (err) {
      logger.error(TAG, 'Failed to close stream:', err.message);
    }
  }

  interrupt() {
    logger.info(TAG, 'Interrupting - closing WebSocket');
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
      this.connected = false;
      this.connecting = false;
    }
  }

  async _ensureConnected() {
    if (!this.connected) {
      await this.connect();
    }
  }

  disconnect() {
    if (this.ws) {
      logger.info(TAG, 'Disconnecting...');
      this.ws.close();
      this.ws = null;
      this.connected = false;
      this.connecting = false;
    }
  }
}

module.exports = ElevenLabsTTS;
