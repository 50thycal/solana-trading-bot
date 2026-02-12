/**
 * Shared navigation component for all dashboard pages
 * Renders a consistent top nav bar with mode-aware links
 */

const NAV_LINKS = [
  { path: '/', label: 'Home' },
  { path: '/dry-run', label: 'Dry Run', modes: ['dry_run'] },
  { path: '/production', label: 'Production', modes: ['production'] },
  { path: '/smoke-test', label: 'Smoke Test', modes: ['smoke'] },
  { path: '/ab-test', label: 'A/B Test', modes: ['ab'] },
  { path: '/diagnostic.html', label: 'Diagnostics' },
];

/**
 * Initialize the navigation bar
 * Fetches bot info to determine current mode and highlights the active page
 */
async function initNav() {
  const navContainer = document.getElementById('nav-bar');
  if (!navContainer) return;

  let botMode = 'unknown';
  try {
    const res = await fetch('/api/bot-info');
    if (res.ok) {
      const info = await res.json();
      botMode = info.botMode || 'unknown';
    }
  } catch { /* ignore */ }

  const currentPath = window.location.pathname;

  const links = NAV_LINKS.map(link => {
    const isActive = currentPath === link.path ||
      (link.path !== '/' && currentPath.startsWith(link.path));
    const isCurrentMode = link.modes ? link.modes.includes(botMode) : false;
    const activeClass = isActive ? ' nav-link-active' : '';
    const modeIndicator = isCurrentMode ? '<span class="nav-mode-dot"></span>' : '';

    return `<a href="${link.path}" class="nav-link${activeClass}">${modeIndicator}${link.label}</a>`;
  });

  navContainer.innerHTML = `
    <div class="nav-left">
      <span class="nav-title">Pump.fun Bot</span>
      <span class="nav-mode-badge">${botMode.replace('_', ' ').toUpperCase()}</span>
    </div>
    <div class="nav-links">${links.join('')}</div>
    <div class="nav-right">
      <div class="status-indicator" id="nav-connection-status">
        <span class="status-dot"></span>
        <span class="status-text">--</span>
      </div>
    </div>
  `;

  // Start connection status polling
  updateNavStatus();
  setInterval(updateNavStatus, 5000);
}

async function updateNavStatus() {
  const statusEl = document.getElementById('nav-connection-status');
  if (!statusEl) return;

  try {
    const res = await fetch('/api/bot-info');
    if (res.ok) {
      const info = await res.json();
      if (info.websocket?.connected) {
        statusEl.classList.add('connected');
        statusEl.classList.remove('disconnected');
        statusEl.querySelector('.status-text').textContent = 'Connected';
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
  } catch {
    statusEl.classList.add('disconnected');
    statusEl.classList.remove('connected');
    statusEl.querySelector('.status-text').textContent = 'Offline';
  }
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNav);
} else {
  initNav();
}
