require("dotenv").config();

const express = require("express");
const path = require("path");

const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const SYSTEM_PROMPT = `You are a senior UiPath RPA developer performing a code review of a UiPath XAML workflow file. You review for:

- Naming conventions (activities, variables, arguments should be descriptive, PascalCase for names)
- Error handling (Try Catch blocks around risky activities, retry scopes, no swallowed exceptions)
- Hardcoded values (URLs, file paths, credentials, or selectors that should be in config/arguments/assets)
- Logging (meaningful Log Message activities at key steps, no missing logging in catch blocks)
- Performance (avoiding unnecessary Delay activities, redundant UI Automation, unbounded loops)
- Maintainability (workflow modularity, use of invoke workflow, avoiding overly long/nested sequences)
- Security (no plaintext credentials or secrets, proper use of Orchestrator assets/credential stores)

You must respond with ONLY a single valid JSON object (no prose, no markdown fences) matching exactly this shape:

{
  "overallScore": <integer 0-100>,
  "summary": "<2-4 sentence overall summary>",
  "categories": [
    { "name": "<category name>", "score": <integer 0-100>, "comments": "<short assessment>" }
  ],
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "title": "<short title>",
      "description": "<what the issue is>",
      "recommendation": "<how to fix it>"
    }
  ]
}

Include one category entry for each of: Naming Conventions, Error Handling, Hardcoded Values, Logging, Performance, Maintainability, Security. List findings in descending order of severity.`;

function buildUserPrompt(fileName, xaml) {
  return `Review the following UiPath workflow file named "${fileName}".\n\n\`\`\`xml\n${xaml}\n\`\`\``;
}

function isTransientError(err) {
  const code = err?.cause?.code || err?.code;
  if (code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  if (typeof err?.status === "number" && err.status >= 500) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOllama(systemPrompt, userPrompt) {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      format: "json",
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`Ollama request failed with status ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  return data?.message?.content ?? "";
}

function extractReviewJson(raw) {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("The model's response did not contain a valid JSON object.");
  }
  return JSON.parse(match[0]);
}

async function runAIReview(fileName, xaml) {
  const userPrompt = buildUserPrompt(fileName, xaml);
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await callOllama(SYSTEM_PROMPT, userPrompt);
      return extractReviewJson(raw);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isTransientError(err)) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      break;
    }
  }

  const code = lastError?.cause?.code || lastError?.code;
  if (code === "ECONNREFUSED") {
    throw new Error(
      "Could not reach Ollama at localhost:11434 — make sure Ollama is running (`ollama serve` or the Ollama desktop app)."
    );
  }
  throw lastError;
}

async function checkOllamaReachable() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

app.get("/api/health", async (req, res) => {
  const ollamaReachable = await checkOllamaReachable();
  res.json({ status: "ok", model: OLLAMA_MODEL, ollamaReachable });
});

app.post("/api/review", async (req, res) => {
  const { fileName, xaml } = req.body || {};

  if (!xaml || typeof xaml !== "string" || !xaml.trim()) {
    return res.status(400).json({ error: "Please provide XAML content to review." });
  }

  try {
    const review = await runAIReview(fileName || "Untitled.xaml", xaml);
    res.json({ model: OLLAMA_MODEL, review });
  } catch (err) {
    res.status(502).json({ error: err.message || "Review failed." });
  }
});

app.listen(PORT, () => {
  console.log(`UiPath Code Reviewer Enterprise listening on http://localhost:${PORT}`);
  console.log(`Using local Ollama model "${OLLAMA_MODEL}" at ${OLLAMA_HOST}`);
});
