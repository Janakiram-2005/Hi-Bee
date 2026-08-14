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

The main problem addressed in this work is the limited availability of accessible desktop technology for rural users, especially persons with disabilities. Existing desktop agents are usually designed for single-language interaction and depend mainly on keyboard, mouse, or touch input, which creates barriers for users who cannot easily use conventional interfaces. They also provide weak support for multilingual input and output, natural language processing, gesture-based interaction, and robust vision-language model (VLM) navigation across desktop applications. In rural settings, these limitations are intensified by low digital literacy, poor infrastructure, and reduced access to assistive tools. As a result, many users remain excluded from independent computer use and effective digital participation. This project therefore aims to develop a unified desktop agent that combines multilingual NLP, gesture input, and intelligent VLM-based navigation to support inclusive, flexible, and accessible human-computer interaction for rural and disabled users. [1] [2] [3]

### Target Audience & Impact

The problem affects all age groups, but it is especially significant for rural users, older adults, students, working professionals, and persons with disabilities. These groups are more likely to face barriers related to language, digital literacy, physical accessibility, and limited access to modern assistive technology. In particular, users who cannot easily rely on keyboard or mouse input, or who need multilingual support, are most impacted by the lack of an inclusive desktop agent.

### Our Solution

Our solution is a low-cost, multilingual desktop agent that supports text, voice, and gesture inputs, uses NLP for understanding commands, and applies VLM-based desktop navigation for visual tasks. It is designed to be accessible, affordable, and easy to use for rural users and persons with disabilities.

The solution works as a desktop assistant running on a standard laptop or PC with a microphone, webcam, and optional gesture-capable camera or mobile device. On the software side, it combines a multilingual NLP engine, speech-to-text, text-to-speech, gesture recognition, and a vision-language model (VLM) for understanding the screen and navigating desktop interfaces. The user can interact through voice, typed text, or gestures in their preferred language. The system interprets the input, identifies the user’s intent, and converts it into an action plan.

In the workflow, the agent first captures input, then processes language and visual context, and finally performs the required desktop task such as opening apps, filling forms, clicking buttons, or reading on-screen content. It returns results through spoken output, visual prompts, or text feedback. Data includes user commands, screen screenshots, UI states, and action logs, which are used only for task execution and response generation. The design is lightweight and cost-aware, using affordable hardware and reusable software components so it can be deployed in rural and low-resource environments while still supporting accessibility for persons with disabilities.

### Core Technologies

- Speech recognition / speech-to-text
- Text-to-speech
- Computer vision
- Natural language processing
- Reinforcement learning
- Edge AI / on-device AI

### Data & Training

The project uses a small custom dataset of desktop screenshots, UI interaction logs, command-response pairs, and gesture samples collected from common desktop tasks. It is used to train and test multilingual command understanding, VLM-based screen navigation, and gesture recognition. Public benchmark data may also be used for pretraining or evaluation where needed, but the main dataset is domain-specific because desktop workflows, languages, and accessibility needs in rural environments are not well covered by generic datasets.

### Accessibility & Inclusion

The project includes multilingual input and output, voice interaction, gesture-based control, and VLM-assisted screen navigation to support users with limited literacy, mobility, or language barriers. It is designed to reduce dependence on keyboard and mouse, making desktop use more accessible for rural users and persons with disabilities. The interface aims to provide clear feedback, simple workflows, and flexible interaction modes so users can choose the method that suits their needs best.

The project improves digital inclusion for rural users and persons with disabilities and runs on existing hardware, making it low-cost and resource-efficient.

### Sustainable Development Goals

- Reduced Inequalities
- Quality Education
- Promote Equity and Inclusion 

### Privacy & Security

The system will follow privacy-first design by minimizing data collection and processing only the information needed for task execution. In the future, we plan to move more computation to local, on-device processing to improve security, reduce exposure of sensitive data, and better support AI PCs. User data will be handled with consent, stored securely, and not shared unnecessarily.

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

This project is licensed under the Apache License 2.0.
