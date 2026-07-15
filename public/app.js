/* ---------- Persistent local state (History / Trends / Clients & People / Rules) ----------
   The backend (server.js) only exposes /api/health and /api/review — it has no storage for
   history, clients, people, or rules. Those features are implemented client-side against
   localStorage so the Review tab's real AI integration stays untouched. */

const STORAGE_KEY = "uipathReviewer.v1";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw);
    return {
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      people: Array.isArray(parsed.people) ? parsed.people : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    };
  } catch {
    return { reviews: [], clients: [], people: [], rules: [] };
  }
}

const state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* ---------- Shared severity / status mapping ----------
   Server always returns finding.severity as "high" | "medium" | "low". We map those to the
   critical/warning/info badge vocabulary used consistently across Review, History, and the
   exported report. Category "pass" status is derived from score thresholds. */

function severityToBadge(severity) {
  return { high: "critical", medium: "warning", low: "info" }[severity] || "info";
}

function severityRank(severity) {
  return { high: 0, medium: 1, low: 2 }[severity] ?? 3;
}

function scoreStatus(score) {
  if (score >= 80) return "pass";
  if (score >= 50) return "warning";
  return "critical";
}

/* ---------- Shared render helpers (used by Review tab, History modal, and export HTML) ---------- */

function renderScoreRingHtml(score, size) {
  const status = scoreStatus(score);
  const sizeClass = size === "sm" ? " sm" : "";
  return `<div class="score-ring${sizeClass} ${status}">${score ?? "–"}</div>`;
}

function renderCategoryCardHtml(cat) {
  return `
    <div class="category-card">
      <div class="cat-name"><span>${escapeHtml(cat.name)}</span><span class="cat-score">${cat.score}</span></div>
      <div class="cat-comments">${escapeHtml(cat.comments || "")}</div>
    </div>
  `;
}

function renderFindingCardHtml(finding) {
  const badge = severityToBadge(finding.severity);
  return `
    <div class="finding-card ${badge}">
      <div class="finding-title">
        <span class="severity-badge ${badge}">${escapeHtml(finding.severity || "low")}</span>
        ${escapeHtml(finding.title || "")}
      </div>
      <div class="finding-desc">${escapeHtml(finding.description || "")}</div>
      <div class="finding-rec"><strong>Recommendation:</strong> ${escapeHtml(finding.recommendation || "")}</div>
    </div>
  `;
}

function renderReviewBodyHtml(record) {
  const categories = record.categories || [];
  const findings = [...(record.findings || [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );

  const meta = [];
  if (record.fileName) meta.push(escapeHtml(record.fileName));
  if (record.developerName) meta.push(`Developer: ${escapeHtml(record.developerName)}`);
  if (record.reviewerName) meta.push(`Reviewer: ${escapeHtml(record.reviewerName)}`);
  if (record.clientName) meta.push(`Client: ${escapeHtml(record.clientName)}`);
  if (record.timestamp) meta.push(new Date(record.timestamp).toLocaleString());

  return `
    <p class="review-meta">${meta.join(" · ")}</p>
    <div class="score-summary">
      ${renderScoreRingHtml(record.overallScore)}
      <p class="summary-text">${escapeHtml(record.summary || "")}</p>
    </div>
    <h3>Category Scores</h3>
    <div class="categories">${categories.map(renderCategoryCardHtml).join("")}</div>
    <h3>Findings</h3>
    <div class="findings">${
      findings.length
        ? findings.map(renderFindingCardHtml).join("")
        : `<p class="empty-state">No findings — nice and clean.</p>`
    }</div>
  `;
}

/* ---------- Tab switching ---------- */

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    tabPanels.forEach((p) => p.classList.toggle("active", p.id === `tab-${target}`));
    if (target === "history") renderHistoryTab();
    if (target === "trends") renderTrendsTab();
    if (target === "progress") renderProgressTab();
    if (target === "people") renderPeopleTab();
    if (target === "rules") renderRulesTab();
  });
});

/* ---------- Modal ---------- */

const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalFooter = document.getElementById("modal-footer");
const modalCloseBtn = document.getElementById("modal-close-btn");

