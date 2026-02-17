const socket = io({
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 20
});

marked.setOptions({ breaks: true, gfm: true });

// ---- Client Debug Logger ----

function dbg(category, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${category}]`, ...args);
}

// Catch unhandled errors that might cascade into socket drops
window.addEventListener('error', (e) => dbg('ERROR', `Uncaught: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => dbg('ERROR', `Unhandled rejection: ${e.reason}`));

// Tab visibility — critical for diagnosing display track drops
document.addEventListener('visibilitychange', () => {
  dbg('Visibility', `Tab ${document.visibilityState} (hidden=${document.hidden})`);
});

// Socket lifecycle logging
socket.on('connect', () => {
  dbg('Socket', `Connected (id=${socket.id}, transport=${socket.io.engine.transport.name})`);
  els.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Connected';
  els.connectionStatus.style.color = 'var(--success)';

  // If session was active before disconnect, re-establish it
  if (state.isSessionActive) {
    dbg('Socket', 'Re-establishing session after reconnect');
    socket.emit('start_session', { toolType: state.selectedTool || 'blender' });
    if (state.displayStream && state.displayStream.getVideoTracks()[0]?.readyState === 'live') {
      setupScreenCapture();
      els.screenIndicator.classList.remove('inactive');
      els.screenShareBanner.classList.add('hidden');
      els.screenPreviewContainer.classList.remove('hidden');
    }
  }
});

socket.on('disconnect', (reason) => {
  dbg('Socket', `Disconnected: "${reason}"`,
    `| wasActive=${state.isSessionActive}`,
    `| bufferedAmount=${socket.io?.engine?.transport?.ws?.bufferedAmount ?? '?'}`);
  els.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Disconnected';
  els.connectionStatus.style.color = 'var(--accent)';
});

socket.on('connect_error', (err) => dbg('Socket', 'Connect error:', err.message || err));
socket.io.on('error', (err) => dbg('Socket', 'Transport error:', err.message || err));
socket.io.on('reconnect', (attempt) => dbg('Socket', `Reconnected after ${attempt} attempt(s)`));
socket.io.on('reconnect_attempt', (attempt) => dbg('Socket', `Reconnect attempt #${attempt}`));
socket.io.on('reconnect_error', (err) => dbg('Socket', 'Reconnect error:', err.message || err));
socket.io.on('reconnect_failed', () => dbg('Socket', 'Reconnect FAILED - giving up'));

// Monitor WebSocket state periodically
setInterval(() => {
  if (!state.isSessionActive) return;
  const engine = socket.io?.engine;
  if (!engine) return;
  const ws = engine.transport?.ws;
  const screenTrack = state.displayStream?.getVideoTracks()[0];
  dbg('Health',
    `socket=${socket.connected ? 'up' : 'DOWN'}`,
    `| wsState=${ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] : 'none'}`,
    `| buffered=${ws?.bufferedAmount ?? '?'}`,
    `| mic=${state.mediaStream?.getAudioTracks()[0]?.readyState ?? 'none'}`,
    `| screen=${screenTrack?.readyState ?? 'none'}`,
    `| muted=${screenTrack?.muted ?? '?'}`,
    `| frames=${frameSentCount}/${frameSkipCount}`,
    `| audioQ=${state.audioQueue.length}`);
}, 10000);

// State
const state = {
  selectedTool: null,
  isSessionActive: false,
  mediaStream: null,
  displayStream: null,
  audioContext: null,
  audioQueue: [],
  isPlayingAudio: false,
  currentAudioSource: null,
  tutorial: null,
  currentStepIndex: 0,
  frameInterval: null,
  playbackContext: null
};

// Tool metadata for landing screen
const toolMeta = {
  blender: {
    title: 'Blender Coach',
    logo: 'assets/blender-icon.png',
    subtitle: 'Real-time AI-powered Blender 3D tutoring',
    description: 'Get voice-guided lessons, live screen analysis, and step-by-step tutorials for 3D modeling in Blender.'
  },
  figma: {
    title: 'Figma Coach',
    logo: 'assets/figma-icon.png',
    subtitle: 'Real-time AI-powered Figma design tutoring',
    description: 'Get voice-guided lessons, live screen analysis, and step-by-step tutorials for UI/UX design in Figma.'
  }
};

