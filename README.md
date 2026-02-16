# Claude Tutors

Real-time AI-powered tutoring for creative tools. Voice-guided lessons, live screen analysis, and step-by-step tutorials — currently supporting **Blender 3D** and **Figma**.

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
client/                          # Browser frontend
  index.html                     # Home screen, pre-session, and session UI
  app.js                         # Tool selection, screen capture, audio, socket events
  styles.css                     # All styling (home tiles, session panels, tutorial)
  audio-processor.js             # AudioWorklet for mic capture

server/
  index.js                       # Express + Socket.IO entry point
  live-ai-module.js              # Core orchestration — ties everything together
  agents/
    blender-tutor.json           # Blender agent: system prompt, tools, voice config
    figma-tutor.json             # Figma agent: system prompt, tools, voice config
    lesson-creator.json          # Blender lesson creator config (image mode, step counts)
    figma-lesson-creator.json    # Figma lesson creator config
    lesson-creator-agent.js      # Blender tutorial generator (analysis + instructions)
    figma-lesson-creator-agent.js# Figma tutorial generator (UI sections + instructions)
  services/
    claude-service.js            # Anthropic SDK wrapper (streaming + non-streaming)
    elevenlabs-stt.js            # Speech-to-text via ElevenLabs WebSocket
    elevenlabs-tts.js            # Text-to-speech with sentence-buffered streaming
    gemini-image.js              # Google Gemini image generation (aspect ratio support)
  utils/
    logger.js                    # Tagged console logger

output/tutorials/                # Generated tutorial images (gitignored)
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
- Streams Claude responses sentence-by-sentence to ElevenLabs TTS for low-latency voice
- Captures screen frames from the client and attaches them to Claude messages
- Handles interruptions — if the user speaks mid-response, everything stops immediately
- Runs recurring screen checks (every 3s when idle) to proactively offer tips
- Manages tool calls: `Create_Tutorial`, `Progressed_Step`, `Suggested_HotKey`

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
| `elevenlabs-stt.js` | Real-time speech-to-text via WebSocket |
| `elevenlabs-tts.js` | Text-to-speech with chunked audio streaming |
| `gemini-image.js` | Image generation with configurable aspect ratio |
