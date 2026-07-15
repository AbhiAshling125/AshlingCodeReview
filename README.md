# UiPath Code Reviewer Enterprise

AI-powered code reviews for UiPath XAML workflows, running entirely on your
own machine via a local [Ollama](https://ollama.com) model. No API keys, no
billing, no cloud calls — everything stays offline.

## Prerequisites

- [Node.js](https://nodejs.org) 18 or newer
- [Ollama](https://ollama.com/download) installed and running locally

## Setup

1. **Install Ollama**

   Download and install it from https://ollama.com/download (Windows, macOS,
   or Linux).

2. **Pull a model**

   Pick a model based on your machine's specs:

   | Machine | Recommended model |
   |---|---|
   | 8–16GB RAM, no GPU | `llama3.1:8b` or `qwen2.5:7b` |
   | 16GB+ RAM or dedicated GPU | `deepseek-coder-v2:16b` or `qwen2.5:14b` |

   ```bash
   ollama pull llama3.1:8b
   ```

3. **Start Ollama**

   Make sure Ollama is running before starting this app:

   ```bash
   ollama serve
   ```

   (If you installed the Ollama desktop app, just leave it open — it runs
   the server for you.)

4. **Configure this app**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` if you want a different port or a different model:

   ```
   PORT=3000
   OLLAMA_HOST=http://localhost:11434
   OLLAMA_MODEL=llama3.1:8b
   ```

5. **Install dependencies and start the app**

   ```bash
   npm install
   npm start
   ```

6. Open http://localhost:3000, paste a `.xaml` file's contents into the
   Review tab, and click **Run Review**.

## How it works

The server sends the XAML content to your local Ollama model via Ollama's
REST API (`POST /api/chat` at `http://localhost:11434`), asks it to return a
structured JSON review (overall score, category scores, findings), and
renders the result in the UI. If Ollama isn't running, the app will tell you
to start it — there is no fallback to any cloud API.

## Troubleshooting

- **Status badge shows "Ollama unreachable"** — make sure `ollama serve` (or
  the Ollama desktop app) is running, and that the model in `.env` has been
  pulled (`ollama pull <model>`).
- **Reviews come back malformed** — some smaller models don't always follow
  the JSON format instructions perfectly. Try a larger/better model (e.g.
  `deepseek-coder-v2:16b`) if you have the RAM for it.