// DOM elements
const els = {
  homeScreen: document.getElementById('home-screen'),
  landingScreen: document.getElementById('landing-screen'),
  landingIcon: document.getElementById('landing-icon'),
  landingTitle: document.getElementById('landing-title'),
  landingSubtitle: document.getElementById('landing-subtitle'),
  landingDescription: document.getElementById('landing-description'),
  sessionScreen: document.getElementById('session-screen'),
  startBtn: document.getElementById('start-btn'),
  micIndicator: document.getElementById('mic-indicator'),
  screenIndicator: document.getElementById('screen-indicator'),
  connectionStatus: document.getElementById('connection-status'),
  screenShareBanner: document.getElementById('screen-share-banner'),
  shareScreenBtn: document.getElementById('share-screen-btn'),
  tutorialPanel: document.getElementById('tutorial-panel'),
  tutorialTitle: document.getElementById('tutorial-title'),
  referenceImageContainer: document.getElementById('reference-image-container'),
  referenceImage: document.getElementById('reference-image'),
  stepList: document.getElementById('step-list'),
  stepImageContainer: document.getElementById('step-image-container'),
  stepImage: document.getElementById('step-image'),
  stepInstructions: document.getElementById('step-instructions'),
  stepInstructionsText: document.getElementById('step-instructions-text'),
  transcript: document.getElementById('transcript'),
  hotkeyDisplay: document.getElementById('hotkey-display'),
  tutorialLoader: document.getElementById('tutorial-loader'),
  loaderLabel: document.getElementById('loader-label'),
  screenVideo: document.getElementById('screen-video'),
  screenCanvas: document.getElementById('screen-canvas'),
  noReferencePlaceholder: document.getElementById('no-reference-placeholder'),
  screenPreviewContainer: document.getElementById('screen-preview-container'),
  sourcePicker: document.getElementById('source-picker'),
  sourcePickerGrid: document.getElementById('source-picker-grid'),
  sourcePickerCancel: document.getElementById('source-picker-cancel')
};

// ---- Mic & Screen Toggle Buttons ----

els.micIndicator.addEventListener('click', () => {
  if (!state.mediaStream) return;
  const track = state.mediaStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  if (track.enabled) {
    els.micIndicator.classList.remove('inactive');
    dbg('Mic', 'Microphone enabled');
  } else {
    els.micIndicator.classList.add('inactive');
    dbg('Mic', 'Microphone muted');
  }
});

els.screenIndicator.addEventListener('click', async () => {
  if (state.displayStream) {
    // Stop screen sharing
    state.displayStream.getTracks().forEach(t => t.stop());
    state.displayStream = null;
    els.screenVideo.srcObject = null;
    els.screenIndicator.classList.add('inactive');
    els.screenPreviewContainer.classList.add('hidden');
    stopFrameCapture();
    dbg('Screen', 'Screen sharing stopped by user');
  } else {
    // Start screen sharing
    try {
      state.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false
      });
      els.screenIndicator.classList.remove('inactive');
      els.screenPreviewContainer.classList.remove('hidden');
      els.screenShareBanner.classList.add('hidden');
      els.screenVideo.srcObject = state.displayStream;
      els.screenVideo.muted = true;
      await els.screenVideo.play();

      const track = state.displayStream.getVideoTracks()[0];
      track.addEventListener('ended', () => {
        dbg('Screen', 'Display track ended');
        state.displayStream = null;
        els.screenVideo.srcObject = null;
        els.screenIndicator.classList.add('inactive');
        els.screenPreviewContainer.classList.add('hidden');
        stopFrameCapture();
      });

      setupScreenCapture();
      dbg('Screen', 'Screen sharing started by user');
    } catch (e) {
      dbg('Screen', 'Screen share declined:', e.message);
    }
  }
});

