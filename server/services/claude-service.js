const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const TAG = 'Claude';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

class ClaudeService {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.currentStream = null;
  }

  buildMessages(conversation, images = []) {
    if (!images.length) return conversation;

    // Clone messages and inject images into the last user message that has text content.
    // Skip tool_result messages — they have no text to pair with images.
    const messages = JSON.parse(JSON.stringify(conversation));

    let targetIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;

      // String content is always text
      if (typeof msg.content === 'string' && msg.content.trim()) {
        targetIdx = i;
        break;
      }

      // Array content — check for a non-empty text block (skip tool_result-only messages)
      if (Array.isArray(msg.content)) {
        const hasText = msg.content.some(b => b.type === 'text' && b.text?.trim());
        if (hasText) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx === -1) return messages;

    const target = messages[targetIdx];
    const textContent = typeof target.content === 'string'
      ? target.content
      : target.content.filter(c => c.type === 'text').map(c => c.text).join('');

    const content = [];
    for (const img of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType || 'image/jpeg',
          data: img.data
        }
      });
    }
    content.push({ type: 'text', text: textContent });

    messages[targetIdx] = { role: 'user', content };
    return messages;
  }

  async getResponse(systemPrompt, messages, tools = [], images = []) {
    const builtMessages = this.buildMessages(messages, images);

    logger.debug(TAG, `Non-streaming request (${builtMessages.length} messages, ${tools.length} tools, ${images.length} images)`);

    const params = {
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: builtMessages
    };
    if (tools.length) params.tools = tools;

    const response = await this.client.messages.create(params);

    logger.debug(TAG, `Response: ${response.content.length} blocks, stop_reason=${response.stop_reason}`);
    return response;
  }

  async getStreamingResponse(systemPrompt, messages, tools = [], images = [], onTextChunk) {
    const builtMessages = this.buildMessages(messages, images);

    logger.debug(TAG, `Streaming request (${builtMessages.length} messages, ${tools.length} tools, ${images.length} images)`);

    const params = {
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: builtMessages
    };
    if (tools.length) params.tools = tools;

    this.currentStream = this.client.messages.stream(params);

    this.currentStream.on('text', (text) => {
      if (onTextChunk) onTextChunk(text);
    });

    try {
      const finalMessage = await this.currentStream.finalMessage();
      logger.debug(TAG, `Streaming complete: ${finalMessage.content.length} blocks, stop_reason=${finalMessage.stop_reason}`);
      return finalMessage;
    } finally {
      this.currentStream = null;
    }
  }

  abortStream() {
    if (this.currentStream) {
      logger.info(TAG, 'Aborting active stream');
      this.currentStream.abort();
      this.currentStream = null;
    }
  }
}

module.exports = ClaudeService;
