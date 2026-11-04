
const $ = id => document.getElementById(id);

function rpc(name, ...args) {
  const token = Math.random().toString(36).slice(2);
  return new Promise(res => {
    chrome.runtime.sendMessage([token, name, ...args], reply => {
      void chrome.runtime.lastError;
      res(reply?.[1]);
    });
  });
}

let savedTimer;
function flashSaved(text = 'Saved') {
  $('saved').textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
}


// ---- Settings ----
function fillSettings(s) {
  $('enabled').checked      = s.enabled ?? true;
  $('autoclick').checked    = s.recaptcha_auto_open ?? true;
  $('images').checked       = s.recaptcha_auto_solve ?? true;
  $('click_delay').value    = s.recaptcha_delay_between_clicks ?? 300;
  $('reveal_delay').value   = s.recaptcha_delay_dynamic_reveal ?? 850;
  $('verify_delay').value   = s.recaptcha_delay_before_verify ?? 850;
  if (document.activeElement !== $('disabled_hosts')) {
    $('disabled_hosts').value = (s.disabled_hosts || []).join('\n');
  }
}

async function loadSettings() {
  const s = await rpc('settings::get');
  if (s && typeof s === 'object') fillSettings(s);
}

function ms(id) {
  return Math.max(0, Number($(id).value) || 0);
}

async function saveSettings(patch) {
  await rpc('settings::update', patch);
  flashSaved();
}

['enabled', 'autoclick', 'images'].forEach(id => {
  $(id).addEventListener('change', () => saveSettings({
    enabled:              $('enabled').checked,
    recaptcha_auto_open:  $('autoclick').checked,
    recaptcha_auto_solve: $('images').checked,
  }));
});
['click_delay', 'reveal_delay', 'verify_delay'].forEach(id => {
  $(id).addEventListener('change', () => saveSettings({
    recaptcha_delay_between_clicks: ms('click_delay'),
    recaptcha_delay_dynamic_reveal: ms('reveal_delay'),
    recaptcha_delay_before_verify:  ms('verify_delay'),
  }));
});

// Accepts bare hostnames or pasted URLs; keeps host[:port] the way the content
// script compares it against the page embedding the captcha.
function parseHosts(text) {
  const out = new Set();
  for (let line of text.split(/[\s,]+/)) {
    line = line.trim().toLowerCase();
    if (!line) continue;
    try {
      line = new URL(line.includes('://') ? line : 'http://' + line).host;
    } catch { continue; }
    if (line) out.add(line);
  }
  return [...out];
}

$('save_hosts').addEventListener('click', async () => {
  const hosts = parseHosts($('disabled_hosts').value);
  $('disabled_hosts').value = hosts.join('\n');
  await saveSettings({ disabled_hosts: hosts });
});

// Keep the page in sync when the popup changes settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) fillSettings(changes.settings.newValue);
});


// ---- Captcha database ----
const short = sha => (sha || '').slice(0, 7);
const fmtDate = v => v ? new Date(v).toLocaleString() : '—';
const fmtSize = n => n ? (n / 1024 / 1024).toFixed(1) + ' MB' : '—';

function setStatus(text, kind = 'info') {
  const el = $('db_status');
  el.textContent = text;
  el.className = `small status ${kind}`;
}

function renderActive(a) {
  if (!a) return;
  $('db_active').textContent = a.source === 'downloaded'
    ? `Downloaded update, installed ${fmtDate(a.installedAt)}`
    : 'Bundled with the extension';
  const c = a.counts || {};
  $('db_counts').textContent = `${(c.phash33 ?? 0).toLocaleString()} 3×3 tiles · ${(c.phash44 ?? 0).toLocaleString()} 4×4 grids`;
  $('db_file').textContent = `${short(a.sha)} · ${fmtSize(a.size)}` + (a.commit ? ` · commit ${short(a.commit)}` : '');
  $('db_reset').classList.toggle('hidden', a.source !== 'downloaded');
}

function renderLastCheck(c) {
  if (!c) { $('db_last_check').textContent = 'Never'; return; }
  const what = {
    up_to_date:       'up to date',
    update_available: 'update available',
    installed:        'update installed',
    error:            'failed',
  }[c.result] || c.result;
  $('db_last_check').textContent = `${fmtDate(c.ts)} (${what})`;
}

function describeUpstream(u) {
  const when = u.commitDate ? ` from ${new Date(u.commitDate).toLocaleDateString()}` : '';
  const msg  = u.commitMessage ? ` ("${u.commitMessage}")` : '';
  return `commit ${short(u.commit)}${when}${msg}, ${fmtSize(u.size)}`;
}

async function loadDb() {
  const st = await rpc('db::status');
  if (!st || typeof st !== 'object') {
    $('db_active').textContent = 'Unavailable';
    setStatus('Could not read the database status from the background script.', 'error');
    return;
  }
  const link = $('db_source_link');
  link.href = `https://github.com/${st.repo}/blob/${st.branch}/${st.path}`;
  link.textContent = st.repo;
  renderActive(st.active);
  renderLastCheck(st.lastCheck);
}

function setBusy(busy) {
  ['db_check', 'db_install', 'db_reset'].forEach(id => { $(id).disabled = busy; });
}

async function runCheck(install) {
  setBusy(true);
  $('db_install').classList.add('hidden');
  setStatus(install ? 'Downloading and verifying the update…' : 'Checking GitHub…');
  try {
    const r = await rpc('db::checkUpdate', { install });
    if (!r || typeof r !== 'object') {
      setStatus('No response from the background script.', 'error');
      return;
    }
    if (r.active) renderActive(r.active);
    if (r.result === 'up_to_date') {
      setStatus('You have the latest database.', 'ok');
    } else if (r.result === 'update_available') {
      setStatus(`Update available: ${describeUpstream(r.upstream)}.`, 'info');
      $('db_install').classList.remove('hidden');
    } else if (r.result === 'installed') {
      setStatus(`Installed ${describeUpstream(r.upstream)}. It's in use now.`, 'ok');
    } else {
      setStatus(`Update failed: ${r.error || 'unknown error'}. The current database is unchanged.`, 'error');
    }
  } finally {
    setBusy(false);
    const st = await rpc('db::status');
    if (st) renderLastCheck(st.lastCheck);
  }
}

$('db_check').addEventListener('click', () => runCheck(false));
$('db_install').addEventListener('click', () => runCheck(true));
$('db_reset').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await rpc('db::reset');
    if (r?.active) {
      renderActive(r.active);
      renderLastCheck(null);
      setStatus('Switched back to the database bundled with the extension.', 'ok');
    } else {
      setStatus('Could not switch back to the bundled database.', 'error');
    }
  } finally {
    setBusy(false);
  }
});


loadSettings();
loadDb();
