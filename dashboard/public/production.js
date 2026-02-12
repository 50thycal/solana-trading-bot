/**
 * Production Mode Dashboard
 * Real trading with live P&L, positions, trade audit, and pipeline stats
 */

const POLL_INTERVAL = 5000;
const API_BASE = '';

let currentTokenFilter = '';
let pipelineStats = null;
let recentTokens = [];

async function fetchApi(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    console.error(`API error for ${endpoint}:`, error);
    return null;
  }
}

async function postApi(endpoint, data = {}) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return await res.json();
  } catch (error) {
    console.error(`API POST error for ${endpoint}:`, error);
    return null;
  }
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

function formatRejectionReason(reason) {
  return reason.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ============================================================
// STATUS & P&L
// ============================================================

async function updateStatus() {
  const data = await fetchApi('/api/status');
  if (!data) return;

  const walletEl = document.getElementById('wallet-balance');
  if (walletEl && data.walletBalance !== null && data.walletBalance !== undefined) {
    walletEl.textContent = `${data.walletBalance.toFixed(4)} SOL`;
  }

  const posCount = document.getElementById('position-count');
  if (posCount) posCount.textContent = data.positions?.open || 0;

  const openPos = document.getElementById('open-positions');
  if (openPos) openPos.textContent = data.positions?.open || 0;

  if (data.exposure) {
    const expEl = document.getElementById('current-exposure');
    if (expEl) expEl.textContent = `${data.exposure.currentExposure.toFixed(4)} / ${data.exposure.maxExposure.toFixed(2)} SOL`;

    const tphEl = document.getElementById('trades-per-hour');
    if (tphEl) tphEl.textContent = `${data.exposure.tradesThisHour} / ${data.exposure.maxTradesPerHour}`;
  }
}

async function updatePnl() {
  const data = await fetchApi('/api/pnl');
  if (!data || data.error) return;

  const realizedEl = document.getElementById('realized-pnl');
  if (realizedEl) {
    realizedEl.textContent = formatPnl(data.realized);
    realizedEl.className = `card-value ${pnlClass(data.realized)}`;
  }

  const unrealizedEl = document.getElementById('unrealized-pnl');
  if (unrealizedEl) {
    unrealizedEl.textContent = formatPnl(data.unrealized);
    unrealizedEl.className = `card-value ${pnlClass(data.unrealized)}`;
  }

  const totalEl = document.getElementById('total-pnl');
  if (totalEl) {
    totalEl.textContent = formatPnl(data.total);
    totalEl.className = `card-value big ${pnlClass(data.total)}`;
  }

  const buysEl = document.getElementById('total-buys');
  if (buysEl) buysEl.textContent = data.totalTrades || 0;

  const sellsEl = document.getElementById('total-sells');
  if (sellsEl) sellsEl.textContent = data.winningTrades || 0;

  const wrEl = document.getElementById('win-rate');
  if (wrEl) wrEl.textContent = data.winRate !== undefined ? `${data.winRate.toFixed(0)}%` : '--';
}

// ============================================================
// TRADE AUDIT
// ============================================================

async function updateTradeAudit() {
  const data = await fetchApi('/api/trade-audit');
  if (!data || data.error) return;

  const summary = data.summary;
  if (summary) {
    const totalEl = document.getElementById('audit-total');
    if (totalEl) totalEl.textContent = summary.totalAudited || 0;

    const mismEl = document.getElementById('audit-mismatches');
    if (mismEl) {
      mismEl.textContent = summary.mismatches || 0;
      mismEl.className = `stat-value ${summary.mismatches > 0 ? 'negative' : 'positive'}`;
    }

    const slipEl = document.getElementById('audit-avg-slippage');
    if (slipEl) slipEl.textContent = `${summary.avgTokenSlippagePercent || 0}%`;
  }
}

// ============================================================
// PIPELINE STATS
// ============================================================

async function updatePipelineStats() {
  const data = await fetchApi('/api/pipeline-stats');
  if (!data) return;

  pipelineStats = data;
  recentTokens = data.recentTokens || [];

  // Funnel
  const detected = data.tokensDetected || 0;
  const bought = data.tokensBought || 0;
  const cheapGates = data.gateStats?.cheapGates || [];
  const deepFilters = data.gateStats?.deepFilters || [];
  const momentumGate = data.gateStats?.momentumGate || [];

  const lastCG = cheapGates[cheapGates.length - 1];
  const lastDF = deepFilters[deepFilters.length - 1];
  const lastMG = momentumGate[momentumGate.length - 1];

  setFunnelValue('funnel-detected', detected);
  setFunnelValue('funnel-cheap-gates', lastCG ? lastCG.passed : 0);
  setFunnelValue('funnel-deep-filters', lastDF ? lastDF.passed : 0);
  setFunnelValue('funnel-momentum-gate', lastMG ? lastMG.passed : 0);
  setFunnelValue('funnel-bought', bought);

  // Gate stats
  updateGateStats('cheap-gates-stats', cheapGates);
  updateGateStats('deep-filters-stats', deepFilters);

  // Rejection reasons
  updateRejectionReasons(data.topRejectionReasons);

  // Token list
  updateTokenList();
}

function setFunnelValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.querySelector('.funnel-value').textContent = value;
}

