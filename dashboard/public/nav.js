/**
 * Shared navigation component for all dashboard pages
 * Renders a consistent top nav bar with mode-aware links
 */

const NAV_LINKS = [
  { path: '/', label: 'Home' },
  { path: '/dry-run', label: 'Dry Run', modes: ['dry_run'] },
  { path: '/production', label: 'Production', modes: ['production'] },
  { path: '/smoke-test', label: 'Smoke Test', modes: ['smoke'] },
  { path: '/smoke-analytics', label: 'Smoke Analytics', modes: ['smoke'] },
  { path: '/ab-test', label: 'A/B Test', modes: ['ab'] },
  { path: '/diagnostic.html', label: 'Diagnostics' },
  { path: '/env-config', label: 'Config' },
  { path: '/journal', label: 'Journal' },
  { path: '/ai-report', label: 'AI Report' },
];

// Cache the last known status in sessionStorage so new page loads
// can render instantly instead of flashing "--" / "Offline".
const NAV_CACHE_KEY = 'nav_bot_info';

function getCachedBotInfo() {
  try {
    const raw = sessionStorage.getItem(NAV_CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

function setCachedBotInfo(info) {
  try {
    sessionStorage.setItem(NAV_CACHE_KEY, JSON.stringify(info));
  } catch { /* ignore */ }
}

/**
 * Initialize the navigation bar
 * Uses cached bot-info to render immediately, then fetches fresh data once.
 */
async function initNav() {
  const navContainer = document.getElementById('nav-bar');
  if (!navContainer) return;

  // Use cached data for instant render (prevents "Offline" flash)
  const cached = getCachedBotInfo();
  const botMode = cached?.botMode || 'unknown';

  renderNav(navContainer, botMode, cached);

  // Fetch fresh data (single call — no duplicate)
  try {
    const res = await fetch('/api/bot-info');
    if (res.ok) {
      const info = await res.json();
      setCachedBotInfo(info);

      // Re-render nav if mode changed
      const newMode = info.botMode || 'unknown';
      if (newMode !== botMode) {
        renderNav(navContainer, newMode, info);
      }

      // Update status indicator with fresh data
      applyStatusFromInfo(info);
    }
  } catch {
    // If fetch fails and we had no cache, mark as offline
    if (!cached) {
      applyOfflineStatus();
    }
  }

  // Poll status every 5 seconds (single poll loop)
  setInterval(updateNavStatus, 5000);
}

function renderNav(navContainer, botMode, info) {
  const currentPath = window.location.pathname;

  const links = NAV_LINKS.map(link => {
    const isActive = currentPath === link.path ||
      (link.path !== '/' && currentPath.startsWith(link.path));
    const isCurrentMode = link.modes ? link.modes.includes(botMode) : false;
    const activeClass = isActive ? ' nav-link-active' : '';
    const modeIndicator = isCurrentMode ? '<span class="nav-mode-dot"></span>' : '';

    return `<a href="${link.path}" class="nav-link${activeClass}">${modeIndicator}${link.label}</a>`;
  });

  // Determine initial status text from cache
  let statusClass = '';
  let statusText = '--';
  if (info) {
    if (info.websocket?.connected) {
      statusClass = ' connected';
      statusText = info.botMode === 'ab' ? 'A/B Test Active'
        : info.botMode === 'smoke' ? 'Smoke Test Active'
        : 'Connected';
    } else if (info.botMode === 'standby') {
      statusText = 'Standby';
    } else {
      statusClass = ' disconnected';
      statusText = 'Disconnected';
    }
  }

  navContainer.innerHTML = `
    <div class="nav-left">
      <span class="nav-title">Pump.fun Bot</span>
      <span class="nav-mode-badge">${botMode.replace('_', ' ').toUpperCase()}</span>
    </div>
    <div class="nav-links">${links.join('')}</div>
    <div class="nav-right">
      <div class="status-indicator${statusClass}" id="nav-connection-status">
        <span class="status-dot"></span>
        <span class="status-text">${statusText}</span>
      </div>
    </div>
  `;
}

function applyStatusFromInfo(info) {
  const statusEl = document.getElementById('nav-connection-status');
  if (!statusEl) return;

  if (info.websocket?.connected) {
    statusEl.classList.add('connected');
    statusEl.classList.remove('disconnected');
    const modeLabel = info.botMode === 'ab' ? 'A/B Test Active'
      : info.botMode === 'smoke' ? 'Smoke Test Active'
      : 'Connected';
    statusEl.querySelector('.status-text').textContent = modeLabel;
  } else if (info.botMode === 'standby') {
    statusEl.classList.remove('connected');
    statusEl.classList.remove('disconnected');
    statusEl.querySelector('.status-text').textContent = 'Standby';
  } else {
    statusEl.classList.add('disconnected');
    statusEl.classList.remove('connected');
    statusEl.querySelector('.status-text').textContent = 'Disconnected';
  }
}

function applyOfflineStatus() {
  const statusEl = document.getElementById('nav-connection-status');
  if (!statusEl) return;
  statusEl.classList.add('disconnected');
  statusEl.classList.remove('connected');
  statusEl.querySelector('.status-text').textContent = 'Offline';
}

async function updateNavStatus() {
  try {
    const res = await fetch('/api/bot-info');
    if (res.ok) {
      const info = await res.json();
      setCachedBotInfo(info);
      applyStatusFromInfo(info);
    }
  } catch {
    applyOfflineStatus();
  }
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNav);
} else {
  initNav();
}