function openModal(title, bodyHtml, footerButtons = []) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalFooter.innerHTML = "";
  footerButtons.forEach((btn) => modalFooter.appendChild(btn));
  modalOverlay.hidden = false;
}

function closeModal() {
  modalOverlay.hidden = true;
  modalBody.innerHTML = "";
  modalFooter.innerHTML = "";
}

modalCloseBtn.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

/* ---------- Review tab ---------- */

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const reviewBtn = document.getElementById("review-btn");
const errorBox = document.getElementById("error-box");
const resultsPanel = document.getElementById("results-panel");
const overallScoreEl = document.getElementById("overall-score");
const summaryTextEl = document.getElementById("summary-text");
const categoriesEl = document.getElementById("categories");
const findingsEl = document.getElementById("findings");
const exportBtn = document.getElementById("export-btn");
const clientSelect = document.getElementById("client-select");
const reviewerSelect = document.getElementById("reviewer-select");
const developerSelect = document.getElementById("developer-select");

let lastReviewRecord = null;

async function refreshStatus() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.ollamaReachable) {
      statusDot.className = "status-dot online";
      statusText.textContent = `${data.model} (local)`;
    } else {
      statusDot.className = "status-dot offline";
      statusText.textContent = "Ollama unreachable";
    }
  } catch {
    statusDot.className = "status-dot offline";
    statusText.textContent = "Server unreachable";
  }
}

function renderResults(review) {
  overallScoreEl.className = `score-ring ${scoreStatus(review.overallScore)}`;
  overallScoreEl.textContent = review.overallScore ?? "–";
  summaryTextEl.textContent = review.summary ?? "";

  categoriesEl.innerHTML = (review.categories || []).map(renderCategoryCardHtml).join("");

  const findings = [...(review.findings || [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );
  findingsEl.innerHTML = findings.length
    ? findings.map(renderFindingCardHtml).join("")
    : `<p class="empty-state">No findings — nice and clean.</p>`;

  resultsPanel.hidden = false;
}

reviewBtn.addEventListener("click", async () => {
  const fileName = document.getElementById("filename").value.trim() || "Untitled.xaml";
  const xaml = document.getElementById("xaml-input").value;
  const clientId = clientSelect.value;
  const reviewerId = reviewerSelect.value;
  const developerId = developerSelect.value;

  errorBox.hidden = true;
  errorBox.textContent = "";

  if (!xaml.trim()) {
    errorBox.hidden = false;
    errorBox.textContent = "Please paste some XAML content first.";
    return;
  }

  reviewBtn.disabled = true;
  reviewBtn.textContent = "Reviewing…";

  try {
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, xaml }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Review failed.");
    }

    renderResults(data.review);

    const client = state.clients.find((c) => c.id === clientId);
    const reviewerPerson = state.people.find((p) => p.id === reviewerId);
    const developerPerson = state.people.find((p) => p.id === developerId);

    lastReviewRecord = {
      id: uid(),
      fileName,
      xaml,
      model: data.model,
      timestamp: Date.now(),
      clientId: clientId || null,
      clientName: client ? client.name : null,
      reviewerId: reviewerId || null,
      reviewerName: reviewerPerson ? reviewerPerson.name : null,
      developerId: developerId || null,
      developerName: developerPerson ? developerPerson.name : null,
      overallScore: data.review.overallScore,
      summary: data.review.summary,
      categories: data.review.categories || [],
      findings: data.review.findings || [],
    };

    state.reviews.unshift(lastReviewRecord);
    state.reviews = state.reviews.slice(0, 50);
    saveState();
  } catch (err) {
    errorBox.hidden = false;
    errorBox.textContent = err.message;
    resultsPanel.hidden = true;
    lastReviewRecord = null;
  } finally {
    reviewBtn.disabled = false;
    reviewBtn.textContent = "Run Review";
  }
});

/* ---------- Export (shared HTML report generator) ---------- */