function updateGateStats(containerId, gates) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (gates && gates.length > 0) {
    container.innerHTML = gates.map(gate => {
      const total = gate.totalChecked || 0;
      const passRate = total > 0 ? (gate.passed / total) * 100 : 0;
      return `
        <div class="gate-stat-item">
          <span class="gate-stat-name">${escapeHtml(gate.displayName)}</span>
          <div class="gate-stat-values">
            <span class="gate-stat-passed">${gate.passed}</span>
            <span class="gate-stat-failed">${gate.failed}</span>
            <div class="gate-stat-bar"><div class="gate-stat-bar-fill" style="width:${passRate}%"></div></div>
            <span class="gate-stat-rate">${passRate.toFixed(0)}%</span>
          </div>
        </div>
      `;
    }).join('');
  } else {
    container.innerHTML = '<div class="empty-state">No data yet</div>';
  }
}

function updateRejectionReasons(reasons) {
  const el = document.getElementById('rejection-list');
  if (!el) return;
  if (!reasons || reasons.length === 0) {
    el.innerHTML = '<div class="empty-state">No rejections yet</div>';
    return;
  }
  el.innerHTML = reasons.slice(0, 8).map(item => `
    <div class="rejection-item">
      <span class="rejection-name">${escapeHtml(formatRejectionReason(item.reason))}</span>
      <span class="rejection-count">${item.count}</span>
    </div>
  `).join('');
}

// ============================================================
// POSITIONS & TRADES
// ============================================================

async function updatePositions() {
  const data = await fetchApi('/api/positions');
  if (!data || !data.positions) return;

  const countEl = document.getElementById('position-count');
  if (countEl) countEl.textContent = data.positions.length;

  const listEl = document.getElementById('positions-list');
  if (!listEl) return;

  if (data.positions.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No open positions</div>';
    return;
  }

  listEl.innerHTML = data.positions.map(pos => {
    const tokenShort = shortenAddress(pos.tokenMint);
    const pnlPercent = pos.currentPnlPercent ?? 0;
    const pnlCls = pnlPercent >= 0 ? 'positive' : 'negative';
    return `
      <div class="position-item">
        <div class="position-token">${tokenShort}</div>
        <div class="position-details">
          <div>Entry: ${pos.amountSol.toFixed(4)} SOL</div>
          <div class="position-pnl ${pnlCls}">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%</div>
        </div>
      </div>
    `;
  }).join('');
}

