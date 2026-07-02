<div align="center">
# 🤖 Hi-Bee — Autonomous Voice-Controlled Desktop AI Agent

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue?style=for-the-badge&logo=python&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?style=for-the-badge&logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-UI-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Google Cloud](https://img.shields.io/badge/Google_Cloud-STT-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white)

**Your ultimate voice-controlled, multi-modal desktop assistant. Hi-Bee can see your screen, listen to your commands, and autonomously control your computer's mouse and keyboard to complete complex tasks.**

[🚀 Quick Start](#running-locally) • [📖 Architecture](#architecture) • [🧩 Features](#key-features) • [🗣️ Voice Control](#voice--vision)

</div>

---

## 📌 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Voice & Vision Integration](#voice--vision-integration)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Running Locally](#running-locally)
- [Configuration](#configuration)
- [License](#license)

---

## Overview

**UI-TARS Desktop** is a cutting-edge, open-source desktop application from ByteDance that lets users control their computer with natural language. Built on the UI-TARS vision-language model, it works as a native GUI agent that can understand what is on the screen, plan a response, and execute complex computer tasks the way a human operator would. The project is designed for Windows and macOS and is distributed under the Apache 2.0 license, making it available for both personal and commercial use.

The repository is organized as a pnpm workspace and Turborepo monorepo, with two major products living side by side: UI-TARS Desktop and Agent TARS. The desktop app itself lives under `apps/ui-tars` and is implemented with Electron for the native shell, React and TypeScript for the renderer UI, and Vite/electron-vite for the build pipeline. Around that core, the workspace is split into reusable layers for browser control, MCP clients and servers, logging, search, shared utilities, and supporting infrastructure, which keeps the codebase modular and easy to extend.

At the heart of the application is a multimodal AI stack that can support multiple model providers, including Hugging Face UI-TARS models, VolcEngine Ark, and Google Vertex AI Gemini. The agent reasoning loop is built to inspect screenshots, decide on the next step, and emit precise GUI actions such as clicks, typing, scrolling, hotkeys, drag operations, and gesture-driven input handling. The operator system adds practical execution modes for local computer control, local browser control, and remote computer or browser control, while the Hi-Bee voice experience adds a draggable animated avatar, Azure voice models for multilingual input and output, live speech and TTS interactions, and a synchronized agent chat window for a more natural assistant experience.

```
Your Voice ──► Cloud STT ──► AI Brain (VLM) ──► Native Desktop Operator ──► Computer
        ▲                                                                        │
        └──────────────────────── Screen Capture Feedback ───────────────────────┘
```

---

## Key Features

| Feature | Description |
|---|---|
| 🎙️ **Real-Time Voice STT** | Speak naturally. Powered by Google Cloud Speech-to-Text and multilingual Azure voice models for fast transcription and response. |
| 🔊 **Dynamic TTS Voices** | Agent speaks back using Google Free TTS or premium Azure TTS voices with multi-language support. |
| 👁️ **Screen Vision** | Takes screenshots of your desktop to visually ground actions, just like a human. |
| 🖱️ **Native GUI Control** | Autonomously takes over your mouse and keyboard to click, type, and navigate OS interfaces. |
| 🪟 **Adaptive UI Widget** | Sleek orb mode for standby, expanding into a beautifully designed Voice Panel when active. |
| ↕️ **Smart Resizing** | Drag the panel to resize; the built-in chat history automatically expands to fill the space! |
| ⚙️ **Live Settings** | Swap AI models, change TTS voices, or update API keys on the fly without restarting. |
| 🗣️ **Gesture Recognition** | Use gesture-based input and vision parsing to trigger interactions and support hands-free control. |
| 🔒 **Local Execution** | Hybrid Python/Node architecture ensures local, secure execution of OS-level commands. |
| 🖐️ **Gesture Controls** | Trigger actions via webcam with hand and face gestures using local Mediapipe vision tasks. |
| 🛡️ **DOM Validation** | Improved and robust DOM structure validation for higher interaction accuracy, including text parsing flows for more precise automation. |

---

## Voice & Vision Integration

Hi-Bee bridges the gap between conversational AI and practical computer usage:

- **The Flow:** Click the microphone and say, *"Hi-Bee, open Visual Studio Code and create a Python file."*
- **The Brain:** The AI interprets the command and captures your screen.
- **The Action:** You watch as your mouse physically moves to open the start menu, types "VS Code", opens the app, and creates the file.
- **The Feedback:** Hi-Bee announces *"I have successfully created your Python file."*

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE LAYER                        │
│                                                                     │
│   ┌───────────────────────┐        ┌──────────────────────────┐    │
│   │  Floating Orb Mode    │        │  Expanded Voice Panel    │    │
│   │                       │        │                          │    │
│   │  • Always on top      │        │  • Live STT Transcript   │    │
│   │  • Pulse animations   │        │  • Expandable Chat Hist  │    │
│   │  • Drag to move       │        │  • Voice/Vision Toggles  │    │
│   └──────────┬────────────┘        └────────────┬─────────────┘    │
│              │             Electron IPC         │                  │
└──────────────┼───────────────────────────────────┼──────────────────┘
               │                                   │
┌──────────────▼───────────────────────────────────▼──────────────────┐
│                      NODE.JS MAIN PROCESS                           │
│                                                                     │
│   ┌─────────────────┐    ┌────────────────┐    ┌─────────────────┐ │
│   │  Cloud STT      │    │  TTS Engine    │    │  Native Bridge  │ │
│   │  Google Speech  │    │  Azure TTS     │    │  Child Process  │ │
│   └─────────┬───────┘    └────────┬───────┘    └────────┬────────┘ │
└─────────────┼─────────────────────┼─────────────────────┼──────────┘
              │                     │                     │
┌─────────────▼─────────────────────▼─────────────────────▼──────────┐
│                      PYTHON HYBRID OPERATOR                         │
│                                                                     │
│  • Captures Screen   • Vision-Language Model   • Mouse/Keyboard    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- **Node.js** (v18 or higher)
- **Python** (v3.10 or higher)
- **pnpm** (Package manager)
- API Keys for Google Cloud (STT) and an LLM provider (e.g., Anthropic, Vertex AI)

---

## Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Janakiram-2005/Hi-Bee.git
   cd Hi-Bee
   ```

2. **Install Node.js Dependencies:**
   ```bash
   npx pnpm install
   ```

3. **Install Python Backend Dependencies:**
   ```bash
   cd hybrid_gui_agent
   pip install -r requirements.txt
   cd ..
   ```

---

## Running Locally

To launch the desktop application in development mode:

```bash
npx pnpm run dev:ui-tars
```

A glowing robot orb will appear on your screen. Click the **gear icon** inside the expanded panel to configure your settings.

---

## Configuration

In the settings panel, you can configure:
1. **Google Cloud Credentials:** Point to your `.json` service account file for Speech-to-Text.
2. **TTS Provider:** Choose between Google Free TTS or provide Azure Speech credentials (Key and Region).
3. **Vision Model:** Configure Google Vertex AI for base reasoning and Anthropic Claude (`claude-3-5-sonnet` or `claude-3-7-sonnet-20250219`) for precise coordinate navigation. Insert your API keys accordingly.
4. **Voice Settings:** Change your wake phrase, language, and volume level.

---

## License

This project is licensed under the Apache License 2.0. Built upon the UI-TARS framework.
