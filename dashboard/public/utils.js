/**
 * Shared utility functions for all dashboard pages.
 * Loaded before page-specific scripts to avoid duplication.
 */

function fetchApi(endpoint) {
  return fetch(endpoint)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .catch(error => {
      console.error(`API error for ${endpoint}:`, error);
      return null;
    });
}

function postApi(endpoint, data = {}) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
    .then(res => res.json())
    .catch(error => {
      console.error(`API POST error for ${endpoint}:`, error);
      return null;
    });
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
  if (!timestamp) return '--';
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

async function copyToClipboard(text, element) {
  try {
    await navigator.clipboard.writeText(text);
    if (element) {
      if (element.classList.contains('copy-btn')) {
        element.textContent = '\u2713';
        element.classList.add('copied');
        setTimeout(() => {
          element.textContent = '\uD83D\uDCCB';
          element.classList.remove('copied');
        }, 1500);
      } else {
        element.style.color = 'var(--accent-green)';
        setTimeout(() => { element.style.color = ''; }, 1500);
      }
    }
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}
