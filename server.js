// ============================================================
//  Sout Network — ISRC Lookup Tool  (v4)
//  Spotify (direct ISRC + UPC search) + Deezer + iTunes + Odesli
//  Modes: single lookup, bulk ISRC, UPC -> tracks
// ============================================================

const express = require('express');
const path = require('path');

const PORT = 4090;

// ---- Spotify credentials ----
const SPOTIFY_CLIENT_ID     = 'd2d0ca4f52024ced8ab4bcb790daeaf7';
const SPOTIFY_CLIENT_SECRET = '82a29387ade845afb8f9a719f2d31eb8';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- cache ----
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24;         // 24h complete
const CACHE_TTL_PARTIAL = 1000 * 60 * 20;      // 20m incomplete

// ================= Spotify =================
let spotifyToken = null, spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry - 60000) return spotifyToken;
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`Spotify auth failed (${res.status})`);
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return spotifyToken;
}

// fetch with timeout
async function fetchT(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

// Spotify GET.
// Returns parsed JSON on 2xx (even if results are empty).
// THROWS on transient failure (429/5xx/network) after exhausting retries,
// so callers can tell "request failed" apart from "found nothing".
async function spotifyGet(url, attempt = 0) {
  const MAX = 6;
  let res;
  try {
    const token = await getSpotifyToken();
    res = await fetchT(url, { headers: { 'Authorization': `Bearer ${token}` } });
  } catch (netErr) {
    if (attempt < MAX) { await sleep(backoff(attempt)); return spotifyGet(url, attempt + 1); }
    throw new Error('Spotify network error: ' + netErr.message);
  }
  if (res.status === 429) {
    const raRaw = parseInt(res.headers.get('retry-after') || '2', 10);
    // Spotify can send a very large Retry-After during a cool-down window.
    // Never block on it — cap the wait, and give up quickly with a clear error.
    const waitMs = Math.min(isNaN(raRaw) ? 2000 : raRaw * 1000, 6000);
    if (attempt < 2) { await sleep(waitMs); return spotifyGet(url, attempt + 1); }
    const err = new Error('RATE_LIMITED');
    err.rateLimited = true;
    err.retryAfter = isNaN(raRaw) ? null : raRaw;
    throw err;
  }
  if (res.status >= 500) {
    if (attempt < MAX) { await sleep(backoff(attempt)); return spotifyGet(url, attempt + 1); }
    throw new Error('Spotify server error ' + res.status);
  }
  if (res.status === 401) { // token expired mid-flight
    spotifyToken = null;
    if (attempt < MAX) { await sleep(300); return spotifyGet(url, attempt + 1); }
    throw new Error('Spotify auth error');
  }
  if (res.status === 404) return null;           // genuine not found
  if (!res.ok) {
    // Include which endpoint failed — essential for diagnosing 401/403.
    let where = 'unknown';
    if (url.includes('/search')) where = url.includes('upc%3A') ? 'search-upc' : 'search-isrc';
    else if (url.includes('/albums/')) where = 'album';
    else if (url.includes('/tracks?')) where = 'tracks-batch';
    else if (url.includes('/tracks/')) where = 'track-single';
    let body = '';
    try { const j = await res.json(); body = (j && j.error && j.error.message) ? (' - ' + j.error.message) : ''; } catch (e) {}
    throw new Error('Spotify ' + res.status + ' on ' + where + body);
  }
  return res.json();
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function backoff(attempt){ return Math.min(8000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random()*300); }
// Resolve with `fallback` if the promise takes longer than ms (never rejects).
function withDeadline(promise, ms, fallback = null) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise(r => setTimeout(() => r(fallback), ms))
  ]);
}

function shapeSpotifyTrack(track) {
  if (!track) return null;
  return {
    url: track.external_urls && track.external_urls.spotify,
    id: track.id,
    isrc: track.external_ids && track.external_ids.isrc ? track.external_ids.isrc : null,
    title: track.name,
    artists: track.artists ? track.artists.map(a => a.name) : [],
    album: track.album ? track.album.name : null,
    releaseDate: track.album ? track.album.release_date : null,
    durationMs: track.duration_ms,
    explicit: track.explicit,
    artwork: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
    preview: track.preview_url || null
  };
}

