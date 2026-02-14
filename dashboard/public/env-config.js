/**
 * Environment Config Dashboard
 * Allows viewing, editing, and copying env variables for Railway.
 */

// State
let categories = [];
let currentValues = {};
let editedValues = {};   // user overrides: { VAR_NAME: 'value' }
let collapsedCategories = new Set();
let showChangedOnly = false;
let showDescriptions = true;

// DOM refs
const categoriesContainer = document.getElementById('env-categories');
const copyAllBtn = document.getElementById('copy-all-btn');
const resetAllBtn = document.getElementById('reset-all-btn');
const pushRailwayBtn = document.getElementById('push-railway-btn');
const restartBotBtn = document.getElementById('restart-bot-btn');
const showChangedOnlyCheckbox = document.getElementById('show-changed-only');
const showDescriptionsCheckbox = document.getElementById('show-descriptions');
const copyToast = document.getElementById('copy-toast');
let railwayConfigured = false;

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
  const [data, railwayStatus] = await Promise.all([
    fetchApi('/api/env-reference'),
    fetchApi('/api/railway/status'),
  ]);

  if (!data) {
    categoriesContainer.innerHTML = '<div class="error-state">Failed to load configuration</div>';
    return;
  }

  categories = data.categories;
  currentValues = data.currentValues || {};

  // Initialize editedValues from currentValues
  for (const cat of categories) {
    for (const v of cat.vars) {
      const cur = currentValues[v.name];
      if (cur) {
        editedValues[v.name] = cur;
      }
    }
  }

  // Show Railway buttons if API is configured
  if (railwayStatus && railwayStatus.configured) {
    railwayConfigured = true;
    pushRailwayBtn.style.display = '';
    restartBotBtn.style.display = '';
  }

  render();
}

// ============================================================
// RENDERING
// ============================================================

function render() {
  const html = categories.map(cat => renderCategory(cat)).join('');
  categoriesContainer.innerHTML = html || '<div class="empty-state">No variables found</div>';

  // Attach input handlers
  categoriesContainer.querySelectorAll('.env-input').forEach(input => {
    input.addEventListener('input', handleInputChange);
    input.addEventListener('change', handleInputChange);
  });

  // Attach toggle handlers for boolean selects
  categoriesContainer.querySelectorAll('.env-select').forEach(select => {
    select.addEventListener('change', handleInputChange);
  });

  // Category collapse toggle
  categoriesContainer.querySelectorAll('.env-cat-header').forEach(header => {
    header.addEventListener('click', (e) => {
      // Don't toggle on button clicks
      if (e.target.closest('.btn')) return;
      const catId = header.dataset.catId;
      if (collapsedCategories.has(catId)) {
        collapsedCategories.delete(catId);
      } else {
        collapsedCategories.add(catId);
      }
      render();
    });
  });

  // Copy category buttons
  categoriesContainer.querySelectorAll('.copy-cat-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const catId = btn.dataset.catId;
      copyCategoryToClipboard(catId);
    });
  });
}

function renderCategory(cat) {
  const isCollapsed = collapsedCategories.has(cat.id);
  const vars = getFilteredVars(cat);

  if (showChangedOnly && vars.length === 0) return '';

  const varCount = vars.length;
  const changedCount = vars.filter(v => isChanged(v)).length;
  const countBadge = showChangedOnly
    ? `<span class="env-cat-count">${changedCount}</span>`
    : `<span class="env-cat-count">${varCount} vars${changedCount > 0 ? `, ${changedCount} changed` : ''}</span>`;

  const varsHtml = isCollapsed ? '' : `
    <div class="env-cat-body">
      ${vars.map(v => renderVar(v)).join('')}
    </div>
  `;

  return `
    <div class="env-cat panel ${isCollapsed ? 'collapsed' : ''}">
      <div class="env-cat-header" data-cat-id="${cat.id}">
        <div class="env-cat-header-left">
          <span class="env-cat-chevron">${isCollapsed ? '&#9654;' : '&#9660;'}</span>
          <div>
            <h2 class="env-cat-title">${escapeHtml(cat.label)}</h2>
            <span class="env-cat-desc">${escapeHtml(cat.description)}</span>
          </div>
        </div>
        <div class="env-cat-header-right">
          ${countBadge}
          <button class="btn btn-secondary btn-small copy-cat-btn" data-cat-id="${cat.id}" title="Copy this category">Copy</button>
        </div>
      </div>
      ${varsHtml}
    </div>
  `;
}

