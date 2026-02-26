/**
 * Smoke Test Analytics Dashboard
 * Provides aggregated analytics, charts, and env variable impact analysis
 * across multiple smoke test runs.
 */

// ============================================================
// STATE
// ============================================================

let allReports = [];
let selectedIds = new Set();
let analyticsData = null;
let currentSort = { field: 'date', dir: 'desc' };

// ============================================================
// HELPERS
// ============================================================

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

function formatDate(timestamp) {
  if (!timestamp) return '--';
  return new Date(timestamp).toLocaleString();
}

function formatDateShort(timestamp) {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatPnl(value) {
  if (value === null || value === undefined) return '--';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(6)} SOL`;
}

function formatPnlShort(value) {
  if (value === null || value === undefined) return '--';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(4)}`;
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

// ============================================================
// RUN SELECTOR
// ============================================================

async function loadReports() {
  const data = await fetchApi('/api/smoke-test-reports');
  if (!data || !data.reports) {
    document.getElementById('run-selector-list').innerHTML =
      '<div class="empty-state">No smoke test reports found. Run smoke tests first.</div>';
    return;
  }

  allReports = data.reports.sort((a, b) => b.startedAt - a.startedAt);

  // Initialize date inputs from report range
  if (allReports.length > 0) {
    const oldest = allReports[allReports.length - 1].startedAt;
    const newest = allReports[0].startedAt;
    document.getElementById('date-from').value = toLocalDatetimeStr(oldest);
    document.getElementById('date-to').value = toLocalDatetimeStr(newest + 60000); // +1 min buffer
  }

  // Select all by default
  selectedIds = new Set(allReports.map(r => String(r.startedAt)));

  renderRunSelector();
  updateDateFilterCount();

  // Auto-analyze on load
  await applySelection();
}

// ============================================================
// DATE FILTERING
// ============================================================

/** Convert a timestamp to a local datetime-local input value */
function toLocalDatetimeStr(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Get the current date range from the inputs (as timestamps, or null) */
function getDateRange() {
  const fromEl = document.getElementById('date-from');
  const toEl = document.getElementById('date-to');
  const from = fromEl.value ? new Date(fromEl.value).getTime() : null;
  const to = toEl.value ? new Date(toEl.value).getTime() : null;
  return { from, to };
}

/** Get reports filtered by the current date range */
function getDateFilteredReports() {
  const { from, to } = getDateRange();
  return allReports.filter(r => {
    if (from && r.startedAt < from) return false;
    if (to && r.startedAt > to) return false;
    return true;
  });
}

/** Apply the date filter: select only runs within the range, re-render, and auto-analyze */
function applyDateFilter() {
  const filtered = getDateFilteredReports();
  selectedIds = new Set(filtered.map(r => String(r.startedAt)));
  renderRunSelector();
  updateDateFilterCount();
  applySelection();
}

/** Quick preset buttons for common date ranges */
function datePreset(preset) {
  const now = Date.now();
  const fromEl = document.getElementById('date-from');
  const toEl = document.getElementById('date-to');

  toEl.value = toLocalDatetimeStr(now);

  if (preset === 'all') {
    if (allReports.length > 0) {
      fromEl.value = toLocalDatetimeStr(allReports[allReports.length - 1].startedAt);
    } else {
      fromEl.value = '';
    }
  } else {
    const durations = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    const ms = durations[preset] || 86400000;
    fromEl.value = toLocalDatetimeStr(now - ms);
  }

  applyDateFilter();
}

function updateDateFilterCount() {
  const filtered = getDateFilteredReports();
  const countEl = document.getElementById('date-filter-count');
  if (countEl) {
    countEl.textContent = `${filtered.length} of ${allReports.length} runs in range`;
  }
}

function renderRunSelector() {
  const list = document.getElementById('run-selector-list');
  const filtered = getDateFilteredReports();
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No smoke test runs in this date range</div>';
    return;
  }

  list.innerHTML = filtered.map(r => {
    const id = String(r.startedAt);
    const checked = selectedIds.has(id) ? 'checked' : '';
    const pnl = -r.netCostSol;
    const statusClass = r.overallResult === 'PASS' ? 'positive' : 'negative';

    // Show key env vars if available
    let envTags = '';
    if (r.envSnapshot) {
      const tp = r.envSnapshot.TAKE_PROFIT;
      const sl = r.envSnapshot.STOP_LOSS;
      const qa = r.envSnapshot.QUOTE_AMOUNT;
      if (tp !== undefined || sl !== undefined) {
        envTags = `<span class="env-tag">TP:${tp || '?'}% SL:${sl || '?'}%</span>`;
      }
      if (qa !== undefined) {
        envTags += `<span class="env-tag">${qa} SOL</span>`;
      }
    }

    return `
      <label class="run-selector-item" data-id="${escapeHtml(id)}">
        <input type="checkbox" class="run-checkbox" value="${escapeHtml(id)}" ${checked}
               onchange="toggleRun('${escapeHtml(id)}', this.checked)">
        <span class="run-result ${statusClass}">${r.overallResult}</span>
        <span class="run-date">${formatDate(r.startedAt)}</span>
        <span class="run-pnl ${pnlClass(pnl)}">${formatPnlShort(pnl)} SOL</span>
        <span class="run-duration">${formatDuration(r.totalDurationMs)}</span>
        ${envTags}
        <span class="run-exit">${escapeHtml(r.exitTrigger || '--')}</span>
      </label>
    `;
  }).join('');
}

function toggleRun(id, checked) {
  if (checked) {
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }
}

function selectAll() {
  const filtered = getDateFilteredReports();
  selectedIds = new Set(filtered.map(r => String(r.startedAt)));
  document.querySelectorAll('.run-checkbox').forEach(cb => cb.checked = true);
}

function selectNone() {
  selectedIds.clear();
  document.querySelectorAll('.run-checkbox').forEach(cb => cb.checked = false);
}

function selectPassing() {
  const filtered = getDateFilteredReports();
  selectedIds = new Set(
    filtered.filter(r => r.overallResult === 'PASS').map(r => String(r.startedAt))
  );
  document.querySelectorAll('.run-checkbox').forEach(cb => {
    cb.checked = selectedIds.has(cb.value);
  });
}

// ============================================================
// ANALYTICS FETCH & RENDER
// ============================================================

async function applySelection() {
  if (selectedIds.size === 0) {
    hideAnalytics();
    return;
  }

  const idsParam = Array.from(selectedIds).join(',');
  const data = await fetchApi(`/api/smoke-test-analytics?ids=${idsParam}`);

  if (!data || !data.analytics) {
    hideAnalytics();
    return;
  }

  analyticsData = data;
  renderAnalytics(data);
}

function hideAnalytics() {
  document.getElementById('agg-stats').style.display = 'none';
  document.getElementById('agg-stats-2').style.display = 'none';
  document.getElementById('charts-panel').style.display = 'none';
  document.getElementById('env-impact-panel').style.display = 'none';
  document.getElementById('detail-table-panel').style.display = 'none';
}

function renderAnalytics(data) {
  const a = data.analytics;

  // Update badge
  const badge = document.getElementById('analytics-badge');
  badge.textContent = `${data.selectedCount} runs`;
  badge.style.background = 'linear-gradient(135deg, #2196f3, #00c853)';

  // Show all sections
  document.getElementById('agg-stats').style.display = '';
  document.getElementById('agg-stats-2').style.display = '';
  document.getElementById('charts-panel').style.display = '';
  document.getElementById('env-impact-panel').style.display = '';
  document.getElementById('detail-table-panel').style.display = '';

  // Aggregate stats
  const avgPnlEl = document.getElementById('stat-avg-pnl');
  avgPnlEl.textContent = formatPnl(a.pnl.avg);
  avgPnlEl.className = `card-value big ${pnlClass(a.pnl.avg)}`;

  const totalPnlEl = document.getElementById('stat-total-pnl');
  totalPnlEl.textContent = formatPnl(a.pnl.total);
  totalPnlEl.className = `card-value ${pnlClass(a.pnl.total)}`;

  document.getElementById('stat-pass-rate').textContent = `${(a.passRate * 100).toFixed(1)}%`;
  document.getElementById('stat-run-count').textContent = `${a.totalRuns}`;

  const medPnlEl = document.getElementById('stat-median-pnl');
  medPnlEl.textContent = formatPnl(a.pnl.median);
  medPnlEl.className = `card-value ${pnlClass(a.pnl.median)}`;

  document.getElementById('stat-pnl-stddev').textContent = `${a.pnl.stdDev.toFixed(6)} SOL`;
  document.getElementById('stat-avg-duration').textContent = formatDuration(a.duration.avg);
  document.getElementById('stat-avg-tokens').textContent = a.tokensEvaluated.avg.toFixed(1);

  document.getElementById('stat-avg-pipeline').textContent = a.tokensPipelinePassed.avg.toFixed(1);
  document.getElementById('stat-avg-buyfails').textContent = a.buyFailures.avg.toFixed(1);

  const bestEl = document.getElementById('stat-best-pnl');
  bestEl.textContent = formatPnl(a.pnl.max);
  bestEl.className = `card-value ${pnlClass(a.pnl.max)}`;

  const worstEl = document.getElementById('stat-worst-pnl');
  worstEl.textContent = formatPnl(a.pnl.min);
  worstEl.className = `card-value ${pnlClass(a.pnl.min)}`;

  // Draw charts
  drawPnlChart(data.timeSeries);
  drawCumulativePnlChart(data.cumulativePnl);
  drawDurationChart(data.timeSeries);
  drawTokensChart(data.timeSeries);
  drawExitTriggerChart(a.exitTriggers);
  drawPassFailChart(a.passCount, a.failCount);

  // Render env impact
  renderEnvImpact(data.envImpact);

  // Render detail table
  renderDetailTable(data.timeSeries);
}

// ============================================================
// CHART DRAWING (Canvas API)
// ============================================================

const COLORS = {
  green: '#00c853',
  red: '#ff5252',
  blue: '#2196f3',
  yellow: '#ffc107',
  purple: '#9c27b0',
  cyan: '#00bcd4',
  orange: '#ff9800',
  teal: '#009688',
  gridLine: '#2f3336',
  text: '#8b98a5',
  bgBar: 'rgba(33, 150, 243, 0.3)',
};

function getCanvas(id) {
  const canvas = document.getElementById(id);
  const ctx = canvas.getContext('2d');
  // Handle high DPI displays
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  return { canvas, ctx, width: rect.width, height: rect.height };
}

function drawGrid(ctx, width, height, padding, yMin, yMax, ySteps) {
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 0.5;
  ctx.fillStyle = COLORS.text;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';

  const chartH = height - padding.top - padding.bottom;
  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + (chartH / ySteps) * i;
    const val = yMax - ((yMax - yMin) / ySteps) * i;

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillText(formatYLabel(val), padding.left - 6, y + 4);
  }
}

