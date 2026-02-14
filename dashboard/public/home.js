/**
 * Homepage Dashboard
 * Overview of bot stats, wallet, P&L, infra costs, and current mode
 */

const POLL_INTERVAL = 5000;

// DOM elements
const el = {
  botMode: document.getElementById('bot-mode'),
  botStatus: document.getElementById('bot-status'),
  botVersion: document.getElementById('bot-version'),
  uptime: document.getElementById('uptime'),
  walletBalance: document.getElementById('wallet-balance'),
  realizedPnl: document.getElementById('realized-pnl'),
  unrealizedPnl: document.getElementById('unrealized-pnl'),
  totalPnl: document.getElementById('total-pnl'),
  totalBuys: document.getElementById('total-buys'),
  totalSells: document.getElementById('total-sells'),
  winRate: document.getElementById('win-rate'),
  openPositions: document.getElementById('open-positions'),
  pipelineDetected: document.getElementById('pipeline-detected'),
  pipelineBought: document.getElementById('pipeline-bought'),
  pipelineBuyRate: document.getElementById('pipeline-buy-rate'),
  currentExposure: document.getElementById('current-exposure'),
  // Infra costs
  monthlyInfraCost: document.getElementById('monthly-infra-cost'),
  totalInfraSpent: document.getElementById('total-infra-spent'),
  infraDays: document.getElementById('infra-days'),
  infraBreakdown: document.getElementById('infra-breakdown'),
  costVsPnl: document.getElementById('cost-vs-pnl'),
  // Training runs
  abSessions: document.getElementById('ab-sessions'),
  smokeTestStatus: document.getElementById('smoke-test-status'),
  runHistoryList: document.getElementById('run-history-list'),
  // Mode stats
  modeStatsPanel: document.getElementById('mode-stats-panel'),
  modeStatsTitle: document.getElementById('mode-stats-title'),
  modeStatsContent: document.getElementById('mode-stats-content'),
  // Paper P&L (for dry run / ab modes)
  paperPnlCard: document.getElementById('paper-pnl-card'),
  paperRealizedPnl: document.getElementById('paper-realized-pnl'),
  paperActiveTrades: document.getElementById('paper-active-trades'),
  paperClosedTrades: document.getElementById('paper-closed-trades'),
};

