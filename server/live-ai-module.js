const path = require('path');
const ClaudeService = require('./services/claude-service');
const ElevenLabsSTT = require('./services/elevenlabs-stt');
const ElevenLabsTTS = require('./services/elevenlabs-tts');
const LessonCreatorAgent = require('./agents/lesson-creator-agent');
const FigmaLessonCreatorAgent = require('./agents/figma-lesson-creator-agent');
const logger = require('./utils/logger');

const TAG = 'LiveAI';
const MAX_CONTEXT_IMAGES = 10;

class LiveAIModule {
  constructor() {
    this.socket = null;
    this.config = null;

    // Services
    this.claude = null;
    this.stt = null;
    this.tts = null;
    this.lessonCreator = null;

    // Tool type
    this.toolType = null;

    // State
    this.lastUserInputAt = 0;
    this.lastAgentAudioSentAt = 0;
    this.isAgentCurrentlySpeaking = false;
    this.currentConversation = [];
    this.currentTutorial = null;
    this.currentStepIndex = 0;
    this.latestFrame = null;
    this.recurringCheckInterval = null;
    this.isRecurringCheckRunning = false;
    this.recurringCheckCancelled = false;
    this.isProcessing = false;
    this.interrupted = false;
    this.hasPendingUserMessage = false;

    // TTS sentence buffer
    this.sentenceBuffer = '';
  }

  initialize(socket) {
    this.socket = socket;

    // Create services (config + lessonCreator deferred to startSession)
    this.claude = new ClaudeService(process.env.ANTHROPIC_API_KEY);
    this.stt = new ElevenLabsSTT(process.env.ELEVENLABS_API_KEY);

    // Wire socket events
    socket.on('audio_data', (data) => this.handleUserAudio(data));
    socket.on('frame', (data) => this.handleFrame(data));
    socket.on('audio_playback_started', () => {
      logger.debug(TAG, 'Client: audio playback started');
    });
    socket.on('audio_playback_ended', () => this.onAudioPlaybackEnded());
    socket.on('start_session', (data) => this.startSession(data));

    // Wire STT events
    this.stt.on('partial_transcript', (text) => this.onPartialTranscript(text));
    this.stt.on('committed_transcript', (text) => this.onCommittedTranscript(text));

    logger.info(TAG, `Initialized for socket ${socket.id}`);
  }

  async startSession(data) {
    const isRestart = this.currentConversation.length > 0;
    logger.info(TAG, isRestart ? 'Restarting session (reconnect)...' : 'Starting session...');

    // Load tool-specific config on first start
    if (!isRestart) {
      this.toolType = data?.toolType || 'blender';
      this.config = require(`./agents/${this.toolType}-tutor.json`);
      this.lessonCreator = this.toolType === 'figma'
        ? new FigmaLessonCreatorAgent()
        : new LessonCreatorAgent();

      // Initialize TTS with the loaded voice config
      this.tts = new ElevenLabsTTS(
        process.env.ELEVENLABS_API_KEY,
        process.env.ELEVENLABS_VOICE_ID,
        this.config.voice
      );
      this.tts.on('audio_chunk', (base64) => this.onTTSAudioChunk(base64));
      this.tts.on('generation_complete', () => {
        logger.debug(TAG, 'TTS generation complete');
      });

      logger.info(TAG, `Tool type: ${this.toolType}`);
    }

    // Connect STT (idempotent — reconnects if already closed)
    if (!this.stt.connected) {
      this.stt.connect();
    }

    if (!isRestart) {
      // First time: send initial greeting
      this.currentConversation.push({
        role: 'user',
        content: '[SESSION_START]'
      });

      await this.sendToClaudeAndSpeak();

      // Start recurring check
      this.startRecurringCheck();
    }

    this.socket.emit('session_started');
    logger.info(TAG, 'Session started');
  }

  handleUserAudio(data) {
    this.stt.sendAudio(data);
  }

  handleFrame(data) {
    this.frameCount = (this.frameCount || 0) + 1;
    this.latestFrame = data;
    if (this.frameCount <= 3 || this.frameCount % 30 === 0) {
      logger.debug(TAG, `Frame #${this.frameCount} received (${(data.length / 1024).toFixed(0)}KB)`);
    }
  }

