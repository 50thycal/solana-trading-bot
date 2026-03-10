/**
 * Smoke Test Results Page
 * Shows smoke test report with full step-by-step detail and clickable history
 */

const POLL_INTERVAL = 5000;

// Track whether the user is viewing a historical report (null = current)
let viewingReportId = null;

// fetchApi is loaded from utils.js

function formatDuration(ms) {
  if (!ms) return '--';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

// formatTimeAgo, formatPnl, pnlClass, escapeHtml are loaded from utils.js

function formatDate(timestamp) {
  if (!timestamp) return '--';
  return new Date(timestamp).toLocaleString();
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

/**
 * Build a run group label like "10:30 AM - 2/5" for multi-run sessions.
 * Returns empty string for single runs.
 */
function runGroupLabel(report) {
  if (!report || !report.totalRuns || report.totalRuns <= 1) return '';
  const time = formatTime(report.startedAt);
  return `${time} - ${report.runNumber}/${report.totalRuns}`;
}

/**
 * Render live progress of a running smoke test
 */
function renderProgress(progress) {
  const badge = document.getElementById('smoke-badge');
  badge.textContent = 'RUNNING';
  badge.style.background = 'linear-gradient(135deg, #ff9800, #ffcc02)';

  // Show run group label for multi-run sessions
  const groupEl = document.getElementById('run-group-label');
  if (groupEl) {
    if (progress.totalRuns > 1) {
      groupEl.textContent = `Run ${progress.runNumber} of ${progress.totalRuns}`;
      groupEl.style.display = '';
    } else {
      groupEl.style.display = 'none';
    }
  }

  document.getElementById('overall-result').textContent = 'Running...';
  document.getElementById('overall-result').className = 'card-value';

  document.getElementById('pnl-value').textContent = '--';
  document.getElementById('trade-return').textContent = '--';
  document.getElementById('trade-return').className = 'card-value';
  document.getElementById('total-overhead').textContent = '--';
  document.getElementById('total-overhead').className = 'card-value';
  document.getElementById('pnl-percent-with').textContent = '--';
  document.getElementById('pnl-percent-with').className = 'card-value';
  document.getElementById('pnl-percent-without').textContent = '--';
  document.getElementById('pnl-percent-without').className = 'card-value';
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

  document.getElementById('wallet-after').textContent = '--';
  document.getElementById('net-cost').textContent = '--';

  document.getElementById('efficiency-score').textContent = '--';
  document.getElementById('efficiency-score').className = 'card-value big';
  document.getElementById('hold-duration').textContent = '--';
  document.getElementById('high-water-mark').textContent = '--';
  document.getElementById('high-water-mark').className = 'card-value';

  // Hide panels during progress
  const feePanel = document.getElementById('fee-breakdown-panel');
  if (feePanel) feePanel.style.display = 'none';
  const slippagePanel = document.getElementById('slippage-panel');
  if (slippagePanel) slippagePanel.style.display = 'none';
  const pricePanel = document.getElementById('price-chart-panel');
  if (pricePanel) pricePanel.style.display = 'none';

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
  lastRenderedReport = report;

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

  // Show run group label for multi-run sessions
  const groupEl = document.getElementById('run-group-label');
  if (groupEl) {
    const label = runGroupLabel(report);
    if (label) {
      groupEl.textContent = label;
      groupEl.style.display = '';
    } else {
      groupEl.style.display = 'none';
    }
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

  // Trade return (ex-overhead)
  const tradeReturnEl = document.getElementById('trade-return');
  if (report.tradeReturnSol !== undefined) {
    tradeReturnEl.textContent = formatPnl(report.tradeReturnSol);
    tradeReturnEl.className = `card-value ${pnlClass(report.tradeReturnSol)}`;
  } else {
    tradeReturnEl.textContent = '--';
    tradeReturnEl.className = 'card-value';
  }

  // Total overhead
  const totalOverheadEl = document.getElementById('total-overhead');
  if (report.feeBreakdown && report.feeBreakdown.totalOverhead !== undefined) {
    totalOverheadEl.textContent = `${report.feeBreakdown.totalOverhead.toFixed(6)} SOL`;
    totalOverheadEl.className = 'card-value negative';
  } else {
    totalOverheadEl.textContent = '--';
    totalOverheadEl.className = 'card-value';
  }

  // % Return with overhead
  const pctWithEl = document.getElementById('pnl-percent-with');
  if (report.pnlPercentWithOverhead !== undefined) {
    const sign = report.pnlPercentWithOverhead >= 0 ? '+' : '';
    pctWithEl.textContent = `${sign}${report.pnlPercentWithOverhead.toFixed(2)}%`;
    pctWithEl.className = `card-value ${pnlClass(report.pnlPercentWithOverhead)}`;
  } else {
    pctWithEl.textContent = '--';
    pctWithEl.className = 'card-value';
  }

  // % Return without overhead
  const pctWithoutEl = document.getElementById('pnl-percent-without');
  if (report.pnlPercentWithoutOverhead !== undefined) {
    const sign = report.pnlPercentWithoutOverhead >= 0 ? '+' : '';
    pctWithoutEl.textContent = `${sign}${report.pnlPercentWithoutOverhead.toFixed(2)}%`;
    pctWithoutEl.className = `card-value ${pnlClass(report.pnlPercentWithoutOverhead)}`;
  } else {
    pctWithoutEl.textContent = '--';
    pctWithoutEl.className = 'card-value';
  }

  // Efficiency score
  const effEl = document.getElementById('efficiency-score');
  if (report.tradeEfficiencyScore !== undefined) {
    effEl.textContent = `${report.tradeEfficiencyScore}/100`;
    const effClass = report.tradeEfficiencyScore >= 70 ? 'positive'
      : report.tradeEfficiencyScore >= 40 ? '' : 'negative';
    effEl.className = `card-value big ${effClass}`;
  } else {
    effEl.textContent = '--';
    effEl.className = 'card-value big';
  }

  // Hold duration
  const holdEl = document.getElementById('hold-duration');
  if (report.holdDurationMs) {
    holdEl.textContent = formatDuration(report.holdDurationMs);
  } else {
    holdEl.textContent = '--';
  }

  // High water mark
  const hwmEl = document.getElementById('high-water-mark');
  if (report.highWaterMarkPercent !== undefined) {
    const sign = report.highWaterMarkPercent >= 0 ? '+' : '';
    hwmEl.textContent = `${sign}${report.highWaterMarkPercent.toFixed(2)}%`;
    hwmEl.className = `card-value ${pnlClass(report.highWaterMarkPercent)}`;
  } else {
    hwmEl.textContent = '--';
    hwmEl.className = 'card-value';
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

  const walletAfter = document.getElementById('wallet-after');
  if (report.walletBalanceAfter !== undefined) {
    walletAfter.textContent = `${report.walletBalanceAfter.toFixed(4)} SOL`;
  } else {
    walletAfter.textContent = '--';
  }

  const netCost = document.getElementById('net-cost');
  if (report.netCostSol !== undefined) {
    netCost.textContent = `${report.netCostSol.toFixed(6)} SOL`;
    netCost.className = `card-value ${report.netCostSol > 0 ? 'negative' : 'positive'}`;
  }

  // Fee breakdown panel
  renderFeeBreakdown(report);

  // Slippage analysis panel
  renderSlippageAnalysis(report);

  // Price chart panel
  renderPriceChart(report);

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

  // Traded token panel
  renderTradedToken(report);
}

/**
 * Copy a mint/address to clipboard and flash the button label.
 * Called from inline onclick in the traded-token panel.
 */
function copyMint(text, btn) {
  const original = btn.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {
    // Fallback for browsers that block clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

/**
 * Render the Traded Token info panel for a completed report.
 * Shows token name/symbol, contract address, bonding curve, and
 * buy/sell timestamps with Solscan explorer links.
 */
function renderTradedToken(report) {
  const panel = document.getElementById('traded-token-panel');
  const meta = document.getElementById('traded-token-meta');
  const subtitle = document.getElementById('traded-token-subtitle');
  if (!panel || !meta) return;

  const token = report.tradedToken;
  if (!token || !token.mint) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  subtitle.textContent = `${token.symbol || '?'} · ${token.name || 'Unknown'}`;

  const solscanTx = (sig) => sig
    ? `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}" target="_blank" rel="noopener" title="${escapeHtml(sig)}">${escapeHtml(sig.substring(0, 12))}…</a>`
    : '<span class="text-muted">—</span>';

  const solscanAddr = (addr, label) => addr
    ? `<a href="https://solscan.io/token/${encodeURIComponent(addr)}" target="_blank" rel="noopener" title="${escapeHtml(addr)}">${label || escapeHtml(addr.substring(0, 16))}…</a>`
    : '<span class="text-muted">—</span>';

  const buyTime  = report.buyTimestamp  ? formatDate(report.buyTimestamp)  : '—';
  const sellTime = report.sellTimestamp ? formatDate(report.sellTimestamp) : '—';

  meta.innerHTML = `
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Token</span>
      <span class="smoke-meta-value">${escapeHtml(token.symbol || '?')} &mdash; ${escapeHtml(token.name || 'Unknown')}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Contract Address</span>
      <span class="smoke-meta-value" style="font-family:monospace;font-size:0.8rem;display:flex;align-items:center;gap:0.4rem;">
        <span title="${escapeHtml(token.mint)}">${escapeHtml(token.mint.substring(0, 20))}…</span>
        <button class="btn btn-secondary btn-small" style="padding:0.1rem 0.5rem;font-size:0.7rem;font-family:sans-serif;" onclick="copyMint('${token.mint}', this)">Copy</button>
      </span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Bonding Curve</span>
      <span class="smoke-meta-value" style="font-family:monospace;font-size:0.8rem;" title="${escapeHtml(token.bondingCurve || '')}">
        ${token.bondingCurve ? escapeHtml(token.bondingCurve.substring(0, 20)) + '…' : '—'}
      </span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Buy Confirmed</span>
      <span class="smoke-meta-value">${escapeHtml(buyTime)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Buy Transaction</span>
      <span class="smoke-meta-value" style="font-family:monospace;font-size:0.8rem;">${solscanTx(report.buySignature)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Sell Confirmed</span>
      <span class="smoke-meta-value">${escapeHtml(sellTime)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Sell Transaction</span>
      <span class="smoke-meta-value" style="font-family:monospace;font-size:0.8rem;">${solscanTx(report.sellSignature)}</span>
    </div>
  `;
}

/**
 * Render the Fee Breakdown panel for a completed report.
 * Shows itemized overhead costs and estimated protocol fees.
 */
function renderFeeBreakdown(report) {
  const panel = document.getElementById('fee-breakdown-panel');
  const meta = document.getElementById('fee-breakdown-meta');
  const subtitle = document.getElementById('fee-breakdown-subtitle');
  if (!panel || !meta) return;

  const fb = report.feeBreakdown;
  if (!fb) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  subtitle.textContent = `${fb.totalOverhead.toFixed(6)} SOL all-in overhead`;

  const fmtSol = (v) => v !== undefined && v !== null ? `${v.toFixed(6)} SOL` : '—';

  const sellReceivedHtml = report.sellSolReceived !== undefined
    ? `<div class="smoke-meta-item">
        <span class="smoke-meta-label">SOL Received from Sell</span>
        <span class="smoke-meta-value">${fmtSol(report.sellSolReceived)}</span>
      </div>`
    : '';

  const sectionDivider = '<div style="border-top: 1px solid rgba(255,255,255,0.08); margin: 0.4rem 0;"></div>';

  meta.innerHTML = `
    <div style="font-size:0.75rem;color:var(--text-secondary);padding:0.25rem 0.5rem;text-transform:uppercase;letter-spacing:0.05em;">Wallet Overhead (measured)</div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Buy Side (gas + priority fee + Jito tip + ATA rent)</span>
      <span class="smoke-meta-value negative">${fmtSol(fb.buyOverhead)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Sell Side (gas + priority fee + Jito tip)</span>
      <span class="smoke-meta-value negative">${fmtSol(fb.sellOverhead)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Wallet Overhead Subtotal</span>
      <span class="smoke-meta-value negative">${fmtSol(fb.walletOverhead)}</span>
    </div>
    ${sectionDivider}
    <div style="font-size:0.75rem;color:var(--text-secondary);padding:0.25rem 0.5rem;text-transform:uppercase;letter-spacing:0.05em;">Protocol Fees (estimated, embedded in price)</div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Pump.fun Buy Fee (~1%)</span>
      <span class="smoke-meta-value negative">${fmtSol(fb.estimatedPumpBuyFee)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Pump.fun Sell Fee (~1.25%)</span>
      <span class="smoke-meta-value negative">${fmtSol(fb.estimatedPumpSellFee)}</span>
    </div>
    ${sectionDivider}
    <div style="font-size:0.75rem;color:var(--text-secondary);padding:0.25rem 0.5rem;text-transform:uppercase;letter-spacing:0.05em;">Transaction Executor</div>
    ${(() => {
      if (!fb.bundleExecutorActive) {
        return `
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Jito Tip (configured per tx)</span>
      <span class="smoke-meta-value" style="opacity:0.5;">${fmtSol(fb.jitoTipPerTx)} <span style="font-size:0.7rem;color:#ff9800;">NOT SENT</span></span>
    </div>
    <div style="font-size:0.7rem;color:#ff9800;padding:0 0.75rem 0.25rem;">TRANSACTION_EXECUTOR=${fb.executorType || 'default'} — set to "jito" or "warp" to enable bundles</div>`;
      }
      const buyExec = fb.buyExecutorUsed || 'unknown';
      const sellExec = fb.sellExecutorUsed || 'unknown';
      const buyIsJito = buyExec === 'jito';
      const sellIsJito = sellExec === 'jito';
      const bothJito = buyIsJito && sellIsJito;
      const neitherJito = !buyIsJito && !sellIsJito;
      const statusColor = bothJito ? '#00c853' : neitherJito ? '#ff5252' : '#ff9800';
      const statusLabel = bothJito ? 'SENT' : neitherJito ? 'FAILED → RPC' : 'PARTIAL';
      const detailText = bothJito
        ? 'Both transactions sent via Jito bundle (MEV protected)'
        : neitherJito
        ? 'Jito bundles failed — fell back to default RPC (no tip sent)'
        : 'Buy: ' + (buyIsJito ? 'Jito ✓' : 'default RPC ✗') + ' | Sell: ' + (sellIsJito ? 'Jito ✓' : 'default RPC ✗');
      return `
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">${fb.executorType === 'jito' ? 'Jito' : 'Warp'} Tip (per tx)</span>
      <span class="smoke-meta-value negative">${fmtSol(fb.jitoTipPerTx)} <span style="font-size:0.7rem;color:${statusColor};">${statusLabel}</span></span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Buy Executor</span>
      <span class="smoke-meta-value" style="color:${buyIsJito ? '#00c853' : '#ff5252'};">${buyExec}${buyIsJito ? ' ✓' : ' (fallback)'}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Sell Executor</span>
      <span class="smoke-meta-value" style="color:${sellIsJito ? '#00c853' : '#ff5252'};">${sellExec}${sellIsJito ? ' ✓' : ' (fallback)'}</span>
    </div>
    <div style="font-size:0.7rem;color:${statusColor};padding:0 0.75rem 0.25rem;">${detailText}</div>`;
    })()}
    ${sellReceivedHtml}
    ${sectionDivider}
    <div class="smoke-meta-item" style="padding-top: 0.25rem;">
      <span class="smoke-meta-label" style="font-weight:700;">Total Overhead (all-in)</span>
      <span class="smoke-meta-value negative" style="font-weight:700;">${fmtSol(fb.totalOverhead)}</span>
    </div>
  `;
}

/**
 * Render the Slippage Analysis panel.
 */
function renderSlippageAnalysis(report) {
  const panel = document.getElementById('slippage-panel');
  const meta = document.getElementById('slippage-meta');
  const subtitle = document.getElementById('slippage-subtitle');
  if (!panel || !meta) return;

  const s = report.slippage;
  if (!s) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  const totalCost = (s.buySlippageCostSol || 0) + (s.sellSlippageCostSol || 0);
  subtitle.textContent = totalCost > 0 ? `~${totalCost.toFixed(6)} SOL lost to slippage` : 'Minimal slippage';

  const fmtPct = (v) => {
    if (v === undefined || v === null) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}%`;
  };
  const fmtSol = (v) => v !== undefined && v !== null ? `${v.toFixed(6)} SOL` : '—';
  const fmtTokens = (v) => {
    if (v === undefined || v === null) return '—';
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
    return v.toFixed(0);
  };

  const buySlipClass = (s.buySlippagePercent ?? 0) < -2 ? 'negative' : (s.buySlippagePercent ?? 0) > 0 ? 'positive' : '';
  const sellSlipClass = (s.sellSlippagePercent ?? 0) < -2 ? 'negative' : (s.sellSlippagePercent ?? 0) > 0 ? 'positive' : '';

  meta.innerHTML = `
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Buy Slippage</span>
      <span class="smoke-meta-value ${buySlipClass}">${fmtPct(s.buySlippagePercent)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Expected / Actual Tokens</span>
      <span class="smoke-meta-value">${fmtTokens(s.buyExpectedTokens)} / ${fmtTokens(s.buyActualTokens)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Buy Slippage Cost</span>
      <span class="smoke-meta-value ${s.buySlippageCostSol > 0 ? 'negative' : ''}">${fmtSol(s.buySlippageCostSol)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Sell Slippage</span>
      <span class="smoke-meta-value ${sellSlipClass}">${fmtPct(s.sellSlippagePercent)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Expected / Actual SOL</span>
      <span class="smoke-meta-value">${fmtSol(s.sellExpectedSol)} / ${fmtSol(s.sellActualSol)}</span>
    </div>
    <div class="smoke-meta-item">
      <span class="smoke-meta-label">Sell Slippage Cost</span>
      <span class="smoke-meta-value ${s.sellSlippageCostSol > 0 ? 'negative' : ''}">${fmtSol(s.sellSlippageCostSol)}</span>
    </div>
  `;
}

/**
 * Render the Price During Hold sparkline chart using Canvas.
 * No external chart library needed — draws a simple line chart.
 */
function renderPriceChart(report) {
  const panel = document.getElementById('price-chart-panel');
  const subtitle = document.getElementById('price-chart-subtitle');
  const canvas = document.getElementById('price-sparkline');
  if (!panel || !canvas) return;

  const history = report.priceHistory;
  if (!history || history.length < 2) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';

  const minPnl = Math.min(...history.map(p => p.pnlPercent));
  const maxPnl = Math.max(...history.map(p => p.pnlPercent));
  subtitle.textContent = `${history.length} snapshots · PnL range: ${minPnl.toFixed(1)}% to ${maxPnl.toFixed(1)}%`;

  // Draw on canvas
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const padding = { top: 20, right: 15, bottom: 25, left: 50 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Value range for Y axis
  const values = history.map(p => p.pnlPercent);
  let yMin = Math.min(...values, 0);
  let yMax = Math.max(...values, 0);
  const yPad = Math.max((yMax - yMin) * 0.1, 0.5);
  yMin -= yPad;
  yMax += yPad;

  // Time range for X axis
  const tMin = history[0].timestamp;
  const tMax = history[history.length - 1].timestamp;
  const tRange = tMax - tMin || 1;

  const xScale = (t) => padding.left + ((t - tMin) / tRange) * plotW;
  const yScale = (v) => padding.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Draw zero line
  const zeroY = yScale(0);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padding.left, zeroY);
  ctx.lineTo(w - padding.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw Y axis labels
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '11px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('0%', padding.left - 5, zeroY + 4);
  ctx.fillText(`${yMax.toFixed(1)}%`, padding.left - 5, padding.top + 4);
  ctx.fillText(`${yMin.toFixed(1)}%`, padding.left - 5, h - padding.bottom + 4);

  // Draw X axis labels (start and end time)
  ctx.textAlign = 'center';
  const fmtT = (ts) => {
    const d = new Date(ts);
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${d.getHours()}:${m}:${s}`;
  };
  ctx.fillText(fmtT(tMin), padding.left, h - 5);
  ctx.fillText(fmtT(tMax), w - padding.right, h - 5);

  // Draw gradient fill
  const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
  const lastVal = values[values.length - 1];
  if (lastVal >= 0) {
    gradient.addColorStop(0, 'rgba(0, 200, 83, 0.3)');
    gradient.addColorStop(1, 'rgba(0, 200, 83, 0.02)');
  } else {
    gradient.addColorStop(0, 'rgba(255, 82, 82, 0.02)');
    gradient.addColorStop(1, 'rgba(255, 82, 82, 0.3)');
  }

  ctx.beginPath();
  ctx.moveTo(xScale(history[0].timestamp), yScale(history[0].pnlPercent));
  for (let i = 1; i < history.length; i++) {
    ctx.lineTo(xScale(history[i].timestamp), yScale(history[i].pnlPercent));
  }
  // Close the fill area down to zero line
  ctx.lineTo(xScale(history[history.length - 1].timestamp), zeroY);
  ctx.lineTo(xScale(history[0].timestamp), zeroY);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw the line
  ctx.beginPath();
  ctx.moveTo(xScale(history[0].timestamp), yScale(history[0].pnlPercent));
  for (let i = 1; i < history.length; i++) {
    ctx.lineTo(xScale(history[i].timestamp), yScale(history[i].pnlPercent));
  }
  ctx.strokeStyle = lastVal >= 0 ? '#00c853' : '#ff5252';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw endpoint dot
  const lastX = xScale(history[history.length - 1].timestamp);
  const lastY = yScale(history[history.length - 1].pnlPercent);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = lastVal >= 0 ? '#00c853' : '#ff5252';
  ctx.fill();
}

/**
 * Load and render the current (live) smoke test report or in-progress status
 */
async function updateSmokeTestReport() {
  // Don't overwrite when viewing a historical report
  if (viewingReportId !== null) return;

  // Check progress FIRST - if a test is actively running, always show live progress.
  // This is critical for multi-run mode: after run 1 completes, lastReport is set,
  // but run 2 may already be in progress. Without checking progress first, the
  // dashboard would get stuck showing the stale run 1 report.
  const progress = await fetchApi('/api/smoke-test-progress');

  // Re-check after await: user may have clicked a history item while fetch was in-flight
  if (viewingReportId !== null) return;

  if (progress && progress.running) {
    renderProgress(progress);
    return;
  }

  // No test running - show the latest completed report
  const report = await fetchApi('/api/smoke-test-report');

  // Re-check again after second await
  if (viewingReportId !== null) return;

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
    const groupInfo = (report.totalRuns && report.totalRuns > 1) ? ` (Run ${report.runNumber}/${report.totalRuns})` : '';
    bannerText.textContent = `Viewing smoke test from ${formatDate(Number(reportId))}${groupInfo}`;
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
    const groupTag = (report.totalRuns && report.totalRuns > 1)
      ? `<span class="run-group-tag">${report.runNumber}/${report.totalRuns}</span>`
      : '';

    return `
      <div class="run-history-item history-item-clickable ${isActive ? 'active-report' : ''}"
           data-report-id="${escapeHtml(id)}"
           onclick="viewReport('${escapeHtml(id)}')">
        <div class="run-mode">${escapeHtml(report.overallResult)}</div>
        <div class="run-summary">${groupTag}${escapeHtml(date)} &middot; ${duration}${exitTrigger ? ' &middot; ' + escapeHtml(exitTrigger) : ''}</div>
        <div class="run-pnl ${pnlCls}">${pnlValue}</div>
        <div class="run-status ${statusClass}">${report.passedCount}/${report.totalSteps} steps</div>
        <div class="run-time">${formatTimeAgo(report.startedAt)}</div>
      </div>
    `;
  }).join('');
}

/**
 * Build a plain-text report for clipboard (for pasting into Claude for analysis)
 */
function buildReportText(report) {
  if (!report || report.status === 'no_report') return 'No smoke test report available.';

  const lines = [];
  const groupInfo = (report.totalRuns && report.totalRuns > 1) ? ` (Run ${report.runNumber}/${report.totalRuns})` : '';
  lines.push(`=== Smoke Test Report${groupInfo} ===`);
  lines.push(`Result: ${report.overallResult}`);
  lines.push(`Date: ${formatDate(report.startedAt)}`);
  lines.push(`Duration: ${formatDuration(report.totalDurationMs)}`);
  lines.push(`Steps: ${report.passedCount}/${report.totalSteps} passed, ${report.failedCount} failed`);

  if (report.exitTrigger) lines.push(`Exit Trigger: ${report.exitTrigger}`);
  if (report.walletBalanceBefore !== undefined) lines.push(`Wallet Before: ${report.walletBalanceBefore.toFixed(4)} SOL`);
  if (report.walletBalanceAfter !== undefined) lines.push(`Wallet After: ${report.walletBalanceAfter.toFixed(4)} SOL`);
  if (report.netCostSol !== undefined) {
    lines.push(`Net Cost: ${report.netCostSol.toFixed(6)} SOL`);
    lines.push(`P&L (All-in): ${formatPnl(-report.netCostSol)}`);
  }
  if (report.tradeReturnSol !== undefined) lines.push(`Trade Return (ex-overhead): ${formatPnl(report.tradeReturnSol)}`);
  if (report.pnlPercentWithOverhead !== undefined) {
    const sign = report.pnlPercentWithOverhead >= 0 ? '+' : '';
    lines.push(`% Return (All-in): ${sign}${report.pnlPercentWithOverhead.toFixed(2)}%`);
  }
  if (report.pnlPercentWithoutOverhead !== undefined) {
    const sign = report.pnlPercentWithoutOverhead >= 0 ? '+' : '';
    lines.push(`% Return (Trade only): ${sign}${report.pnlPercentWithoutOverhead.toFixed(2)}%`);
  }
  if (report.feeBreakdown) {
    const fb = report.feeBreakdown;
    lines.push('');
    lines.push('--- Fee Breakdown (All-In) ---');
    lines.push(`Buy Overhead (measured):      ${fb.buyOverhead.toFixed(6)} SOL`);
    lines.push(`Sell Overhead (measured):     ${fb.sellOverhead.toFixed(6)} SOL`);
    lines.push(`Wallet Overhead Subtotal:     ${fb.walletOverhead.toFixed(6)} SOL`);
    lines.push(`Pump Buy Fee (~1%, est):      ${fb.estimatedPumpBuyFee.toFixed(6)} SOL`);
    lines.push(`Pump Sell Fee (~1.25%, est):   ${fb.estimatedPumpSellFee.toFixed(6)} SOL`);
    if (fb.bundleExecutorActive) {
      const buyExec = fb.buyExecutorUsed || 'unknown';
      const sellExec = fb.sellExecutorUsed || 'unknown';
      const bothJito = buyExec === 'jito' && sellExec === 'jito';
      const tipNote = bothJito ? '✓ SENT via Jito' : `buy: ${buyExec}, sell: ${sellExec}`;
      lines.push(`${fb.executorType} Tip (per tx):          ${fb.jitoTipPerTx.toFixed(6)} SOL ${tipNote}`);
      lines.push(`Buy Executor Used:            ${buyExec}`);
      lines.push(`Sell Executor Used:           ${sellExec}`);
    } else {
      lines.push(`Jito Tip (configured/tx):     ${fb.jitoTipPerTx.toFixed(6)} SOL ⚠ NOT SENT (set TRANSACTION_EXECUTOR=jito)`);
    }
    lines.push(`Total Overhead (all-in):      ${fb.totalOverhead.toFixed(6)} SOL`);
    if (report.sellSolReceived !== undefined) lines.push(`SOL Received from Sell:       ${report.sellSolReceived.toFixed(6)} SOL`);
  }

  if (report.tradeEfficiencyScore !== undefined) lines.push(`Trade Efficiency Score: ${report.tradeEfficiencyScore}/100`);
  if (report.holdDurationMs) lines.push(`Hold Duration: ${formatDuration(report.holdDurationMs)}`);
  if (report.highWaterMarkPercent !== undefined) {
    const sign = report.highWaterMarkPercent >= 0 ? '+' : '';
    lines.push(`High Water Mark: ${sign}${report.highWaterMarkPercent.toFixed(2)}%`);
  }

  if (report.slippage) {
    const s = report.slippage;
    lines.push('');
    lines.push('--- Slippage Analysis ---');
    if (s.buySlippagePercent !== undefined) lines.push(`Buy Slippage:    ${s.buySlippagePercent.toFixed(2)}%`);
    if (s.sellSlippagePercent !== undefined) lines.push(`Sell Slippage:   ${s.sellSlippagePercent.toFixed(2)}%`);
    if (s.buySlippageCostSol !== undefined) lines.push(`Buy Slip Cost:   ${s.buySlippageCostSol.toFixed(6)} SOL`);
    if (s.sellSlippageCostSol !== undefined) lines.push(`Sell Slip Cost:  ${s.sellSlippageCostSol.toFixed(6)} SOL`);
  }

  if (report.tradedToken && report.tradedToken.mint) {
    const t = report.tradedToken;
    lines.push('');
    lines.push('--- Traded Token ---');
    lines.push(`Token:    ${t.symbol || '?'} — ${t.name || 'Unknown'}`);
    lines.push(`Contract: ${t.mint}`);
    lines.push(`Curve:    ${t.bondingCurve || '—'}`);
    if (report.buyTimestamp)  lines.push(`Bought:   ${formatDate(report.buyTimestamp)}  sig: ${report.buySignature || '—'}`);
    if (report.sellTimestamp) lines.push(`Sold:     ${formatDate(report.sellTimestamp)}  sig: ${report.sellSignature || '—'}`);
  }

  if (report.steps && report.steps.length > 0) {
    lines.push('');
    lines.push('--- Steps ---');
    report.steps.forEach((step, i) => {
      const duration = step.durationMs ? formatDuration(step.durationMs) : '--';
      lines.push(`${i + 1}. [${step.status.toUpperCase()}] ${step.name} (${duration})`);
      if (step.details) lines.push(`   ${step.details}`);
    });
  }

  if (report.buyFailures && report.buyFailures.length > 0) {
    lines.push('');
    lines.push('--- Buy Failures ---');
    report.buyFailures.forEach(f => {
      const mint = (f.tokenSymbol || '') + ' ' + (f.tokenMint || '').substring(0, 12) + '...';
      lines.push(`- ${mint}: ${f.reason || 'Unknown'}`);
    });
  }

  return lines.join('\n');
}

// Store the latest rendered report for copy
let lastRenderedReport = null;

/**
 * Copy current report to clipboard
 */
async function copyCurrentReport() {
  const btn = document.getElementById('copy-report-btn');
  let report = lastRenderedReport;

  if (!report) {
    // Fetch fresh
    if (viewingReportId) {
      report = await fetchApi(`/api/smoke-test-reports/${viewingReportId}`);
    } else {
      report = await fetchApi('/api/smoke-test-report');
    }
  }

  const text = buildReportText(report);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy Report'; }, 2000);
}

async function updateAll() {
  await Promise.all([
    updateSmokeTestReport(),
    updateHistory(),
  ]);
}

// Initial load, then schedule next poll only after the current one finishes.
// This prevents overlapping requests when the server is slow.
async function pollLoop() {
  await updateAll();
  setTimeout(pollLoop, POLL_INTERVAL);
}
pollLoop();