async function lookupSpotify(isrc) {
  const data = await spotifyGet(`https://api.spotify.com/v1/search?q=${encodeURIComponent('isrc:' + isrc)}&type=track&limit=1`);
  const track = data && data.tracks && data.tracks.items && data.tracks.items[0];
  return shapeSpotifyTrack(track);
}

// UPC -> album (+ its tracks with ISRCs)
// Spotify is inconsistent about barcode padding: the same release can be stored
// as 12, 13 or 14 digits (with or without leading zeros). Try the variants
// before concluding the release isn't there.
function upcVariants(upc) {
  const bare = String(upc).replace(/\D/g, '').replace(/^0+/, '');
  const set = new Set([String(upc), bare]);
  [12, 13, 14].forEach(len => { if (bare.length <= len) set.add(bare.padStart(len, '0')); });
  return [...set].filter(Boolean);
}

async function spotifyAlbumByUpc(upc) {
  let albumLite = null;
  for (const variant of upcVariants(upc)) {
    const data = await spotifyGet(`https://api.spotify.com/v1/search?q=${encodeURIComponent('upc:' + variant)}&type=album&limit=1`);
    const hit = data && data.albums && data.albums.items && data.albums.items[0];
    if (hit) { albumLite = hit; break; }
  }
  if (!albumLite) return null;
  const album = await spotifyGet(`https://api.spotify.com/v1/albums/${albumLite.id}?market=US`);
  if (!album) return null;

  // 1) Base track list from the album (simplified items) — always available.
  //    Page through album tracks in case the album has > 50 tracks.
  let simple = (album.tracks && album.tracks.items) ? album.tracks.items.slice() : [];
  let next = album.tracks && album.tracks.next;
  while (next) {
    const page = await spotifyGet(next);
    if (page && page.items) { simple = simple.concat(page.items); next = page.next; }
    else break;
  }

  // 2) Enrich each track with ISRC via /tracks?ids= (batch). Include market.
  const idToFull = {};
  const ids = simple.map(t => t.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const tr = await spotifyGet(`https://api.spotify.com/v1/tracks?ids=${batch.join(',')}&market=US`);
    if (tr && tr.tracks) tr.tracks.filter(Boolean).forEach(f => { idToFull[f.id] = f; });
  }
  // 2b) For any track still missing an ISRC, ask the single-track endpoint directly.
  //     Errors here PROPAGATE (via Promise.all) so the whole UPC is retried rather
  //     than returning a track with a silently-missing ISRC.
  const missing = ids.filter(id => !(idToFull[id] && idToFull[id].external_ids && idToFull[id].external_ids.isrc));
  for (let i = 0; i < missing.length; i += 3) {
    const chunk = missing.slice(i, i + 3);
    await Promise.all(chunk.map(async (id) => {
      const t = await spotifyGet(`https://api.spotify.com/v1/tracks/${id}`); // throws on transient failure
      if (t) idToFull[id] = t;
    }));
  }

  // 3) Build final track list — falls back to simplified data if enrich missed
  const tracks = simple.map(s => {
    const full = idToFull[s.id];
    return {
      id: s.id,
      isrc: full && full.external_ids && full.external_ids.isrc ? full.external_ids.isrc : null,
      title: s.name,
      artists: s.artists ? s.artists.map(a => a.name) : [],
      url: (s.external_urls && s.external_urls.spotify) || (full && full.external_urls && full.external_urls.spotify) || null,
      durationMs: full ? full.duration_ms : s.duration_ms,
      trackNumber: s.track_number
    };
  });

  return {
    album: {
      title: album.name,
      artists: album.artists ? album.artists.map(a => a.name) : [],
      upc: album.external_ids && album.external_ids.upc ? album.external_ids.upc : upc,
      label: album.label || null,
      releaseDate: album.release_date || null,
      artwork: album.images && album.images[0] ? album.images[0].url : null,
      url: album.external_urls && album.external_urls.spotify,
      totalTracks: album.total_tracks
    },
    tracks
  };
}