async function fetchApi(endpoint) {
  try {
    const res = await fetch(endpoint);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function formatSol(value) {
  if (value === null || value === undefined) return '-- SOL';
  return `${value >= 0 ? '' : ''}${value.toFixed(4)} SOL`;
}

function formatPnl(value) {
  if (value === null || value === undefined) return '--';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(4)} SOL`;
}

function formatPnlPercent(value) {
  if (value === null || value === undefined) return '';
  const sign = value >= 0 ? '+' : '';
  return `(${sign}${value.toFixed(1)}%)`;
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

function formatTimeAgo(timestamp) {
  if (!timestamp) return '--';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatUptime(seconds) {
  if (!seconds) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

async function updateOverview() {
  const data = await fetchApi('/api/overview');
  if (!data) return;

  // Bot info
  if (el.botMode) {
    el.botMode.textContent = (data.botMode || 'unknown').replace('_', ' ').toUpperCase();
    el.botMode.className = `mode-badge mode-${data.botMode}`;
  }
  if (el.botStatus) {
    el.botStatus.textContent = data.status || '--';
    el.botStatus.className = `status-value status-${data.status}`;
  }
  if (el.botVersion) el.botVersion.textContent = `v${data.version || '?'}`;
  if (el.uptime) el.uptime.textContent = data.uptimeFormatted || '--';

  // Wallet
  if (el.walletBalance) {
    el.walletBalance.textContent = data.walletBalance !== null
      ? `${data.walletBalance.toFixed(4)} SOL`
      : '-- SOL';
  }

  // Real P&L
  if (data.realPnl) {
    if (el.realizedPnl) {
      el.realizedPnl.textContent = formatPnl(data.realPnl.realized);
      el.realizedPnl.className = `stat-value ${pnlClass(data.realPnl.realized)}`;
    }
    if (el.unrealizedPnl) {
      el.unrealizedPnl.textContent = formatPnl(data.realPnl.unrealized);
      el.unrealizedPnl.className = `stat-value ${pnlClass(data.realPnl.unrealized)}`;
    }
    if (el.totalPnl) {
      el.totalPnl.textContent = formatPnl(data.realPnl.total);
      el.totalPnl.className = `stat-value big ${pnlClass(data.realPnl.total)}`;
    }
    if (el.totalBuys) el.totalBuys.textContent = data.realPnl.totalBuys || 0;
    if (el.totalSells) el.totalSells.textContent = data.realPnl.totalSells || 0;
    if (el.winRate) el.winRate.textContent = data.realPnl.winRate !== undefined
      ? `${data.realPnl.winRate.toFixed(0)}%` : '--';
  }

  // Paper P&L
  if (data.paperPnl && el.paperPnlCard) {
    el.paperPnlCard.style.display = 'block';
    if (el.paperRealizedPnl) {
      el.paperRealizedPnl.textContent = formatPnl(data.paperPnl.realizedPnlSol);
      el.paperRealizedPnl.className = `stat-value ${pnlClass(data.paperPnl.realizedPnlSol)}`;
    }
    if (el.paperActiveTrades) el.paperActiveTrades.textContent = data.paperPnl.activeTrades || 0;
    if (el.paperClosedTrades) el.paperClosedTrades.textContent = data.paperPnl.closedTrades || 0;
  } else if (el.paperPnlCard) {
    el.paperPnlCard.style.display = 'none';
  }

  // Positions & Pipeline
  if (el.openPositions) el.openPositions.textContent = data.positions?.open || 0;
  if (data.pipeline) {
    if (el.pipelineDetected) el.pipelineDetected.textContent = data.pipeline.totalDetected || 0;
    if (el.pipelineBought) el.pipelineBought.textContent = data.pipeline.totalBought || 0;
    if (el.pipelineBuyRate) el.pipelineBuyRate.textContent = `${(data.pipeline.buyRate || 0).toFixed(1)}%`;
  }

  // Exposure
  if (data.exposure) {
    if (el.currentExposure) el.currentExposure.textContent =
      `${data.exposure.currentExposure.toFixed(4)} / ${data.exposure.maxExposure.toFixed(2)} SOL`;
  }

  // Infrastructure costs
  if (data.infraCosts) {
    const infra = data.infraCosts;
    if (el.monthlyInfraCost) el.monthlyInfraCost.textContent = `$${infra.monthlyTotal}/mo`;
    if (el.totalInfraSpent) el.totalInfraSpent.textContent = `$${infra.totalSpent.toFixed(2)}`;
    if (el.infraDays) el.infraDays.textContent = `${infra.daysSinceStart} days`;
    if (el.infraBreakdown) {
      el.infraBreakdown.innerHTML = infra.breakdown.map(item =>
        `<div class="infra-item">
          <span class="infra-name">${escapeHtml(item.name)}</span>
          <span class="infra-cost">$${item.monthlyCost}/mo</span>
          <span class="infra-total">$${item.totalSpent.toFixed(2)}</span>
        </div>`
      ).join('');
    }

    // Cost vs P&L comparison
    if (el.costVsPnl) {
      const totalRealPnl = data.realPnl ? data.realPnl.total : 0;
      // Convert SOL P&L to approximate USD (rough estimate - we'd need a price feed for accuracy)
      // For now just show the raw comparison
      const netVsCost = totalRealPnl;
      const infraSol = infra.totalSpent; // This is in USD, so we can't directly compare
      el.costVsPnl.innerHTML = `
        <div class="cost-comparison">
          <div class="cost-row">
            <span>Infra Cost (USD)</span>
            <span class="negative">-$${infra.totalSpent.toFixed(2)}</span>
          </div>
          <div class="cost-row">
            <span>Real P&L (SOL)</span>
            <span class="${pnlClass(totalRealPnl)}">${formatPnl(totalRealPnl)}</span>
          </div>
          <div class="cost-goal">Goal: Beat $${infra.monthlyTotal}/mo in trading profits</div>
        </div>
      `;
    }
  }

  // Training runs
  if (data.trainingRuns) {
    if (el.abSessions) el.abSessions.textContent = data.trainingRuns.abSessions || 0;
    if (el.smokeTestStatus) {
      const count = data.trainingRuns.smokeTestCount || 0;
      const result = data.trainingRuns.smokeTestResult || 'None';
      const totalPnl = data.trainingRuns.smokeTestTotalPnlSol;
      const isRunning = data.trainingRuns.smokeTestRunning;
      let statusText;
      if (isRunning && !data.trainingRuns.smokeTestResult) {
        statusText = 'Running...';
        if (count > 0) statusText += ` (${count} previous runs)`;
      } else {
        statusText = count > 0 ? `${result} (${count} runs)` : result;
      }
      if (totalPnl !== undefined && totalPnl !== 0) {
        statusText += ` | P&L: ${formatPnl(totalPnl)}`;
      }
      el.smokeTestStatus.textContent = statusText;
      el.smokeTestStatus.className = `stat-value ${isRunning ? '' : (data.trainingRuns.smokeTestResult === 'PASS' ? 'positive' : '')}`;
    }
  }

  // Mode-specific quick stats
  updateModeStats(data);
}

function updateModeStats(data) {
  if (!el.modeStatsPanel) return;

  const mode = data.botMode;
  el.modeStatsPanel.style.display = 'block';

  switch (mode) {
    case 'dry_run':
      el.modeStatsTitle.textContent = 'Dry Run Mode Stats';
      el.modeStatsContent.innerHTML = buildDryRunStats(data);
      break;
    case 'production':
      el.modeStatsTitle.textContent = 'Production Mode Stats';
      el.modeStatsContent.innerHTML = buildProductionStats(data);
      break;
    case 'ab':
      el.modeStatsTitle.textContent = 'A/B Test Mode Stats';
      el.modeStatsContent.innerHTML = buildAbStats(data);
      break;
    case 'smoke':
      el.modeStatsTitle.textContent = 'Smoke Test Mode Stats';
      el.modeStatsContent.innerHTML = buildSmokeStats(data);
      break;
    case 'standby':
      el.modeStatsTitle.textContent = 'Standby Mode';
      el.modeStatsContent.innerHTML = '<div class="mode-stat-row"><span>Bot is idle. Set BOT_MODE to production or dry_run to start trading.</span></div>';
      break;
    default:
      el.modeStatsPanel.style.display = 'none';
  }
}

function buildDryRunStats(data) {
  const paper = data.paperPnl;
  if (!paper) return '<div class="mode-stat-row"><span>Waiting for paper trades...</span></div>';
  return `
    <div class="mode-stat-row"><span>Active Paper Trades</span><span>${paper.activeTrades}</span></div>
    <div class="mode-stat-row"><span>Closed Paper Trades</span><span>${paper.closedTrades}</span></div>
    <div class="mode-stat-row"><span>Realized Paper P&L</span><span class="${pnlClass(paper.realizedPnlSol)}">${formatPnl(paper.realizedPnlSol)}</span></div>
    <div class="mode-stat-row"><span>Monitoring</span><span>${paper.monitoringEnabled ? 'Active' : 'Off'}</span></div>
    <div class="mode-action"><a href="/dry-run" class="btn btn-primary btn-small">View Pipeline</a></div>
  `;
}

function buildProductionStats(data) {
  const pnl = data.realPnl;
  if (!pnl) return '<div class="mode-stat-row"><span>Waiting for trades...</span></div>';
  return `
    <div class="mode-stat-row"><span>Total Buys</span><span>${pnl.totalBuys}</span></div>
    <div class="mode-stat-row"><span>Total Sells</span><span>${pnl.totalSells}</span></div>
    <div class="mode-stat-row"><span>Win Rate</span><span>${pnl.winRate !== undefined ? pnl.winRate.toFixed(0) + '%' : '--'}</span></div>
    <div class="mode-stat-row"><span>Open Positions</span><span>${data.positions?.open || 0}</span></div>
    <div class="mode-action"><a href="/production" class="btn btn-primary btn-small">View Trading</a></div>
  `;
}

function buildAbStats(data) {
  return `
    <div class="mode-stat-row"><span>A/B Sessions Completed</span><span>${data.trainingRuns?.abSessions || 0}</span></div>
    <div class="mode-stat-row"><span>Status</span><span>Running</span></div>
    <div class="mode-action"><a href="/ab-test" class="btn btn-primary btn-small">View A/B Results</a></div>
  `;
}

function buildSmokeStats(data) {
  const isRunning = data.trainingRuns?.smokeTestRunning;
  const result = data.trainingRuns?.smokeTestResult;
  const count = data.trainingRuns?.smokeTestCount || 0;
  const totalPnl = data.trainingRuns?.smokeTestTotalPnlSol;

  let rows = '';
  if (isRunning) {
    rows += '<div class="mode-stat-row"><span>Status</span><span>Running...</span></div>';
  }
  if (result) {
    rows += `<div class="mode-stat-row"><span>Last Result</span><span>${result}</span></div>`;
  }
  if (count > 0) {
    rows += `<div class="mode-stat-row"><span>Total Runs</span><span>${count}</span></div>`;
  }
  if (totalPnl !== undefined && totalPnl !== 0) {
    rows += `<div class="mode-stat-row"><span>Total P&L</span><span class="${pnlClass(totalPnl)}">${formatPnl(totalPnl)}</span></div>`;
  }
  if (!rows) {
    rows = '<div class="mode-stat-row"><span>Status</span><span>Running...</span></div>';
  }
  rows += '<div class="mode-action"><a href="/smoke-test" class="btn btn-primary btn-small">View Smoke Test</a></div>';
  return rows;
}

async function updateRunHistory() {
  const data = await fetchApi('/api/run-history');
  if (!data || !data.runs || !el.runHistoryList) return;

  if (data.runs.length === 0) {
    el.runHistoryList.innerHTML = '<div class="empty-state">No training runs yet</div>';
    return;
  }

  el.runHistoryList.innerHTML = data.runs.slice(0, 20).map(run => {
    const modeLabel = run.mode === 'ab' ? 'A/B Test' : run.mode === 'smoke' ? 'Smoke Test' : run.mode;
    const statusClass = run.status === 'completed' ? 'positive' : run.status === 'failed' ? 'negative' : '';
    const time = formatTimeAgo(run.startedAt);

    // Show P&L for smoke test runs that have real money data
    let pnlHtml = '';
    if (run.pnlSol !== undefined && run.pnlSol !== null) {
      const pnlValue = formatPnl(run.pnlSol);
      const pnlCls = pnlClass(run.pnlSol);
      pnlHtml = `<div class="run-pnl ${pnlCls}">${pnlValue}</div>`;
    }

    let exitHtml = '';
    if (run.exitTrigger) {
      exitHtml = `<div class="run-exit">${escapeHtml(run.exitTrigger)}</div>`;
    }

    return `
      <div class="run-history-item">
        <div class="run-mode">${escapeHtml(modeLabel)}</div>
        <div class="run-summary">${escapeHtml(run.summary || '--')}</div>
        ${pnlHtml}
        ${exitHtml}
        <div class="run-status ${statusClass}">${escapeHtml(run.status)}</div>
        <div class="run-time">${time}</div>
      </div>
    `;
  }).join('');
}

async function updateAll() {
  await Promise.all([
    updateOverview(),
    updateRunHistory(),
  ]);
}

// Initial load
updateAll();

// Polling
setInterval(updateAll, POLL_INTERVAL);