// ---- Back Navigation ----

document.getElementById('back-to-home').addEventListener('click', () => {
  els.landingScreen.classList.add('hidden');
  els.homeScreen.classList.remove('hidden');
  document.title = 'Claude Coach';
});

document.getElementById('back-to-landing').addEventListener('click', () => {
  // Tell server to tear down the session
  socket.emit('stop_session');

  // Stop any audio currently playing and clear the queue
  state.audioQueue = [];
  if (state.currentAudioSource) {
    try { state.currentAudioSource.stop(); } catch (e) { /* already stopped */ }
    state.currentAudioSource = null;
  }
  state.isPlayingAudio = false;

  // Close playback audio context
  if (state.playbackContext) {
    state.playbackContext.close();
    state.playbackContext = null;
  }

  // Stop active session resources
  if (state.displayStream) {
    state.displayStream.getTracks().forEach(t => t.stop());
    state.displayStream = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
  state.analyser = null;
  stopFrameCapture();

  // Reset session state
  state.isSessionActive = false;
  state.tutorial = null;
  state.currentStepIndex = 0;
  if (window.electronBridge) window.electronBridge.setSessionActive(false);

  // Reset UI
  els.sessionScreen.classList.add('hidden');
  els.landingScreen.classList.remove('hidden');
  els.tutorialPanel.classList.add('hidden');
  els.screenShareBanner.classList.add('hidden');
  els.screenPreviewContainer.classList.add('hidden');
  els.screenVideo.srcObject = null;
  els.transcript.innerHTML = '';
  els.stepList.innerHTML = '';
  els.stepInstructions.classList.add('hidden');
  els.stepImageContainer.classList.add('hidden');
  els.referenceImageContainer.classList.add('hidden');
  els.noReferencePlaceholder.classList.remove('hidden');
  els.tutorialLoader.classList.add('hidden');
  els.hotkeyDisplay.classList.add('hidden');
  els.micIndicator.classList.remove('inactive');
  els.screenIndicator.classList.add('inactive');
});

// ---- Tool Selection ----

document.querySelectorAll('.tool-tile[data-tool]').forEach(tile => {
  tile.addEventListener('click', () => {
    const tool = tile.dataset.tool;
    state.selectedTool = tool;

    const meta = toolMeta[tool];
    if (meta) {
      els.landingIcon.src = meta.logo;
      els.landingTitle.textContent = meta.title;
      els.landingSubtitle.textContent = meta.subtitle;
      els.landingDescription.textContent = meta.description;
      document.title = meta.title;
    }

    els.homeScreen.classList.add('hidden');
    els.landingScreen.classList.remove('hidden');
  });
});

// ---- Start Session ----

els.startBtn.addEventListener('click', startSession);

async function startSession() {
  try {
    dbg('Session', 'Starting...');

    // Request microphone
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    dbg('Session', 'Mic acquired');

    // Request screen share
    try {
      state.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false
      });
      dbg('Session', 'Screen share acquired');
      els.screenIndicator.classList.remove('inactive');
      els.screenPreviewContainer.classList.remove('hidden');

      // Attach to video element and play immediately so the browser
      // keeps the capture track alive (don't orphan the stream)
      els.screenVideo.srcObject = state.displayStream;
      els.screenVideo.muted = true;
      await els.screenVideo.play();
      dbg('Session', 'Screen video playing');

      const track = state.displayStream.getVideoTracks()[0];
      const settings = track.getSettings();
      dbg('Screen', `Track settings: ${settings.width}x${settings.height} @${settings.frameRate}fps, displaySurface=${settings.displaySurface}`);

      track.addEventListener('ended', () => {
        dbg('Screen', 'Display track ended');
        state.displayStream = null;
        els.screenVideo.srcObject = null;
        els.screenIndicator.classList.add('inactive');
        els.screenShareBanner.classList.remove('hidden');
        els.screenPreviewContainer.classList.add('hidden');
        stopFrameCapture();
      });
      track.addEventListener('mute', () => dbg('Screen', 'Track MUTED'));
      track.addEventListener('unmute', () => dbg('Screen', 'Track unmuted'));
    } catch (e) {
      dbg('Screen', 'Screen share declined:', e.message);
      els.screenShareBanner.classList.remove('hidden');
    }

    // Switch screens
    els.landingScreen.classList.add('hidden');
    els.sessionScreen.classList.remove('hidden');

    // Setup audio capture
    await setupAudioCapture();

    // Setup audio playback context
    state.playbackContext = new (window.AudioContext || window.webkitAudioContext)();

    // Start session on server
    socket.emit('start_session', { toolType: state.selectedTool || 'blender' });
    state.isSessionActive = true;
    if (window.electronBridge) window.electronBridge.setSessionActive(true);
    dbg('Session', `start_session emitted (toolType=${state.selectedTool})`);

    if (state.displayStream) {
      setupScreenCapture();
    }
  } catch (err) {
    dbg('Session', 'FAILED:', err.message);
    alert('Could not access microphone. Please grant permission and try again.');
  }
}

