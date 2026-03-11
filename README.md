# Agent Arena

Two LLM agents run an automated back-and-forth roleplay conversation against each other. Watch them improvise, argue, plead, and react in real time. Includes an **Evolution Circuit** that automatically runs hundreds of scenarios, rates them, and mutates the prompts toward better dramatic output.

---

## What You Need

There are three things to install before this project will run:

1. **Node.js** — runs the web app
2. **npm** — installs the app's dependencies (comes bundled with Node.js)
3. **Ollama** — runs the AI models locally on your machine

---

## Step 1 — Install Node.js

Node.js 18.17 or higher is required. Node.js 20 or 22 LTS is recommended.

**Mac:**

The easiest way is with [Homebrew](https://brew.sh). If you don't have Homebrew, install it first by pasting this into Terminal:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then install Node.js:

```bash
brew install node
```

Alternatively, download the macOS installer directly from [nodejs.org](https://nodejs.org) and run it.

**Windows:**

Download the Windows installer (.msi) from [nodejs.org](https://nodejs.org). Choose the LTS version. Run the installer and follow the prompts — it installs both Node.js and npm automatically.

After installation, open a new Command Prompt or PowerShell window and verify:

```bash
node --version
npm --version
```

Both should print version numbers.

---

## Step 2 — Install Ollama

Ollama runs AI models locally. It handles all the inference — the web app talks to it over a local API.

**Mac:**

Download the Mac app from [ollama.com](https://ollama.com/download). Open the downloaded `.zip`, drag Ollama to your Applications folder, and launch it. You'll see an Ollama icon appear in your menu bar.

Or install via Homebrew:

```bash
brew install ollama
```

Then start the server:

```bash
ollama serve
```

**Windows:**

Download the Windows installer from [ollama.com](https://ollama.com/download) and run it. Ollama will start automatically and run in the system tray. If it doesn't start, open it from the Start menu.

**Verify Ollama is running:**

Open a browser and go to `http://localhost:11434`. You should see plain text that says `Ollama is running`.

---

## Step 3 — Pull Models

Ollama needs to download models before you can use them. Models are large files (several gigabytes each) stored locally on your machine.

Open a terminal (Terminal on Mac, Command Prompt or PowerShell on Windows) and run:

```bash
ollama pull huihui_ai/qwen3.5-abliterated
```

This is the recommended model for this project. It handles roleplay well and follows character prompts naturally. The download is around 8GB — wait for it to finish before starting the app.

**Other models you can try:**

```bash
ollama pull gemma3:27b
```

Good for analytical tasks (the optimizer's judge/mutation calls). Not recommended as a roleplay character model.

```bash
ollama pull llama3.2
```

A smaller 3B model. Fast, but output quality for roleplay is low.

**To see all models you've downloaded:**

```bash
ollama list
```

**To remove a model:**

```bash
ollama rm model-name
```

**Model storage location:**

- Mac: `~/.ollama/models`
- Windows: `C:\Users\<you>\.ollama\models`

Make sure you have enough disk space before pulling large models.

---

## Step 4 — Clone or Download This Project

If you have Git installed:

```bash
git clone https://github.com/JoshKappler/LLM-simulation.git
cd LLM-simulation
```

Or download the ZIP from GitHub and extract it, then open a terminal in the project folder.

---

## Step 5 — Install Project Dependencies

In the project folder, run:

```bash
npm install
```

This reads `package.json` and downloads everything the app needs into a `node_modules` folder. It only needs to be run once (or again after pulling updates).

**What gets installed:**

| Package | Version | What it does |
|---|---|---|
| `next` | 15 | The web framework — handles routing, server, and build |
| `react` | 19 | UI component library |
| `react-dom` | 19 | Renders React components to the browser |
| `tailwindcss` | 4 | Utility CSS framework used for styling |
| `@tailwindcss/postcss` | 4 | Connects Tailwind to the CSS build pipeline |
| `typescript` | 5 | Type checking for the source code (dev only) |
| `@types/node` | 20 | TypeScript types for Node.js (dev only) |
| `@types/react` | 19 | TypeScript types for React (dev only) |
| `@types/react-dom` | 19 | TypeScript types for React DOM (dev only) |

No other external services, databases, or API keys are required. Everything runs locally.

---

## Step 6 — Start the App

Make sure Ollama is running first, then:

```bash
npm run dev
```

Open your browser and go to:

```
http://localhost:3000
```

The app will be live. The first load may take a few seconds while Next.js compiles.

---

## Using the App

**Arena tab** — Set up two characters with names, system prompts, and a shared situation. Pick a model for each agent (must be a model you've already pulled in Ollama). Hit Run and watch them talk.

**Model tab** — Set the model for both agents at once.

**Prompts tab** — Save and load prompt configurations as JSON files (stored in the `prompts/` folder).

**Optimize tab (Evolution Circuit)** — Select a saved prompt config as a seed. The optimizer runs headless simulations automatically, rates each transcript on dramatic quality, mutates the weakest prompts, and evolves toward better configurations over multiple generations. Requires Ollama to be running with enough resources to handle back-to-back calls.

---

## Troubleshooting

**"connection refused" or model never loads:**
Ollama isn't running. On Mac, check your menu bar for the Ollama icon. On Windows, check the system tray. Start it manually if needed:
```bash
ollama serve
```

**Model not found error:**
You haven't pulled the model yet. Run `ollama pull <model-name>` in a terminal.

**App won't start / npm errors:**
Make sure you ran `npm install` in the project folder and that Node.js is version 18.17 or higher (`node --version`).

**Slow or empty output after several turns:**
Normal for large models on slower hardware. The app has a repeat penalty setting — if output is completely empty, the model may be running out of context. Try reducing the number of turns or using a smaller model.

**Port 3000 already in use:**
Another process is using that port. Either stop it, or run the app on a different port:
```bash
npm run dev -- --port 3001
```
