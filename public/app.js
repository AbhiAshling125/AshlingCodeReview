const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const reviewBtn = document.getElementById("review-btn");
const errorBox = document.getElementById("error-box");
const resultsPanel = document.getElementById("results-panel");
const overallScoreEl = document.getElementById("overall-score");
const summaryTextEl = document.getElementById("summary-text");
const categoriesEl = document.getElementById("categories");
const findingsEl = document.getElementById("findings");

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

function severityRank(severity) {
  return { high: 0, medium: 1, low: 2 }[severity] ?? 3;
}

function renderResults(review) {
  overallScoreEl.textContent = review.overallScore ?? "–";
  summaryTextEl.textContent = review.summary ?? "";

  categoriesEl.innerHTML = "";
  (review.categories || []).forEach((cat) => {
    const card = document.createElement("div");
    card.className = "category-card";
    card.innerHTML = `
      <div class="cat-name">${escapeHtml(cat.name)} — <span class="cat-score">${cat.score}</span></div>
      <div class="cat-comments">${escapeHtml(cat.comments || "")}</div>
    `;
    categoriesEl.appendChild(card);
  });

  findingsEl.innerHTML = "";
  const findings = [...(review.findings || [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );
  if (findings.length === 0) {
    findingsEl.innerHTML = `<p style="color: var(--muted)">No findings — nice and clean.</p>`;
  }
  findings.forEach((finding) => {
    const card = document.createElement("div");
    const severity = finding.severity || "low";
    card.className = `finding-card ${severity}`;
    card.innerHTML = `
      <div class="finding-title">
        <span class="severity-tag ${severity}">${severity}</span>
        ${escapeHtml(finding.title || "")}
      </div>
      <div class="finding-desc">${escapeHtml(finding.description || "")}</div>
      <div class="finding-rec"><strong>Recommendation:</strong> ${escapeHtml(finding.recommendation || "")}</div>
    `;
    findingsEl.appendChild(card);
  });

  resultsPanel.hidden = false;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

reviewBtn.addEventListener("click", async () => {
  const fileName = document.getElementById("filename").value.trim() || "Untitled.xaml";
  const xaml = document.getElementById("xaml-input").value;

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
  } catch (err) {
    errorBox.hidden = false;
    errorBox.textContent = err.message;
    resultsPanel.hidden = true;
  } finally {
    reviewBtn.disabled = false;
    reviewBtn.textContent = "Run Review";
  }
});

refreshStatus();
setInterval(refreshStatus, 10000);
