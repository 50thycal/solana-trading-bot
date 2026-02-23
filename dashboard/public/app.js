/**
 * Pump.fun Trading Bot Dashboard
 * Pipeline monitoring with gate-by-gate statistics
 */

// Configuration
const POLL_INTERVAL = 5000; // 5 seconds
const API_BASE = '';

// State
let currentTokenFilter = '';
let pipelineStats = null;
let recentTokens = [];
let isDryRunMode = false;
let lastPaperPnLSummary = null;

// DOM Elements
const elements = {
  // Header
  connectionStatus: document.getElementById('connection-status'),
  uptime: document.getElementById('uptime'),

  // Overview cards
  tokensDetected: document.getElementById('tokens-detected'),
  tokensBought: document.getElementById('tokens-bought'),
  buyRate: document.getElementById('buy-rate'),
  avgPipelineTime: document.getElementById('avg-pipeline-time'),
  walletBalance: document.getElementById('wallet-balance'),

  // Funnel
  funnelDetected: document.getElementById('funnel-detected'),
  funnelCheapGates: document.getElementById('funnel-cheap-gates'),
  funnelDeepFilters: document.getElementById('funnel-deep-filters'),
  funnelMomentumGate: document.getElementById('funnel-momentum-gate'),
  funnelBought: document.getElementById('funnel-bought'),

  // Gate stats
  cheapGatesStats: document.getElementById('cheap-gates-stats'),
  deepFiltersStats: document.getElementById('deep-filters-stats'),
  momentumGateStats: document.getElementById('momentum-gate-stats'),
  gate4FunnelLabel: document.getElementById('funnel-gate4-label'),
  gate4PanelTitle: document.getElementById('gate4-panel-title'),
  gate4PanelSubtitle: document.getElementById('gate4-panel-subtitle'),

  // Token list
  tokenList: document.getElementById('token-list'),
  tokenFilter: document.getElementById('token-filter'),

  // Positions
  positionsList: document.getElementById('positions-list'),
  positionCount: document.getElementById('position-count'),

  // Rejection reasons
  rejectionList: document.getElementById('rejection-list'),

  // Buttons
  resetStatsBtn: document.getElementById('reset-stats-btn'),
  confirmResetBtn: document.getElementById('confirm-reset-btn'),

  // Modals
  tokenModal: document.getElementById('token-modal'),
  tokenModalBody: document.getElementById('token-modal-body'),
  resetModal: document.getElementById('reset-modal'),

  // Paper P&L (dry run mode)
  paperPnlPanel: document.getElementById('paper-pnl-panel'),
  paperPnlSummary: document.getElementById('paper-pnl-summary'),
  paperTradesList: document.getElementById('paper-trades-list'),
  paperTradeCount: document.getElementById('paper-trade-count'),
  checkPaperPnlBtn: document.getElementById('check-paper-pnl-btn'),
  copyPaperPnlBtn: document.getElementById('copy-paper-pnl-btn'),
  clearPaperTradesBtn: document.getElementById('clear-paper-trades-btn'),
};

// ============================================================
// API CALLS
// ============================================================

async function fetchApi(endpoint) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`API error for ${endpoint}:`, error);
    return null;
  }
}

async function postApi(endpoint, data = {}) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return await response.json();
  } catch (error) {
    console.error(`API POST error for ${endpoint}:`, error);
    return null;
  }
}

// ============================================================
// DATA FETCHING & UPDATES
// ============================================================

async function updateStatus() {
  const data = await fetchApi('/api/status');
  if (!data) return;

  // Connection status
  const statusEl = elements.connectionStatus;
  if (data.websocket?.connected) {
    statusEl.classList.add('connected');
    statusEl.classList.remove('disconnected');
    statusEl.querySelector('.status-text').textContent = 'Connected';
  } else {
    statusEl.classList.add('disconnected');
    statusEl.classList.remove('connected');
    statusEl.querySelector('.status-text').textContent = 'Disconnected';
  }

  // Uptime
  elements.uptime.textContent = data.uptimeFormatted || '--';

  // Wallet balance
  if (data.walletBalance !== null && data.walletBalance !== undefined) {
    elements.walletBalance.textContent = `${data.walletBalance.toFixed(4)} SOL`;
  } else {
    elements.walletBalance.textContent = '-- SOL';
  }

  // Position count
  elements.positionCount.textContent = data.positions?.open || 0;
}

