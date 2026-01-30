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
  funnelBought: document.getElementById('funnel-bought'),

  // Gate stats
  cheapGatesStats: document.getElementById('cheap-gates-stats'),
  deepFiltersStats: document.getElementById('deep-filters-stats'),

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
  updateGateStats(data.gateStats);

  // Update rejection reasons
  updateRejectionReasons(data.topRejectionReasons);

  // Update token list
  updateTokenList();
}

function updateFunnel(data) {
  const detected = data.tokensDetected || 0;
  const bought = data.tokensBought || 0;

  // Calculate how many passed each stage
  // Tokens that passed cheap gates = tokens that reached deep filters + bought
  const cheapGates = data.gateStats?.cheapGates || [];
  const deepFilters = data.gateStats?.deepFilters || [];

  // Get the last cheap gate passed count (those that made it through all cheap gates)
  const lastCheapGate = cheapGates[cheapGates.length - 1];
  const passedCheapGates = lastCheapGate ? lastCheapGate.passed : 0;

  // Get the last deep filter passed count
  const lastDeepFilter = deepFilters[deepFilters.length - 1];
  const passedDeepFilters = lastDeepFilter ? lastDeepFilter.passed : 0;

  // Update funnel values
  elements.funnelDetected.querySelector('.funnel-value').textContent = detected;
  elements.funnelCheapGates.querySelector('.funnel-value').textContent = passedCheapGates;
  elements.funnelDeepFilters.querySelector('.funnel-value').textContent = passedDeepFilters;
  elements.funnelBought.querySelector('.funnel-value').textContent = bought;
}

function updateGateStats(gateStats) {
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
    const count = data.count || 0;
    elements.paperTradeCount.textContent = `${count} trade${count !== 1 ? 's' : ''}`;
  }
}

async function checkPaperPnL() {
  elements.checkPaperPnlBtn.disabled = true;
  elements.checkPaperPnlBtn.textContent = 'Checking...';
  elements.paperPnlSummary.innerHTML = '<div class="loading">Fetching current prices...</div>';
  elements.paperTradesList.innerHTML = '';

  const summary = await postApi('/api/paper-trades/check-pnl');

  if (summary && !summary.error) {
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

function renderPaperPnLSummary(summary) {
  if (summary.totalTrades === 0) {
    elements.paperPnlSummary.innerHTML = '<div class="empty-state">No paper trades recorded yet</div>';
    return;
  }

  const pnlClass = (summary.totalPnlPercent || 0) >= 0 ? 'positive' : 'negative';
  const pnlSign = (summary.totalPnlPercent || 0) >= 0 ? '+' : '';

  elements.paperPnlSummary.innerHTML = `
    <div class="pnl-summary-grid">
      <div class="pnl-stat">
        <div class="pnl-stat-label">Total Entry</div>
        <div class="pnl-stat-value">${summary.totalEntrySol.toFixed(4)} SOL</div>
      </div>
      <div class="pnl-stat">
        <div class="pnl-stat-label">Current Value</div>
        <div class="pnl-stat-value">${summary.totalCurrentSol !== null ? summary.totalCurrentSol.toFixed(4) + ' SOL' : 'N/A'}</div>
      </div>
      <div class="pnl-stat">
        <div class="pnl-stat-label">Paper P&L</div>
        <div class="pnl-stat-value ${pnlClass}">
          ${summary.totalPnlSol !== null ? `${pnlSign}${summary.totalPnlSol.toFixed(4)} SOL` : 'N/A'}
          ${summary.totalPnlPercent !== null ? `(${pnlSign}${summary.totalPnlPercent.toFixed(2)}%)` : ''}
        </div>
      </div>
      <div class="pnl-stat">
        <div class="pnl-stat-label">Trades</div>
        <div class="pnl-stat-value">${summary.activeTrades} active / ${summary.totalTrades} total</div>
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

    let statusBadge = '';
    if (trade.status === 'graduated') {
      statusBadge = '<span class="status-badge graduated">Graduated</span>';
    } else if (trade.status === 'error') {
      statusBadge = '<span class="status-badge error">Error</span>';
    }

    const name = escapeHtml(trade.name || 'Unknown');
    const symbol = trade.symbol ? escapeHtml(`($${trade.symbol})`) : '';
    const mintShort = shortenAddress(trade.mint);
    const timeAgo = formatTimeAgo(trade.entryTimestamp);

    return `
      <div class="paper-trade-item ${trade.status}">
        <div class="paper-trade-info">
          <div class="paper-trade-name">${name} <span class="symbol">${symbol}</span></div>
          <div class="paper-trade-meta">
            <span class="paper-trade-mint" onclick="copyToClipboard('${trade.mint}', this)" title="Click to copy">${mintShort}</span>
            <span class="paper-trade-time">${timeAgo}</span>
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

function showTokenDetail(mint) {
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