// ================= Deezer =================
async function lookupDeezerTrack(isrc) {
  try {
    const res = await fetchT(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, {}, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data;
  } catch (e) { return null; }
}
async function lookupDeezerAlbum(albumId) {
  const res = await fetch(`https://api.deezer.com/album/${albumId}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return data;
}

// ================= iTunes / Apple =================
// Query all storefronts IN PARALLEL with a short timeout.
// (Sequential storefronts were the main cause of very slow UPC batches:
//  a track missing from Apple used to cost 4 x 7s = 28s on its own.)
async function lookupItunes(isrc) {
  const countries = ['US', 'EG', 'SA', 'GB'];
  const tasks = countries.map(async (country) => {
    const res = await fetchT(`https://itunes.apple.com/lookup?isrc=${encodeURIComponent(isrc)}&country=${country}&entity=song`, {}, 4000);
    if (!res.ok) throw new Error('bad');
    const data = await res.json();
    const song = data.results && data.results.find(r => r.wrapperType === 'track');
    if (!song) throw new Error('none');
    return song;
  });
  try {
    return await Promise.any(tasks);   // first storefront that has it wins
  } catch (e) {
    return null;                       // none of them had it
  }
}

// ================= Odesli =================
async function lookupOdesli(sourceUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(sourceUrl)}&userCountry=EG`);
      if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      if (!res.ok) return null;
      const data = await res.json();
      return data.linksByPlatform || null;
    } catch (e) { await new Promise(r => setTimeout(r, 800)); }
  }
  return null;
}

// ================= helpers =================
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const cleanIsrc = s => (s || '').trim().toUpperCase().replace(/[-\s]/g, '');
const cleanUpc  = s => (s || '').trim().replace(/[-\s]/g, '');

// Full single-ISRC resolution (all platforms via Odesli)
async function fullLookup(isrc) {
  const cached = cache.get(isrc);
  if (cached && Date.now() - cached.time < cached.ttl) return cached.payload;

  const [spotifyR, deezerR, itunesR] = await Promise.allSettled([
    lookupSpotify(isrc), lookupDeezerTrack(isrc), lookupItunes(isrc)
  ]);
  const spotify = spotifyR.status === 'fulfilled' ? spotifyR.value : null;
  const deezer  = deezerR.status === 'fulfilled' ? deezerR.value : null;
  const itunes  = itunesR.status === 'fulfilled' ? itunesR.value : null;
  if (!spotify && !deezer && !itunes) return null;

  let album = null;
  if (deezer && deezer.album && deezer.album.id) {
    try { album = await lookupDeezerAlbum(deezer.album.id); } catch (e) {}
  }

  let platformLinks = null;
  const spotifySeed = spotify && spotify.url;
  const appleSeed = itunes && itunes.trackViewUrl;
  const deezerSeed = deezer && deezer.link;
  const firstSeed = spotifySeed || appleSeed || deezerSeed;
  if (firstSeed) { try { platformLinks = await lookupOdesli(firstSeed); } catch (e) {} }
  const gotApple = platformLinks && platformLinks.appleMusic;
  const backupSeed = [appleSeed, deezerSeed].find(s => s && s !== firstSeed);
  if ((!platformLinks || !gotApple) && backupSeed) {
    try { const alt = await lookupOdesli(backupSeed); if (alt) platformLinks = Object.assign({}, alt, platformLinks || {}); } catch (e) {}
  }
  const seedUrl = spotifySeed || appleSeed || deezerSeed;
  const pick = key => platformLinks && platformLinks[key] ? platformLinks[key].url : null;

  const core = {
    isrc,
    title: (spotify && spotify.title) || (deezer && deezer.title) || (itunes && itunes.trackName),
    artists: (spotify && spotify.artists && spotify.artists.length) ? spotify.artists
      : (deezer ? (deezer.contributors ? deezer.contributors.map(c => c.name) : [deezer.artist.name]) : [itunes.artistName]),
    album: (spotify && spotify.album) || (deezer && deezer.album && deezer.album.title) || (itunes && itunes.collectionName) || null,
    releaseDate: (spotify && spotify.releaseDate) || (deezer && deezer.release_date) || (album && album.release_date) || (itunes && itunes.releaseDate ? itunes.releaseDate.slice(0,10) : null),
    durationMs: (spotify && spotify.durationMs) || (deezer ? deezer.duration * 1000 : (itunes ? itunes.trackTimeMillis : null)),
    explicit: spotify ? spotify.explicit : (deezer ? !!deezer.explicit_lyrics : null),
    label: album ? album.label : null,
    upc: album ? album.upc : null,
    bpm: deezer && deezer.bpm ? deezer.bpm : null,
    artwork: (spotify && spotify.artwork) || (deezer && deezer.album && deezer.album.cover_xl) || (itunes && itunes.artworkUrl100 ? itunes.artworkUrl100.replace('100x100','600x600') : null),
    preview: (spotify && spotify.preview) || (deezer && deezer.preview) || (itunes && itunes.previewUrl) || null
  };
  const links = {
    spotify: (spotify && spotify.url) || pick('spotify'),
    appleMusic: pick('appleMusic') || pick('itunes') || (itunes && itunes.trackViewUrl) || null,
    youtubeMusic: pick('youtubeMusic'),
    youtube: pick('youtube'),
    anghami: pick('anghami'),
    amazonMusic: pick('amazonMusic') || pick('amazonStore'),
    tidal: pick('tidal'),
    deezer: pick('deezer') || (deezer && deezer.link) || null,
    soundcloud: pick('soundcloud'),
    pandora: pick('pandora'),
    napster: pick('napster'),
    audiomack: pick('audiomack'),
    audius: pick('audius'),
    boomplay: pick('boomplay'),
    songlink: seedUrl ? `https://song.link/${encodeURIComponent(seedUrl)}` : null
  };
  const payload = { core, links };
  const complete = links.spotify && links.appleMusic;
  cache.set(isrc, { time: Date.now(), ttl: complete ? CACHE_TTL : CACHE_TTL_PARTIAL, payload });
  return payload;
}

