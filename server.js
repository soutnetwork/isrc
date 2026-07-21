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

async function spotifyGet(url) {
  const token = await getSpotifyToken();
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
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
async function spotifyAlbumByUpc(upc) {
  const data = await spotifyGet(`https://api.spotify.com/v1/search?q=${encodeURIComponent('upc:' + upc)}&type=album&limit=1`);
  const albumLite = data && data.albums && data.albums.items && data.albums.items[0];
  if (!albumLite) return null;
  const album = await spotifyGet(`https://api.spotify.com/v1/albums/${albumLite.id}`);
  if (!album) return null;

  // Collect track ids (album endpoint returns first page; handle up to 50)
  const trackIds = (album.tracks && album.tracks.items ? album.tracks.items : []).map(t => t.id).filter(Boolean);
  let fullTracks = [];
  for (let i = 0; i < trackIds.length; i += 50) {
    const batch = trackIds.slice(i, i + 50);
    const tr = await spotifyGet(`https://api.spotify.com/v1/tracks?ids=${batch.join(',')}`);
    if (tr && tr.tracks) fullTracks = fullTracks.concat(tr.tracks.filter(Boolean));
  }
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
    tracks: fullTracks.map(shapeSpotifyTrack)
  };
}

// ================= Deezer =================
async function lookupDeezerTrack(isrc) {
  const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return data;
}
async function lookupDeezerAlbum(albumId) {
  const res = await fetch(`https://api.deezer.com/album/${albumId}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return data;
}

// ================= iTunes / Apple =================
async function lookupItunes(isrc) {
  const countries = ['US', 'EG', 'SA', 'GB'];
  for (const country of countries) {
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?isrc=${encodeURIComponent(isrc)}&country=${country}&entity=song`);
      if (!res.ok) continue;
      const data = await res.json();
      const song = data.results && data.results.find(r => r.wrapperType === 'track');
      if (song) return song;
    } catch (e) {}
  }
  return null;
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

// UPC -> album + its tracks (each with ISRC + Spotify/Apple/Deezer)
app.post('/api/upc', async (req, res) => {
  let upcs = Array.isArray(req.body.upcs) ? req.body.upcs : [];
  upcs = [...new Set(upcs.map(cleanUpc).filter(x => x))].slice(0, 50);
  if (!upcs.length) return res.status(400).json({ error: 'No valid UPCs provided.' });
  try {
    const albums = await mapLimit(upcs, 3, async (upc) => {
      const found = await spotifyAlbumByUpc(upc);
      if (!found) return { upc, found: false };
      // enrich each track with Apple + Deezer (direct, in parallel, limited)
      const tracks = await mapLimit(found.tracks, 6, async (t) => {
        if (!t) return null;
        let appleUrl = null, deezerUrl = null;
        if (t.isrc) {
          const [it, dz] = await Promise.allSettled([lookupItunes(t.isrc), lookupDeezerTrack(t.isrc)]);
          appleUrl = it.status === 'fulfilled' && it.value ? it.value.trackViewUrl : null;
          deezerUrl = dz.status === 'fulfilled' && dz.value ? dz.value.link : null;
        }
        return {
          isrc: t.isrc, title: t.title, artists: t.artists,
          links: { spotify: t.url, appleMusic: appleUrl, deezer: deezerUrl }
        };
      });
      return { upc, found: true, album: found.album, tracks: tracks.filter(Boolean) };
    });
    res.json({ count: albums.length, albums });
  } catch (err) { res.status(500).json({ error: 'UPC lookup failed', detail: err.message }); }
});

app.listen(PORT, () => console.log(`ISRC Lookup Tool running on http://localhost:${PORT}`));