// Share screen button (for delayed share)
els.shareScreenBtn.addEventListener('click', async () => {
  try {
    state.displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false
    });
    els.screenIndicator.classList.remove('inactive');
    els.screenShareBanner.classList.add('hidden');
    els.screenPreviewContainer.classList.remove('hidden');
    els.screenVideo.srcObject = state.displayStream;
    els.screenVideo.muted = true;
    await els.screenVideo.play();

    const track = state.displayStream.getVideoTracks()[0];
    const settings = track.getSettings();
    dbg('Screen', `Track settings: ${settings.width}x${settings.height} @${settings.frameRate}fps, displaySurface=${settings.displaySurface}`);

    track.addEventListener('ended', () => {
      dbg('Screen', 'Display track ended');
      state.displayStream = null;
      els.screenVideo.srcObject = null;
      els.screenIndicator.classList.add('inactive');
      els.screenShareBanner.classList.remove('hidden');
      els.screenPreviewContainer.classList.add('hidden');
      stopFrameCapture();
    });
    track.addEventListener('mute', () => dbg('Screen', 'Track MUTED'));
    track.addEventListener('unmute', () => dbg('Screen', 'Track unmuted'));

    setupScreenCapture();
  } catch (e) {
    dbg('Screen', 'Screen share declined:', e.message);
  }
});

// ---- Audio Capture (Mic → Server via AudioWorklet) ----

async function setupAudioCapture() {
  state.audioContext = new AudioContext({ sampleRate: 16000 });
  const source = state.audioContext.createMediaStreamSource(state.mediaStream);

  // Create analyser for spectrogram visualization
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 256;
  state.analyser.smoothingTimeConstant = 0.7;
  source.connect(state.analyser);

  // AudioWorklet runs off the main thread
  await state.audioContext.audioWorklet.addModule('audio-processor.js');
  const workletNode = new AudioWorkletNode(state.audioContext, 'audio-processor');

  workletNode.port.onmessage = (e) => {
    if (!socket.connected) return;
    const base64 = arrayBufferToBase64(e.data);
    socket.emit('audio_data', base64);
  };

  source.connect(workletNode);
  workletNode.connect(state.audioContext.destination);

  // Start spectrogram render loop
  startMicVisualizer();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---- Screen Capture (Frames → Server) ----

let frameSentCount = 0;
let frameSkipCount = 0;

function captureAndSendFrame() {
  if (!state.displayStream) return false;

  const video = els.screenVideo;
  const track = state.displayStream.getVideoTracks()[0];

  if (!track || track.readyState !== 'live') {
    dbg('Screen', `Skip: track ${track ? track.readyState : 'missing'}`);
    frameSkipCount++;
    return false;
  }
  if (!video.videoWidth || video.readyState < 2) {
    dbg('Screen', `Skip: video not ready (readyState=${video.readyState}, w=${video.videoWidth})`);
    frameSkipCount++;
    return false;
  }
  if (!socket.connected) {
    frameSkipCount++;
    return false;
  }

  try {
    const canvas = els.screenCanvas;
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 960, 540);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    const base64 = dataUrl.split(',')[1];
    if (base64) {
      socket.emit('frame', base64);
      frameSentCount++;
      if (frameSentCount <= 3 || frameSentCount % 30 === 0) {
        dbg('Screen', `Frame #${frameSentCount} sent (${(base64.length / 1024).toFixed(0)}KB)`);
      }
      return true;
    }
  } catch (err) {
    dbg('Screen', 'Frame capture error:', err.message);
  }
  return false;
}