async function updatePipelineStats() {
  const data = await fetchApi('/api/pipeline-stats');
  if (!data) return;

  pipelineStats = data;
  recentTokens = data.recentTokens || [];

  // Update overview cards
  elements.tokensDetected.textContent = data.tokensDetected || 0;
  elements.tokensBought.textContent = data.tokensBought || 0;
  elements.buyRate.textContent = `${(data.buyRate || 0).toFixed(1)}%`;
  elements.avgPipelineTime.textContent = `${Math.round(data.avgPipelineDurationMs || 0)}ms`;

  // Update funnel
  updateFunnel(data);

  // Update gate stats
  updateGateStats(data.gateStats, data.sniperGateActive);

  // Update rejection reasons
  updateRejectionReasons(data.topRejectionReasons);

  // Update token list
  updateTokenList();
}

function updateFunnel(data) {
  const detected = data.tokensDetected || 0;
  const bought = data.tokensBought || 0;

  // Calculate how many passed each stage
  const cheapGates = data.gateStats?.cheapGates || [];
  const deepFilters = data.gateStats?.deepFilters || [];
  const sniperGateActive = data.sniperGateActive || false;

  // Gate 4: sniper or momentum
  const gate4Stats = sniperGateActive
    ? (data.gateStats?.sniperGate || [])
    : (data.gateStats?.momentumGate || []);

  const lastCheapGate = cheapGates[cheapGates.length - 1];
  const passedCheapGates = lastCheapGate ? lastCheapGate.passed : 0;

  const lastDeepFilter = deepFilters[deepFilters.length - 1];
  const passedDeepFilters = lastDeepFilter ? lastDeepFilter.passed : 0;

  const lastGate4 = gate4Stats[gate4Stats.length - 1];
  const passedGate4 = lastGate4 ? lastGate4.passed : 0;

  // Update funnel labels if sniper gate is active
  if (elements.gate4FunnelLabel) {
    elements.gate4FunnelLabel.textContent = sniperGateActive ? 'Sniper Gate' : 'Momentum Gate';
  }

  // Update funnel values
  elements.funnelDetected.querySelector('.funnel-value').textContent = detected;
  elements.funnelCheapGates.querySelector('.funnel-value').textContent = passedCheapGates;
  elements.funnelDeepFilters.querySelector('.funnel-value').textContent = passedDeepFilters;
  elements.funnelMomentumGate.querySelector('.funnel-value').textContent = passedGate4;
  elements.funnelBought.querySelector('.funnel-value').textContent = bought;
}

function updateGateStats(gateStats, sniperGateActive) {
  if (!gateStats) return;

  // Cheap gates
  if (gateStats.cheapGates && gateStats.cheapGates.length > 0) {
    elements.cheapGatesStats.innerHTML = gateStats.cheapGates.map(renderGateStat).join('');
  } else {
    elements.cheapGatesStats.innerHTML = '<div class="empty-state">No data yet</div>';
  }

  // Deep filters
  if (gateStats.deepFilters && gateStats.deepFilters.length > 0) {
    elements.deepFiltersStats.innerHTML = gateStats.deepFilters.map(renderGateStat).join('');
  } else {
    elements.deepFiltersStats.innerHTML = '<div class="empty-state">No data yet</div>';
  }

  // Gate 4: show sniper or momentum depending on which is active
  if (sniperGateActive) {
    if (elements.gate4PanelTitle) elements.gate4PanelTitle.textContent = 'Sniper Gate';
    if (elements.gate4PanelSubtitle) elements.gate4PanelSubtitle.textContent = 'Bot exit + organic buyer detection';
    if (gateStats.sniperGate && gateStats.sniperGate.length > 0) {
      elements.momentumGateStats.innerHTML = gateStats.sniperGate.map(renderGateStat).join('');
    } else {
      elements.momentumGateStats.innerHTML = '<div class="empty-state">No data yet</div>';
    }
  } else {
    if (elements.gate4PanelTitle) elements.gate4PanelTitle.textContent = 'Momentum Gate';
    if (elements.gate4PanelSubtitle) elements.gate4PanelSubtitle.textContent = 'Buy activity validation';
    if (gateStats.momentumGate && gateStats.momentumGate.length > 0) {
      elements.momentumGateStats.innerHTML = gateStats.momentumGate.map(renderGateStat).join('');
    } else {
      elements.momentumGateStats.innerHTML = '<div class="empty-state">No data yet</div>';
    }
  }
}

