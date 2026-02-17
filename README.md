# Claude Coach

Real-time AI-powered coaching for creative tools. Voice-guided lessons, live screen analysis, and step-by-step tutorials — currently supporting **Blender 3D** and **Figma**.

Users select a tool, share their screen, and have a voice conversation with Claude who watches what they're doing and guides them through building things step by step.

## Quick Setup

### Prerequisites

- Node.js 18+
- API keys for: [Anthropic](https://console.anthropic.com/), [ElevenLabs](https://elevenlabs.io/), [Google AI](https://aistudio.google.com/apikey)

### Install & Run

```bash
npm install
cp .env.example .env   # then fill in your API keys
npm run dev             # starts on http://localhost:3000
```

### Electron App

```bash
npm run electron        # launches the desktop app (starts server automatically)
```

The Electron app wraps the same web client with native features:
- **Window picker** for screen sharing (windows only, no full screens)
- **Floating overlay** — always-on-top reference image + step indicator visible while you work in Blender/Figma
- **Auto-managed server** — the Node server starts/stops with the app

### Environment Variables

```
ANTHROPIC_API_KEY=      # Claude API key
ELEVENLABS_API_KEY=     # ElevenLabs API key
ELEVENLABS_VOICE_ID=    # ElevenLabs voice ID
GOOGLE_GENAI_API_KEY=   # Google Gemini API key (for reference image generation)
PORT=3000
```

## Project Structure

```
client/                            # Browser frontend (shared by web + Electron)
  index.html                       # Home screen, pre-session, and session UI
  app.js                           # Tool selection, screen capture, audio, socket events
  styles.css                       # All styling (home tiles, session panels, tutorial)
  audio-processor.js               # AudioWorklet for mic capture
  assets/                          # Tool icons (Blender, Figma)

electron/                          # Electron desktop wrapper
  main.js                          # App lifecycle, window management, IPC, screen picker
  overlay.html                     # Floating overlay UI (reference image, steps, hotkeys)
  preload-main.js                  # Preload bridge for main window
  preload-overlay.js               # Preload bridge for overlay window
  icon.png                         # App icon

server/
  index.js                         # Express + Socket.IO entry point
  live-ai-module.js                # Core orchestration — ties everything together
  agents/
    blender-tutor.json             # Blender agent: system prompt, tools, voice config
    figma-tutor.json               # Figma agent: system prompt, tools, voice config
    blender3d-lesson-creator.json  # Blender lesson creator config
    figma-lesson-creator.json      # Figma lesson creator config
    blender3d-lesson-creator-agent.js  # Blender tutorial generator
    figma-lesson-creator-agent.js  # Figma tutorial generator
  services/
    claude-service.js              # Anthropic SDK wrapper (streaming + non-streaming)
    elevenlabs-stt.js              # Speech-to-text via ElevenLabs WebSocket
    elevenlabs-tts.js              # Text-to-speech with sentence-buffered streaming
    gemini-image.js                # Google Gemini image generation
  utils/
    logger.js                      # Tagged console logger

output/tutorials/                  # Generated tutorial images (gitignored)
```

## How It Works

### Session Flow

1. **Home screen** — user picks a tool (Blender or Figma)
2. **Pre-session** — grants mic + screen share, clicks Start
3. **Session** — Claude greets the user and asks what they want to build
4. **Tutorial** — Claude calls `Create_Tutorial`, the lesson creator generates steps with reference images, and Claude walks the user through each one

### Server Architecture

**LiveAIModule** is the central coordinator. One instance per connected socket. It:

- Loads the right agent config (`blender-tutor.json` or `figma-tutor.json`) based on the client's tool selection
- Streams Claude responses to the UI in real-time as text chunks arrive
- Sends text to ElevenLabs TTS at clause boundaries (commas, periods) for low-latency voice
- Pre-connects the TTS WebSocket at session start to eliminate handshake delay
- Captures screen frames from the client and attaches them to Claude messages
- Handles interruptions — if the user speaks mid-response, everything stops immediately (Claude stream aborted, TTS killed, client audio queue cleared)
- Runs recurring screen checks (every 3s when idle) to proactively offer tips
- Manages tool calls: `Create_Tutorial`, `Progressed_Step`, `Suggested_HotKey`
- Supports session stop/restart — the client can end a session and start a fresh one on the same socket

### Electron Architecture

The Electron app and web client share the **same client code**. The main window loads `http://localhost:3000` from the embedded server. The client detects Electron via `window.electronBridge` (injected by preload scripts) and conditionally uses native features like overlay forwarding and session state management.

The overlay is a separate transparent, always-on-top, non-focusable window that receives events forwarded from the main window via IPC. It shows the reference image, current step, and hotkey hints while the user works in their target application.

### Tutorial Generation

The lesson creator agents (one per tool) follow the same 3-phase pattern:

1. **Reference image** — Gemini generates a visual target for what the user will build
2. **Analysis** — Claude breaks the target into buildable sections/sub-pieces
3. **Instructions** — Claude writes detailed step-by-step instructions for each section

The Figma agent adapts aspect ratio automatically (portrait for mobile designs, landscape for desktop).

### Key Services

| Service | Purpose |
|---------|---------|
| `claude-service.js` | Claude API calls (streaming for voice, non-streaming for analysis) |
| `elevenlabs-stt.js` | Real-time speech-to-text via WebSocket (VAD at 300ms) |
| `elevenlabs-tts.js` | Text-to-speech with clause-level chunking and eager connection |
| `gemini-image.js` | Image generation with configurable aspect ratio |
