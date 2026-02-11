/**
 * A/B Test Results Dashboard
 * Fetches cross-session analysis data and renders interactive views.
 */

const API_BASE = '';

// State
let analysisData = null;
let selectedSessionId = null;

// ============================================================
// API
// ============================================================

async function fetchApi(endpoint) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`API error for ${endpoint}:`, error);
    return null;
  }
}

// ============================================================
// TAB NAVIGATION
// ============================================================

document.querySelectorAll('.ab-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;

    // Update tab buttons
    document.querySelectorAll('.ab-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // Update tab content
    document.querySelectorAll('.ab-tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
  });
});

function switchToTab(tabName) {
  document.querySelectorAll('.ab-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.ab-tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `tab-${tabName}`);
  });
}

// ============================================================
// DATA LOADING
// ============================================================

async function loadAnalysis() {
  analysisData = await fetchApi('/api/ab-results/analysis');

  if (!analysisData || analysisData.error) {
    showNoData();
    return;
  }

  if (analysisData.totalSessions === 0) {
    showNoData();
    return;
  }

  renderOverview();
  renderImpactRanking();
  renderBestConfig();
  renderTestSuggestions();
}

function showNoData() {
  const msg = `
    <div class="no-data-message">
      <h3>No A/B Test Results Yet</h3>
      <p>Run your first A/B test and results will appear here automatically. Set BOT_MODE=ab with your variant configs and start the bot.</p>
    </div>
  `;
  document.getElementById('session-list').innerHTML = msg;
  document.getElementById('impact-ranking').innerHTML = msg;
  document.getElementById('best-config').innerHTML = msg;
  document.getElementById('test-suggestions').innerHTML = msg;

  document.getElementById('total-sessions').textContent = '0';
  document.getElementById('params-tested').textContent = '0';
  document.getElementById('top-param').textContent = '--';
  document.getElementById('config-confidence').textContent = '--';
}

// ============================================================
// OVERVIEW TAB
// ============================================================

