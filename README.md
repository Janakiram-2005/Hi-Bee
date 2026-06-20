<div align="center">
  <img alt="Hi-Bee Icon" width="128" src="./apps/ui-tars/resources/icon.png">
  <h1>Hi-Bee Desktop Agent</h1>
  <p><strong>Your Ultimate Voice-Controlled Multi-modal Desktop Assistant</strong></p>
</div>

<br/>

## Introduction

**Hi-Bee** is a cutting-edge multimodal AI Desktop Agent. Built upon the robust foundation of the [UI-TARS](https://github.com/bytedance/UI-TARS) project, Hi-Bee introduces a completely reimagined, sleek, and highly interactive **Voice Assistant interface**. 

It transforms standard computer automation into a seamless, conversational experience, allowing you to control your local applications, browse the web, and execute complex workflows entirely via natural voice commands or text!

---

## 🚀 Key Features

- 🎙️ **Advanced Voice Assistant UI**: A beautifully designed, drag-and-resize Voice Panel that can expand into a full conversation history window or collapse into a minimalist desktop orb.
- 🗣️ **Real-time Voice Interaction**: Integrated Google Cloud STT (Speech-To-Text) and multiple TTS (Text-To-Speech) engines including Google Free TTS and ElevenLabs for natural, low-latency conversations.
- 💻 **Vision & Screen Understanding**: Powered by advanced Vision-Language Models (VLM) that can literally "see" your screen and take actions based on what's visible.
- 🎯 **Native GUI Automation**: Precise programmatic control over your mouse and keyboard across Windows, macOS, and Linux to navigate interfaces exactly like a human would.
- ⚙️ **Highly Customizable**: Dynamic settings panel to instantly configure API keys, change text-to-speech voices, toggle muting, and manage listening modes without restarting.
- 🔒 **Local & Secure Execution**: Core operational processing runs fully locally on your device for maximum privacy.

---

## 🛠️ The Flow: How Hi-Bee Works

1. **Wake Up & Listen**: Hi-Bee sits quietly as a glowing orb on your desktop. Click the microphone or use a hotkey to wake it up.
2. **Command Processing**: Speak your command naturally (e.g., *"Hi-Bee, open Visual Studio Code and create a new Python project"*). Your voice is instantly streamed via Cloud STT and transcribed in real-time on the panel.
3. **Agent Planning**: The underlying AI model receives the text, analyzes your current desktop screen (via screenshot capturing), and determines the exact series of mouse movements and keyboard strokes needed.
4. **Execution**: The local hybrid GUI operator executes the plan. You can watch Hi-Bee physically move your mouse and click on the right buttons!
5. **Vocal Feedback**: Once the task is complete, Hi-Bee uses Text-to-Speech to verbally inform you of the result (e.g., *"I have created your new Python project"*), while adding the log to your chat history.

---

## 📦 Quick Start

### 1. Prerequisites
- **Node.js** (v18+)
- **Python** (v3.10+)
- **pnpm** package manager

### 2. Install Dependencies
```bash
# Clone the repository
git clone https://github.com/Janakiram-2005/Hi-Bee.git
cd Hi-Bee

# Install all Node.js dependencies
npx pnpm install

# Install Python backend dependencies
cd hybrid_gui_agent
pip install -r requirements.txt
cd ..
```

### 3. Run Hi-Bee Locally
To launch the desktop agent in development mode:
```bash
npx pnpm run dev:ui-tars
```

### 4. Configuration
When you launch the app, click the **Settings (Gear Icon)** in the Voice Panel to:
- Add your Google Cloud STT credentials for lightning-fast voice recognition.
- Configure your preferred TTS Provider (Google Free TTS or ElevenLabs) and select your favorite voice.
- Set up your VLM (Vision Language Model) API keys (like Anthropic, OpenAI, or Vertex AI).

---

## 🎨 UI Overview

- **Minimalist Orb**: When idle, Hi-Bee shrinks into a non-intrusive floating robot orb that stays on top of your windows.
- **Voice Panel**: Click the orb to expand it into the main command center.
- **Live Transcript**: Watch your spoken words appear instantly in the chat bar.
- **Dynamic Resize**: Drag the corners or edges to stretch the panel. The Chat History window will automatically expand to fill the extra space!
- **Control Row**: Instantly mute TTS, disable the camera/vision, or completely shut down the agent from the quick-access bottom row.

---

## 🤝 Contributing

We welcome contributions! Feel free to open issues or submit Pull Requests to the `main` branch. 

## 📄 License

This project is licensed under the Apache License 2.0. Built upon UI-TARS.
