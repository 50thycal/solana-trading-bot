/**
 * Smoke Test Results Page
 * Shows smoke test report with full step-by-step detail and clickable history
 */

const POLL_INTERVAL = 5000;

// Track whether the user is viewing a historical report (null = current)
let viewingReportId = null;

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

function formatDate(timestamp) {
  if (!timestamp) return '--';
  return new Date(timestamp).toLocaleString();
}

function formatPnl(value) {
  if (value === null || value === undefined) return '--';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(4)} SOL`;
}

function pnlClass(value) {
  if (value === null || value === undefined) return '';
  return value >= 0 ? 'positive' : 'negative';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Render live progress of a running smoke test
 */
function renderProgress(progress) {
  const badge = document.getElementById('smoke-badge');
  badge.textContent = 'RUNNING';
  badge.style.background = 'linear-gradient(135deg, #ff9800, #ffcc02)';

  document.getElementById('overall-result').textContent = 'Running...';
  document.getElementById('overall-result').className = 'card-value';

  document.getElementById('pnl-value').textContent = '--';
  document.getElementById('steps-passed').textContent = '--';
  document.getElementById('steps-failed').textContent = '--';
  document.getElementById('steps-failed').className = 'card-value';

  const elapsed = Date.now() - progress.startedAt;
  document.getElementById('duration').textContent = formatDuration(elapsed);
  document.getElementById('exit-trigger').textContent = progress.currentStep;

  const walletBefore = document.getElementById('wallet-before');
  if (progress.walletBalanceBefore > 0) {
    walletBefore.textContent = `${progress.walletBalanceBefore.toFixed(4)} SOL`;
  } else {
    walletBefore.textContent = '--';
  }

  document.getElementById('net-cost').textContent = '--';

  // Steps list from live progress
  const stepsList = document.getElementById('steps-list');
  if (progress.steps && progress.steps.length > 0) {
    stepsList.innerHTML = progress.steps.map((step, index) => {
      const statusClass = step.status === 'passed' ? 'step-passed'
        : step.status === 'failed' ? 'step-failed'
        : step.status === 'running' ? 'step-running'
        : 'step-pending';
      const statusIcon = step.status === 'passed' ? '&#10003;'
        : step.status === 'failed' ? '&#10007;'
        : step.status === 'running' ? '&#9679;'
        : '&#8943;';
      const duration = step.durationMs ? formatDuration(step.durationMs) : '--';

      return `
        <div class="step-item ${statusClass}">
          <div class="step-number">${index + 1}</div>
          <div class="step-icon">${statusIcon}</div>
          <div class="step-info">
            <div class="step-name">${escapeHtml(step.name)}</div>
            <div class="step-details">${escapeHtml(step.details || (step.status === 'running' ? 'In progress...' : ''))}</div>
          </div>
          <div class="step-duration">${duration}</div>
        </div>
      `;
    }).join('');
  }

  // Show tokens evaluated / pipeline passed in a status line
  const tokensInfo = [];
  if (progress.tokensEvaluated > 0) tokensInfo.push(`${progress.tokensEvaluated} tokens evaluated`);
  if (progress.tokensPipelinePassed > 0) tokensInfo.push(`${progress.tokensPipelinePassed} passed pipeline`);
  if (progress.buyFailures > 0) tokensInfo.push(`${progress.buyFailures} buy failures`);

  if (tokensInfo.length > 0) {
    const existingInfo = document.getElementById('progress-info');
    if (existingInfo) {
      existingInfo.textContent = tokensInfo.join(' | ');
    }
  }

  // Hide buy failures panel during progress
  const buyFailuresPanel = document.getElementById('buy-failures-panel');
  if (buyFailuresPanel) buyFailuresPanel.style.display = 'none';
}

/**
 * Render a smoke test report into the UI (works for both current and historical)
 */
function renderReport(report) {
  if (!report || report.status === 'no_report') {
    document.getElementById('smoke-loading').textContent = 'No smoke test report available. Run in smoke mode to generate one.';
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

  // P&L (computed from net cost)
  const pnlEl = document.getElementById('pnl-value');
  if (report.netCostSol !== undefined) {
    const pnl = -report.netCostSol; // negative netCost = profit
    pnlEl.textContent = formatPnl(pnl);
    pnlEl.className = `card-value big ${pnlClass(pnl)}`;
  } else {
    pnlEl.textContent = '--';
  }

  const passedEl = document.getElementById('steps-passed');
  passedEl.textContent = `${report.passedCount}/${report.totalSteps}`;

  const failedEl = document.getElementById('steps-failed');
  failedEl.textContent = report.failedCount || 0;
  failedEl.className = `card-value ${report.failedCount > 0 ? 'negative' : 'positive'}`;

  document.getElementById('duration').textContent = formatDuration(report.totalDurationMs);

  // Exit trigger
  const exitEl = document.getElementById('exit-trigger');
  if (report.exitTrigger) {
    exitEl.textContent = report.exitTrigger;
  } else {
    exitEl.textContent = '--';
  }

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
      const statusClass = step.status === 'passed' ? 'step-passed'
        : step.status === 'failed' ? 'step-failed'
        : step.status === 'skipped' ? 'step-skipped'
        : 'step-running';
      const statusIcon = step.status === 'passed' ? '&#10003;'
        : step.status === 'failed' ? '&#10007;'
        : step.status === 'skipped' ? '&#8212;'
        : '&#8987;';
      const duration = step.durationMs ? formatDuration(step.durationMs) : '--';

      return `
        <div class="step-item ${statusClass}">
          <div class="step-number">${index + 1}</div>
          <div class="step-icon">${statusIcon}</div>
          <div class="step-info">
            <div class="step-name">${escapeHtml(step.name)}</div>
            <div class="step-details">${escapeHtml(step.details || '')}</div>
          </div>
          <div class="step-duration">${duration}</div>
        </div>
      `;
    }).join('');
  } else {
    stepsList.innerHTML = '<div class="empty-state">No steps recorded</div>';
  }

  // Buy failures section
  const buyFailuresPanel = document.getElementById('buy-failures-panel');
  const buyFailuresList = document.getElementById('buy-failures-list');
  const buyFailuresCount = document.getElementById('buy-failures-count');

  if (report.buyFailures && report.buyFailures.length > 0) {
    buyFailuresPanel.style.display = 'block';
    buyFailuresCount.textContent = `${report.buyFailures.length} failed attempts before successful buy`;
    buyFailuresList.innerHTML = report.buyFailures.map(f => {
      return `
        <div class="buy-failure-item">
          <span class="buy-failure-mint">${escapeHtml((f.tokenSymbol || '') + ' ' + (f.tokenMint || '').substring(0, 12))}...</span>
          <span class="buy-failure-reason">${escapeHtml(f.reason || 'Unknown')}</span>
          <span>${formatTimeAgo(f.timestamp)}</span>
        </div>
      `;
    }).join('');
  } else {
    buyFailuresPanel.style.display = 'none';
  }
}

/**
 * Load and render the current (live) smoke test report or in-progress status
 */
async function updateSmokeTestReport() {
  // Don't overwrite when viewing a historical report
  if (viewingReportId !== null) return;

  const report = await fetchApi('/api/smoke-test-report');

  // If a completed report exists, render it
  if (report && report.status !== 'no_report') {
    renderReport(report);
    return;
  }

  // No report yet - check if a smoke test is running
  const progress = await fetchApi('/api/smoke-test-progress');
  if (progress && progress.running) {
    renderProgress(progress);
    return;
  }

  // No report and not running
  renderReport(report);
}

/**
 * Load a specific historical report and display it
 */
async function viewReport(reportId) {
  viewingReportId = reportId;

  // Show the historical banner
  const banner = document.getElementById('detail-banner');
  const bannerText = document.getElementById('banner-text');
  banner.classList.add('visible');
  bannerText.textContent = `Viewing smoke test from ${formatDate(Number(reportId))}`;

  // Fetch the specific report
  const report = await fetchApi(`/api/smoke-test-reports/${reportId}`);
  if (report && !report.error) {
    renderReport(report);
  }

  // Highlight active row in history
  document.querySelectorAll('.history-item-clickable').forEach(el => {
    el.classList.toggle('active-report', el.dataset.reportId === reportId);
  });
}

/**
 * Go back to viewing the current/live report
 */
function backToCurrent() {
  viewingReportId = null;

  // Hide banner
  document.getElementById('detail-banner').classList.remove('visible');

  // Remove active highlights
  document.querySelectorAll('.history-item-clickable').forEach(el => {
    el.classList.remove('active-report');
  });

  // Reload current report
  updateSmokeTestReport();
}

/**
 * Load and render the history list with clickable entries
 */
async function updateHistory() {
  const data = await fetchApi('/api/smoke-test-reports');
  const listEl = document.getElementById('history-list');
  const countEl = document.getElementById('history-count');
  if (!listEl) return;

  // Use persisted reports; fall back to run-history
  let reports = (data && data.reports) ? data.reports : [];

  // Sort newest first
  reports.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  if (countEl) countEl.textContent = `${reports.length} run${reports.length !== 1 ? 's' : ''}`;

  if (reports.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No previous smoke tests</div>';
    return;
  }

  listEl.innerHTML = reports.map(report => {
    const id = String(report.startedAt);
    const pnl = -report.netCostSol;
    const pnlValue = formatPnl(pnl);
    const pnlCls = pnlClass(pnl);
    const statusClass = report.overallResult === 'PASS' ? 'positive' : 'negative';
    const isActive = viewingReportId === id;
    const date = formatDate(report.startedAt);
    const duration = formatDuration(report.totalDurationMs);
    const exitTrigger = report.exitTrigger || '';

    return `
      <div class="run-history-item history-item-clickable ${isActive ? 'active-report' : ''}"
           data-report-id="${escapeHtml(id)}"
           onclick="viewReport('${escapeHtml(id)}')">
        <div class="run-mode">${escapeHtml(report.overallResult)}</div>
        <div class="run-summary">${escapeHtml(date)} &middot; ${duration}${exitTrigger ? ' &middot; ' + escapeHtml(exitTrigger) : ''}</div>
        <div class="run-pnl ${pnlCls}">${pnlValue}</div>
        <div class="run-status ${statusClass}">${report.passedCount}/${report.totalSteps} steps</div>
        <div class="run-time">${formatTimeAgo(report.startedAt)}</div>
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