function setupScreenCapture() {
  els.screenVideo.srcObject = state.displayStream;

  stopFrameCapture();
  frameSentCount = 0;
  frameSkipCount = 0;

  const FRAME_INTERVAL_MS = 1000;

  // Use requestVideoFrameCallback if available (modern API, keeps pipeline active)
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    dbg('Screen', 'Using requestVideoFrameCallback for capture');
    let lastCaptureTime = 0;
    state.rvfcActive = true;

    function onVideoFrame(now) {
      if (!state.rvfcActive || !state.displayStream) return;
      if (now - lastCaptureTime >= FRAME_INTERVAL_MS) {
        captureAndSendFrame();
        lastCaptureTime = now;
      }
      els.screenVideo.requestVideoFrameCallback(onVideoFrame);
    }
    els.screenVideo.requestVideoFrameCallback(onVideoFrame);
  } else {
    dbg('Screen', 'Using setInterval fallback for capture');
    state.frameInterval = setInterval(() => captureAndSendFrame(), FRAME_INTERVAL_MS);
  }
}

function stopFrameCapture() {
  state.rvfcActive = false;
  if (state.frameInterval) {
    clearInterval(state.frameInterval);
    state.frameInterval = null;
  }
  if (frameSentCount > 0 || frameSkipCount > 0) {
    dbg('Screen', `Capture stopped: ${frameSentCount} sent, ${frameSkipCount} skipped`);
  }
}

// ---- Audio Playback (Server → Speaker) ----

socket.on('agent_audio', (base64) => {
  if (!state.isSessionActive) return;
  state.audioQueue.push(base64);
  if (!state.isPlayingAudio) {
    playNextAudio();
  }
});

const TTS_SAMPLE_RATE = 24000;

async function playNextAudio() {
  if (state.audioQueue.length === 0) {
    state.isPlayingAudio = false;
    state.currentAudioSource = null;
    socket.emit('audio_playback_ended');
    return;
  }

  state.isPlayingAudio = true;
  const base64 = state.audioQueue.shift();

  try {
    // Decode base64 to raw bytes
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // TTS sends raw PCM 16-bit signed little-endian at 24kHz
    // Convert Int16 PCM to Float32 AudioBuffer
    const int16 = new Int16Array(bytes.buffer);
    const numSamples = int16.length;
    const audioBuffer = state.playbackContext.createBuffer(1, numSamples, TTS_SAMPLE_RATE);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = int16[i] / 32768;
    }

    const source = state.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(state.playbackContext.destination);

    state.currentAudioSource = source;
    socket.emit('audio_playback_started');

    source.onended = () => {
      playNextAudio();
    };

    source.start(0);
  } catch (err) {
    console.error('Audio playback error:', err);
    playNextAudio();
  }
}

// ---- Interrupt Handling ----

socket.on('interrupt', () => {
  dbg('Audio', 'Interrupt received');
  state.audioQueue = [];
  if (state.currentAudioSource) {
    try {
      state.currentAudioSource.stop();
    } catch (e) { /* already stopped */ }
    state.currentAudioSource = null;
  }
  state.isPlayingAudio = false;
  socket.emit('audio_playback_ended');
});

// ---- UI Event Handlers ----

socket.on('session_started', () => {
  dbg('Session', 'Server confirmed session_started');
});

socket.on('agent_text', (text) => {
  appendMessage('Claude', text, 'agent');
});

socket.on('agent_text_continue', (text) => {
  appendToLastAgentMessage(text);
});