async function updateTrades() {
  const data = await fetchApi('/api/trades?limit=20');
  if (!data || !data.trades) return;

  const listEl = document.getElementById('trade-list');
  if (!listEl) return;

  if (data.trades.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No trades yet</div>';
    return;
  }

  listEl.innerHTML = data.trades.map(trade => {
    const time = formatTimeAgo(trade.timestamp);
    const typeClass = trade.type === 'buy' ? 'positive' : 'negative';
    return `
      <div class="trade-item">
        <span class="trade-type ${typeClass}">${trade.type.toUpperCase()}</span>
        <span class="trade-token">${shortenAddress(trade.tokenMint)}</span>
        <span class="trade-amount">${trade.amountSol.toFixed(4)} SOL</span>
        <span class="trade-status">${escapeHtml(trade.status)}</span>
        <span class="trade-time">${time}</span>
      </div>
    `;
  }).join('');
}

// ============================================================
// TOKEN LIST
// ============================================================

function updateTokenList() {
  let tokens = recentTokens;
  if (currentTokenFilter) {
    tokens = tokens.filter(t => t.outcome === currentTokenFilter);
  }

  const el = document.getElementById('token-list');
  if (!el) return;

  if (tokens.length === 0) {
    el.innerHTML = '<div class="empty-state">No tokens detected yet</div>';
    return;
  }

  el.innerHTML = tokens.map(token => {
    const time = formatTimeAgo(token.detectedAt);
    const addressShort = shortenAddress(token.mint);
    const name = token.name || 'Unknown';
    const symbol = token.symbol ? `($${token.symbol})` : '';
    let metaHtml = `<div class="token-time">${time}</div>`;
    if (token.outcome === 'rejected' && token.rejectionReason) {
      metaHtml += `<div class="token-rejection">${escapeHtml(formatRejectionReason(token.rejectionReason))}</div>`;
    }
    metaHtml += `<div class="token-duration">${token.pipelineDurationMs}ms</div>`;

    return `
      <div class="token-item">
        <div class="token-outcome ${token.outcome}"></div>
        <div class="token-info">
          <div class="token-name">${escapeHtml(name)} <span class="symbol">${escapeHtml(symbol)}</span></div>
          <div class="token-address"><span class="token-address-text">${addressShort}</span></div>
        </div>
        <div class="token-meta">${metaHtml}</div>
      </div>
    `;
  }).join('');
}

// ============================================================
// MODALS
// ============================================================

function openResetModal() {
  document.getElementById('reset-modal').classList.add('open');
}

function closeResetModal() {
  document.getElementById('reset-modal').classList.remove('open');
}

async function confirmResetStats() {
  const btn = document.getElementById('confirm-reset-btn');
  btn.disabled = true;
  btn.textContent = 'Resetting...';
  const result = await postApi('/api/pipeline-stats/reset');
  if (result && result.success) {
    closeResetModal();
    await updatePipelineStats();
  } else {
    alert('Failed to reset stats');
  }
  btn.disabled = false;
  btn.textContent = 'Reset Stats';
}

// ============================================================
// EVENT HANDLERS
// ============================================================

const tokenFilter = document.getElementById('token-filter');
if (tokenFilter) {
  tokenFilter.addEventListener('change', (e) => {
    currentTokenFilter = e.target.value;
    updateTokenList();
  });
}

const resetBtn = document.getElementById('reset-stats-btn');
if (resetBtn) resetBtn.addEventListener('click', openResetModal);

const confirmBtn = document.getElementById('confirm-reset-btn');
if (confirmBtn) confirmBtn.addEventListener('click', confirmResetStats);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeResetModal();
});

window.closeResetModal = closeResetModal;

// ============================================================
// POLLING
// ============================================================

async function updateAll() {
  await Promise.all([
    updateStatus(),
    updatePnl(),
    updatePipelineStats(),
    updatePositions(),
    updateTrades(),
    updateTradeAudit(),
  ]);
}

updateAll();
setInterval(updateAll, POLL_INTERVAL);
