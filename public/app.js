const $ = (id) => document.getElementById(id);
const terminalStatuses = new Set(['completed', 'expired', 'failed', 'cancelled']);
const statusLabels = {
  queued: 'Queued', prepared: 'Prepared', uncertain: 'Uncertain', confirming: 'Confirming',
  partial: 'Partial fill', completed: 'Completed', paused: 'Paused', expired: 'Expired',
  failed: 'Failed', cancelled: 'Cancelled',
};
const faultLabels = {
  none: 'No fault armed', drop_ack: 'Acknowledgement drop armed', drop_before_send: 'Failure before exchange armed', stale_read: 'Stale read armed',
  partial_fill: 'Partial fill armed', pending_receipt: 'Receipt delay armed',
};
let state = null;
let selectedId = readSession('perpops.selected');
let pendingSubmission = readPendingSubmission();
let receiptCache = new Map();
let online = false;
let busy = false;
let refreshRunning = null;
let toastTimer;
let lastRenderedDetail = '';
let lastRenderedHistory = '';
let composerInitialised = false;

function readSession(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function saveSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* The execution service remains the source of truth. */ }
}

function readPendingSubmission() {
  try {
    const payload = JSON.parse(readSession('perpops.pending') || 'null');
    return payload && typeof payload.id === 'string' && typeof payload.target === 'string'
      && typeof payload.maxPosition === 'string' && typeof payload.limitPrice === 'string'
      && typeof payload.deadline === 'string' ? payload : null;
  } catch { return null; }
}

function rememberPending(payload) {
  pendingSubmission = payload;
  saveSession('perpops.pending', payload ? JSON.stringify(payload) : null);
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortId(value, head = 9, tail = 5) {
  const text = String(value || '');
  return text.length > head + tail + 3 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

function decimalText(value) {
  if (value === null || value === undefined) return '—';
  const input = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(input)) return input;
  return input.includes('.') ? input.replace(/0+$/, '').replace(/\.$/, '') : input;
}

function isZero(value) {
  return /^-?0+(\.0+)?$/.test(String(value));
}

function decimalUnits(value, decimals, name = 'Value') {
  const input = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(input)) throw new Error(`${name} must be a decimal number.`);
  const negative = input.startsWith('-');
  const [whole, fraction = ''] = input.replace(/^-/, '').split('.');
  if (fraction.length > decimals) throw new Error(`${name} supports at most ${decimals} decimal places.`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return negative ? -units : units;
}

function unitsDecimal(value, decimals) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(decimals + 1, '0');
  const result = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
  return `${negative ? '-' : ''}${decimalText(result)}`;
}

function assetSymbol() { return state?.market?.symbol?.replace(/-PERP$/i, '') || 'BTC'; }

function dateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatTime(value, seconds = false) {
  const date = dateValue(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false,
  }).format(date);
}

function statusClass(status) {
  if (status === 'completed') return 'good';
  if (['uncertain', 'partial', 'paused', 'confirming'].includes(status)) return 'warn';
  if (['failed', 'expired'].includes(status)) return 'bad';
  return 'neutral';
}

function selectedIntent() { return state?.intents?.find((intent) => intent.id === selectedId) || null; }

function activeIntent() {
  return state?.intents?.find((intent) => intent.id === state.activeIntentId && !terminalStatuses.has(intent.status)) || null;
}

function canTrade() {
  return online && state?.readiness?.status === 'ready' && state?.market?.canTrade === true;
}

function isSimulation() { return state?.mode === 'simulation'; }

function showAlert(message) {
  $('global-alert').textContent = message || '';
  $('global-alert').hidden = !message;
}

function showFormError(message) {
  $('form-error').textContent = message || '';
  $('form-error').hidden = !message;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}

async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method, signal: controller.signal, cache: 'no-store',
      headers: method === 'GET' ? { Accept: 'application/json' } : {
        Accept: 'application/json', 'Content-Type': 'application/json', 'X-PerpOps-Client': 'workbench',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The execution service returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      const error = new Error(data.error?.message || `The request failed (${response.status}).`);
      error.code = data.error?.code;
      error.httpStatus = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The service did not respond in time. Transaction state may still need reconciliation.');
    throw error;
  } finally { clearTimeout(timer); }
}

