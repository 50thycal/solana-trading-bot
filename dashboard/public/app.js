/**
 * Solana Trading Bot Dashboard
 * Vanilla JavaScript with polling
 */

// Configuration
const POLL_INTERVAL = 5000; // 5 seconds
const API_BASE = '';

// State
let currentPoolFilter = '';
let currentPoolTypeFilter = '';
let selectedPoolId = null;

// DOM Elements
const elements = {
  connectionStatus: document.getElementById('connection-status'),
  uptime: document.getElementById('uptime'),
  walletBalance: document.getElementById('wallet-balance'),
  totalPnl: document.getElementById('total-pnl'),
  openPositions: document.getElementById('open-positions'),
  poolList: document.getElementById('pool-list'),
  poolFilter: document.getElementById('pool-filter'),
  positionsList: document.getElementById('positions-list'),
  statPoolsDetected: document.getElementById('stat-pools-detected'),
  statPoolsBought: document.getElementById('stat-pools-bought'),
  statBuyRate: document.getElementById('stat-buy-rate'),
  statWinRate: document.getElementById('stat-win-rate'),
  statAmmv4Pools: document.getElementById('stat-ammv4-pools'),
  statCpmmPools: document.getElementById('stat-cpmm-pools'),
  rejectionList: document.getElementById('rejection-list'),
  poolTypeFilter: document.getElementById('pool-type-filter'),
  poolModal: document.getElementById('pool-modal'),
  poolModalBody: document.getElementById('pool-modal-body'),
  // Test trade elements
  poolSelector: document.getElementById('pool-selector'),
  poolIdInput: document.getElementById('pool-id-input'),
  amountInput: document.getElementById('amount-input'),
  dryRunCheckbox: document.getElementById('dry-run-checkbox'),
  testTradeBtn: document.getElementById('test-trade-btn'),
  testTradeResult: document.getElementById('test-trade-result'),
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

  // Actual wallet balance from chain
  if (data.walletBalance !== null && data.walletBalance !== undefined) {
    elements.walletBalance.textContent = `${data.walletBalance.toFixed(4)} SOL`;
  } else {
    elements.walletBalance.textContent = '-- SOL';
  }

  // P&L
  if (data.pnl) {
    const pnl = data.pnl.total;
    elements.totalPnl.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`;
    elements.totalPnl.className = 'card-value ' + (pnl >= 0 ? 'positive' : 'negative');
  }

  // Open positions count
  elements.openPositions.textContent = data.positions?.open || 0;
}

async function updatePools() {
  const filterParam = currentPoolFilter ? `&action=${currentPoolFilter}` : '';
  const poolTypeParam = currentPoolTypeFilter ? `&poolType=${currentPoolTypeFilter}` : '';
  const data = await fetchApi(`/api/pools?limit=50${filterParam}${poolTypeParam}`);
  if (!data || !data.pools) return;

  if (data.pools.length === 0) {
    elements.poolList.innerHTML = '<div class="empty-state">No pool activity yet</div>';
    return;
  }

  elements.poolList.innerHTML = data.pools.map(pool => renderPoolItem(pool)).join('');
}

async function updatePositions() {
  const data = await fetchApi('/api/positions');
  if (!data || !data.positions) return;

  if (data.positions.length === 0) {
    elements.positionsList.innerHTML = '<div class="empty-state">No open positions</div>';
    return;
  }

  elements.positionsList.innerHTML = data.positions.map(pos => renderPositionItem(pos)).join('');
}

async function updateStats() {
  const [statsData, pnlData] = await Promise.all([
    fetchApi('/api/stats'),
    fetchApi('/api/pnl'),
  ]);

  if (statsData?.pools) {
    elements.statPoolsDetected.textContent = statsData.pools.totalDetected;
    elements.statPoolsBought.textContent = statsData.pools.bought;
    elements.statBuyRate.textContent = `${statsData.pools.buyRate}%`;

    // Pool type breakdown
    if (statsData.pools.byPoolType) {
      const ammv4 = statsData.pools.byPoolType.AmmV4 || { total: 0, bought: 0 };
      const cpmm = statsData.pools.byPoolType.CPMM || { total: 0, bought: 0 };
      elements.statAmmv4Pools.textContent = `${ammv4.total} (${ammv4.bought} bought)`;
      elements.statCpmmPools.textContent = `${cpmm.total} (${cpmm.bought} bought)`;
    }
  }

  if (pnlData) {
    const winRate = pnlData.totalTrades > 0
      ? ((pnlData.winningTrades / pnlData.totalTrades) * 100).toFixed(1)
      : '0';
    elements.statWinRate.textContent = `${winRate}%`;
  }

  // Rejection reasons
  if (statsData?.topRejectionReasons?.length > 0) {
    elements.rejectionList.innerHTML = statsData.topRejectionReasons
      .slice(0, 5)
      .map(item => `
        <div class="rejection-item">
          <span class="rejection-name">${item.name}</span>
          <span class="rejection-count">${item.count}</span>
        </div>
      `).join('');
  } else {
    elements.rejectionList.innerHTML = '<div class="empty-state">No data yet</div>';
  }
}

async function updatePoolSelector() {
  // Fetch recent pools for the dropdown (limit to 10 most recent)
  const data = await fetchApi('/api/pools?limit=10');
  if (!data || !data.pools) return;

  // Keep the default option, add pool options
  const defaultOption = '<option value="">-- Select a pool --</option>';

  if (data.pools.length === 0) {
    elements.poolSelector.innerHTML = defaultOption + '<option disabled>No pools available</option>';
    return;
  }

  const poolOptions = data.pools.map(pool => {
    const tokenShort = shortenAddress(pool.tokenMint);
    const poolShort = shortenAddress(pool.poolId);
    const time = formatTimeAgo(pool.detectedAt);
    const actionLabel = pool.action.charAt(0).toUpperCase() + pool.action.slice(1);

    return `<option value="${pool.poolId}">${poolShort} - ${tokenShort} (${actionLabel}, ${time})</option>`;
  }).join('');

  elements.poolSelector.innerHTML = defaultOption + poolOptions;
}

// ============================================================
// RENDERING
// ============================================================

function renderPoolItem(pool) {
  const time = formatTimeAgo(pool.detectedAt);
  const tokenShort = shortenAddress(pool.tokenMint);
  const poolType = pool.poolType || 'AmmV4';
  const poolTypeClass = poolType.toLowerCase();

  // Filter badges (show first 3 failed or all passed)
  const filterBadges = renderFilterBadges(pool.filterResults);

  return `
    <div class="pool-item" onclick="showPoolDetail('${pool.id}')">
      <div class="pool-header">
        <div>
          <span class="pool-action ${pool.action}">${pool.action}</span>
          <span class="pool-type ${poolTypeClass}">${poolType}</span>
          <span class="pool-token">${tokenShort}</span>
        </div>
        <span class="pool-time">${time}</span>
      </div>
      <div class="pool-summary">${pool.summary}</div>
      ${filterBadges ? `<div class="filter-preview">${filterBadges}</div>` : ''}
    </div>
  `;
}

function renderFilterBadges(filterResults) {
  if (!filterResults || filterResults.length === 0) return '';

  const checkedFilters = filterResults.filter(f => f.checked);
  if (checkedFilters.length === 0) return '';

  // Show failed filters first, then passed
  const failed = checkedFilters.filter(f => !f.passed);
  const passed = checkedFilters.filter(f => f.passed);

  const toShow = [...failed.slice(0, 3), ...passed.slice(0, Math.max(0, 3 - failed.length))];

  return toShow.map(f => `
    <span class="filter-badge ${f.passed ? 'pass' : 'fail'}">
      <span class="icon">${f.passed ? '\u2713' : '\u2717'}</span>
      ${f.displayName}
    </span>
  `).join('');
}

function renderPositionItem(pos) {
  const tokenShort = shortenAddress(pos.tokenMint);
  const pnlPercent = pos.currentPnlPercent ?? 0;
  const pnlClass = pnlPercent >= 0 ? 'positive' : 'negative';

  return `
    <div class="position-item">
      <div class="position-token">${tokenShort}</div>
      <div class="position-details">
        <div>Entry: ${pos.amountSol.toFixed(4)} SOL</div>
        <div class="position-pnl ${pnlClass}">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%</div>
        <div>TP: ${pos.takeProfitSol?.toFixed(4) || '--'}</div>
        <div>SL: ${pos.stopLossSol?.toFixed(4) || '--'}</div>
      </div>
    </div>
  `;
}

// ============================================================
// MODAL
// ============================================================

async function showPoolDetail(poolId) {
  selectedPoolId = poolId;
  const pool = await fetchApi(`/api/pools/${poolId}`);
  if (!pool || pool.error) {
    alert('Failed to load pool details');
    return;
  }

  elements.poolModalBody.innerHTML = renderPoolDetailContent(pool);
  elements.poolModal.classList.add('open');
}

function closePoolModal() {
  elements.poolModal.classList.remove('open');
  selectedPoolId = null;
}

function renderPoolDetailContent(pool) {
  const time = new Date(pool.detectedAt).toLocaleString();
  const poolType = pool.poolType || 'AmmV4';
  const poolTypeClass = poolType.toLowerCase();

  // Token info section
  const tokenInfo = `
    <div class="modal-section">
      <h4>Token Information</h4>
      <div class="token-info">
        <div class="token-field">
          <div class="token-field-label">Token Mint</div>
          <div class="token-field-value">${pool.tokenMint}</div>
        </div>
        <div class="token-field">
          <div class="token-field-label">Pool ID</div>
          <div class="token-field-value">${pool.poolId}</div>
        </div>
        <div class="token-field">
          <div class="token-field-label">Pool Type</div>
          <div class="token-field-value">
            <span class="pool-type ${poolTypeClass}">${poolType}</span>
          </div>
        </div>
        <div class="token-field">
          <div class="token-field-label">Detected At</div>
          <div class="token-field-value">${time}</div>
        </div>
        <div class="token-field">
          <div class="token-field-label">Action</div>
          <div class="token-field-value">
            <span class="pool-action ${pool.action}">${pool.action}</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Filter results section
  let filterSection = '';
  if (pool.filterResults && pool.filterResults.length > 0) {
    const filterItems = pool.filterResults.map(f => {
      const iconClass = !f.checked ? 'skipped' : (f.passed ? 'pass' : 'fail');
      const icon = !f.checked ? '-' : (f.passed ? '\u2713' : '\u2717');

      let valuesHtml = '';
      if (f.expectedValue || f.actualValue) {
        valuesHtml = `
          <div class="filter-values">
            ${f.expectedValue ? `Expected: ${f.expectedValue}` : ''}
            ${f.expectedValue && f.actualValue ? ' | ' : ''}
            ${f.actualValue ? `Actual: ${f.actualValue}` : ''}
          </div>
        `;
      }

      return `
        <div class="filter-detail">
          <span class="filter-icon ${iconClass}">${icon}</span>
          <div class="filter-info">
            <div class="filter-name">${f.displayName}</div>
            <div class="filter-reason">${f.reason}</div>
            ${valuesHtml}
          </div>
        </div>
      `;
    }).join('');

    filterSection = `
      <div class="modal-section">
        <h4>Filter Results</h4>
        ${filterItems}
      </div>
    `;
  }

  // Risk check section
  let riskSection = '';
  if (pool.riskCheckReason) {
    riskSection = `
      <div class="modal-section">
        <h4>Risk Check</h4>
        <div class="filter-detail">
          <span class="filter-icon ${pool.riskCheckPassed ? 'pass' : 'fail'}">
            ${pool.riskCheckPassed ? '\u2713' : '\u2717'}
          </span>
          <div class="filter-info">
            <div class="filter-name">Risk Assessment</div>
            <div class="filter-reason">${pool.riskCheckReason}</div>
          </div>
        </div>
      </div>
    `;
  }

  // Summary section
  const summarySection = `
    <div class="modal-section">
      <h4>Summary</h4>
      <div class="filter-detail">
        <div class="filter-info">
          <div class="filter-reason">${pool.summary}</div>
        </div>
      </div>
    </div>
  `;

  // External links
  const linksSection = `
    <div class="modal-section">
      <h4>External Links</h4>
      <div class="token-info">
        <div class="token-field">
          <a href="https://dexscreener.com/solana/${pool.tokenMint}" target="_blank" rel="noopener" style="color: var(--accent-blue);">
            DexScreener
          </a>
        </div>
        <div class="token-field">
          <a href="https://solscan.io/token/${pool.tokenMint}" target="_blank" rel="noopener" style="color: var(--accent-blue);">
            Solscan
          </a>
        </div>
      </div>
    </div>
  `;

  return tokenInfo + filterSection + riskSection + summarySection + linksSection;
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

// ============================================================
// EVENT HANDLERS
// ============================================================

elements.poolFilter.addEventListener('change', (e) => {
  currentPoolFilter = e.target.value;
  updatePools();
});

elements.poolTypeFilter.addEventListener('change', (e) => {
  currentPoolTypeFilter = e.target.value;
  updatePools();
});

// Pool selector for test trade
elements.poolSelector.addEventListener('change', (e) => {
  const selectedPoolId = e.target.value;
  if (selectedPoolId) {
    elements.poolIdInput.value = selectedPoolId;
  }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && elements.poolModal.classList.contains('open')) {
    closePoolModal();
  }
});

// ============================================================
// TEST TRADE
// ============================================================

let isTestTradeRunning = false;

async function executeTestTrade() {
  if (isTestTradeRunning) return;

  const poolId = elements.poolIdInput.value.trim();
  const amountValue = elements.amountInput.value.trim();
  const dryRun = elements.dryRunCheckbox.checked;

  // Validate pool ID
  if (!poolId) {
    showTestTradeResult(false, 'Please enter a Pool ID');
    return;
  }

  // Validate pool ID format (base58, 32-44 characters)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(poolId)) {
    showTestTradeResult(false, 'Invalid Pool ID format');
    return;
  }

  // Parse amount if provided
  let amount;
  if (amountValue) {
    amount = parseFloat(amountValue);
    if (isNaN(amount) || amount <= 0) {
      showTestTradeResult(false, 'Invalid amount');
      return;
    }
  }

  // Start loading state
  isTestTradeRunning = true;
  elements.testTradeBtn.disabled = true;
  elements.testTradeBtn.textContent = 'Executing...';
  hideTestTradeResult();

  try {
    const response = await fetch(`${API_BASE}/api/test-trade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        poolId,
        dryRun,
        amount,
      }),
    });

    const result = await response.json();
    showTestTradeResult(result.success, result.message, result.details);
  } catch (error) {
    console.error('Test trade error:', error);
    showTestTradeResult(false, 'Failed to execute test trade', { error: error.message });
  } finally {
    isTestTradeRunning = false;
    elements.testTradeBtn.disabled = false;
    elements.testTradeBtn.textContent = 'Execute Trade';
  }
}

function showTestTradeResult(success, message, details) {
  const resultEl = elements.testTradeResult;
  const iconEl = resultEl.querySelector('.result-icon');
  const messageEl = resultEl.querySelector('.result-message');
  const detailsEl = resultEl.querySelector('.result-details');

  resultEl.style.display = 'block';
  resultEl.className = `test-trade-result ${success ? 'success' : 'error'}`;

  iconEl.textContent = success ? '\u2713' : '\u2717';
  messageEl.textContent = message;

  if (details) {
    const detailItems = [];
    if (details.poolId) detailItems.push(`Pool: ${shortenAddress(details.poolId)}`);
    if (details.tokenMint) detailItems.push(`Token: ${shortenAddress(details.tokenMint)}`);
    if (details.amount) detailItems.push(`Amount: ${details.amount} SOL`);
    if (details.dryRun !== undefined) detailItems.push(`Mode: ${details.dryRun ? 'Dry Run' : 'Live'}`);
    if (details.txSignature) detailItems.push(`Tx: ${shortenAddress(details.txSignature)}`);
    if (details.error) detailItems.push(`Error: ${details.error}`);

    detailsEl.innerHTML = detailItems.map(item => `<div>${item}</div>`).join('');
  } else {
    detailsEl.innerHTML = '';
  }
}

function hideTestTradeResult() {
  elements.testTradeResult.style.display = 'none';
}

// Test trade button handler
elements.testTradeBtn.addEventListener('click', executeTestTrade);

// Handle Enter key in pool ID input
elements.poolIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    executeTestTrade();
  }
});

// ============================================================
// POLLING
// ============================================================

async function updateAll() {
  await Promise.all([
    updateStatus(),
    updatePools(),
    updatePositions(),
    updateStats(),
    updatePoolSelector(),
  ]);
}

// Initial load
updateAll();

// Start polling
setInterval(updateAll, POLL_INTERVAL);

// Make functions available globally for onclick handlers
window.showPoolDetail = showPoolDetail;
window.closePoolModal = closePoolModal;