  onPartialTranscript(text) {
    if (!text.trim()) return;

    // Interrupt as soon as the first word is detected — covers active speech,
    // gaps between TTS chunks while Claude is still streaming, and recurring checks
    if (this.isAgentCurrentlySpeaking || this.isProcessing || this.isRecurringCheckRunning) {
      logger.info(TAG, `Interruption detected: "${text.substring(0, 50)}"`);
      this.handleInterruption();
      return;
    }
  }

  async onCommittedTranscript(text) {
    if (!text.trim()) return;

    logger.info(TAG, `User: "${text}"`);
    this.lastUserInputAt = Date.now();

    // If conversation ends with a user message (previous response was interrupted
    // before assistant message was pushed), insert a placeholder to maintain
    // proper user/assistant alternation required by Claude API
    const lastMsg = this.currentConversation[this.currentConversation.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      this.currentConversation.push({
        role: 'assistant',
        content: '[Response interrupted by user]'
      });
    }

    this.currentConversation.push({ role: 'user', content: this.buildUserContent(text) });
    this.socket.emit('user_text', text);

    // Always interrupt current output — user input takes priority.
    // This covers regular responses, recurring checks, and stale client audio.
    this.handleInterruption();

    if (this.isProcessing) {
      logger.info(TAG, 'Queuing user message (processing still winding down)');
      this.hasPendingUserMessage = true;
      return;
    }

    await this.sendToClaudeAndSpeak();
  }