// Fast per-track resolution for bulk (direct APIs only: Spotify + Apple + Deezer)
async function fastLookup(isrc) {
  const [spotifyR, deezerR, itunesR] = await Promise.allSettled([
    lookupSpotify(isrc), lookupDeezerTrack(isrc), lookupItunes(isrc)
  ]);
  const spotify = spotifyR.status === 'fulfilled' ? spotifyR.value : null;
  const deezer  = deezerR.status === 'fulfilled' ? deezerR.value : null;
  const itunes  = itunesR.status === 'fulfilled' ? itunesR.value : null;
  if (!spotify && !deezer && !itunes) return { isrc, found: false };
  return {
    isrc,
    found: true,
    title: (spotify && spotify.title) || (deezer && deezer.title) || (itunes && itunes.trackName),
    artists: (spotify && spotify.artists && spotify.artists.length) ? spotify.artists
      : (deezer ? (deezer.contributors ? deezer.contributors.map(c => c.name) : [deezer.artist.name]) : [itunes.artistName]),
    artwork: (spotify && spotify.artwork) || (deezer && deezer.album && deezer.album.cover_xl) || (itunes && itunes.artworkUrl100 ? itunes.artworkUrl100.replace('100x100','300x300') : null),
    links: {
      spotify: spotify && spotify.url,
      appleMusic: (itunes && itunes.trackViewUrl) || null,
      deezer: (deezer && deezer.link) || null
    }
  };
}

// map array with limited concurrency
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ================= routes =================

// Single, full (all platforms)
app.get('/api/lookup', async (req, res) => {
  const isrc = cleanIsrc(req.query.isrc);
  if (!ISRC_RE.test(isrc)) return res.status(400).json({ error: 'Invalid ISRC format. Expected 12 characters, e.g. EGA032500123' });
  try {
    const payload = await fullLookup(isrc);
    if (!payload) return res.status(404).json({ error: 'No track found for this ISRC.' });
    res.json(payload);
  } catch (err) { res.status(500).json({ error: 'Lookup failed', detail: err.message }); }
});

// Bulk ISRC (fast: Spotify + Apple + Deezer per track)
app.post('/api/bulk', async (req, res) => {
  let isrcs = Array.isArray(req.body.isrcs) ? req.body.isrcs : [];
  isrcs = [...new Set(isrcs.map(cleanIsrc).filter(x => x))].slice(0, 200);
  if (!isrcs.length) return res.status(400).json({ error: 'No valid ISRCs provided.' });
  try {
    const results = await mapLimit(isrcs, 6, async (isrc) => {
      if (!ISRC_RE.test(isrc)) return { isrc, found: false, invalid: true };
      return fastLookup(isrc);
    });
    res.json({ count: results.length, results });
  } catch (err) { res.status(500).json({ error: 'Bulk lookup failed', detail: err.message }); }
});

