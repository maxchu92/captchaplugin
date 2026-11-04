
importScripts(chrome.runtime.getURL('lib/sql-wasm.js'));
if (typeof self.initSqlJs !== 'function') {
  console.error('initSqlJs not found in sql-wasm.js — stop!');
  throw new Error('sql.js runtime not available');
}


const SQLPromise = self.initSqlJs({
  locateFile: f => chrome.runtime.getURL('lib/' + f)
});

// ---- Database updates from upstream GitHub ----
// The bundled db/captcha.sqlite can't be overwritten at runtime, so a downloaded
// copy is kept in IndexedDB and preferred over the bundled one when present.
const UPDATE_REPO    = 'CaptchaRaptor/captchaplugin';
const UPDATE_BRANCH  = 'main';
const UPDATE_PATH    = 'extension/db/captcha.sqlite';
const UPDATE_MAX_BYTES = 64 * 1024 * 1024;
const STORE_DB_NAME  = 'captcha-db';
const STORE_NAME     = 'files';
const STORE_KEY      = 'captcha.sqlite';
const CHECK_STATE_KEY = 'db_update_check';

function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STORE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error('captcha-db open failed'));
  });
}

async function storeOp(mode, fn) {
  const idb = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      const tx  = idb.transaction(STORE_NAME, mode);
      const req = fn(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror    = () => reject(tx.error || new Error('captcha-db tx failed'));
    });
  } finally {
    idb.close();
  }
}

const readStored   = ()    => storeOp('readonly',  s => s.get(STORE_KEY));
const writeStored  = (rec) => storeOp('readwrite', s => s.put(rec, STORE_KEY));
const deleteStored = ()    => storeOp('readwrite', s => s.delete(STORE_KEY));

// Git blob SHA-1 ("blob <size>\0" + bytes) — the same id GitHub reports for the file,
// so the bundled copy can be compared with upstream without any extra metadata.
async function gitBlobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const buf  = new Uint8Array(head.byteLength + bytes.byteLength);
  buf.set(head, 0);
  buf.set(bytes, head.byteLength);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Opens bytes as a database and checks it has the tables and columns queryPhash needs.
// Throws (after freeing it) if it doesn't, so a bad download never replaces a good db.
function openValidated(SQL, bytes) {
  const magic = new TextDecoder().decode(bytes.subarray(0, 16));
  if (magic !== 'SQLite format 3\0') throw new Error('not an SQLite file');
  const db = new SQL.Database(bytes);
  try {
    const n33 = db.exec('SELECT COUNT(*) FROM phash33 WHERE label IS NOT NULL AND phash IS NOT NULL AND selected IS NOT NULL')[0].values[0][0];
    const n44 = db.exec('SELECT COUNT(*) FROM phash44 WHERE label IS NOT NULL AND phash IS NOT NULL AND mask IS NOT NULL')[0].values[0][0];
    db.exec('SELECT band0, band1, band2, band3 FROM phash33 LIMIT 1; SELECT band0, band1, band2, band3 FROM phash44 LIMIT 1');
    if (!n33 && !n44) throw new Error('database has no entries');
    return { db, counts: { phash33: n33, phash44: n44 } };
  } catch (e) {
    db.close();
    throw new Error('invalid captcha database: ' + (e && e.message || e));
  }
}

async function loadBundled(SQL) {
  const bytes = new Uint8Array(await (await fetch(
    chrome.runtime.getURL('db/captcha.sqlite')
  )).arrayBuffer());
  const { db, counts } = openValidated(SQL, bytes);
  return { db, counts, source: 'bundled', sha: await gitBlobSha(bytes), size: bytes.byteLength };
}

async function loadInitial() {
  const SQL = await SQLPromise;
  try {
    const rec = await readStored();
    if (rec && rec.bytes) {
      const { db, counts } = openValidated(SQL, new Uint8Array(rec.bytes));
      return { db, counts, source: 'downloaded', sha: rec.sha, size: rec.size, commit: rec.commit, commitDate: rec.commitDate, installedAt: rec.installedAt };
    }
  } catch (e) {
    console.warn('[db] stored database unusable, using bundled copy:', e);
  }
  return loadBundled(SQL);
}

// The live database plus its metadata; queryPhash prepares its statements on it lazily.
let ActivePromise = loadInitial();

// Swap the live database and free the old one with its prepared statements.
async function activate(next) {
  const prev = await ActivePromise.catch(() => null);
  ActivePromise = Promise.resolve(next);
  if (prev && prev.db !== next.db) {
    try { prev.stmt33 && prev.stmt33.free(); } catch {}
    try { prev.stmt44 && prev.stmt44.free(); } catch {}
    try { prev.db.close(); } catch {}
  }
}

async function fetchGithubJson(url, accept) {
  const res = await fetch(url, { headers: { Accept: accept || 'application/vnd.github+json' }, cache: 'no-store' });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached, try again later');
  if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
  return res.json();
}

async function getUpstreamInfo() {
  const api = `https://api.github.com/repos/${UPDATE_REPO}`;
  const [file, commits] = await Promise.all([
    fetchGithubJson(`${api}/contents/${UPDATE_PATH}?ref=${UPDATE_BRANCH}`, 'application/vnd.github.object'),
    fetchGithubJson(`${api}/commits?path=${encodeURIComponent(UPDATE_PATH)}&sha=${UPDATE_BRANCH}&per_page=1`),
  ]);
  const commit = Array.isArray(commits) && commits[0];
  if (!file || !/^[0-9a-f]{40}$/.test(file.sha || '')) throw new Error('unexpected GitHub response');
  if (!commit || !/^[0-9a-f]{40}$/.test(commit.sha || '')) throw new Error('could not find the commit for the database');
  return {
    sha: file.sha,
    size: file.size,
    commit: commit.sha,
    commitDate: commit.commit && commit.commit.committer && commit.commit.committer.date || null,
    commitMessage: commit.commit && commit.commit.message ? commit.commit.message.split('\n')[0] : '',
  };
}