socket.on('agent_text_delta', (text) => {
  appendDeltaToLastAgentMessage(text);
});

socket.on('user_text', (text) => {
  appendMessage('You', text, 'user');
});

socket.on('tutorial_loading', ({ objectLabel }) => {
  els.loaderLabel.textContent = objectLabel;
  els.tutorialLoader.classList.remove('hidden');
});

socket.on('tutorial_ready', (tutorial) => {
  els.tutorialLoader.classList.add('hidden');
  state.tutorial = tutorial;
  state.currentStepIndex = 0;
  renderTutorial(tutorial);
  if (window.electronBridge) {
    window.electronBridge.forwardToOverlay('tutorial_ready', {
      referenceImagePath: tutorial.referenceImagePath || null,
      totalSteps: tutorial.steps ? tutorial.steps.length : 0
    });
  }
});

socket.on('tutorial_error', ({ error }) => {
  els.tutorialLoader.classList.add('hidden');
  appendMessage('System', `Tutorial generation failed: ${error}`, 'agent');
});

socket.on('step_update', ({ previousStep, currentStep, totalSteps }) => {
  state.currentStepIndex = currentStep - 1;
  updateStepHighlight();
  if (window.electronBridge) {
    window.electronBridge.forwardToOverlay('step_update', { currentStep, totalSteps });
  }
});

socket.on('hotkey_display', ({ keyCombo, description }) => {
  showHotkey(keyCombo, description);
  if (window.electronBridge) {
    window.electronBridge.forwardToOverlay('hotkey_display', { keyCombo, description });
  }
});

// ---- UI Render Functions ----

function appendMessage(role, text, type) {
  const div = document.createElement('div');
  div.className = `message ${type}`;
  const renderedText = type === 'agent' ? marked.parse(text) : escapeHtml(text);
  div.innerHTML = `
    <div class="message-role">${role}</div>
    <div class="message-text">${renderedText}</div>
  `;
  if (type === 'agent') div.dataset.rawText = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function appendToLastAgentMessage(text) {
  const messages = els.transcript.querySelectorAll('.message.agent');
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.dataset.rawText !== undefined) {
    lastMsg.dataset.rawText += ' ' + text;
    lastMsg.querySelector('.message-text').innerHTML = marked.parse(lastMsg.dataset.rawText);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  } else {
    appendMessage('Claude', text, 'agent');
  }
}