function buildReportHtml(record) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Review report — ${escapeHtml(record.fileName)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@500&family=Inter:wght@400;600;700&family=Instrument+Sans:wght@600&display=swap" rel="stylesheet" />
<style>
  /* Ashling Partners brand palette — see index.html for the full token
     rationale (functional red/olive exceptions for Critical/Warning). */
  body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #e5ffff; color: #192931; padding: 32px; }
  .report { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #dcece9; border-radius: 4px 26px 26px 26px; padding: 24px; box-shadow: 0 1px 3px rgba(7,28,23,0.08); }
  h1 { font-family: "Instrument Sans", sans-serif; font-size: 1.2rem; font-weight: 600; color: #192931; }
  h3 { font-family: "DM Mono", monospace; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; color: #4c5e64; margin: 24px 0 12px; font-weight: 500; }
  .review-meta { color: #4c5e64; font-size: 0.82rem; margin: 0 0 12px; }
  .summary-text { color: #4c5e64; line-height: 1.55; margin: 0; }
  .score-summary { display: flex; align-items: center; gap: 24px; }
  .score-ring { width: 68px; height: 68px; border-radius: 50%; border: 3px solid #60d086; background: rgba(96,208,134,0.14); display: flex; align-items: center; justify-content: center; font-family: "DM Mono", monospace; font-size: 1.15rem; font-weight: 700; color: #007538; flex-shrink: 0; }
  .score-ring.pass { border-color: #007538; background: rgba(0,117,56,0.08); color: #007538; }
  .score-ring.warning { border-color: #264600; background: #eafcd4; color: #264600; }
  .score-ring.critical { border-color: #d6455a; background: rgba(214,69,90,0.1); color: #d6455a; }
  .categories { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .category-card { border: 1px solid #dcece9; background: #f8f8f8; border-radius: 10px; padding: 12px 16px; }
  .cat-name { font-weight: 600; font-size: 0.85rem; display: flex; justify-content: space-between; gap: 8px; }
  .cat-score { color: #007538; font-family: "DM Mono", monospace; }
  .cat-comments { color: #4c5e64; font-size: 0.8rem; margin-top: 4px; }
  .findings { display: flex; flex-direction: column; gap: 12px; }
  .finding-card { border: 1px solid #dcece9; border-left: 4px solid #4c5e64; background: #f8f8f8; border-radius: 10px; padding: 12px 16px; }
  .finding-card.critical { border-left-color: #d6455a; }
  .finding-card.warning { border-left-color: #264600; }
  .finding-card.info { border-left-color: #007538; }
  .finding-card.pass { border-left-color: #007538; }
  .finding-title { font-weight: 600; font-size: 0.9rem; display: flex; align-items: center; gap: 8px; }
  .severity-badge { font-family: "DM Mono", monospace; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 9px; border-radius: 999px; font-weight: 500; }
  .severity-badge.critical { background: rgba(214,69,90,0.1); color: #d6455a; }
  .severity-badge.warning { background: #eafcd4; color: #264600; }
  .severity-badge.info { background: rgba(0,117,56,0.08); color: #007538; }
  .severity-badge.pass { background: rgba(0,117,56,0.08); color: #007538; }
  .finding-desc, .finding-rec { font-size: 0.84rem; color: #4c5e64; margin-top: 4px; }
  .finding-rec strong { color: #192931; }
</style>
</head>
<body>
  <div class="report">
    <h1>UiPath Code Reviewer Enterprise — Review Report</h1>
    ${renderReviewBodyHtml(record)}
  </div>
</body>
</html>`;
}

function downloadReport(record) {
  const html = buildReportHtml(record);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(record.fileName || "review").replace(/\.xaml$/i, "")}-report.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openExportModal(record) {
  const downloadBtn = document.createElement("button");
  downloadBtn.className = "btn btn-primary";
  downloadBtn.type = "button";
  downloadBtn.textContent = "Download HTML report";
  downloadBtn.addEventListener("click", () => downloadReport(record));

  openModal(
    "Export preview",
    `<div class="panel" style="box-shadow:none;">${renderReviewBodyHtml(record)}</div>`,
    [downloadBtn]
  );
}

exportBtn.addEventListener("click", () => {
  if (!lastReviewRecord) return;
  openExportModal(lastReviewRecord);
});

/* ---------- History tab ---------- */

const historyListEl = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history-btn");

function renderHistoryTab() {
  if (state.reviews.length === 0) {
    historyListEl.innerHTML = `<p class="empty-state">No reviews yet — run one from the Review tab.</p>`;
    return;
  }

  historyListEl.innerHTML = "";
  state.reviews.forEach((record) => {
    const row = document.createElement("div");
    row.className = "history-row";
    row.tabIndex = 0;

    const status = scoreStatus(record.overallScore);
    const meta = [new Date(record.timestamp).toLocaleString()];
    if (record.developerName) meta.push(`Dev: ${record.developerName}`);
    if (record.clientName) meta.push(record.clientName);
    if (record.reviewerName) meta.push(record.reviewerName);

    row.innerHTML = `
      ${renderScoreRingHtml(record.overallScore, "sm")}
      <div class="history-main">
        <div class="history-file">${escapeHtml(record.fileName)}</div>
        <div class="history-meta">${meta.map(escapeHtml).join(" · ")}</div>
      </div>
      <span class="severity-badge ${status}">${status}</span>
    `;

    const openDetail = () => {
      const exportHistBtn = document.createElement("button");
      exportHistBtn.className = "btn btn-secondary";
      exportHistBtn.type = "button";
      exportHistBtn.textContent = "Export HTML report";
      exportHistBtn.addEventListener("click", () => downloadReport(record));

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn btn-tertiary";
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => {
        state.reviews = state.reviews.filter((r) => r.id !== record.id);
        saveState();
        closeModal();
        renderHistoryTab();
      });

      openModal(record.fileName, renderReviewBodyHtml(record), [deleteBtn, exportHistBtn]);
    };

    row.addEventListener("click", openDetail);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail();
      }
    });

    historyListEl.appendChild(row);
  });
}

clearHistoryBtn.addEventListener("click", () => {
  if (state.reviews.length === 0) return;
  if (!confirm("Clear all saved review history? This can't be undone.")) return;
  state.reviews = [];
  saveState();
  renderHistoryTab();
});

/* ---------- Trends tab ---------- */

function renderTrendsTab() {
  const reviews = state.reviews;
  const total = reviews.length;
  const avg = total ? Math.round(reviews.reduce((s, r) => s + (r.overallScore || 0), 0) / total) : null;
  const criticalCount = reviews.reduce(
    (sum, r) => sum + (r.findings || []).filter((f) => f.severity === "high").length,
    0
  );
  const latest = total ? reviews[0].overallScore : null;

  document.getElementById("stat-total").textContent = total;
  document.getElementById("stat-avg").textContent = avg ?? "–";
  document.getElementById("stat-critical").textContent = criticalCount;
  document.getElementById("stat-latest").textContent = latest ?? "–";

  renderTrendChart(reviews, "trend-chart", 200);
  renderCategoryTrends(reviews, "category-trends");
}

function renderTrendChart(reviews, svgId, height) {
  const svg = document.getElementById(svgId);
  const ordered = [...reviews].reverse().slice(-20);

  if (ordered.length < 2) {
    svg.innerHTML = `<text x="20" y="${height / 2}" fill="#4c5e64" font-size="13">Run at least two reviews to see a trend line.</text>`;
    return;
  }

  const width = 640;
  const padding = 20;
  const step = (width - padding * 2) / (ordered.length - 1);

  const points = ordered.map((r, i) => {
    const x = padding + i * step;
    const y = height - padding - ((r.overallScore || 0) / 100) * (height - padding * 2);
    return `${x},${y}`;
  });

  const circles = ordered
    .map((r, i) => {
      const [x, y] = points[i].split(",");
      return `<circle cx="${x}" cy="${y}" r="3.5" fill="#007538" />`;
    })
    .join("");

  svg.innerHTML = `
    <polyline points="${points.join(" ")}" fill="none" stroke="#007538" stroke-width="2" />
    ${circles}
  `;
}

function renderCategoryTrends(reviews, elId) {
  const el = document.getElementById(elId);
  if (reviews.length === 0) {
    el.innerHTML = `<p class="empty-state">No category data yet.</p>`;
    return;
  }

  const sums = {};
  const counts = {};
  reviews.forEach((r) => {
    (r.categories || []).forEach((cat) => {
      sums[cat.name] = (sums[cat.name] || 0) + cat.score;
      counts[cat.name] = (counts[cat.name] || 0) + 1;
    });
  });

  el.innerHTML = Object.keys(sums)
    .map((name) => {
      const avg = Math.round(sums[name] / counts[name]);
      return renderCategoryCardHtml({ name, score: avg, comments: `Averaged across ${counts[name]} review${counts[name] === 1 ? "" : "s"}` });
    })
    .join("");
}

/* ---------- Developer Progress tab ---------- */

const TRAINING_SUGGESTIONS = {
  "naming conventions": "Naming & readability standards — REFramework variable/activity naming conventions.",
  "error handling": "Exception handling patterns — Try Catch scopes, Retry Scope, and avoiding swallowed exceptions.",
  "hardcoded values": "Configuration-driven design — externalizing values via Config files and Orchestrator Assets.",
  "logging": "Structured logging practices — meaningful Log Message levels, including in catch blocks.",
  "performance": "Automation performance tuning — reducing Delays, optimizing UI Automation, avoiding unbounded loops.",
  "maintainability": "Workflow modularity — breaking down long sequences, effective use of Invoke Workflow.",
  "security": "Secure credential handling — Orchestrator Credential/Asset stores, avoiding plaintext secrets.",
};

function trainingSuggestionFor(categoryName) {
  return TRAINING_SUGGESTIONS[categoryName.toLowerCase()] || `Review UiPath best practices for ${categoryName}.`;
}

const progressDeveloperSelect = document.getElementById("progress-developer-select");
const progressEmptyEl = document.getElementById("progress-empty");
const progressContentEl = document.getElementById("progress-content");

function populateProgressDeveloperSelect() {
  const developedIds = new Set(state.reviews.filter((r) => r.developerId).map((r) => r.developerId));
  const developers = state.people.filter((p) => developedIds.has(p.id));
  const previousValue = progressDeveloperSelect.value;

  progressDeveloperSelect.innerHTML =
    `<option value="">Select a developer…</option>` +
    developers.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");

  if (developers.some((p) => p.id === previousValue)) {
    progressDeveloperSelect.value = previousValue;
  } else if (developers.length === 1) {
    progressDeveloperSelect.value = developers[0].id;
  }
}

function computeTrend(scores) {
  if (scores.length < 2) return { label: "Not enough data", cls: "" };
  const mid = Math.floor(scores.length / 2);
  const earlier = scores.slice(0, mid);
  const later = scores.slice(mid);
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const delta = avg(later) - avg(earlier);

  if (delta >= 4) return { label: "↑ Improving", cls: "pass" };
  if (delta <= -4) return { label: "↓ Declining", cls: "critical" };
  return { label: "→ Steady", cls: "warning" };
}

function renderProgressForDeveloper(developerId) {
  const reviews = state.reviews.filter((r) => r.developerId === developerId);

  if (reviews.length === 0) {
    progressEmptyEl.hidden = false;
    progressContentEl.hidden = true;
    return;
  }

  progressEmptyEl.hidden = true;
  progressContentEl.hidden = false;

  const chronological = [...reviews].reverse();
  const scores = chronological.map((r) => r.overallScore || 0);
  const avg = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
  const trend = computeTrend(scores);

  document.getElementById("progress-total").textContent = reviews.length;
  document.getElementById("progress-avg").textContent = avg;
  document.getElementById("progress-latest").textContent = reviews[0].overallScore ?? "–";

  const trendEl = document.getElementById("progress-trend");
  trendEl.innerHTML = trend.cls
    ? `<span class="severity-badge ${trend.cls}">${trend.label}</span>`
    : trend.label;

  renderTrendChart(reviews, "progress-chart", 180);
  renderCategoryTrends(reviews, "progress-categories");

  // Recurring issues: group findings by title across this developer's reviews.
  // `reviews` is already newest-first, so the first occurrence encountered per
  // key is the most recent one — its wording is what we keep.
  const groups = new Map();
  reviews.forEach((r) => {
    (r.findings || []).forEach((f) => {
      const key = (f.title || "Untitled finding").trim().toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { title: f.title, severity: f.severity, description: f.description, recommendation: f.recommendation, count: 0 });
      }
      groups.get(key).count += 1;
    });
  });

  const recurring = [...groups.values()]
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 8);

  const recurringEl = document.getElementById("progress-recurring");
  recurringEl.innerHTML = recurring.length
    ? recurring
        .map((entry) => {
          const badge = severityToBadge(entry.severity);
          return `
            <div class="finding-card ${badge}">
              <div class="finding-title">
                <span class="severity-badge ${badge}">${escapeHtml(entry.severity || "low")}</span>
                ${escapeHtml(entry.title || "")}
                <span class="severity-badge warning">×${entry.count}</span>
              </div>
              <div class="finding-desc">${escapeHtml(entry.description || "")}</div>
              <div class="finding-rec"><strong>Recommendation:</strong> ${escapeHtml(entry.recommendation || "")}</div>
            </div>
          `;
        })
        .join("")
    : `<p class="empty-state">No repeated findings yet — nothing showing up more than once across their reviews.</p>`;

  // Suggested upskilling: categories averaging below 70.
  const catSums = {};
  const catCounts = {};
  reviews.forEach((r) => {
    (r.categories || []).forEach((cat) => {
      catSums[cat.name] = (catSums[cat.name] || 0) + cat.score;
      catCounts[cat.name] = (catCounts[cat.name] || 0) + 1;
    });
  });

  const weakCategories = Object.keys(catSums)
    .map((name) => ({ name, avg: Math.round(catSums[name] / catCounts[name]) }))
    .filter((c) => c.avg < 70)
    .sort((a, b) => a.avg - b.avg);

  const suggestionsEl = document.getElementById("progress-suggestions");
  suggestionsEl.innerHTML = weakCategories.length
    ? weakCategories
        .map(
          (c) => `
            <div class="finding-card warning">
              <div class="finding-title">
                <span class="severity-badge warning">focus area</span>
                ${escapeHtml(c.name)} — avg ${c.avg}
              </div>
              <div class="finding-desc">${escapeHtml(trainingSuggestionFor(c.name))}</div>
            </div>
          `
        )
        .join("")
    : `<p class="empty-state">No category is consistently scoring low — no specific training gaps flagged yet.</p>`;

  // Review history for this developer, reusing the same clickable row pattern as History tab.
  const historyEl = document.getElementById("progress-history");
  historyEl.innerHTML = "";
  reviews.forEach((record) => {
    const row = document.createElement("div");
    row.className = "history-row";
    row.tabIndex = 0;
    const status = scoreStatus(record.overallScore);
    const meta = [new Date(record.timestamp).toLocaleString()];
    if (record.reviewerName) meta.push(`Reviewer: ${record.reviewerName}`);

    row.innerHTML = `
      ${renderScoreRingHtml(record.overallScore, "sm")}
      <div class="history-main">
        <div class="history-file">${escapeHtml(record.fileName)}</div>
        <div class="history-meta">${meta.map(escapeHtml).join(" · ")}</div>
      </div>
      <span class="severity-badge ${status}">${status}</span>
    `;

    row.addEventListener("click", () => openModal(record.fileName, renderReviewBodyHtml(record), []));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openModal(record.fileName, renderReviewBodyHtml(record), []);
      }
    });

    historyEl.appendChild(row);
  });
}

function renderProgressTab() {
  populateProgressDeveloperSelect();
  if (progressDeveloperSelect.value) {
    renderProgressForDeveloper(progressDeveloperSelect.value);
  } else {
    progressEmptyEl.hidden = false;
    progressContentEl.hidden = true;
  }
}

progressDeveloperSelect.addEventListener("change", () => {
  if (progressDeveloperSelect.value) {
    renderProgressForDeveloper(progressDeveloperSelect.value);
  } else {
    progressEmptyEl.hidden = false;
    progressContentEl.hidden = true;
  }
});

/* ---------- Clients & People tab ---------- */

const clientInput = document.getElementById("client-input");
const addClientBtn = document.getElementById("add-client-btn");
const clientListEl = document.getElementById("client-list");

const personInput = document.getElementById("person-input");
const addPersonBtn = document.getElementById("add-person-btn");
const personListEl = document.getElementById("person-list");

function renderListRow(name, onRemove) {
  const row = document.createElement("div");
  row.className = "list-row";
  row.innerHTML = `<div class="list-main"><div class="list-name">${escapeHtml(name)}</div></div>`;
  const removeBtn = document.createElement("button");
  removeBtn.className = "btn btn-tertiary btn-sm";
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", onRemove);
  row.appendChild(removeBtn);
  return row;
}

function renderPeopleTab() {
  clientListEl.innerHTML = "";
  if (state.clients.length === 0) {
    clientListEl.innerHTML = `<p class="empty-state">No clients yet.</p>`;
  } else {
    state.clients.forEach((c) => {
      clientListEl.appendChild(
        renderListRow(c.name, () => {
          state.clients = state.clients.filter((x) => x.id !== c.id);
          saveState();
          renderPeopleTab();
          populateSelectors();
        })
      );
    });
  }

  personListEl.innerHTML = "";
  if (state.people.length === 0) {
    personListEl.innerHTML = `<p class="empty-state">No people yet.</p>`;
  } else {
    state.people.forEach((p) => {
      personListEl.appendChild(
        renderListRow(p.name, () => {
          state.people = state.people.filter((x) => x.id !== p.id);
          saveState();
          renderPeopleTab();
          populateSelectors();
        })
      );
    });
  }
}

function addClient() {
  const name = clientInput.value.trim();
  if (!name) return;
  state.clients.push({ id: uid(), name });
  saveState();
  clientInput.value = "";
  renderPeopleTab();
  populateSelectors();
}

function addPerson() {
  const name = personInput.value.trim();
  if (!name) return;
  state.people.push({ id: uid(), name });
  saveState();
  personInput.value = "";
  renderPeopleTab();
  populateSelectors();
}

addClientBtn.addEventListener("click", addClient);
clientInput.addEventListener("keydown", (e) => e.key === "Enter" && addClient());
addPersonBtn.addEventListener("click", addPerson);
personInput.addEventListener("keydown", (e) => e.key === "Enter" && addPerson());

function populateSelectors() {
  clientSelect.innerHTML = `<option value="">— None —</option>` +
    state.clients.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  const peopleOptions = state.people.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  reviewerSelect.innerHTML = `<option value="">— None —</option>` + peopleOptions;
  developerSelect.innerHTML = `<option value="">— None —</option>` + peopleOptions;
}

/* ---------- Rules tab ---------- */

const ruleInput = document.getElementById("rule-input");
const addRuleBtn = document.getElementById("add-rule-btn");
const ruleListEl = document.getElementById("rule-list");

function renderRulesTab() {
  ruleListEl.innerHTML = "";
  if (state.rules.length === 0) {
    ruleListEl.innerHTML = `<p class="empty-state">No custom rules yet.</p>`;
    return;
  }

  state.rules.forEach((rule) => {
    const row = document.createElement("div");
    row.className = "rule-row";
    row.innerHTML = `<div class="rule-text">${escapeHtml(rule.text)}</div>`;
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn-tertiary btn-sm";
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      state.rules = state.rules.filter((r) => r.id !== rule.id);
      saveState();
      renderRulesTab();
    });
    row.appendChild(removeBtn);
    ruleListEl.appendChild(row);
  });
}

function addRule() {
  const text = ruleInput.value.trim();
  if (!text) return;
  state.rules.push({ id: uid(), text });
  saveState();
  ruleInput.value = "";
  renderRulesTab();
}

addRuleBtn.addEventListener("click", addRule);
ruleInput.addEventListener("keydown", (e) => e.key === "Enter" && addRule());

/* ---------- Init ---------- */

populateSelectors();
refreshStatus();
setInterval(refreshStatus, 10000);