async function saveCheckState(state) {
  await chrome.storage.local.set({ [CHECK_STATE_KEY]: { ...state, ts: Date.now() } });
}

async function describeActive() {
  const a = await ActivePromise;
  return { source: a.source, sha: a.sha, size: a.size, counts: a.counts, commit: a.commit || null, commitDate: a.commitDate || null, installedAt: a.installedAt || null };
}

self.dbStatus = async function () {
  const { [CHECK_STATE_KEY]: lastCheck = null } = await chrome.storage.local.get(CHECK_STATE_KEY);
  return { active: await describeActive(), lastCheck, repo: UPDATE_REPO, branch: UPDATE_BRANCH, path: UPDATE_PATH };
};

let updateRunning = null;
self.dbCheckForUpdate = function ({ install = false } = {}) {
  if (updateRunning) return updateRunning;
  updateRunning = (async () => {
    try {
      const active   = await ActivePromise;
      const upstream = await getUpstreamInfo();
      if (upstream.sha === active.sha) {
        await saveCheckState({ result: 'up_to_date', upstream });
        return { result: 'up_to_date', upstream, active: await describeActive() };
      }
      if (!install) {
        await saveCheckState({ result: 'update_available', upstream });
        return { result: 'update_available', upstream, active: await describeActive() };
      }
      if (!(upstream.size > 0 && upstream.size <= UPDATE_MAX_BYTES)) throw new Error(`unexpected file size ${upstream.size}`);

      // Pin the download to the commit so the bytes match the sha we just looked up.
      const rawUrl = `https://raw.githubusercontent.com/${UPDATE_REPO}/${upstream.commit}/${UPDATE_PATH}`;
      const res = await fetch(rawUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const got = await gitBlobSha(bytes);
      if (got !== upstream.sha) throw new Error('downloaded file does not match GitHub checksum');

      const SQL = await SQLPromise;
      const { db, counts } = openValidated(SQL, bytes);
      const rec = { bytes: bytes.buffer, sha: got, size: bytes.byteLength, commit: upstream.commit, commitDate: upstream.commitDate, installedAt: Date.now() };
      try {
        await writeStored(rec);
      } catch (e) {
        db.close();
        throw e;
      }
      await activate({ db, counts, source: 'downloaded', sha: rec.sha, size: rec.size, commit: rec.commit, commitDate: rec.commitDate, installedAt: rec.installedAt });
      await saveCheckState({ result: 'installed', upstream });
      return { result: 'installed', upstream, active: await describeActive() };
    } catch (e) {
      const error = String(e && e.message || e);
      await saveCheckState({ result: 'error', error }).catch(() => {});
      return { result: 'error', error, active: await describeActive().catch(() => null) };
    } finally {
      updateRunning = null;
    }
  })();
  return updateRunning;
};

self.dbResetToBundled = async function () {
  await deleteStored();
  await activate(await loadBundled(await SQLPromise));
  await chrome.storage.local.remove(CHECK_STATE_KEY);
  return { active: await describeActive() };
};


function hamming64(a, b) {
  let v = BigInt.asUintN(64, a ^ b), c = 0n;
  while (v) { v &= v - 1n; c++; }
  return Number(c);
}


self.queryPhash = async function ({ imgtype, name: label, phash }) {
  const active = await ActivePromise;
  const db = active.db;


  const big = BigInt('0x' + phash);
  const b0 = Number((big >> 48n) & 0xFFFFn);
  const b1 = Number((big >> 32n) & 0xFFFFn);
  const b2 = Number((big >> 16n) & 0xFFFFn);
  const b3 = Number( big         & 0xFFFFn);

      console.log(`[queryPhash] trying to find: ${phash}, ${label}, ${imgtype}`);


  if (!active.stmt33) {
    active.stmt33 = db.prepare(`
      SELECT CAST(phash AS TEXT) AS phash, selected
      FROM   phash33
      WHERE  label = ? AND (
        (band0=? AND band1=?) OR (band0=? AND band2=?) OR (band0=? AND band3=?) OR
        (band1=? AND band2=?) OR (band1=? AND band3=?) OR (band2=? AND band3=?))
    `);
    active.stmt44 = db.prepare(`
      SELECT phash, mask
      FROM   phash44
      WHERE  label = ? AND (
        (band0=? AND band1=?) OR (band0=? AND band2=?) OR (band0=? AND band3=?) OR
        (band1=? AND band2=?) OR (band1=? AND band3=?) OR (band2=? AND band3=?))
    `);
  }

  const stmt   = imgtype === '33' ? active.stmt33 : active.stmt44;
  const params = [label, b0,b1, b0,b2, b0,b3, b1,b2, b1,b3, b2,b3];

  const candidates = [];
  stmt.bind(params);
  while (stmt.step()) candidates.push(stmt.getAsObject());
  stmt.reset();

for (const c of candidates) {
  c.hamming = hamming64(BigInt(c.phash), big);
}


console.log(`[queryPhash] found ${candidates.length} candidates :`);
for (const c of candidates) {
  console.log(`phash: ${c.phash}, selected/mask: ${c.selected ?? c.mask}, distance: ${c.hamming}`);
}


const hit = candidates.find(r => r.hamming < 10);
  if (!hit) return {};

  return imgtype === '33'
       ? { selected: !!hit.selected }
       : { selected: hit.mask.toString(16).toUpperCase().padStart(4, '0') };
};