function appendDeltaToLastAgentMessage(text) {
  const messages = els.transcript.querySelectorAll('.message.agent');
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.dataset.rawText !== undefined) {
    lastMsg.dataset.rawText += text;
    lastMsg.querySelector('.message-text').innerHTML = marked.parse(lastMsg.dataset.rawText);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  } else {
    appendMessage('Claude', text, 'agent');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderTutorial(tutorial) {
  els.tutorialPanel.classList.remove('hidden');
  els.tutorialTitle.textContent = tutorial.objectLabel;

  if (tutorial.referenceImagePath) {
    els.referenceImage.src = tutorial.referenceImagePath;
    els.referenceImageContainer.classList.remove('hidden');
    els.noReferencePlaceholder.classList.add('hidden');
  }

  els.stepList.innerHTML = '';
  tutorial.steps.forEach((step, idx) => {
    const item = document.createElement('div');
    item.className = `step-item${idx === 0 ? ' active' : ''}`;
    item.dataset.index = idx;
    item.innerHTML = `
      <div class="step-number"><span>${step.stepNumber}</span></div>
      <div class="step-title">${escapeHtml(step.title)}</div>
    `;
    item.addEventListener('click', () => selectStep(idx));
    els.stepList.appendChild(item);
  });

  selectStep(0);
}

function selectStep(idx) {
  if (!state.tutorial) return;
  const step = state.tutorial.steps[idx];
  if (!step) return;

  if (step.imagePath) {
    els.stepImage.src = step.imagePath;
    els.stepImageContainer.classList.remove('hidden');
  } else {
    els.stepImageContainer.classList.add('hidden');
  }

  els.stepInstructionsText.innerHTML = marked.parse(step.instruction);
  els.stepInstructions.classList.remove('hidden');
  updateStepHighlight(idx);
}

function updateStepHighlight(overrideIdx) {
  const idx = overrideIdx !== undefined ? overrideIdx : state.currentStepIndex;
  const items = els.stepList.querySelectorAll('.step-item');
  items.forEach((item, i) => {
    item.classList.remove('active', 'completed');
    if (i < idx) item.classList.add('completed');
    else if (i === idx) item.classList.add('active');
  });
}

// ---- Mic Visualizer (5 bars) ----

function startMicVisualizer() {
  const canvas = document.getElementById('mic-visualizer');
  const ctx = canvas.getContext('2d');
  const analyser = state.analyser;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const dpr = window.devicePixelRatio || 1;
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;
  canvas.width = displayWidth * dpr;
  canvas.height = displayHeight * dpr;
  ctx.scale(dpr, dpr);

  const barCount = 5;
  const barGap = 3;
  const barWidth = (displayWidth - (barCount - 1) * barGap) / barCount;
  const radius = barWidth / 2;

  function draw() {
    requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    const step = Math.floor(bufferLength / barCount);

    for (let i = 0; i < barCount; i++) {
      const value = dataArray[i * step];
      const percent = value / 255;
      const barHeight = Math.max(3, percent * displayHeight);
      const x = i * (barWidth + barGap);
      const y = (displayHeight - barHeight) / 2;
      const alpha = 0.3 + percent * 0.7;

      ctx.fillStyle = `rgba(168, 213, 186, ${alpha})`;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, radius);
      ctx.fill();
    }
  }

  draw();
}

let hotkeyTimeout = null;

function showHotkey(keyCombo, description) {
  const keysContainer = els.hotkeyDisplay.querySelector('.hotkey-keys');
  const descEl = els.hotkeyDisplay.querySelector('.hotkey-desc');

  const keys = keyCombo.split(/\s*\+\s*|\s+then\s+/i);
  const separators = [];
  let match;
  const sepRegex = /(\+| then )/gi;
  while ((match = sepRegex.exec(keyCombo)) !== null) {
    separators.push(match[1].trim() === 'then' ? 'then' : '+');
  }

  let html = '';
  keys.forEach((key, i) => {
    html += `<span class="key-cap">${escapeHtml(key.trim())}</span>`;
    if (i < keys.length - 1) {
      html += `<span class="key-sep">${separators[i] || '+'}</span>`;
    }
  });

  keysContainer.innerHTML = html;
  descEl.textContent = description;

  els.hotkeyDisplay.classList.remove('hidden');
  els.hotkeyDisplay.style.opacity = '1';

  if (hotkeyTimeout) clearTimeout(hotkeyTimeout);
  hotkeyTimeout = setTimeout(() => {
    els.hotkeyDisplay.style.opacity = '0';
    setTimeout(() => {
      els.hotkeyDisplay.classList.add('hidden');
    }, 500);
  }, 5000);
}

// ---- Electron Screen Source Picker ----

if (window.electronBridge && window.electronBridge.onSelectDisplaySource) {
  els.sourcePickerCancel.addEventListener('click', () => {
    els.sourcePicker.classList.add('hidden');
    window.electronBridge.selectDisplaySource(null);
  });

  window.electronBridge.onSelectDisplaySource((sources) => {
    els.sourcePickerGrid.innerHTML = '';
    sources.forEach((source) => {
      const item = document.createElement('div');
      item.className = 'source-picker-item';
      item.innerHTML = `
        <img src="${source.thumbnail}" alt="${escapeHtml(source.name)}" />
        <span class="source-name">${escapeHtml(source.name)}</span>
      `;
      item.addEventListener('click', () => {
        els.sourcePicker.classList.add('hidden');
        window.electronBridge.selectDisplaySource(source.id);
      });
      els.sourcePickerGrid.appendChild(item);
    });
    els.sourcePicker.classList.remove('hidden');
  });
}