function renderOverview() {
  const data = analysisData;

  // Summary cards
  document.getElementById('total-sessions').textContent = data.totalSessions;
  document.getElementById('params-tested').textContent = data.parameterImpacts.length;

  if (data.parameterImpacts.length > 0) {
    document.getElementById('top-param').textContent = formatParamName(data.parameterImpacts[0].paramName);
  }

  const confidence = data.bestConfig.overallConfidence;
  const confEl = document.getElementById('config-confidence');
  confEl.textContent = formatConfidence(confidence);
  confEl.className = 'card-value';
  if (confidence === 'high') confEl.classList.add('positive');
  else if (confidence === 'insufficient_data') confEl.style.color = 'var(--text-muted)';

  // Session list
  if (data.sessions.length === 0) {
    document.getElementById('session-list').innerHTML = '<div class="empty-state">No completed sessions</div>';
    return;
  }

  document.getElementById('session-list').innerHTML = data.sessions.map(session => {
    const date = new Date(session.startedAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const duration = formatDuration(session.durationMs);
    const winnerClass = `winner-${session.winner.toLowerCase()}`;
    const winnerLabel = session.winner === 'tie' ? 'Tie' : `Config ${session.winner} Won`;
    const pnlDiff = Math.abs(session.pnlA - session.pnlB).toFixed(4);
    const desc = session.description ? escapeHtml(session.description) : '';

    const paramTags = (session.paramsTested || []).map(p =>
      `<span class="param-tag">${formatParamName(p)}</span>`
    ).join('');

    return `
      <div class="session-item" onclick="viewSessionDetail('${session.sessionId}')">
        <div class="session-winner-dot ${winnerClass}"></div>
        <div class="session-info">
          <div class="session-date">${date}</div>
          ${desc ? `<div class="session-description">${desc}</div>` : ''}
          <div class="session-params-tested">${paramTags || '<span class="param-tag">all defaults</span>'}</div>
        </div>
        <div class="session-result">
          <div class="session-winner-label ${winnerClass}">${winnerLabel}</div>
          <div class="session-pnl-diff">PnL diff: ${pnlDiff} SOL</div>
          <div class="session-duration">${duration} | ${session.totalTokensDetected} tokens</div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// PARAMETER ANALYSIS TAB
// ============================================================

function renderImpactRanking() {
  const impacts = analysisData.parameterImpacts;

  if (impacts.length === 0) {
    document.getElementById('impact-ranking').innerHTML = '<div class="empty-state">No parameter data yet</div>';
    return;
  }

  const maxAvgPnl = Math.max(...impacts.map(i => i.avgPnlImpact));

  document.getElementById('impact-ranking').innerHTML = impacts.map((impact, idx) => {
    const barWidth = maxAvgPnl > 0 ? (impact.avgPnlImpact / maxAvgPnl) * 100 : 0;
    const rankClass = idx < 3 ? `rank-${idx + 1}` : '';
    const direction = impact.higherWins > impact.lowerWins
      ? 'Higher wins more'
      : impact.lowerWins > impact.higherWins
        ? 'Lower wins more'
        : 'No clear direction';

    return `
      <div class="impact-item" onclick="showParamDetail('${impact.paramName}')">
        <div class="impact-rank ${rankClass}">${idx + 1}</div>
        <div class="impact-info">
          <div class="impact-name">${formatParamName(impact.paramName)}</div>
          <div class="impact-meta">
            <span>${impact.sessionsTested} session(s)</span>
            <span>${direction}</span>
          </div>
        </div>
        <div class="impact-bar-container">
          <div class="impact-bar">
            <div class="impact-bar-fill" style="width: ${barWidth}%"></div>
          </div>
        </div>
        <div class="impact-values">
          <div class="impact-avg-pnl">${impact.avgPnlImpact.toFixed(4)} SOL</div>
          <div class="impact-best-value">Best: ${impact.bestValue !== null ? impact.bestValue : '--'}</div>
        </div>
      </div>
    `;
  }).join('');
}

function showParamDetail(paramName) {
  const impact = analysisData.parameterImpacts.find(i => i.paramName === paramName);
  if (!impact) return;

  const panel = document.getElementById('param-detail-panel');
  const title = document.getElementById('param-detail-title');
  const body = document.getElementById('param-detail-body');

  title.textContent = formatParamName(paramName);

  let html = `
    <div style="padding: 1rem 1.25rem;">
      <div style="display: flex; gap: 1.5rem; margin-bottom: 1rem; flex-wrap: wrap;">
        <div><strong>Sessions Tested:</strong> ${impact.sessionsTested}</div>
        <div><strong>Higher Wins:</strong> ${impact.higherWins}</div>
        <div><strong>Lower Wins:</strong> ${impact.lowerWins}</div>
        <div><strong>Avg PnL Impact:</strong> ${impact.avgPnlImpact.toFixed(4)} SOL</div>
        <div><strong>Max PnL Impact:</strong> ${impact.maxPnlImpact.toFixed(4)} SOL</div>
        <div><strong>Best Value:</strong> ${impact.bestValue !== null ? impact.bestValue : '--'} (${impact.bestValueWinRate.toFixed(0)}% win rate)</div>
      </div>
    </div>
    <table class="param-history-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Value A</th>
          <th>Value B</th>
          <th>Winner</th>
          <th>Winning Value</th>
          <th>PnL Diff</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const h of impact.history) {
    const date = new Date(h.startedAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const winnerClass = `winner-${h.winner.toLowerCase()}`;

    html += `
      <tr>
        <td>${date}</td>
        <td>${h.valueA}</td>
        <td>${h.valueB}</td>
        <td class="winner-cell ${winnerClass}">${h.winner === 'tie' ? 'Tie' : `Config ${h.winner}`}</td>
        <td>${h.winner === 'tie' ? '--' : h.winnerValue}</td>
        <td>${h.pnlDifference.toFixed(4)} SOL</td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  body.innerHTML = html;
  panel.style.display = 'block';
}

function closeParamDetail() {
  document.getElementById('param-detail-panel').style.display = 'none';
}

// ============================================================
// RECOMMENDATIONS TAB
// ============================================================

function renderBestConfig() {
  const config = analysisData.bestConfig;

  const confLabel = document.getElementById('config-confidence-label');
  confLabel.textContent = `Overall confidence: ${formatConfidence(config.overallConfidence)} (${config.totalSessions} sessions)`;

  const params = Object.entries(config.params);

  if (params.length === 0) {
    document.getElementById('best-config').innerHTML = '<div class="empty-state">Not enough data to recommend settings yet</div>';
    return;
  }

  document.getElementById('best-config').innerHTML = params.map(([name, info]) => `
    <div class="config-param-row">
      <div class="config-param-name">${formatParamName(name)}</div>
      <div class="config-param-value">${info.value}</div>
      <span class="config-confidence-badge ${info.confidence}">${info.confidence}</span>
      <div class="config-sessions-count">${info.sessionsTested} tests</div>
    </div>
  `).join('');
}

function renderTestSuggestions() {
  const suggestions = analysisData.testSuggestions;

  if (suggestions.length === 0) {
    document.getElementById('test-suggestions').innerHTML =
      '<div class="empty-state">All parameters have sufficient test coverage</div>';
    return;
  }

  document.getElementById('test-suggestions').innerHTML = `
    <div class="suggestion-list">
      ${suggestions.map(s => `
        <div class="suggestion-item">
          <div class="suggestion-header">
            <span class="suggestion-priority ${s.priority}">${s.priority}</span>
            <span class="suggestion-param">${formatParamName(s.paramName)}</span>
          </div>
          <div class="suggestion-reason">${escapeHtml(s.reason)}</div>
          <div class="suggestion-values">
            <div class="suggestion-value">
              <span class="label">A:</span>${s.suggestedValueA}
            </div>
            <div class="suggestion-value">
              <span class="label">B:</span>${s.suggestedValueB}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ============================================================
// SESSION DETAIL TAB
// ============================================================

async function viewSessionDetail(sessionId) {
  selectedSessionId = sessionId;
  switchToTab('session-detail');

  const container = document.getElementById('session-detail-content');
  container.innerHTML = '<div class="loading">Loading session report...</div>';

  const report = await fetchApi(`/api/ab-results/session/${sessionId}`);

  if (!report || report.error) {
    container.innerHTML = `<div class="error-state">Failed to load session: ${report?.error || 'unknown'}</div>`;
    return;
  }

  renderSessionDetail(report);
}

function renderSessionDetail(report) {
  const container = document.getElementById('session-detail-content');
  const cA = report.variantA.config;
  const cB = report.variantB.config;
  const sA = report.variantA;
  const sB = report.variantB;

  const date = new Date(report.startedAt).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const duration = formatDuration(report.durationMs);

  // Find which params differ
  const configKeys = [
    'takeProfit', 'stopLoss', 'maxHoldDurationMs', 'priceCheckIntervalMs',
    'momentumMinTotalBuys', 'pumpfunMinSolInCurve', 'pumpfunMaxSolInCurve',
    'maxTokenAgeSeconds', 'momentumInitialDelayMs', 'momentumRecheckIntervalMs',
    'momentumMaxChecks', 'buySlippage', 'sellSlippage', 'maxTradesPerHour', 'quoteAmount'
  ];

  function configRow(label, valA, valB) {
    const isDiff = valA !== valB;
    const cls = isDiff ? ' class="diff-highlight"' : '';
    return `<tr${cls}><td>${label}</td><td>${valA}</td><td>${valB}</td></tr>`;
  }

  function pnlClass(val) {
    return val >= 0 ? 'pnl-positive' : 'pnl-negative';
  }

  function pnlStr(val) {
    return (val >= 0 ? '+' : '') + val.toFixed(4);
  }

  function pnlPctStr(val) {
    return (val >= 0 ? '+' : '') + val.toFixed(1) + '%';
  }

  // Build rejection breakdown rows
  const allStages = new Set([
    ...Object.keys(sA.rejectionBreakdown || {}),
    ...Object.keys(sB.rejectionBreakdown || {})
  ]);
  let rejectionRows = '';
  for (const stage of allStages) {
    const countA = (sA.rejectionBreakdown || {})[stage] || 0;
    const countB = (sB.rejectionBreakdown || {})[stage] || 0;
    rejectionRows += `<tr><td style="padding-left:2rem">Rej: ${stage}</td><td>${countA}</td><td>${countB}</td></tr>`;
  }

  const winnerClass = `winner-${report.winner}`;
  const winnerText = report.winner === 'tie'
    ? 'Result: TIE'
    : `Winner: Config ${report.winner} (PnL: ${pnlStr(report.winner === 'A' ? sA.realizedPnlSol : sB.realizedPnlSol)} SOL) | Difference: ${report.pnlDifferenceSol.toFixed(4)} SOL`;

  container.innerHTML = `
    <div class="panel">
      <div class="session-detail-header">
        <div class="session-detail-title">Session: ${report.sessionId}</div>
        <div class="session-detail-meta">
          <span>${date}</span>
          <span>Duration: ${duration}</span>
          <span>Tokens: ${report.totalTokensDetected}</span>
        </div>
      </div>

      <table class="comparison-table">
        <thead>
          <tr><th>Metric</th><th>Config A</th><th>Config B</th></tr>
        </thead>
        <tbody>
          <tr class="section-row"><td colspan="3">Configuration</td></tr>
          ${configRow('Take Profit', cA.takeProfit + '%', cB.takeProfit + '%')}
          ${configRow('Stop Loss', cA.stopLoss + '%', cB.stopLoss + '%')}
          ${configRow('Max Hold Duration', cA.maxHoldDurationMs + 'ms', cB.maxHoldDurationMs + 'ms')}
          ${configRow('Price Check Interval', cA.priceCheckIntervalMs + 'ms', cB.priceCheckIntervalMs + 'ms')}
          ${configRow('Min Buys (Momentum)', cA.momentumMinTotalBuys, cB.momentumMinTotalBuys)}
          ${configRow('Min SOL in Curve', cA.pumpfunMinSolInCurve, cB.pumpfunMinSolInCurve)}
          ${configRow('Max SOL in Curve', cA.pumpfunMaxSolInCurve, cB.pumpfunMaxSolInCurve)}
          ${configRow('Max Token Age', cA.maxTokenAgeSeconds + 's', cB.maxTokenAgeSeconds + 's')}
          ${configRow('Mom. Initial Delay', cA.momentumInitialDelayMs + 'ms', cB.momentumInitialDelayMs + 'ms')}
          ${configRow('Mom. Recheck Interval', cA.momentumRecheckIntervalMs + 'ms', cB.momentumRecheckIntervalMs + 'ms')}
          ${configRow('Mom. Max Checks', cA.momentumMaxChecks, cB.momentumMaxChecks)}
          ${configRow('Buy Slippage', cA.buySlippage + '%', cB.buySlippage + '%')}
          ${configRow('Sell Slippage', cA.sellSlippage + '%', cB.sellSlippage + '%')}
          ${configRow('Quote Amount', cA.quoteAmount + ' SOL', cB.quoteAmount + ' SOL')}
          ${configRow('Max Trades/Hour', cA.maxTradesPerHour, cB.maxTradesPerHour)}

          <tr class="section-row"><td colspan="3">Pipeline Results</td></tr>
          <tr><td>Pipeline Passed</td><td>${sA.totalPipelinePassed}</td><td>${sB.totalPipelinePassed}</td></tr>
          <tr><td>Pipeline Rejected</td><td>${sA.totalPipelineRejected}</td><td>${sB.totalPipelineRejected}</td></tr>
          ${rejectionRows}

          <tr class="section-row"><td colspan="3">Trades</td></tr>
          <tr><td>Trades Entered</td><td>${sA.totalTradesEntered}</td><td>${sB.totalTradesEntered}</td></tr>
          <tr><td>Trades Closed</td><td>${sA.totalTradesClosed}</td><td>${sB.totalTradesClosed}</td></tr>
          <tr><td>Trades Active</td><td>${sA.totalTradesActive}</td><td>${sB.totalTradesActive}</td></tr>
          <tr><td>Win Rate</td><td>${sA.winRate.toFixed(1)}%</td><td>${sB.winRate.toFixed(1)}%</td></tr>
          <tr><td>Avg Hold Time</td><td>${(sA.avgHoldDurationMs / 1000).toFixed(1)}s</td><td>${(sB.avgHoldDurationMs / 1000).toFixed(1)}s</td></tr>

          <tr class="section-row"><td colspan="3">P&L</td></tr>
          <tr><td>Total SOL Deployed</td><td>${sA.totalSolDeployed.toFixed(4)}</td><td>${sB.totalSolDeployed.toFixed(4)}</td></tr>
          <tr><td>Total SOL Returned</td><td>${sA.totalSolReturned.toFixed(4)}</td><td>${sB.totalSolReturned.toFixed(4)}</td></tr>
          <tr><td>Realized PnL (SOL)</td><td class="${pnlClass(sA.realizedPnlSol)}">${pnlStr(sA.realizedPnlSol)}</td><td class="${pnlClass(sB.realizedPnlSol)}">${pnlStr(sB.realizedPnlSol)}</td></tr>
          <tr><td>Realized PnL (%)</td><td class="${pnlClass(sA.realizedPnlPercent)}">${pnlPctStr(sA.realizedPnlPercent)}</td><td class="${pnlClass(sB.realizedPnlPercent)}">${pnlPctStr(sB.realizedPnlPercent)}</td></tr>

          <tr class="section-row"><td colspan="3">Win/Loss Detail</td></tr>
          <tr><td>Wins</td><td>${sA.winCount}</td><td>${sB.winCount}</td></tr>
          <tr><td>Losses</td><td>${sA.lossCount}</td><td>${sB.lossCount}</td></tr>
          <tr><td>Avg Win PnL</td><td>${sA.avgWinPnlPercent.toFixed(1)}%</td><td>${sB.avgWinPnlPercent.toFixed(1)}%</td></tr>
          <tr><td>Avg Loss PnL</td><td>${sA.avgLossPnlPercent.toFixed(1)}%</td><td>${sB.avgLossPnlPercent.toFixed(1)}%</td></tr>
          <tr><td>Best Trade</td><td>${sA.bestTradePnlPercent.toFixed(1)}%</td><td>${sB.bestTradePnlPercent.toFixed(1)}%</td></tr>
          <tr><td>Worst Trade</td><td>${sA.worstTradePnlPercent.toFixed(1)}%</td><td>${sB.worstTradePnlPercent.toFixed(1)}%</td></tr>

          <tr class="section-row"><td colspan="3">Exit Breakdown</td></tr>
          <tr><td>Take Profit</td><td>${sA.takeProfitCount}</td><td>${sB.takeProfitCount}</td></tr>
          <tr><td>Stop Loss</td><td>${sA.stopLossCount}</td><td>${sB.stopLossCount}</td></tr>
          <tr><td>Time Exit</td><td>${sA.timeExitCount}</td><td>${sB.timeExitCount}</td></tr>
          <tr><td>Graduated</td><td>${sA.graduatedCount}</td><td>${sB.graduatedCount}</td></tr>
        </tbody>
      </table>

      <div class="winner-banner ${winnerClass}">
        ${winnerText}
      </div>
    </div>
  `;
}

// ============================================================
// UTILITIES
// ============================================================

function formatParamName(name) {
  // camelCase to Title Case
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .replace(/Ms$/, ' (ms)')
    .replace(/Sol /, 'SOL ')
    .trim();
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatConfidence(conf) {
  const map = {
    'high': 'High',
    'medium': 'Medium',
    'low': 'Low',
    'insufficient_data': 'Need More Data'
  };
  return map[conf] || conf;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Make functions available globally for onclick handlers
window.viewSessionDetail = viewSessionDetail;
window.showParamDetail = showParamDetail;
window.closeParamDetail = closeParamDetail;

// ============================================================
// INIT
// ============================================================

loadAnalysis();
