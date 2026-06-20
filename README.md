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

**Hi-Bee** is a next-generation native GUI agent built on top of the powerful UI-TARS foundation. It introduces a revolutionary **conversational interface** to desktop automation. 

Instead of typing commands, Hi-Bee sits quietly on your screen as a sleek, glowing orb. When invoked, it expands into a full command center. You can speak naturally, and Hi-Bee will use Vision-Language Models (VLMs) to visually understand your current desktop screen and execute native mouse clicks and keystrokes to accomplish the goal—all while talking back to you!

```
Your Voice ──► Cloud STT ──► AI Brain (VLM) ──► Native Desktop Operator ──► Computer
        ▲                                                                        │
        └──────────────────────── Screen Capture Feedback ───────────────────────┘
```

---

## Key Features

| Feature | Description |
|---|---|
| 🎙️ **Real-Time Voice STT** | Speak naturally. Powered by Google Cloud Speech-to-Text for lightning-fast transcription. |
| 🔊 **Dynamic TTS Voices** | Agent speaks back using Google Free TTS or premium ElevenLabs voices. |
| 👁️ **Screen Vision** | Takes screenshots of your desktop to visually ground actions, just like a human. |
| 🖱️ **Native GUI Control** | Autonomously takes over your mouse and keyboard to click, type, and navigate OS interfaces. |
| 🪟 **Adaptive UI Widget** | Sleek orb mode for standby, expanding into a beautifully designed Voice Panel when active. |
| ↕️ **Smart Resizing** | Drag the panel to resize; the built-in chat history automatically expands to fill the space! |
| ⚙️ **Live Settings** | Swap AI models, change TTS voices, or update API keys on the fly without restarting. |
| 🔒 **Local Execution** | Hybrid Python/Node architecture ensures local, secure execution of OS-level commands. |

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
│   │  Google Speech  │    │  ElevenLabs    │    │  Child Process  │ │
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
2. **TTS Provider:** Choose between Google Free TTS or provide an ElevenLabs API key.
3. **Vision Model:** Select your preferred VLM (e.g., `doubao-1-5-vision-pro`, `claude-3-5-sonnet`) and insert your API key.
4. **Voice Settings:** Change your wake phrase, language, and volume level.

---

## License

This project is licensed under the Apache License 2.0. Built upon the UI-TARS framework.