  async sendToClaudeAndSpeak(isContinuation = false) {
    if (this.isProcessing) {
      logger.debug(TAG, 'Already processing, skipping');
      return;
    }
    this.isProcessing = true;
    this.interrupted = false;

    try {
      this.sanitizeConversation();
      const systemPrompt = this.buildSystemPrompt();
      this.pruneOldImages();

      // Reset sentence buffer
      this.sentenceBuffer = '';
      let fullText = '';

      const response = await this.claude.getStreamingResponse(
        systemPrompt,
        this.currentConversation,
        this.config.tools,
        [],
        (chunk) => {
          if (this.interrupted) return;
          fullText += chunk;
          this.handleTextChunkForTTS(chunk);
        }
      );

      // If interrupted during streaming, discard the stale response
      if (this.interrupted) {
        logger.info(TAG, 'Interrupted — discarding stale response');
        return;
      }

      // Flush remaining sentence buffer to TTS
      if (this.sentenceBuffer.trim()) {
        await this.tts.sendTextChunk(this.sentenceBuffer + ' ');
        this.sentenceBuffer = '';
      }
      await this.tts.flush();
      await this.tts.closeStream();

      // Add assistant message to conversation
      if (fullText) {
        this.socket.emit(isContinuation ? 'agent_text_continue' : 'agent_text', fullText);
      }
      this.currentConversation.push({
        role: 'assistant',
        content: response.content
      });

      // Handle tool calls (keeping isProcessing=true throughout)
      const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');

      if (toolUseBlocks.length > 0) {
        // Process all tool calls and collect results
        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          if (this.interrupted) {
            logger.info(TAG, 'Interrupted during tool processing — skipping remaining tools');
            break;
          }
          logger.info(TAG, `Tool: ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 80)})`);
          const result = await this.handleToolCall(toolUse.name, toolUse.input, toolUse.id);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
        }

        if (!this.interrupted) {
          // Add ALL tool results in a single user message (required by Claude API)
          this.currentConversation.push({
            role: 'user',
            content: toolResults
          });

          // Recurse with isProcessing still true — release it only at the end
          this.isProcessing = false;
          await this.sendToClaudeAndSpeak(true);
          return; // isProcessing managed by recursive call
        }
        // If interrupted, fall through to finally block.
        // sanitizeConversation() will clean up the orphaned tool_use on next call.
      }
    } catch (err) {
      if (this.interrupted) {
        logger.info(TAG, 'Stream aborted due to interruption');
      } else {
        logger.error(TAG, 'sendToClaudeAndSpeak error:', err.message);
      }
    } finally {
      this.isProcessing = false;

      // If a user message arrived during processing, handle it now
      if (this.hasPendingUserMessage) {
        this.hasPendingUserMessage = false;
        logger.info(TAG, 'Processing queued user message');
        await this.sendToClaudeAndSpeak();
      }
    }
  }

  handleTextChunkForTTS(chunk) {
    if (this.interrupted) return;

    this.sentenceBuffer += chunk;

    const sentenceEnd = /[.!?]\s/;
    let match;
    while ((match = sentenceEnd.exec(this.sentenceBuffer))) {
      if (this.interrupted) break;
      const sentence = this.sentenceBuffer.substring(0, match.index + match[0].length);
      this.tts.sendTextChunk(sentence);
      this.sentenceBuffer = this.sentenceBuffer.substring(match.index + match[0].length);
    }
  }

  handleInterruption() {
    logger.info(TAG, 'Interrupting');
    this.interrupted = true;
    this.recurringCheckCancelled = true;
    this.claude.abortStream();
    this.tts.interrupt();
    this.socket.emit('interrupt');
    this.isAgentCurrentlySpeaking = false;
  }

  buildUserContent(text) {
    if (!this.latestFrame) return text;
    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: this.latestFrame
        }
      },
      { type: 'text', text }
    ];
  }

  pruneOldImages() {
    const imageIndices = [];
    for (let i = 0; i < this.currentConversation.length; i++) {
      const msg = this.currentConversation[i];
      if (!Array.isArray(msg.content)) continue;
      if (msg.content.some(b => b.type === 'image')) {
        imageIndices.push(i);
      }
    }

    if (imageIndices.length <= MAX_CONTEXT_IMAGES) return;

    const toStrip = imageIndices.slice(0, imageIndices.length - MAX_CONTEXT_IMAGES);
    for (const idx of toStrip) {
      const msg = this.currentConversation[idx];
      const textBlocks = msg.content.filter(b => b.type !== 'image');
      if (textBlocks.length === 1 && textBlocks[0].type === 'text') {
        msg.content = textBlocks[0].text;
      } else {
        msg.content = textBlocks;
      }
    }

    logger.debug(TAG, `Pruned images from ${toStrip.length} older messages (keeping last ${MAX_CONTEXT_IMAGES})`);
  }

  onTTSAudioChunk(base64) {
    if (this.interrupted) return;  // discard stale audio from previous response
    this.socket.volatile.emit('agent_audio', base64);
    this.lastAgentAudioSentAt = Date.now();
    this.isAgentCurrentlySpeaking = true;
  }

  onAudioPlaybackEnded() {
    logger.debug(TAG, 'Playback ended');
    this.isAgentCurrentlySpeaking = false;
  }

  async handleToolCall(name, args, id) {
    switch (name) {
      case 'Create_Tutorial':
        return this.handleCreateTutorial(args);
      case 'Progressed_Step':
        return this.handleProgressedStep(args);
      case 'Suggested_HotKey':
        return this.handleSuggestedHotKey(args);
      default:
        logger.warn(TAG, `Unknown tool: ${name}`);
        return { error: `Unknown tool: ${name}` };
    }
  }

  async handleCreateTutorial({ object_label, proficiency }) {
    logger.info(TAG, `Creating tutorial: "${object_label}" (${proficiency})`);
    this.socket.emit('tutorial_loading', { objectLabel: object_label });

    try {
      const tutorial = await this.lessonCreator.generate(object_label, proficiency);
      this.currentTutorial = tutorial;
      this.currentStepIndex = 0;

      this.socket.emit('tutorial_ready', tutorial);
      logger.info(TAG, `Tutorial ready: ${tutorial.totalSteps} steps`);

      return {
        success: true,
        message: `Tutorial is ready! Announce it to the user enthusiastically. Tell them you'll be building a ${tutorial.objectLabel} in ${tutorial.totalSteps} steps, and ask if they're ready to start.`,
        objectLabel: tutorial.objectLabel,
        totalSteps: tutorial.totalSteps,
        steps: tutorial.steps.map(s => ({
          stepNumber: s.stepNumber,
          title: s.title,
          instruction: s.instruction
        }))
      };
    } catch (err) {
      logger.error(TAG, 'Tutorial generation failed:', err.message);
      this.socket.emit('tutorial_error', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  handleProgressedStep({ previous_step, current_step }) {
    logger.info(TAG, `Step: ${previous_step} -> ${current_step}`);
    this.currentStepIndex = current_step - 1;

    this.socket.emit('step_update', {
      previousStep: previous_step,
      currentStep: current_step,
      totalSteps: this.currentTutorial?.totalSteps || 0
    });

    const step = this.currentTutorial?.steps?.[this.currentStepIndex];
    return {
      success: true,
      currentStep: current_step,
      stepTitle: step?.title || 'Unknown',
      stepInstruction: step?.instruction || ''
    };
  }

  handleSuggestedHotKey({ key_combo, description }) {
    logger.info(TAG, `Hotkey: ${key_combo} - ${description}`);
    this.socket.emit('hotkey_display', { keyCombo: key_combo, description });
    return { displayed: true };
  }

  buildSystemPrompt() {
    let prompt = this.config.systemPrompt;

    if (this.currentTutorial) {
      const step = this.currentTutorial.steps[this.currentStepIndex];
      prompt += `\n\n--- CURRENT TUTORIAL ---\nObject: ${this.currentTutorial.objectLabel}\nCurrent Step: ${this.currentStepIndex + 1} of ${this.currentTutorial.totalSteps}\nStep Title: ${step?.title || 'N/A'}\nStep Instructions: ${step?.instruction || 'N/A'}\n--- END TUTORIAL ---`;
    }

    return prompt;
  }

  /**
   * Fix orphaned tool_use blocks in conversation history. When a response is
   * interrupted mid-tool-call, the assistant message may contain tool_use blocks
   * without matching tool_result in the next user message. This strips the
   * tool_use blocks (keeping any text) to prevent Claude API 400 errors.
   */
  sanitizeConversation() {
    for (let i = this.currentConversation.length - 1; i >= 0; i--) {
      const msg = this.currentConversation[i];
      if (msg.role !== 'assistant') continue;

      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const hasToolUse = blocks.some(b => b.type === 'tool_use');
      if (!hasToolUse) continue;

      // Check if the next message has matching tool_results
      const next = this.currentConversation[i + 1];
      if (next && next.role === 'user') {
        const nextBlocks = Array.isArray(next.content) ? next.content : [];
        if (nextBlocks.some(b => b.type === 'tool_result')) continue; // Valid pair
      }

      // Orphaned tool_use — strip tool_use blocks, keep only text
      const textBlocks = blocks.filter(b => b.type === 'text');
      if (textBlocks.length > 0 && textBlocks.some(b => b.text?.trim())) {
        msg.content = textBlocks.length === 1 ? textBlocks[0].text : textBlocks;
      } else {
        msg.content = '[Response interrupted by user]';
      }
      logger.warn(TAG, `Sanitize: stripped orphaned tool_use from message at index ${i}`);
    }
  }

  startRecurringCheck() {
    if (!this.config.recurringCheck?.enabled) return;

    const intervalMs = this.config.recurringCheck.intervalMs || 3000;
    const idleThresholdMs = this.config.recurringCheck.idleThresholdMs || 10000;

    logger.info(TAG, `Recurring check: every ${intervalMs}ms, idle ${idleThresholdMs}ms`);

    this.recurringCheckInterval = setInterval(async () => {
      if (this.isRecurringCheckRunning) return;
      if (this.isAgentCurrentlySpeaking) return;
      if (this.isProcessing) return;
      if (Date.now() - this.lastUserInputAt < idleThresholdMs) return;
      if (!this.latestFrame) return;

      this.isRecurringCheckRunning = true;
      this.recurringCheckCancelled = false;
      this.isProcessing = true;

      try {
        const screenLabel = this.toolType === 'figma' ? 'Figma canvas' : 'Blender screen';
        let checkPrompt = `[RECURRING_SCREEN_CHECK] Look at the user's current ${screenLabel}. If they seem stuck or could use a tip, provide brief guidance. If everything looks fine, respond with exactly: [NO_GUIDANCE_NEEDED]`;

        if (this.currentTutorial) {
          const step = this.currentTutorial.steps[this.currentStepIndex];
          checkPrompt += `\nCurrent step ${this.currentStepIndex + 1}: ${step?.title}`;
        }

        const userContent = this.buildUserContent(checkPrompt);
        this.sanitizeConversation();
        this.pruneOldImages();
        const checkMessages = [
          ...this.currentConversation,
          { role: 'user', content: userContent }
        ];

        const response = await this.claude.getResponse(
          this.buildSystemPrompt(),
          checkMessages,
          this.config.tools,
          []
        );

        // User spoke while we were waiting for Claude — discard this response
        if (this.recurringCheckCancelled) {
          logger.info(TAG, 'Recurring check cancelled — discarding response');
          return;
        }

        const messagesToCommit = [{ role: 'user', content: userContent }];
        let currentResponse = response;
        let isFirstText = true;
        const MAX_TOOL_ROUNDS = 3;

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          if (this.recurringCheckCancelled) {
            logger.info(TAG, 'Recurring check cancelled — discarding');
            return;
          }

          const text = currentResponse.content.find(c => c.type === 'text')?.text || '';
          const toolUseBlocks = currentResponse.content.filter(c => c.type === 'tool_use');

          if (text.includes('[NO_GUIDANCE_NEEDED]')) {
            logger.debug(TAG, 'Recurring: no guidance needed');
            return;
          }

          messagesToCommit.push({ role: 'assistant', content: currentResponse.content });

          if (text) {
            logger.info(TAG, `Recurring guidance: "${text.substring(0, 80)}..."`);
            this.socket.emit(isFirstText ? 'agent_text' : 'agent_text_continue', text);
            await this.tts.sendText(text);
            isFirstText = false;

            if (this.recurringCheckCancelled) {
              logger.info(TAG, 'Recurring check cancelled after TTS — discarding');
              return;
            }
          }

          // No tools — done
          if (toolUseBlocks.length === 0) break;

          // Process tool calls
          const toolResults = [];
          for (const toolUse of toolUseBlocks) {
            if (this.recurringCheckCancelled) {
              logger.info(TAG, 'Recurring check cancelled during tool processing — discarding');
              return;
            }
            logger.info(TAG, `Recurring tool: ${toolUse.name}`);
            const result = await this.handleToolCall(toolUse.name, toolUse.input, toolUse.id);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(result)
            });
          }
          messagesToCommit.push({ role: 'user', content: toolResults });

          // Last round — don't follow up
          if (round === MAX_TOOL_ROUNDS) break;

          if (this.recurringCheckCancelled) {
            logger.info(TAG, 'Recurring check cancelled before follow-up — discarding');
            return;
          }

          // Follow-up call to get continuation after tool results
          const allMessages = [...this.currentConversation, ...messagesToCommit];
          currentResponse = await this.claude.getResponse(
            this.buildSystemPrompt(),
            allMessages,
            this.config.tools,
            []
          );
        }

        // Final cancellation check before atomic commit
        if (this.recurringCheckCancelled) {
          logger.info(TAG, 'Recurring check cancelled before commit — discarding');
          return;
        }

        // Atomic commit — all messages pushed together, or none at all
        for (const msg of messagesToCommit) {
          this.currentConversation.push(msg);
        }
      } catch (err) {
        if (!this.recurringCheckCancelled) {
          logger.error(TAG, 'Recurring check error:', err.message);
        }
      } finally {
        this.isRecurringCheckRunning = false;
        this.recurringCheckCancelled = false;
        this.isProcessing = false;

        // If user spoke during this check, process their message now
        if (this.hasPendingUserMessage) {
          this.hasPendingUserMessage = false;
          logger.info(TAG, 'Processing queued user message after recurring check');
          await this.sendToClaudeAndSpeak();
        }
      }
    }, intervalMs);
  }

  destroy() {
    logger.info(TAG, 'Destroying module');

    if (this.recurringCheckInterval) {
      clearInterval(this.recurringCheckInterval);
      this.recurringCheckInterval = null;
    }

    this.stt.disconnect();
    if (this.tts) this.tts.disconnect();

    this.socket = null;
  }
}

module.exports = LiveAIModule;