// Resolve a single UPC into a result row. Distinguishes:
//   found:true            -> album resolved
//   found:false           -> genuinely not on Spotify
//   found:false, error:.. -> transient failure (should be retried)
async function resolveUpcRow(upc, tries = 3, fast = false) {
  const ck = 'upc:' + upc + (fast ? ':f' : '');
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.time < hit.ttl) return hit.payload;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const found = await spotifyAlbumByUpc(upc);
      if (!found) return { upc, found: false };            // genuine not found
      const tracks = await mapLimit(found.tracks, 6, async (t) => {
        if (!t) return null;
        let appleUrl = null, deezerUrl = null;
        // Fast mode: ISRC + Spotify only (all that's needed for the database).
        // Apple/Deezer can be pulled per-track later via "+ all platforms".
        if (!fast && t.isrc) {
          const [it, dz] = await Promise.all([
            withDeadline(lookupItunes(t.isrc), 5000, null),
            withDeadline(lookupDeezerTrack(t.isrc), 5000, null)
          ]);
          appleUrl = it ? it.trackViewUrl : null;
          deezerUrl = dz ? dz.link : null;
        }
        return { isrc: t.isrc, title: t.title, artists: t.artists,
          links: { spotify: t.url, appleMusic: appleUrl, deezer: deezerUrl } };
      });
      const row = { upc, found: true, album: found.album, tracks: tracks.filter(Boolean) };
      cache.set(ck, { time: Date.now(), ttl: CACHE_TTL, payload: row });
      return row;
    } catch (e) {
      if (e && e.rateLimited) {
        return { upc, found: false, error: 'RATE_LIMITED', retryAfter: e.retryAfter || null };
      }
      if (attempt < tries - 1) { await sleep(backoff(attempt + 1)); continue; }
      console.error('[UPC FAIL]', upc, '->', e && e.message);
      return { upc, found: false, error: e.message || 'failed', detail: String(e && e.message || e) };
    }
  }
}

// UPC -> album + its tracks (each with ISRC + Spotify/Apple/Deezer)
app.post('/api/upc', async (req, res) => {
  let upcs = Array.isArray(req.body.upcs) ? req.body.upcs : [];
  // Keep every input UPC in its exact order (no dedup) so output maps 1:1 to input.
  upcs = upcs.map(cleanUpc).filter(x => x).slice(0, 150);
  const fast = req.body.fast !== false;   // default: fast (ISRC + Spotify)
  if (!upcs.length) return res.status(400).json({ error: 'No valid UPCs provided.' });
  try {
    // Pass 1
    let albums = await mapLimit(upcs, fast ? 5 : 2, (upc) => resolveUpcRow(upc, 3, fast));

    const rateLimited = albums.some(a => a && a.error === 'RATE_LIMITED');

    if (!rateLimited) {
      const retryIdx = albums.map((a, i) => (a && a.error) ? i : -1).filter(i => i >= 0);
      for (const i of retryIdx) albums[i] = await resolveUpcRow(upcs[i], 3, fast);
    }

    const errors = albums.filter(a => a && a.error).length;
    res.json({ count: albums.length, errored: errors, rateLimited, fast, albums });
  } catch (err) { res.status(500).json({ error: 'UPC lookup failed', detail: err.message }); }
});

// Quick diagnostic: is Spotify reachable / are we rate-limited right now?
app.get('/api/health', async (req, res) => {
  const out = { ok: true, spotify: 'unknown', cacheEntries: cache.size };
  try {
    const t0 = Date.now();
    const data = await spotifyGet('https://api.spotify.com/v1/search?q=' + encodeURIComponent('upc:00602547461445') + '&type=album&limit=1');
    out.spotify = data ? 'ok' : 'no-result';
    out.ms = Date.now() - t0;
  } catch (e) {
    out.ok = false;
    out.spotify = e && e.rateLimited ? 'RATE_LIMITED' : ('error: ' + (e.message||'')); 
    if (e && e.retryAfter) out.retryAfter = e.retryAfter;
  }
  res.json(out);
});

app.listen(PORT, () => console.log(`ISRC Lookup Tool running on http://localhost:${PORT}`));
