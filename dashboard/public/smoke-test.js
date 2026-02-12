/**
 * Smoke Test Results Page
 * Shows smoke test report and step-by-step results
 */

const POLL_INTERVAL = 5000;

async function fetchApi(endpoint) {
  try {
    const res = await fetch(endpoint);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function formatDuration(ms) {
  if (!ms) return '--';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '--';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function updateSmokeTestReport() {
  const report = await fetchApi('/api/smoke-test-report');

  if (!report || report.status === 'no_report') {
    document.getElementById('smoke-loading').textContent = 'No smoke test report available. Run in smoke mode to generate one.';

    // Update badge
    document.getElementById('smoke-badge').textContent = 'No Report';
    return;
  }

  // Update result badge
  const badge = document.getElementById('smoke-badge');
  if (report.overallResult === 'PASS') {
    badge.textContent = 'PASSED';
    badge.style.background = 'linear-gradient(135deg, #00c853, #69f0ae)';
  } else {
    badge.textContent = 'FAILED';
    badge.style.background = 'linear-gradient(135deg, #ff5252, #ff8a80)';
  }

  // Summary cards
  const resultEl = document.getElementById('overall-result');
  resultEl.textContent = report.overallResult;
  resultEl.className = `card-value ${report.overallResult === 'PASS' ? 'positive' : 'negative'}`;

  const passedEl = document.getElementById('steps-passed');
  passedEl.textContent = `${report.passedCount}/${report.totalSteps}`;

  const failedEl = document.getElementById('steps-failed');
  failedEl.textContent = report.failedCount || 0;
  failedEl.className = `card-value ${report.failedCount > 0 ? 'negative' : 'positive'}`;

  document.getElementById('duration').textContent = formatDuration(report.totalDurationMs);

  const walletBefore = document.getElementById('wallet-before');
  if (report.walletBalanceBefore !== undefined) {
    walletBefore.textContent = `${report.walletBalanceBefore.toFixed(4)} SOL`;
  }

  const netCost = document.getElementById('net-cost');
  if (report.netCostSol !== undefined) {
    netCost.textContent = `${report.netCostSol.toFixed(6)} SOL`;
    netCost.className = `card-value ${report.netCostSol > 0 ? 'negative' : 'positive'}`;
  }

  // Steps list
  const stepsList = document.getElementById('steps-list');
  if (report.steps && report.steps.length > 0) {
    stepsList.innerHTML = report.steps.map((step, index) => {
      const statusClass = step.status === 'passed' ? 'step-passed' : step.status === 'failed' ? 'step-failed' : 'step-running';
      const statusIcon = step.status === 'passed' ? '&#10003;' : step.status === 'failed' ? '&#10007;' : '&#8987;';
      const duration = step.durationMs ? formatDuration(step.durationMs) : '--';

      return `
        <div class="step-item ${statusClass}">
          <div class="step-number">${index + 1}</div>
          <div class="step-icon">${statusIcon}</div>
          <div class="step-info">
            <div class="step-name">${step.name}</div>
            <div class="step-details">${step.details || ''}</div>
          </div>
          <div class="step-duration">${duration}</div>
        </div>
      `;
    }).join('');
  } else {
    stepsList.innerHTML = '<div class="empty-state">No steps recorded</div>';
  }
}

async function updateHistory() {
  const data = await fetchApi('/api/run-history');
  if (!data || !data.runs) return;

  const smokeRuns = data.runs.filter(r => r.mode === 'smoke');
  const listEl = document.getElementById('history-list');
  if (!listEl) return;

  if (smokeRuns.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No previous smoke tests</div>';
    return;
  }

  listEl.innerHTML = smokeRuns.map(run => {
    const statusClass = run.status === 'completed' ? 'positive' : 'negative';
    return `
      <div class="run-history-item">
        <div class="run-mode">Smoke Test</div>
        <div class="run-summary">${run.summary || '--'}</div>
        <div class="run-status ${statusClass}">${run.status}</div>
        <div class="run-time">${formatTimeAgo(run.startedAt)}</div>
      </div>
    `;
  }).join('');
}

async function updateAll() {
  await Promise.all([
    updateSmokeTestReport(),
    updateHistory(),
  ]);
}

// Initial load
updateAll();

// Poll for updates (useful when smoke test is running)
setInterval(updateAll, POLL_INTERVAL);