function chooseIntent(id) {
  selectedId = id;
  saveSession('perpops.selected', id);
  lastRenderedDetail = '';
  render();
  if (matchMedia('(max-width: 800px)').matches) scrollToDetail();
}

function scrollToDetail() {
  $('detail-title').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function renderMetric(id, value, unit) {
  const node = $(id);
  node.replaceChildren(document.createTextNode(decimalText(value)));
  if (unit && value !== null && value !== undefined) node.append(makeElement('span', 'value-unit', unit));
}

function renderOverview() {
  const sim = isSimulation();
  const market = state.market;
  const account = state.account;
  const asset = assetSymbol();
  $('environment-badge').className = `environment-badge ${sim ? 'simulation' : 'testnet'}`;
  $('environment-label').textContent = sim ? 'Local simulation' : 'DreamDEX testnet';
  $('connection-state').textContent = online ? 'Execution service connected' : 'Service unavailable';
  $('connection-state').classList.toggle('error', !online);
  $('market-label').textContent = market.symbol;
  $('composer-market').textContent = market.symbol;
  $('target-unit').textContent = asset;
  $('cap-unit').textContent = asset;
  $('price-help').textContent = account?.markPrice
    ? `Mark ${decimalText(account.markPrice)} USDso. No fill guarantee.`
    : 'A price limit does not ensure a fill.';
  const message = state.readiness?.message || '';
  $('mode-notice-text').textContent = sim
    ? `Local simulation uses fictional prices and balances. Orders do not reach a blockchain.${state.readiness.status !== 'ready' && message ? ` ${message}` : ''}`
    : `DreamDEX testnet · chain ${market.chainId}. ${message}`;
  $('demo-note').textContent = sim ? 'Local simulation. No real funds.' : 'Recovery demo is available in local simulation.';
  $('close-note').textContent = market.nativeReduceOnly
    ? 'Prepare close sets a zero target. Review its price limit, then create a new intent.'
    : 'Prepare close sets a zero target for a bounded IOC order. It is not an exchange-held stop. Review the price limit before submitting.';
  const selected = selectedIntent();
  renderMetric('current-position', account?.position, asset);
  $('current-caption').textContent = sim ? 'Local simulation account' : market.account ? `Account ${shortId(market.account, 6, 4)}` : 'No account available';
  renderMetric('target-position', selected?.target, asset);
  $('target-caption').textContent = selected ? `Intent ${shortId(selected.id, 6, 4)}` : 'No intent selected';
  if (account && isZero(account.pendingBuys) && isZero(account.pendingSells)) {
    renderMetric('pending-position', '0', asset);
    $('pending-caption').textContent = 'No outstanding orders';
  } else if (account) {
    renderMetric('pending-position', `${decimalText(account.pendingBuys)} / ${decimalText(account.pendingSells)}`, asset);
    $('pending-caption').textContent = 'Buy quantity / sell quantity';
  } else {
    renderMetric('pending-position', null);
    $('pending-caption').textContent = 'No snapshot available';
  }
  $('account-state').textContent = !online ? 'Disconnected' : state.readiness.status === 'ready' ? 'Connected' : state.readiness.status === 'read_only' ? 'Read only' : 'Offline';
  $('account-caption').textContent = account ? `Block ${account.blockNumber} · ${formatTime(account.observedAt, true)}` : 'No snapshot available';
  const armed = state.fault?.armed || 'none';
  $('fault-state').classList.toggle('armed', armed !== 'none');
  $('fault-state').lastElementChild.textContent = sim ? (faultLabels[armed] || `Armed: ${armed}`) : 'Fault injection is disabled on testnet';
  $('last-updated').textContent = `Updated ${formatTime(state.now || Date.now(), true)}`;
  const stats = state.stats;
  $('history-footnote').textContent = stats
    ? `${stats.transactionCount} transaction${stats.transactionCount === 1 ? '' : 's'} · ${stats.recovered} recovered intent${stats.recovered === 1 ? '' : 's'} · Source: execution service`
    : 'Receipts come from the execution service.';
}

function renderHistory() {
  const intents = [...(state.intents || [])].sort((a, b) => b.createdAt - a.createdAt);
  const version = JSON.stringify([selectedId, intents.map((intent) => [intent.id, intent.updatedAt, intent.status, intent.target])]);
  if (version === lastRenderedHistory) return;
  lastRenderedHistory = version;
  $('intent-count').textContent = String(intents.length);
  $('history-empty').hidden = intents.length > 0;
  const rows = intents.map((intent) => {
    const row = makeElement('tr', `intent-row${intent.id === selectedId ? ' selected' : ''}`);
    row.dataset.intentId = intent.id;
    row.setAttribute('aria-selected', String(intent.id === selectedId));
    const idCell = makeElement('td');
    const button = makeElement('button', 'intent-select', shortId(intent.id, 7, 4));
    button.type = 'button';
    button.title = intent.id;
    button.setAttribute('aria-label', `Inspect intent ${intent.id}`);
    button.addEventListener('click', () => chooseIntent(intent.id));
    idCell.append(button);
    const targetCell = makeElement('td', 'history-target', decimalText(intent.target));
    const statusCell = makeElement('td');
    statusCell.append(makeElement('span', `status-badge ${statusClass(intent.status)}`, statusLabels[intent.status] || intent.status));
    const timeCell = makeElement('td', '', formatTime(intent.createdAt));
    timeCell.title = dateValue(intent.createdAt)?.toLocaleString() || '';
    row.append(idCell, targetCell, statusCell, timeCell);
    row.addEventListener('click', (event) => {
      if (!event.target.closest('button')) chooseIntent(intent.id);
    });
    return row;
  });
  $('intent-list').replaceChildren(...rows);
}

function eventTitle(event) {
  const words = String(event.type || 'event').replace(/[_.-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function makeTransactionLink(hash) {
  const base = state.market.explorerUrl;
  if (!base || isSimulation()) return makeElement('span', '', shortId(hash, 8, 5));
  try {
    const url = new URL(`${base.replace(/\/$/, '')}/tx/${encodeURIComponent(hash)}`);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported explorer URL');
    const link = makeElement('a', '', shortId(hash, 8, 5));
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = hash;
    return link;
  } catch { return makeElement('span', '', shortId(hash, 8, 5)); }
}

function renderDetail() {
  const intent = selectedIntent();
  $('detail-empty').hidden = Boolean(intent);
  $('detail-content').hidden = !intent;
  $('detail-status').hidden = !intent;
  if (!intent) return;
  $('detail-status').className = `status-badge ${statusClass(intent.status)}`;
  $('detail-status').textContent = statusLabels[intent.status] || intent.status;
  $('selected-id').textContent = intent.id;
  $('selected-target').textContent = `${decimalText(intent.target)} ${assetSymbol()}`;
  const lastAttempt = intent.attempts?.at(-1);
  $('selected-transaction').replaceChildren(lastAttempt?.hash ? makeTransactionLink(lastAttempt.hash) : document.createTextNode('Not submitted'));
  $('selected-transaction').title = lastAttempt?.hash || '';
  const detailVersion = JSON.stringify([intent.id, intent.updatedAt, intent.status, intent.events, receiptCache.get(intent.id)]);
  if (detailVersion !== lastRenderedDetail) {
    lastRenderedDetail = detailVersion;
    const entries = (intent.events || []).map((event) => {
      const type = String(event.type || '').toLowerCase();
      const severity = /fail|reject|expired|error/.test(type) ? 'bad' : /uncertain|stale|partial|pause|recover|retry/.test(type) ? 'warn' : '';
      const item = makeElement('li', severity);
      const heading = makeElement('div', 'timeline-head');
      heading.append(makeElement('span', 'timeline-title', eventTitle(event)));
      const time = makeElement('time', '', formatTime(event.at, true));
      if (dateValue(event.at)) time.dateTime = new Date(event.at).toISOString();
      heading.append(time);
      item.append(heading);
      if (event.message) item.append(makeElement('p', '', event.message));
      return item;
    });
    if (!entries.length) {
      const entry = makeElement('li');
      entry.append(makeElement('span', 'timeline-title', 'Intent received'));
      entry.append(makeElement('p', '', 'No execution events have been returned yet.'));
      entries.push(entry);
    }
    $('timeline').replaceChildren(...entries);
    $('receipt-json').textContent = JSON.stringify(receiptCache.get(intent.id) || intent, null, 2);
  }
  $('detail-message').textContent = intent.message || '';
  $('detail-message').hidden = !intent.message;
}

function renderControls() {
  const trade = canTrade();
  const intent = selectedIntent();
  const active = activeIntent();
  const blocked = busy || !trade;
  $('submit-intent').disabled = blocked || Boolean(active && active.id !== pendingSubmission?.id);
  $('submit-intent').title = active ? 'Resolve the active intent before creating another.' : '';
  $('submit-intent').querySelector('span').textContent = pendingSubmission ? 'Retry pending submission' : 'Create execution intent';
  $('run-demo').disabled = blocked || !isSimulation() || Boolean(active);
  $('run-demo').title = active ? 'Recover or resolve the active intent first.' : '';
  $('arm-fault').disabled = busy || !online || !isSimulation();
  $('settle-simulation').disabled = busy || !online || !isSimulation();
  $('refresh-state').disabled = busy;
  $('recover-intent').disabled = blocked || !intent || terminalStatuses.has(intent.status);
  $('retry-intent').disabled = blocked || !intent;
  const lastAttempt = intent?.attempts?.at(-1);
  const canResend = trade && intent && !terminalStatuses.has(intent.status)
    && lastAttempt?.phase === 'submitted' && Date.parse(intent.deadline) > Date.now();
  $('rebroadcast-actions').hidden = !canResend;
  $('rebroadcast-intent').disabled = blocked || !canResend;
  $('export-receipt').disabled = busy || !online || !intent;
  $('close-position').disabled = blocked || !state?.account || isZero(state.account.position) || Boolean(active);
  const unresolvedTransaction = intent?.attempts?.some((attempt) => attempt.phase !== 'confirmed');
  $('cancel-intent').disabled = blocked || !intent || terminalStatuses.has(intent.status) || Boolean(unresolvedTransaction);
  document.querySelectorAll('input[name="fault"]').forEach((input) => { input.disabled = busy || !online || !isSimulation(); });
  document.querySelectorAll('#intent-form input, .preset-button').forEach((input) => { input.disabled = busy || !trade || Boolean(pendingSubmission); });
}

function render() {
  if (state) {
    if (!selectedId || !state.intents.some((intent) => intent.id === selectedId)) {
      selectedId = state.activeIntentId || [...state.intents].sort((a, b) => b.createdAt - a.createdAt)[0]?.id || null;
    }
    if (pendingSubmission && state.intents.some((intent) => intent.id === pendingSubmission.id)) {
      selectedId = pendingSubmission.id;
      rememberPending(null);
    }
    renderOverview();
    renderHistory();
    renderDetail();
  }
  $('request-id-preview').textContent = pendingSubmission?.id || 'New identity on submit · valid for 10 minutes';
  renderControls();
}

async function refresh({ quiet = false } = {}) {
  if (refreshRunning) return refreshRunning;
  refreshRunning = (async () => {
    try {
      const response = await api('/api/state', { timeout: 12000 });
      if (!response.market || !Array.isArray(response.intents)) throw new Error('The execution service returned an incomplete state.');
      for (const next of response.intents) {
        const previous = state?.intents?.find((intent) => intent.id === next.id);
        if (previous && previous.updatedAt !== next.updatedAt) receiptCache.delete(next.id);
      }
      state = response;
      online = true;
      if (!composerInitialised && state.account) {
        composerInitialised = true;
        if (!pendingSubmission) suggestLimit($('target-input').value);
      }
      showAlert('');
      render();
      return response;
    } catch (error) {
      online = false;
      $('connection-state').textContent = 'Service unavailable';
      $('connection-state').classList.add('error');
      showAlert(`Cannot refresh execution state. ${error.message}${state ? ' Values shown are from the last received snapshot.' : ''}`);
      renderControls();
      if (!quiet) toast('The execution service is unavailable. No new request was sent.', true);
      return null;
    } finally { refreshRunning = null; }
  })();
  return refreshRunning;
}

async function mutate(button, action, successMessage) {
  if (busy) return;
  busy = true;
  showFormError('');
  button?.classList.add('loading');
  renderControls();
  try {
    // Wait for any older read before sending a write, so it cannot overwrite the result.
    if (refreshRunning) await refreshRunning;
    const result = await action();
    const intent = result?.intent || (result?.id && result?.status ? result : null);
    if (intent) {
      selectedId = intent.id;
      saveSession('perpops.selected', intent.id);
      receiptCache.delete(intent.id);
    }
    await refresh({ quiet: true });
    if (intent && ['run-demo', 'submit-intent'].includes(button?.id)) scrollToDetail();
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    return result;
  } catch (error) {
    showFormError(error.message);
    toast(error.message, true);
    await refresh({ quiet: true });
    return null;
  } finally {
    busy = false;
    button?.classList.remove('loading');
    render();
  }
}

function intentPayload() {
  const target = $('target-input').value.trim();
  const maxPosition = $('max-position-input').value.trim();
  const limitPrice = $('price-input').value.trim();
  const baseDecimals = Number(state?.market?.baseDecimals ?? 8);
  const quoteDecimals = Number(state?.market?.quoteDecimals ?? 18);
  const targetUnits = decimalUnits(target, baseDecimals, 'Target position');
  const capUnits = decimalUnits(maxPosition, baseDecimals, 'Position limit');
  const priceUnits = decimalUnits(limitPrice, quoteDecimals, 'Limit price');
  if (capUnits <= 0n) throw new Error('Position limit must be greater than zero.');
  if (targetUnits > capUnits || targetUnits < -capUnits) throw new Error('The target position exceeds your position limit.');
  if (priceUnits <= 0n) throw new Error('Limit price must be greater than zero.');
  if (pendingSubmission && [target, maxPosition, limitPrice].every((value, index) => value === [pendingSubmission.target, pendingSubmission.maxPosition, pendingSubmission.limitPrice][index])) {
    return pendingSubmission;
  }
  if (pendingSubmission) throw new Error('An earlier submission is unresolved. Refresh its state before changing the request.');
  return { id: crypto.randomUUID(), target, maxPosition, limitPrice, deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
}

function payloadFor(intent) {
  return { id: intent.id, target: intent.target, maxPosition: intent.maxPosition, limitPrice: intent.limitPrice, deadline: intent.deadline };
}

function suggestLimit(target) {
  if (!state?.account) return;
  try {
    const baseDecimals = Number(state.market.baseDecimals);
    const quoteDecimals = Number(state.market.quoteDecimals);
    const delta = decimalUnits(target, baseDecimals) - decimalUnits(state.account.position, baseDecimals);
    if (delta === 0n) return;
    const buying = delta > 0n;
    const reference = buying ? state.account.bestAsk || state.account.markPrice : state.account.bestBid || state.account.markPrice;
    const price = decimalUnits(reference, quoteDecimals);
    const tick = decimalUnits(state.market.tickSize, quoteDecimals);
    if (price <= 0n || tick <= 0n) return;
    const scaled = buying ? (price * 1001n + 999n) / 1000n : price * 999n / 1000n;
    const rounded = buying ? (scaled + tick - 1n) / tick * tick : scaled / tick * tick;
    if (rounded > 0n) $('price-input').value = unitsDecimal(rounded, quoteDecimals);
  } catch { /* Keep the user's explicit price when a market quote is unavailable. */ }
}

$('intent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !canTrade()) return;
  let payload;
  try { payload = intentPayload(); }
  catch (error) { showFormError(error.message); return; }
  rememberPending(payload);
  $('request-id-preview').textContent = payload.id;
  await mutate($('submit-intent'), async () => {
    try {
      const result = await api('/api/intents', { method: 'POST', body: payload });
      rememberPending(null);
      return result;
    } catch (error) {
      if (error.httpStatus >= 400 && error.httpStatus < 500) rememberPending(null);
      throw error;
    }
  }, 'Execution intent recorded. Inspect its status and receipt below.');
});

document.querySelectorAll('.preset-button').forEach((button) => {
  button.addEventListener('click', () => {
    $('target-input').value = button.dataset.target;
    suggestLimit(button.dataset.target);
    showFormError('');
    $('target-input').focus();
  });
});

$('run-demo').addEventListener('click', () => mutate($('run-demo'), () => api('/api/demo', { method: 'POST', body: {} }), 'The demo dropped the acknowledgement. Recover the selected intent to reconcile its transaction.'));

$('arm-fault').addEventListener('click', () => {
  const fault = document.querySelector('input[name="fault"]:checked')?.value;
  if (!fault) return;
  mutate($('arm-fault'), () => api('/api/fault', { method: 'POST', body: { fault } }), 'Simulation fault armed. It applies to the next matching operation.');
});

$('settle-simulation').addEventListener('click', () => mutate($('settle-simulation'), () => api('/api/simulation/settle', { method: 'POST', body: {} }), 'Simulated delay released. Resume the intent to reconcile the result.'));

$('recover-intent').addEventListener('click', () => {
  const intent = selectedIntent();
  if (!intent) return;
  mutate($('recover-intent'), () => api(`/api/intents/${encodeURIComponent(intent.id)}/resume`, { method: 'POST', body: {} }), 'Recovery step completed. The timeline shows the current execution state.');
});

$('retry-intent').addEventListener('click', () => {
  const intent = selectedIntent();
  if (!intent) return;
  const payload = payloadFor(intent);
  mutate($('retry-intent'), () => api('/api/intents', { method: 'POST', body: payload }), 'Replayed the original request with the same identity and parameters.');
});

$('rebroadcast-intent').addEventListener('click', () => {
  const intent = selectedIntent();
  if (!intent) return;
  mutate($('rebroadcast-intent'), () => api(`/api/intents/${encodeURIComponent(intent.id)}/rebroadcast`, { method: 'POST', body: {} }), 'Saved transaction checked. Inspect the timeline for its reconciliation or resend result.');
});

$('cancel-intent').addEventListener('click', () => {
  const intent = selectedIntent();
  if (!intent) return;
  mutate($('cancel-intent'), () => api(`/api/intents/${encodeURIComponent(intent.id)}/cancel`, { method: 'POST', body: {} }), 'Intent stopped. Existing positions remain open.');
});

$('close-position').addEventListener('click', () => {
  if (busy || !canTrade() || activeIntent()) return;
  $('target-input').value = '0';
  suggestLimit('0');
  rememberPending(null);
  $('request-id-preview').textContent = 'New close intent · assigned when submitted';
  showFormError('');
  $('composer-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('target-input').focus({ preventScroll: true });
  toast('Close target prepared. Review the price limit, then create the new intent.');
});

$('export-receipt').addEventListener('click', async () => {
  const intent = selectedIntent();
  if (!intent || busy) return;
  busy = true;
  renderControls();
  try {
    const receipt = await api(`/api/intents/${encodeURIComponent(intent.id)}/receipt`);
    receiptCache.set(intent.id, receipt);
    const blob = new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `perpops-${intent.id.replace(/[^a-zA-Z0-9_-]/g, '')}-receipt.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Execution receipt exported.');
  } catch (error) { toast(error.message, true); }
  finally { busy = false; render(); }
});

$('refresh-state').addEventListener('click', async () => {
  $('refresh-state').classList.add('loading');
  await refresh();
  $('refresh-state').classList.remove('loading');
});

document.querySelector('.raw-receipt').addEventListener('toggle', async (event) => {
  const intent = selectedIntent();
  if (!event.target.open || !intent || !online) return;
  try {
    const receipt = await api(`/api/intents/${encodeURIComponent(intent.id)}/receipt`);
    receiptCache.set(intent.id, receipt);
    if (selectedId === intent.id) renderDetail();
  } catch (error) { toast(`Receipt unavailable. ${error.message}`, true); }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !busy) refresh({ quiet: true });
});

if (pendingSubmission) {
  $('target-input').value = pendingSubmission.target;
  $('max-position-input').value = pendingSubmission.maxPosition;
  $('price-input').value = pendingSubmission.limitPrice;
}
renderControls();
await refresh({ quiet: true });
setInterval(() => {
  if (!busy && document.visibilityState === 'visible') refresh({ quiet: true });
}, 4000);
