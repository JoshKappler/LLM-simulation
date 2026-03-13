# Agent Arena

Two LLM agents run an automated back-and-forth roleplay conversation against each other. Watch them improvise, argue, plead, and react in real time. Includes an **Evolution Circuit** that automatically runs hundreds of scenarios, rates them, and mutates the prompts toward better dramatic output.

---

## What You Need

There are two things to install, plus a Groq API key:

1. **Node.js** — runs the web app
2. **npm** — installs the app's dependencies (comes bundled with Node.js)
3. **Groq API key** — provides LLM inference via the Groq cloud API

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

## Step 2 — Get a Groq API Key

Sign up at [console.groq.com](https://console.groq.com) and create an API key.

Create a file called `.env.local` in the project root with:

```
GROQ_API_KEY=gsk_your_key_here
```

The app uses Groq's OpenAI-compatible API for all LLM calls. Models available through Groq (like `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, etc.) will appear in the model selector automatically.

---

## Step 3 — Clone or Download This Project

If you have Git installed:

```bash
git clone https://github.com/JoshKappler/LLM-simulation.git
cd LLM-simulation
```

Or download the ZIP from GitHub and extract it, then open a terminal in the project folder.

---

## Step 4 — Install Project Dependencies

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

---

## Step 5 — Start the App

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

**Arena tab** — Set up two characters with names, system prompts, and a shared situation. Pick a model for each agent from the Groq model list. Hit Run and watch them talk.

**Model tab** — Set the model for both agents at once.

**Prompts tab** — Save and load prompt configurations as JSON files (stored in the `prompts/` folder).

**Optimize tab (Evolution Circuit)** — Select a saved prompt config as a seed. The optimizer runs headless simulations automatically, rates each transcript on dramatic quality, mutates the weakest prompts, and evolves toward better configurations over multiple generations.

---

## Troubleshooting

**"Chat API error" or 401 errors:**
Your `GROQ_API_KEY` is missing or invalid. Check `.env.local` in the project root.

**Rate limit errors (429):**
The app retries automatically on 429s (up to 5 times with backoff). If you're still hitting limits, reduce the number of concurrent runs or upgrade your Groq plan.

**App won't start / npm errors:**
Make sure you ran `npm install` in the project folder and that Node.js is version 18.17 or higher (`node --version`).

**Port 3000 already in use:**
Another process is using that port. Either stop it, or run the app on a different port:
```bash
npm run dev -- --port 3001
```