function renderGateStat(gate) {
  const total = gate.totalChecked || 0;
  const passRate = total > 0 ? (gate.passed / total) * 100 : 0;

  return `
    <div class="gate-stat-item">
      <span class="gate-stat-name">${gate.displayName}</span>
      <div class="gate-stat-values">
        <span class="gate-stat-passed" title="Passed">${gate.passed}</span>
        <span class="gate-stat-failed" title="Failed">${gate.failed}</span>
        <div class="gate-stat-bar">
          <div class="gate-stat-bar-fill" style="width: ${passRate}%"></div>
        </div>
        <span class="gate-stat-rate">${passRate.toFixed(0)}%</span>
      </div>
    </div>
  `;
}

function updateRejectionReasons(reasons) {
  if (!reasons || reasons.length === 0) {
    elements.rejectionList.innerHTML = '<div class="empty-state">No rejections yet</div>';
    return;
  }

  elements.rejectionList.innerHTML = reasons.slice(0, 8).map(item => `
    <div class="rejection-item">
      <span class="rejection-name">${formatRejectionReason(item.reason)}</span>
      <span class="rejection-count">${item.count}</span>
    </div>
  `).join('');
}

function formatRejectionReason(reason) {
  // Convert SCREAMING_CASE to Title Case
  return reason
    .toLowerCase()
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function updateTokenList() {
  let tokens = recentTokens;

  // Apply filter
  if (currentTokenFilter) {
    tokens = tokens.filter(t => t.outcome === currentTokenFilter);
  }

  if (tokens.length === 0) {
    elements.tokenList.innerHTML = '<div class="empty-state">No tokens detected yet</div>';
    return;
  }

  elements.tokenList.innerHTML = tokens.map(renderTokenItem).join('');
}

function renderTokenItem(token) {
  const time = formatTimeAgo(token.detectedAt);
  const addressShort = shortenAddress(token.mint);
  const name = token.name || 'Unknown';
  const symbol = token.symbol ? `($${token.symbol})` : '';

  let metaHtml = `<div class="token-time">${time}</div>`;
  if (token.outcome === 'rejected' && token.rejectionReason) {
    metaHtml += `<div class="token-rejection">${formatRejectionReason(token.rejectionReason)}</div>`;
  }
  metaHtml += `<div class="token-duration">${token.pipelineDurationMs}ms</div>`;

  return `
    <div class="token-item" onclick="showTokenDetail('${token.mint}')">
      <div class="token-outcome ${token.outcome}"></div>
      <div class="token-info">
        <div class="token-name">${escapeHtml(name)} <span class="symbol">${escapeHtml(symbol)}</span></div>
        <div class="token-address">
          <span class="token-address-text" onclick="event.stopPropagation(); copyToClipboard('${token.mint}', this)">${addressShort}</span>
          <button class="copy-btn" onclick="event.stopPropagation(); copyToClipboard('${token.mint}', this)" title="Copy address">📋</button>
        </div>
      </div>
      <div class="token-meta">
        ${metaHtml}
      </div>
    </div>
  `;
}

async function updatePositions() {
  const data = await fetchApi('/api/positions');
  if (!data || !data.positions) return;

  elements.positionCount.textContent = data.positions.length;

  if (data.positions.length === 0) {
    elements.positionsList.innerHTML = '<div class="empty-state">No open positions</div>';
    return;
  }

  elements.positionsList.innerHTML = data.positions.map(pos => {
    const tokenShort = shortenAddress(pos.tokenMint);
    const pnlPercent = pos.currentPnlPercent ?? 0;
    const pnlClass = pnlPercent >= 0 ? 'positive' : 'negative';

    return `
      <div class="position-item">
        <div class="position-token">${tokenShort}</div>
        <div class="position-details">
          <div>Entry: ${pos.amountSol.toFixed(4)} SOL</div>
          <div class="position-pnl ${pnlClass}">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%</div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// PAPER P&L (DRY RUN MODE)
// ============================================================

async function checkDryRunMode() {
  const config = await fetchApi('/api/config');
  if (config?.mode?.dryRun) {
    isDryRunMode = true;
    elements.paperPnlPanel.style.display = 'block';
    await updatePaperTradeCount();
  } else {
    isDryRunMode = false;
    elements.paperPnlPanel.style.display = 'none';
  }
}

async function updatePaperTradeCount() {
  if (!isDryRunMode) return;

  const data = await fetchApi('/api/paper-trades');
  if (data) {
    const activeCount = data.activeCount || 0;
    const closedCount = data.closedCount || 0;
    const totalCount = activeCount + closedCount;

    let countText = `${totalCount} trade${totalCount !== 1 ? 's' : ''}`;
    if (closedCount > 0) {
      countText += ` (${activeCount} active, ${closedCount} closed)`;
    }
    elements.paperTradeCount.textContent = countText;

    // Show monitoring status indicator
    if (data.monitoringEnabled) {
      elements.paperTradeCount.title = 'TP/SL monitoring active';
    } else {
      elements.paperTradeCount.title = 'TP/SL monitoring disabled';
    }
  }
}

async function checkPaperPnL() {
  elements.checkPaperPnlBtn.disabled = true;
  elements.checkPaperPnlBtn.textContent = 'Checking...';
  elements.paperPnlSummary.innerHTML = '<div class="loading">Fetching current prices...</div>';
  elements.paperTradesList.innerHTML = '';

  const summary = await postApi('/api/paper-trades/check-pnl');

  if (summary && !summary.error) {
    lastPaperPnLSummary = summary; // Store for copy function
    renderPaperPnLSummary(summary);
    renderPaperTradesList(summary.trades);
  } else {
    elements.paperPnlSummary.innerHTML = `
      <div class="error-state">Error: ${summary?.error || 'Unknown error'}</div>
    `;
  }

  elements.checkPaperPnlBtn.disabled = false;
  elements.checkPaperPnlBtn.textContent = 'Check P&L';
}

/**
 * Copy paper P&L log as formatted text for AI analysis
 */
async function copyPaperPnLLog() {
  if (!lastPaperPnLSummary || !lastPaperPnLSummary.trades) {
    alert('Please click "Check P&L" first to load trade data.');
    return;
  }

  const summary = lastPaperPnLSummary;
  const trades = summary.trades || [];

  // Format summary section
  let logText = `=== PAPER TRADING P&L LOG ===
Generated: ${new Date().toISOString()}
Mode: DRY RUN (Paper Trading)

=== SUMMARY ===
Total Trades: ${summary.totalTrades}
Active Trades: ${summary.activeTrades}
Closed Trades: ${summary.closedTrades}
Graduated Trades: ${summary.graduatedTrades}

Unrealized P&L: ${summary.unrealizedPnlSol?.toFixed(4) || 'N/A'} SOL (${summary.unrealizedPnlPercent?.toFixed(2) || 'N/A'}%)
Realized P&L: ${summary.realizedPnlSol?.toFixed(4) || '0'} SOL (${summary.realizedPnlPercent?.toFixed(2) || 'N/A'}%)
Total P&L: ${summary.totalPnlSol?.toFixed(4) || 'N/A'} SOL (${summary.totalPnlPercent?.toFixed(2) || 'N/A'}%)

TP/SL Monitoring: ${summary.monitoringEnabled ? 'ENABLED' : 'DISABLED'}

=== INDIVIDUAL TRADES ===
`;

  // Format each trade
  trades.forEach((trade, index) => {
    const entryTime = new Date(trade.entryTimestamp).toISOString();
    const closedTime = trade.closedTimestamp ? new Date(trade.closedTimestamp).toISOString() : null;
    const holdDuration = trade.closedTimestamp
      ? formatDuration(trade.closedTimestamp - trade.entryTimestamp)
      : formatDuration(Date.now() - trade.entryTimestamp);

    logText += `
--- Trade ${index + 1} ---
Token: ${trade.name || 'Unknown'} (${trade.symbol || 'N/A'})
Mint: ${trade.mint}
Status: ${trade.status.toUpperCase()}${trade.closedReason ? ` (${trade.closedReason})` : ''}

Entry Time: ${entryTime}
Entry Price: ${trade.entryPricePerToken?.toExponential(4) || 'N/A'} SOL/token
Hypothetical SOL Spent: ${trade.entrySol?.toFixed(4) || 'N/A'} SOL
Hypothetical Tokens: ${trade.hypotheticalTokens?.toLocaleString() || 'N/A'}
`;

    if (trade.closedTimestamp) {
      logText += `Closed Time: ${closedTime}
Hold Duration: ${holdDuration}
Exit Price: ${trade.currentPricePerToken?.toExponential(4) || 'N/A'} SOL/token
`;
    } else {
      logText += `Current Hold Duration: ${holdDuration}
Current Price: ${trade.currentPricePerToken?.toExponential(4) || 'N/A'} SOL/token
`;
    }

    logText += `P&L: ${trade.pnlSol?.toFixed(4) || 'N/A'} SOL (${trade.pnlPercent?.toFixed(2) || 'N/A'}%)
Pipeline Duration: ${trade.pipelineDurationMs || 'N/A'}ms
`;
  });

  logText += `
=== END OF LOG ===
`;

  await copyToClipboard(logText, elements.copyPaperPnlBtn);

  // Show feedback on the button
  const originalText = elements.copyPaperPnlBtn.textContent;
  elements.copyPaperPnlBtn.textContent = 'Copied!';
  elements.copyPaperPnlBtn.classList.add('copied');
  setTimeout(() => {
    elements.copyPaperPnlBtn.textContent = originalText;
    elements.copyPaperPnlBtn.classList.remove('copied');
  }, 1500);
}

function renderPaperPnLSummary(summary) {
  if (summary.totalTrades === 0) {
    elements.paperPnlSummary.innerHTML = '<div class="empty-state">No paper trades recorded yet</div>';
    return;
  }

  const totalPnlClass = (summary.totalPnlPercent || 0) >= 0 ? 'positive' : 'negative';
  const totalPnlSign = (summary.totalPnlPercent || 0) >= 0 ? '+' : '';

  const realizedPnlClass = (summary.realizedPnlSol || 0) >= 0 ? 'positive' : 'negative';
  const realizedPnlSign = (summary.realizedPnlSol || 0) >= 0 ? '+' : '';

  const unrealizedPnlClass = (summary.unrealizedPnlPercent || 0) >= 0 ? 'positive' : 'negative';
  const unrealizedPnlSign = (summary.unrealizedPnlPercent || 0) >= 0 ? '+' : '';

  const monitoringStatus = summary.monitoringEnabled
    ? '<span class="monitoring-badge active">TP/SL Active</span>'
    : '<span class="monitoring-badge inactive">Monitoring Off</span>';

  elements.paperPnlSummary.innerHTML = `
    <div class="pnl-header">
      ${monitoringStatus}
    </div>
    <div class="pnl-summary-grid">
      <div class="pnl-stat">
        <div class="pnl-stat-label">Open Positions (${summary.activeTrades})</div>
        <div class="pnl-stat-value ${unrealizedPnlClass}">
          ${summary.unrealizedPnlSol !== null
            ? `${unrealizedPnlSign}${summary.unrealizedPnlSol.toFixed(4)} SOL (${unrealizedPnlSign}${(summary.unrealizedPnlPercent || 0).toFixed(2)}%)`
            : 'N/A'}
        </div>
        <div class="pnl-stat-sublabel">Unrealized</div>
      </div>
      <div class="pnl-stat">
        <div class="pnl-stat-label">Closed Positions (${summary.closedTrades})</div>
        <div class="pnl-stat-value ${realizedPnlClass}">
          ${realizedPnlSign}${summary.realizedPnlSol.toFixed(4)} SOL
          ${summary.realizedPnlPercent !== null ? `(${realizedPnlSign}${summary.realizedPnlPercent.toFixed(2)}%)` : ''}
        </div>
        <div class="pnl-stat-sublabel">Realized (locked in)</div>
      </div>
      <div class="pnl-stat total">
        <div class="pnl-stat-label">Total Paper P&L</div>
        <div class="pnl-stat-value ${totalPnlClass}">
          ${summary.totalPnlSol !== null ? `${totalPnlSign}${summary.totalPnlSol.toFixed(4)} SOL` : 'N/A'}
          ${summary.totalPnlPercent !== null ? `(${totalPnlSign}${summary.totalPnlPercent.toFixed(2)}%)` : ''}
        </div>
      </div>
      <div class="pnl-stat">
        <div class="pnl-stat-label">Trade Breakdown</div>
        <div class="pnl-stat-value">${summary.activeTrades} active, ${summary.closedTrades} closed, ${summary.graduatedTrades} graduated</div>
      </div>
    </div>
    <div class="pnl-timestamp">Last checked: ${new Date(summary.checkedAt).toLocaleTimeString()}</div>
  `;
}

function renderPaperTradesList(trades) {
  if (!trades || trades.length === 0) {
    elements.paperTradesList.innerHTML = '';
    return;
  }

  elements.paperTradesList.innerHTML = trades.map(trade => {
    const pnlClass = (trade.pnlPercent || 0) >= 0 ? 'positive' : 'negative';
    const pnlSign = (trade.pnlPercent || 0) >= 0 ? '+' : '';

    // Status badge based on trade status and close reason
    let statusBadge = '';
    if (trade.status === 'closed' && trade.closedReason) {
      const reasonMap = {
        'take_profit': { text: 'TP Hit', class: 'take-profit' },
        'stop_loss': { text: 'SL Hit', class: 'stop-loss' },
        'time_exit': { text: 'Time Exit', class: 'time-exit' },
        'graduated': { text: 'Graduated', class: 'graduated' },
      };
      const badge = reasonMap[trade.closedReason] || { text: 'Closed', class: 'closed' };
      statusBadge = `<span class="status-badge ${badge.class}">${badge.text}</span>`;
    } else if (trade.status === 'graduated') {
      statusBadge = '<span class="status-badge graduated">Graduated</span>';
    } else if (trade.status === 'error') {
      statusBadge = '<span class="status-badge error">Error</span>';
    } else if (trade.status === 'active') {
      statusBadge = '<span class="status-badge active">Open</span>';
    }

    const name = escapeHtml(trade.name || 'Unknown');
    const symbol = trade.symbol ? escapeHtml(`($${trade.symbol})`) : '';
    const mintShort = shortenAddress(trade.mint);

    // For closed trades, show how long ago it was closed; for active, show entry time
    let timeInfo = '';
    if (trade.closedTimestamp) {
      const holdDuration = trade.closedTimestamp - trade.entryTimestamp;
      const holdDurationStr = formatDuration(holdDuration);
      timeInfo = `
        <span class="paper-trade-time">Closed ${formatTimeAgo(trade.closedTimestamp)}</span>
        <span class="paper-trade-hold-time">Held: ${holdDurationStr}</span>
      `;
    } else {
      timeInfo = `<span class="paper-trade-time">Entered ${formatTimeAgo(trade.entryTimestamp)}</span>`;
    }

    return `
      <div class="paper-trade-item ${trade.status} ${trade.closedReason || ''}">
        <div class="paper-trade-info">
          <div class="paper-trade-name">${name} <span class="symbol">${symbol}</span></div>
          <div class="paper-trade-meta">
            <span class="paper-trade-mint" onclick="copyToClipboard('${trade.mint}', this)" title="Click to copy">${mintShort}</span>
            ${timeInfo}
          </div>
        </div>
        <div class="paper-trade-pnl">
          ${statusBadge}
          ${trade.pnlPercent !== null ? `
            <div class="pnl-value ${pnlClass}">${pnlSign}${trade.pnlPercent.toFixed(2)}%</div>
            <div class="pnl-sol">${pnlSign}${trade.pnlSol?.toFixed(4) || '0'} SOL</div>
          ` : '<div class="pnl-na">N/A</div>'}
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Format duration in ms to human readable string
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

async function clearPaperTrades() {
  if (!confirm('Clear all paper trades? This cannot be undone.')) return;

  elements.clearPaperTradesBtn.disabled = true;
  const result = await postApi('/api/paper-trades/clear');

  if (result && result.success) {
    elements.paperPnlSummary.innerHTML = '<div class="empty-state">Paper trades cleared</div>';
    elements.paperTradesList.innerHTML = '';
    elements.paperTradeCount.textContent = '0 trades';
  } else {
    alert('Failed to clear paper trades: ' + (result?.error || 'Unknown error'));
  }

  elements.clearPaperTradesBtn.disabled = false;
}

// ============================================================
// MODALS
// ============================================================

async function showTokenDetail(mint) {
  const token = recentTokens.find(t => t.mint === mint);
  if (!token) return;

  const time = new Date(token.detectedAt).toLocaleString();
  const name = token.name || 'Unknown';
  const symbol = token.symbol || '--';

  const outcomeIcon = token.outcome === 'bought' ? '✓' : '✗';
  const outcomeText = token.outcome === 'bought' ? 'Bought' : 'Rejected';
  const outcomeDetail = token.outcome === 'rejected' && token.rejectionReason
    ? `at ${token.rejectedAt}: ${formatRejectionReason(token.rejectionReason)}`
    : `Pipeline completed in ${token.pipelineDurationMs}ms`;

  // Build sniper gate summary section (from in-memory token data)
  let sniperSummaryHtml = '';
  if (token.sniperBotCount !== undefined || token.organicBuyerCount !== undefined) {
    const botCount = token.sniperBotCount ?? 0;
    const exitPercent = token.sniperExitPercent ?? 0;
    const exitCount = Math.round(botCount * exitPercent / 100);
    const organicCount = token.organicBuyerCount ?? 0;
    const checks = token.sniperGateChecks ?? 0;
    const waitSec = token.sniperGateWaitMs != null ? (token.sniperGateWaitMs / 1000).toFixed(1) : '--';

    sniperSummaryHtml = `
      <div class="modal-section">
        <h4>Sniper Gate Summary</h4>
        <div class="sniper-stats-grid">
          <div class="sniper-stat">
            <div class="sniper-stat-label">Bots Detected</div>
            <div class="sniper-stat-value bot-count">${botCount}</div>
          </div>
          <div class="sniper-stat">
            <div class="sniper-stat-label">Bots Exited</div>
            <div class="sniper-stat-value bot-exit">${exitCount} <span class="sniper-stat-pct">(${exitPercent.toFixed(0)}%)</span></div>
          </div>
          <div class="sniper-stat">
            <div class="sniper-stat-label">Organic Buyers</div>
            <div class="sniper-stat-value organic-count">${organicCount}</div>
          </div>
          <div class="sniper-stat">
            <div class="sniper-stat-label">Gate Duration</div>
            <div class="sniper-stat-value">${waitSec}s (${checks} checks)</div>
          </div>
        </div>
        <div id="sniper-check-history">
          <div class="loading">Loading check history...</div>
        </div>
      </div>
    `;
  }

  elements.tokenModalBody.innerHTML = `
    <div class="modal-section">
      <h4>Token Information</h4>
      <div class="token-info-grid">
        <div class="token-field">
          <div class="token-field-label">Name</div>
          <div class="token-field-value">${escapeHtml(name)}</div>
        </div>
        <div class="token-field">
          <div class="token-field-label">Symbol</div>
          <div class="token-field-value">${escapeHtml(symbol)}</div>
        </div>
        <div class="token-field full-width">
          <div class="token-field-label">Mint Address</div>
          <div class="token-field-value copyable" onclick="copyToClipboard('${token.mint}', this)">${token.mint}</div>
        </div>
        <div class="token-field">
          <div class="token-field-label">Detected At</div>
          <div class="token-field-value">${time}</div>
        </div>
        <div class="token-field">
          <div class="token-field-label">Pipeline Duration</div>
          <div class="token-field-value">${token.pipelineDurationMs}ms</div>
        </div>
      </div>
    </div>

    <div class="modal-section">
      <h4>Pipeline Result</h4>
      <div class="pipeline-result ${token.outcome}">
        <span class="pipeline-result-icon">${outcomeIcon}</span>
        <div class="pipeline-result-text">
          <div class="pipeline-result-status">${outcomeText}</div>
          <div class="pipeline-result-detail">${outcomeDetail}</div>
        </div>
      </div>
    </div>

    ${sniperSummaryHtml}

    <div class="modal-section">
      <h4>External Links</h4>
      <div class="external-links">
        <a href="https://pump.fun/${token.mint}" target="_blank" rel="noopener" class="external-link">Pump.fun</a>
        <a href="https://dexscreener.com/solana/${token.mint}" target="_blank" rel="noopener" class="external-link">DexScreener</a>
        <a href="https://solscan.io/token/${token.mint}" target="_blank" rel="noopener" class="external-link">Solscan</a>
      </div>
    </div>
  `;

  elements.tokenModal.classList.add('open');

  // Async: fetch and render sniper check history from DB if sniper section is shown
  if (sniperSummaryHtml) {
    const historyEl = document.getElementById('sniper-check-history');
    if (historyEl) {
      const data = await fetchApi(`/api/sniper-gate/token/${mint}`);
      if (data && data.observations && data.observations.length > 0) {
        historyEl.innerHTML = renderSniperCheckHistory(data.observations);
      } else {
        historyEl.innerHTML = '<div class="empty-state sniper-history-empty">No check history in database</div>';
      }
    }
  }
}

function renderSniperCheckHistory(observations) {
  const rows = observations.map(obs => {
    const passClass = obs.passConditionsMet ? 'pass-yes' : 'pass-no';
    const passText = obs.passConditionsMet ? '✓' : '—';
    return `
      <tr>
        <td class="sniper-col-check">#${obs.checkNumber}</td>
        <td class="sniper-col-bots">${obs.botCount}</td>
        <td class="sniper-col-exits">${obs.botExitCount} <span class="sniper-pct">(${obs.botExitPercent.toFixed(0)}%)</span></td>
        <td class="sniper-col-organic">${obs.organicCount}</td>
        <td class="sniper-col-buys">${obs.totalBuys}</td>
        <td class="sniper-col-sells">${obs.totalSells}</td>
        <td class="sniper-col-pass ${passClass}">${passText}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="sniper-check-table-wrap">
      <table class="sniper-check-table">
        <thead>
          <tr>
            <th>Check</th>
            <th>Bots</th>
            <th>Exits</th>
            <th>Organic</th>
            <th>Buys</th>
            <th>Sells</th>
            <th>Pass?</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function closeTokenModal() {
  elements.tokenModal.classList.remove('open');
}

function openResetModal() {
  elements.resetModal.classList.add('open');
}

function closeResetModal() {
  elements.resetModal.classList.remove('open');
}

async function confirmResetStats() {
  elements.confirmResetBtn.disabled = true;
  elements.confirmResetBtn.textContent = 'Resetting...';

  const result = await postApi('/api/pipeline-stats/reset');

  if (result && result.success) {
    closeResetModal();
    // Immediately refresh stats
    await updatePipelineStats();
  } else {
    alert('Failed to reset stats: ' + (result?.error || 'Unknown error'));
  }

  elements.confirmResetBtn.disabled = false;
  elements.confirmResetBtn.textContent = 'Reset Stats';
}

// ============================================================
// UTILITIES
// ============================================================

function shortenAddress(address) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function copyToClipboard(text, element) {
  try {
    await navigator.clipboard.writeText(text);

    // Show feedback
    if (element) {
      const originalText = element.textContent;
      if (element.classList.contains('copy-btn')) {
        element.textContent = '✓';
        element.classList.add('copied');
        setTimeout(() => {
          element.textContent = '📋';
          element.classList.remove('copied');
        }, 1500);
      } else {
        element.style.color = 'var(--accent-green)';
        setTimeout(() => {
          element.style.color = '';
        }, 1500);
      }
    }
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}

// ============================================================
// EVENT HANDLERS
// ============================================================

elements.tokenFilter.addEventListener('change', (e) => {
  currentTokenFilter = e.target.value;
  updateTokenList();
});

elements.resetStatsBtn.addEventListener('click', openResetModal);
elements.confirmResetBtn.addEventListener('click', confirmResetStats);

// Paper P&L event listeners
if (elements.checkPaperPnlBtn) {
  elements.checkPaperPnlBtn.addEventListener('click', checkPaperPnL);
}
if (elements.copyPaperPnlBtn) {
  elements.copyPaperPnlBtn.addEventListener('click', copyPaperPnLLog);
}
if (elements.clearPaperTradesBtn) {
  elements.clearPaperTradesBtn.addEventListener('click', clearPaperTrades);
}

// Close modals on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (elements.tokenModal.classList.contains('open')) {
      closeTokenModal();
    }
    if (elements.resetModal.classList.contains('open')) {
      closeResetModal();
    }
  }
});

// ============================================================
// POLLING
// ============================================================

async function updateAll() {
  await Promise.all([
    updateStatus(),
    updatePipelineStats(),
    updatePositions(),
    updatePaperTradeCount(),
  ]);
}

// Initial load
checkDryRunMode(); // Check if dry run mode, show/hide paper P&L panel
updateAll();

// Start polling
setInterval(updateAll, POLL_INTERVAL);

// Make functions available globally for onclick handlers
window.showTokenDetail = showTokenDetail;
window.closeTokenModal = closeTokenModal;
window.closeResetModal = closeResetModal;
window.copyToClipboard = copyToClipboard;