function formatYLabel(val) {
  if (Math.abs(val) >= 1000) return (val / 1000).toFixed(1) + 'k';
  if (Math.abs(val) >= 1) return val.toFixed(2);
  return val.toFixed(4);
}

function drawXLabels(ctx, width, height, padding, labels, maxLabels) {
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';

  const chartW = width - padding.left - padding.right;
  const step = Math.max(1, Math.ceil(labels.length / maxLabels));

  for (let i = 0; i < labels.length; i += step) {
    const x = padding.left + (chartW / (labels.length - 1 || 1)) * i;
    ctx.fillText(labels[i], x, height - padding.bottom + 16);
  }
}

function drawBarChart(canvasId, data, getColor) {
  const { ctx, width, height } = getCanvas(canvasId);
  const padding = { top: 20, right: 20, bottom: 35, left: 70 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  if (data.length === 0) return;

  const values = data.map(d => d.value);
  const rawMin = Math.min(...values, 0);
  const rawMax = Math.max(...values, 0);
  const range = rawMax - rawMin || 1;
  const yMin = rawMin - range * 0.1;
  const yMax = rawMax + range * 0.1;

  // Clear
  ctx.clearRect(0, 0, width, height);

  // Grid
  drawGrid(ctx, width, height, padding, yMin, yMax, 5);

  // Zero line
  if (yMin < 0 && yMax > 0) {
    const zeroY = padding.top + chartH * (1 - (0 - yMin) / (yMax - yMin));
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, zeroY);
    ctx.lineTo(width - padding.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Bars
  const barWidth = Math.max(2, (chartW / data.length) * 0.7);
  const gap = (chartW / data.length) * 0.3;

  data.forEach((d, i) => {
    const x = padding.left + (chartW / data.length) * i + gap / 2;
    const valH = ((d.value - yMin) / (yMax - yMin)) * chartH;
    const zeroH = ((0 - yMin) / (yMax - yMin)) * chartH;
    const barY = padding.top + chartH - Math.max(valH, zeroH);
    const barH = Math.abs(valH - zeroH);

    ctx.fillStyle = getColor ? getColor(d) : COLORS.blue;
    ctx.fillRect(x, barY, barWidth, Math.max(barH, 1));
  });

  // X labels
  const labels = data.map(d => d.label);
  drawXLabels(ctx, width, height, padding, labels, 10);
}

function drawLineChart(canvasId, datasets, labels) {
  const { ctx, width, height } = getCanvas(canvasId);
  const padding = { top: 20, right: 20, bottom: 35, left: 70 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  if (labels.length === 0) return;

  // Find global min/max across all datasets
  let allValues = [];
  datasets.forEach(ds => allValues.push(...ds.data));
  const rawMin = Math.min(...allValues, 0);
  const rawMax = Math.max(...allValues);
  const range = rawMax - rawMin || 1;
  const yMin = rawMin - range * 0.1;
  const yMax = rawMax + range * 0.1;

  // Clear
  ctx.clearRect(0, 0, width, height);

  // Grid
  drawGrid(ctx, width, height, padding, yMin, yMax, 5);

  // Zero line if applicable
  if (yMin < 0 && yMax > 0) {
    const zeroY = padding.top + chartH * (1 - (0 - yMin) / (yMax - yMin));
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, zeroY);
    ctx.lineTo(width - padding.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw each dataset
  datasets.forEach(ds => {
    ctx.strokeStyle = ds.color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    ds.data.forEach((val, i) => {
      const x = padding.left + (chartW / (labels.length - 1 || 1)) * i;
      const y = padding.top + chartH * (1 - (val - yMin) / (yMax - yMin));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();

    // Dots
    ctx.fillStyle = ds.color;
    ds.data.forEach((val, i) => {
      const x = padding.left + (chartW / (labels.length - 1 || 1)) * i;
      const y = padding.top + chartH * (1 - (val - yMin) / (yMax - yMin));
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // X labels
  drawXLabels(ctx, width, height, padding, labels, 10);

  // Legend
  if (datasets.length > 1) {
    ctx.font = '11px -apple-system, sans-serif';
    let legendX = padding.left + 10;
    datasets.forEach(ds => {
      ctx.fillStyle = ds.color;
      ctx.fillRect(legendX, 6, 12, 12);
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText(ds.label, legendX + 16, 16);
      legendX += ctx.measureText(ds.label).width + 36;
    });
  }
}

function drawPieChart(canvasId, segments) {
  const { ctx, width, height } = getCanvas(canvasId);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 40;

  ctx.clearRect(0, 0, width, height);

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return;

  let startAngle = -Math.PI / 2;
  segments.forEach(seg => {
    const sliceAngle = (seg.value / total) * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;

    // Slice
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    ctx.strokeStyle = '#0f1419';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    if (seg.value > 0) {
      const midAngle = startAngle + sliceAngle / 2;
      const labelR = radius * 0.65;
      const lx = cx + Math.cos(midAngle) * labelR;
      const ly = cy + Math.sin(midAngle) * labelR;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const pct = ((seg.value / total) * 100).toFixed(0);
      ctx.fillText(`${pct}%`, lx, ly);
    }

    startAngle = endAngle;
  });

  // Legend below
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const legendY = height - 25;
  let legendX = 10;
  segments.forEach(seg => {
    ctx.fillStyle = seg.color;
    ctx.fillRect(legendX, legendY, 10, 10);
    ctx.fillStyle = COLORS.text;
    const label = `${seg.label} (${seg.value})`;
    ctx.fillText(label, legendX + 14, legendY);
    legendX += ctx.measureText(label).width + 28;
  });
}

// ============================================================
// CHART RENDERERS
// ============================================================

function drawPnlChart(timeSeries) {
  const data = timeSeries.map(t => ({
    value: t.pnl,
    label: formatDateShort(t.startedAt),
  }));

  drawBarChart('chart-pnl', data, d => d.value >= 0 ? COLORS.green : COLORS.red);
}

function drawCumulativePnlChart(cumulativePnl) {
  const labels = cumulativePnl.map(c => formatDateShort(c.startedAt));
  const values = cumulativePnl.map(c => c.cumulativePnl);

  drawLineChart('chart-cumulative-pnl', [
    { data: values, color: COLORS.cyan, label: 'Cumulative P&L' },
  ], labels);
}

function drawDurationChart(timeSeries) {
  const data = timeSeries.map(t => ({
    value: t.duration / 1000,
    label: formatDateShort(t.startedAt),
  }));

  drawBarChart('chart-duration', data, () => COLORS.blue);
}

function drawTokensChart(timeSeries) {
  const labels = timeSeries.map(t => formatDateShort(t.startedAt));

  drawLineChart('chart-tokens', [
    { data: timeSeries.map(t => t.tokensEvaluated), color: COLORS.yellow, label: 'Evaluated' },
    { data: timeSeries.map(t => t.tokensPipelinePassed), color: COLORS.green, label: 'Pipeline Passed' },
  ], labels);
}

function drawExitTriggerChart(exitTriggers) {
  const triggerColors = {
    take_profit: COLORS.green,
    stop_loss: COLORS.red,
    time_exit: COLORS.yellow,
    max_hold: COLORS.orange,
    unknown: COLORS.text,
  };

  const segments = Object.entries(exitTriggers).map(([trigger, count]) => ({
    label: trigger.replace(/_/g, ' '),
    value: count,
    color: triggerColors[trigger] || COLORS.purple,
  }));

  drawPieChart('chart-exit-triggers', segments);
}

function drawPassFailChart(passCount, failCount) {
  drawPieChart('chart-pass-fail', [
    { label: 'PASS', value: passCount, color: COLORS.green },
    { label: 'FAIL', value: failCount, color: COLORS.red },
  ]);
}

// ============================================================
// ENV VARIABLE IMPACT (Dropdown-based)
// ============================================================

/** Cached env impact data for dropdown re-renders */
let cachedEnvImpact = null;

/**
 * Categorize env variables for the dropdown groupings.
 */
const ENV_VAR_CATEGORIES = {
  'Trading Parameters': [
    'QUOTE_AMOUNT', 'TAKE_PROFIT', 'STOP_LOSS', 'BUY_SLIPPAGE', 'SELL_SLIPPAGE',
    'AUTO_BUY_DELAY', 'AUTO_SELL', 'AUTO_SELL_DELAY', 'PRICE_CHECK_INTERVAL',
    'PRICE_CHECK_DURATION', 'ONE_TOKEN_AT_A_TIME',
  ],
  'Position Management': [
    'MAX_HOLD_DURATION_MS', 'MAX_BUY_RETRIES', 'MAX_SELL_RETRIES',
  ],
  'Risk Controls': [
    'MAX_TOTAL_EXPOSURE_SOL', 'MAX_TRADES_PER_HOUR', 'MIN_WALLET_BUFFER_SOL',
  ],
  'Transaction Execution': [
    'COMPUTE_UNIT_LIMIT', 'COMPUTE_UNIT_PRICE', 'TRANSACTION_EXECUTOR',
    'SIMULATE_TRANSACTION', 'USE_DYNAMIC_FEE', 'PRIORITY_FEE_PERCENTILE',
    'MIN_PRIORITY_FEE', 'MAX_PRIORITY_FEE', 'USE_FALLBACK_EXECUTOR',
  ],
  'Pump.fun Filters': [
    'PUMPFUN_MIN_SOL_IN_CURVE', 'PUMPFUN_MAX_SOL_IN_CURVE',
    'PUMPFUN_ENABLE_MIN_SOL_FILTER', 'PUMPFUN_ENABLE_MAX_SOL_FILTER',
    'PUMPFUN_MIN_SCORE_REQUIRED', 'PUMPFUN_DETECTION_COOLDOWN_MS',
    'MAX_TOKEN_AGE_SECONDS',
  ],
  'Momentum Gate': [
    'MOMENTUM_GATE_ENABLED', 'MOMENTUM_INITIAL_DELAY_MS',
    'MOMENTUM_MIN_TOTAL_BUYS', 'MOMENTUM_RECHECK_INTERVAL_MS',
    'MOMENTUM_MAX_CHECKS',
  ],
  'Sniper Gate': [
    'SNIPER_GATE_ENABLED', 'SNIPER_GATE_INITIAL_DELAY_MS',
    'SNIPER_GATE_RECHECK_INTERVAL_MS', 'SNIPER_GATE_MAX_CHECKS',
    'SNIPER_GATE_SNIPER_SLOT_THRESHOLD', 'SNIPER_GATE_MIN_BOT_EXIT_PERCENT',
    'SNIPER_GATE_MIN_ORGANIC_BUYERS', 'SNIPER_GATE_LOG_ONLY',
  ],
  'Trailing Stop': [
    'TRAILING_STOP_ENABLED', 'TRAILING_STOP_ACTIVATION_PERCENT',
    'TRAILING_STOP_DISTANCE_PERCENT', 'HARD_TAKE_PROFIT_PERCENT',
  ],
  'Test Config': [
    'SMOKE_TEST_TIMEOUT_MS',
  ],
};

/** Find category for a variable name */
function getVarCategory(varName) {
  for (const [cat, vars] of Object.entries(ENV_VAR_CATEGORIES)) {
    if (vars.includes(varName)) return cat;
  }
  return 'Other';
}

/**
 * Compute a confidence-weighted impact score for a variable.
 * Takes into account:
 *   - P&L spread between best and worst values
 *   - Sample sizes (more runs = higher confidence)
 *   - Pass rate differences
 *   - Whether there are actually multiple values to compare
 */
function computeImpactScore(impact) {
  const entries = Object.entries(impact.values);
  if (entries.length < 2) return { score: 0, level: 'single', label: 'Single Value' };

  const sorted = entries.sort((a, b) => b[1].avgPnl - a[1].avgPnl);
  const best = sorted[0][1];
  const worst = sorted[sorted.length - 1][1];

  const pnlSpread = best.avgPnl - worst.avgPnl;
  const passRateSpread = best.passRate - worst.passRate;

  // Minimum sample size across values — low counts reduce confidence
  const minSamples = Math.min(...entries.map(e => e[1].count));
  const totalSamples = entries.reduce((sum, e) => sum + e[1].count, 0);

  // Confidence factor: scales from 0 to 1 based on sample size
  // At least 3 runs per value for reasonable confidence
  const confidenceFactor = Math.min(1, minSamples / 5);

  // Weighted score: P&L spread (primary) + pass rate spread (secondary), scaled by confidence
  const rawScore = (pnlSpread * 10000) + (passRateSpread * 50);
  const score = rawScore * confidenceFactor;

  let level, label;
  if (confidenceFactor < 0.4) {
    level = 'low-confidence';
    label = 'Low Confidence';
  } else if (score > 1.0) {
    level = 'high';
    label = 'High Impact';
  } else if (score > 0.1) {
    level = 'medium';
    label = 'Medium Impact';
  } else {
    level = 'low';
    label = 'Low Impact';
  }

  return { score, level, label, pnlSpread, passRateSpread, confidenceFactor, minSamples, totalSamples };
}

function renderEnvImpact(envImpact) {
  cachedEnvImpact = envImpact;
  const container = document.getElementById('env-impact-content');
  const select = document.getElementById('env-var-select');
  const summary = document.getElementById('env-impact-summary');

  if (!envImpact || Object.keys(envImpact).length === 0) {
    container.innerHTML = '<div class="empty-state">No environment variable data available. Run smoke tests with envSnapshot enabled.</div>';
    select.innerHTML = '<option value="">-- No data --</option>';
    summary.innerHTML = '';
    return;
  }

  // Build dropdown with optgroups by category, sorted by impact score within each
  const varsByCategory = {};
  const impactScores = {};
  for (const [varName, impact] of Object.entries(envImpact)) {
    const cat = getVarCategory(varName);
    if (!varsByCategory[cat]) varsByCategory[cat] = [];
    const scoreInfo = computeImpactScore(impact);
    impactScores[varName] = scoreInfo;
    varsByCategory[cat].push({ varName, scoreInfo });
  }

  // Sort each category: multi-value (by score desc) first, then single-value
  for (const cat of Object.keys(varsByCategory)) {
    varsByCategory[cat].sort((a, b) => b.scoreInfo.score - a.scoreInfo.score);
  }

  // Ordered categories
  const categoryOrder = Object.keys(ENV_VAR_CATEGORIES).concat(['Other']);

  let optionsHtml = '<option value="">-- Select a variable to analyze --</option>';
  for (const cat of categoryOrder) {
    const vars = varsByCategory[cat];
    if (!vars || vars.length === 0) continue;
    optionsHtml += `<optgroup label="${escapeHtml(cat)}">`;
    for (const { varName, scoreInfo } of vars) {
      const indicator = scoreInfo.level === 'single' ? '' :
        scoreInfo.level === 'high' ? ' *** ' :
        scoreInfo.level === 'medium' ? ' ** ' :
        scoreInfo.level === 'low-confidence' ? ' ? ' : ' * ';
      const displayName = varName.replace(/_/g, ' ');
      optionsHtml += `<option value="${escapeHtml(varName)}">${escapeHtml(displayName)}${indicator}</option>`;
    }
    optionsHtml += '</optgroup>';
  }

  select.innerHTML = optionsHtml;

  // Build overview summary: count by impact level
  const levels = { high: 0, medium: 0, low: 0, 'low-confidence': 0, single: 0 };
  for (const info of Object.values(impactScores)) {
    levels[info.level] = (levels[info.level] || 0) + 1;
  }

  summary.innerHTML = `
    <span class="env-summary-item impact-high-bg" title="High impact variables">${levels.high} high</span>
    <span class="env-summary-item impact-medium-bg" title="Medium impact variables">${levels.medium} medium</span>
    <span class="env-summary-item impact-low-bg" title="Low impact variables">${levels.low} low</span>
    ${levels['low-confidence'] > 0 ? `<span class="env-summary-item impact-lowconf-bg" title="Need more data">${levels['low-confidence']} need data</span>` : ''}
    <span class="env-summary-item impact-single-bg" title="Only one value tested">${levels.single} single</span>
    <span class="env-summary-total">${Object.keys(envImpact).length} variables tracked</span>
  `;

  // Auto-select the highest impact variable if there is one
  const highImpactVar = Object.entries(impactScores)
    .filter(([, info]) => info.level !== 'single')
    .sort((a, b) => b[1].score - a[1].score)[0];

  if (highImpactVar) {
    select.value = highImpactVar[0];
    renderSelectedEnvVar(highImpactVar[0]);
  } else {
    container.innerHTML = '<div class="empty-state">All variables have only one value tested. Vary your settings between smoke test runs to see impact analysis.</div>';
  }
}

/** Called when user picks a variable from the dropdown */
function onEnvVarSelected() {
  const select = document.getElementById('env-var-select');
  const varName = select.value;
  if (!varName || !cachedEnvImpact) {
    document.getElementById('env-impact-content').innerHTML = '';
    return;
  }
  renderSelectedEnvVar(varName);
}

/** Render the detailed analysis view for a single env variable */
function renderSelectedEnvVar(varName) {
  const container = document.getElementById('env-impact-content');
  const impact = cachedEnvImpact[varName];
  if (!impact) {
    container.innerHTML = '<div class="empty-state">No data for this variable.</div>';
    return;
  }

  const values = Object.entries(impact.values).sort((a, b) => b[1].avgPnl - a[1].avgPnl);
  const hasMultipleValues = values.length > 1;
  const scoreInfo = computeImpactScore(impact);

  const bestValue = values[0];
  const worstValue = values[values.length - 1];
  const displayName = varName.replace(/_/g, ' ');

  // Impact badge
  let impactBadgeClass, impactBadgeLabel;
  if (!hasMultipleValues) {
    impactBadgeClass = 'impact-single';
    impactBadgeLabel = 'Single Value';
  } else if (scoreInfo.level === 'low-confidence') {
    impactBadgeClass = 'impact-low-confidence';
    impactBadgeLabel = 'Low Confidence';
  } else if (scoreInfo.level === 'high') {
    impactBadgeClass = 'impact-high';
    impactBadgeLabel = 'High Impact';
  } else if (scoreInfo.level === 'medium') {
    impactBadgeClass = 'impact-medium';
    impactBadgeLabel = 'Medium Impact';
  } else {
    impactBadgeClass = 'impact-low';
    impactBadgeLabel = 'Low Impact';
  }

  // Build analysis insights
  let insightsHtml = '';
  if (hasMultipleValues) {
    const pnlSpreadFormatted = formatPnl(scoreInfo.pnlSpread);
    const passRateSpreadPct = (scoreInfo.passRateSpread * 100).toFixed(1);

    insightsHtml = `
      <div class="env-insights">
        <div class="env-insight-row">
          <span class="insight-label">Best value</span>
          <span class="insight-value positive"><code>${escapeHtml(String(bestValue[0]))}</code> (${formatPnl(bestValue[1].avgPnl)} avg, ${(bestValue[1].passRate * 100).toFixed(0)}% pass)</span>
        </div>
        <div class="env-insight-row">
          <span class="insight-label">Worst value</span>
          <span class="insight-value negative"><code>${escapeHtml(String(worstValue[0]))}</code> (${formatPnl(worstValue[1].avgPnl)} avg, ${(worstValue[1].passRate * 100).toFixed(0)}% pass)</span>
        </div>
        <div class="env-insight-row">
          <span class="insight-label">P&L spread</span>
          <span class="insight-value">${pnlSpreadFormatted}</span>
        </div>
        <div class="env-insight-row">
          <span class="insight-label">Pass rate spread</span>
          <span class="insight-value">${passRateSpreadPct}%</span>
        </div>
        <div class="env-insight-row">
          <span class="insight-label">Confidence</span>
          <span class="insight-value">${(scoreInfo.confidenceFactor * 100).toFixed(0)}% (min ${scoreInfo.minSamples} runs per value, ${scoreInfo.totalSamples} total)</span>
        </div>
      </div>
    `;
  }

  const rows = values.map(([val, stats]) => {
    const isBest = hasMultipleValues && val === bestValue[0];
    const isWorst = hasMultipleValues && values.length > 1 && val === worstValue[0];
    const rowClass = isBest ? 'best-value-row' : isWorst ? 'worst-value-row' : '';
    return `
      <tr class="${rowClass}">
        <td class="env-val-cell"><code>${escapeHtml(String(val))}</code></td>
        <td class="${pnlClass(stats.avgPnl)}">${formatPnl(stats.avgPnl)}</td>
        <td>${formatDuration(stats.avgDuration)}</td>
        <td>${(stats.passRate * 100).toFixed(0)}%</td>
        <td>${stats.count} run${stats.count !== 1 ? 's' : ''}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <div class="env-var-card ${hasMultipleValues ? 'multi-value' : 'single-value'}">
      <div class="env-var-header">
        <span class="env-var-name">${escapeHtml(displayName)}</span>
        <span class="impact-badge ${impactBadgeClass}">${impactBadgeLabel}</span>
      </div>
      ${insightsHtml}
      <table class="env-impact-table">
        <thead>
          <tr>
            <th>Value</th>
            <th>Avg P&L</th>
            <th>Avg Duration</th>
            <th>Pass Rate</th>
            <th>Runs</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ============================================================
// DETAIL TABLE
// ============================================================

function renderDetailTable(timeSeries) {
  const sorted = sortTimeSeries(timeSeries, currentSort.field, currentSort.dir);
  const tbody = document.getElementById('detail-table-body');

  tbody.innerHTML = sorted.map(t => {
    const resultClass = t.result === 'PASS' ? 'positive' : 'negative';
    return `
      <tr>
        <td>${formatDate(t.startedAt)}</td>
        <td class="${resultClass}">${t.result}</td>
        <td class="${pnlClass(t.pnl)}">${formatPnl(t.pnl)}</td>
        <td>${formatDuration(t.duration)}</td>
        <td>${t.tokensEvaluated}</td>
        <td>${t.tokensPipelinePassed}</td>
        <td>${t.buyFailures}</td>
        <td>${escapeHtml(t.exitTrigger)}</td>
      </tr>
    `;
  }).join('');
}

function sortTimeSeries(data, field, dir) {
  const sorted = [...data];
  sorted.sort((a, b) => {
    let va, vb;
    switch (field) {
      case 'pnl': va = a.pnl; vb = b.pnl; break;
      case 'duration': va = a.duration; vb = b.duration; break;
      default: va = a.startedAt; vb = b.startedAt;
    }
    return dir === 'asc' ? va - vb : vb - va;
  });
  return sorted;
}

function sortTable(field) {
  if (currentSort.field === field) {
    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.field = field;
    currentSort.dir = 'desc';
  }

  // Update button styles
  document.querySelectorAll('[id^="sort-btn-"]').forEach(btn => {
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
  });
  const activeBtn = document.getElementById(`sort-btn-${field}`);
  if (activeBtn) {
    activeBtn.classList.remove('btn-secondary');
    activeBtn.classList.add('btn-primary');
    activeBtn.textContent = `Sort by ${field.charAt(0).toUpperCase() + field.slice(1)} ${currentSort.dir === 'asc' ? '\u2191' : '\u2193'}`;
  }

  if (analyticsData && analyticsData.timeSeries) {
    renderDetailTable(analyticsData.timeSeries);
  }
}

// ============================================================
// INIT
// ============================================================

loadReports();