function renderVar(v) {
  const value = getEffectiveValue(v);
  const changed = isChanged(v);
  const isSensitive = v.sensitive;
  const changedClass = changed ? 'env-var-changed' : '';
  const requiredBadge = v.required ? '<span class="env-required">REQUIRED</span>' : '';

  const descHtml = showDescriptions
    ? `<div class="env-var-desc">${escapeHtml(v.description)}${v.hint ? ` <span class="env-var-hint">(${escapeHtml(v.hint)})</span>` : ''}</div>`
    : '';

  let inputHtml;
  if (v.type === 'boolean') {
    inputHtml = `
      <select class="env-select" data-var-name="${v.name}">
        <option value="true" ${value === 'true' ? 'selected' : ''}>true</option>
        <option value="false" ${value === 'false' ? 'selected' : ''}>false</option>
      </select>
    `;
  } else if (v.type === 'select') {
    const options = (v.options || []).map(opt =>
      `<option value="${escapeHtml(opt)}" ${value === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
    inputHtml = `<select class="env-select" data-var-name="${v.name}">${options}</select>`;
  } else {
    const inputType = isSensitive ? 'password' : 'text';
    inputHtml = `
      <input
        type="${inputType}"
        class="env-input"
        data-var-name="${v.name}"
        value="${escapeAttr(value)}"
        placeholder="${escapeAttr(v.placeholder || v.defaultValue || '')}"
        autocomplete="off"
      >
    `;
  }

  const defaultLabel = v.defaultValue
    ? `<span class="env-var-default">Default: ${escapeHtml(v.defaultValue)}</span>`
    : '<span class="env-var-default">No default</span>';

  return `
    <div class="env-var ${changedClass}">
      <div class="env-var-header">
        <code class="env-var-name">${v.name}</code>
        ${requiredBadge}
        ${defaultLabel}
      </div>
      ${descHtml}
      <div class="env-var-input-row">
        ${inputHtml}
        ${changed ? '<button class="env-var-reset" data-var-name="' + v.name + '" title="Reset to default">&#x21A9;</button>' : ''}
      </div>
    </div>
  `;
}

// ============================================================
// VALUE HELPERS
// ============================================================

function getEffectiveValue(v) {
  if (editedValues[v.name] !== undefined) {
    return editedValues[v.name];
  }
  return v.defaultValue || '';
}

function isChanged(v) {
  const effective = getEffectiveValue(v);
  return effective !== (v.defaultValue || '');
}

function getFilteredVars(cat) {
  if (!showChangedOnly) return cat.vars;
  return cat.vars.filter(v => isChanged(v) || v.required);
}

// ============================================================
// EVENT HANDLERS
// ============================================================

function handleInputChange(e) {
  const varName = e.target.dataset.varName;
  if (!varName) return;

  const value = e.target.value;
  editedValues[varName] = value;

  // Re-render to update changed state
  render();
}

// Reset individual var
categoriesContainer.addEventListener('click', (e) => {
  const resetBtn = e.target.closest('.env-var-reset');
  if (!resetBtn) return;

  const varName = resetBtn.dataset.varName;
  if (!varName) return;

  // Find the default
  for (const cat of categories) {
    for (const v of cat.vars) {
      if (v.name === varName) {
        editedValues[varName] = v.defaultValue || '';
        render();
        return;
      }
    }
  }
});

// Copy all button
copyAllBtn.addEventListener('click', () => {
  copyAllToClipboard();
});

// Reset all button
resetAllBtn.addEventListener('click', () => {
  if (!confirm('Reset all values to defaults? This only affects this editor, not your running bot.')) return;
  editedValues = {};
  render();
});

// Show changed only toggle
showChangedOnlyCheckbox.addEventListener('change', () => {
  showChangedOnly = showChangedOnlyCheckbox.checked;
  render();
});

// Show descriptions toggle
showDescriptionsCheckbox.addEventListener('change', () => {
  showDescriptions = showDescriptionsCheckbox.checked;
  render();
});

// ============================================================
// COPY TO CLIPBOARD
// ============================================================

function generateEnvBlock(filterCatId) {
  const lines = [];

  for (const cat of categories) {
    if (filterCatId && cat.id !== filterCatId) continue;

    // Sensitive vars are already excluded by the API, but double-check
    const vars = cat.vars.filter(v => !v.sensitive);

    if (vars.length === 0) continue;

    lines.push(`# ${cat.label}`);

    for (const v of vars) {
      const value = getEffectiveValue(v);
      // Skip empty non-required values
      if (!value && !v.required) continue;
      lines.push(`${v.name}=${value}`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

async function copyAllToClipboard() {
  const text = generateEnvBlock(null);
  await copyToClipboard(text);
  showToast('All variables copied to clipboard!');
}

async function copyCategoryToClipboard(catId) {
  const text = generateEnvBlock(catId);
  await copyToClipboard(text);
  const cat = categories.find(c => c.id === catId);
  showToast(`${cat?.label || 'Category'} copied!`);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Fallback for non-HTTPS
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

function showToast(message) {
  copyToast.textContent = message;
  copyToast.classList.add('show');
  setTimeout(() => {
    copyToast.classList.remove('show');
  }, 2000);
}

// ============================================================
// RAILWAY PUSH & RESTART
// ============================================================

pushRailwayBtn.addEventListener('click', async () => {
  // Collect all non-sensitive edited values that differ from defaults
  const variables = {};
  for (const cat of categories) {
    for (const v of cat.vars) {
      if (v.sensitive) continue;
      const value = getEffectiveValue(v);
      if (value) {
        variables[v.name] = value;
      }
    }
  }

  const count = Object.keys(variables).length;
  if (count === 0) {
    showToast('No variables to push');
    return;
  }

  if (!confirm(`Push ${count} variable${count > 1 ? 's' : ''} to Railway? This will stage changes on your Railway service.`)) return;

  pushRailwayBtn.disabled = true;
  pushRailwayBtn.textContent = 'Pushing...';

  try {
    const res = await fetch('/api/railway/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables }),
    });
    const result = await res.json();

    if (result.success) {
      showToast(`Pushed ${result.updatedCount} variable${result.updatedCount > 1 ? 's' : ''} to Railway!`);
    } else {
      showToast(`Error: ${result.error}`);
    }
  } catch (err) {
    showToast('Failed to reach the server');
  } finally {
    pushRailwayBtn.disabled = false;
    pushRailwayBtn.textContent = 'Push to Railway';
  }
});

restartBotBtn.addEventListener('click', async () => {
  if (!confirm('Restart the bot on Railway? This will trigger a full redeploy with the latest variables.')) return;

  restartBotBtn.disabled = true;
  restartBotBtn.textContent = 'Restarting...';

  try {
    const res = await fetch('/api/railway/restart', { method: 'POST' });
    const result = await res.json();

    if (result.success) {
      showToast('Bot restart triggered! Railway is redeploying now.');
    } else {
      showToast(`Error: ${result.error}`);
    }
  } catch (err) {
    showToast('Failed to reach the server');
  } finally {
    restartBotBtn.disabled = false;
    restartBotBtn.textContent = 'Restart Bot';
  }
});

// ============================================================
// UTILITIES
// ============================================================

async function fetchApi(endpoint) {
  try {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`API error for ${endpoint}:`, error);
    return null;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// INIT
// ============================================================

init();
