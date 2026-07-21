// ============================================================
//  Sout Network — ISRC Lookup Tool  (v3)
//  Spotify (direct ISRC search) + Deezer + iTunes + Odesli
// ============================================================

const express = require('express');
const path = require('path');

const PORT = 4090;

// ---- Spotify credentials ----
const SPOTIFY_CLIENT_ID     = 'd2d0ca4f52024ced8ab4bcb790daeaf7';
const SPOTIFY_CLIENT_SECRET = '82a29387ade845afb8f9a719f2d31eb8';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory cache so repeated lookups are instant
// and we stay well within Odesli's rate limits
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours for complete results
const CACHE_TTL_PARTIAL = 1000 * 60 * 20; // 20 min for incomplete (brand-new track, still indexing)

// ---- Spotify: token (client-credentials) with ~55 min cache ----
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry - 60000) return spotifyToken;
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`Spotify auth failed (${res.status})`);
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return spotifyToken;
}

// ---- Spotify: search a track directly by ISRC (reliable, incl. Arabic) ----
async function lookupSpotify(isrc) {
  const token = await getSpotifyToken();
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent('isrc:' + isrc)}&type=track&limit=1`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const track = data.tracks && data.tracks.items && data.tracks.items[0];
  if (!track) return null;
  return {
    url: track.external_urls && track.external_urls.spotify,
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

// ---- Deezer: track by ISRC (no auth needed) ----
async function lookupDeezerTrack(isrc) {
  const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return data;
}

// ---- Deezer: album details (gives us label + UPC) ----
async function lookupDeezerAlbum(albumId) {
  const res = await fetch(`https://api.deezer.com/album/${albumId}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return data;
}

// ---- iTunes / Apple Music: lookup by ISRC (no auth needed) ----
async function lookupItunes(isrc) {
  // Try several storefronts — a brand-new track may be indexed in one before another
  const countries = ['US', 'EG', 'SA', 'GB'];
  for (const country of countries) {
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?isrc=${encodeURIComponent(isrc)}&country=${country}&entity=song`);
      if (!res.ok) continue;
      const data = await res.json();
      const song = data.results && data.results.find(r => r.wrapperType === 'track');
      if (song) return song;
    } catch (e) { /* try next storefront */ }
  }
  return null;
}

// ---- Odesli / song.link: all platform links from a seed URL ----
// Retries on rate-limit (429) since Odesli allows only ~10 requests/minute
async function lookupOdesli(sourceUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(sourceUrl)}&userCountry=EG`
      );
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      return data.linksByPlatform || null;
    } catch (e) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
  return null;
}

// ---- Main API endpoint ----
app.get('/api/lookup', async (req, res) => {
  const isrc = (req.query.isrc || '').trim().toUpperCase().replace(/[-\s]/g, '');

  if (!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) {
    return res.status(400).json({ error: 'Invalid ISRC format. Expected 12 characters, e.g. EGA032500123' });
  }

  // Serve from cache if fresh (partial results expire sooner)
  const cached = cache.get(isrc);
  if (cached && Date.now() - cached.time < cached.ttl) {
    return res.json(cached.payload);
  }

  try {
    const [spotifyR, deezerR, itunesR] = await Promise.allSettled([
      lookupSpotify(isrc),
      lookupDeezerTrack(isrc),
      lookupItunes(isrc)
    ]);

    const spotify = spotifyR.status === 'fulfilled' ? spotifyR.value : null;
    const deezer = deezerR.status === 'fulfilled' ? deezerR.value : null;
    const itunes = itunesR.status === 'fulfilled' ? itunesR.value : null;

    if (!spotify && !deezer && !itunes) {
      return res.status(404).json({
        error: 'No track found for this ISRC on Spotify, Deezer or iTunes. It may not be delivered yet.'
      });
    }

    // Album details from Deezer → label + UPC
    let album = null;
    if (deezer && deezer.album && deezer.album.id) {
      try { album = await lookupDeezerAlbum(deezer.album.id); } catch (e) { /* non-critical */ }
    }

    // All platform links from Odesli.
    // The real Spotify URL is the strongest anchor Odesli has, so seed from it
    // first; fall back to Apple, then Deezer, merging whatever resolves.
    let platformLinks = null;
    const spotifySeed = spotify && spotify.url;
    const appleSeed = itunes && itunes.trackViewUrl;
    const deezerSeed = deezer && deezer.link;

    const firstSeed = spotifySeed || appleSeed || deezerSeed;
    if (firstSeed) {
      try { platformLinks = await lookupOdesli(firstSeed); } catch (e) { /* non-critical */ }
    }
    // If Apple still missing and we have another seed, try it and merge
    const gotApple = platformLinks && platformLinks.appleMusic;
    const backupSeed = [appleSeed, deezerSeed].find(s => s && s !== firstSeed);
    if ((!platformLinks || !gotApple) && backupSeed) {
      try {
        const alt = await lookupOdesli(backupSeed);
        if (alt) platformLinks = Object.assign({}, alt, platformLinks || {});
      } catch (e) { /* non-critical */ }
    }
    const seedUrl = spotifySeed || appleSeed || deezerSeed;

    const pick = key => platformLinks && platformLinks[key] ? platformLinks[key].url : null;

    const core = {
      isrc,
      title: (spotify && spotify.title) || (deezer && deezer.title) || (itunes && itunes.trackName),
      artists: (spotify && spotify.artists && spotify.artists.length) ? spotify.artists
        : (deezer
            ? (deezer.contributors ? deezer.contributors.map(c => c.name) : [deezer.artist.name])
            : [itunes.artistName]),
      album: (spotify && spotify.album) || (deezer && deezer.album && deezer.album.title) || (itunes && itunes.collectionName) || null,
      releaseDate: (spotify && spotify.releaseDate) || (deezer && deezer.release_date) || (album && album.release_date) ||
                   (itunes && itunes.releaseDate ? itunes.releaseDate.slice(0, 10) : null),
      durationMs: (spotify && spotify.durationMs) || (deezer ? deezer.duration * 1000 : (itunes ? itunes.trackTimeMillis : null)),
      explicit: spotify ? spotify.explicit : (deezer ? !!deezer.explicit_lyrics : null),
      label: album ? album.label : null,
      upc: album ? album.upc : null,
      bpm: deezer && deezer.bpm ? deezer.bpm : null,
      artwork: (spotify && spotify.artwork) ||
               (deezer && deezer.album && deezer.album.cover_xl) ||
               (itunes && itunes.artworkUrl100 ? itunes.artworkUrl100.replace('100x100', '600x600') : null),
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
    // If the big platforms resolved, cache long; if not, it's likely still
    // indexing, so cache briefly and re-check on the next lookup.
    const complete = links.spotify && links.appleMusic;
    cache.set(isrc, { time: Date.now(), ttl: complete ? CACHE_TTL : CACHE_TTL_PARTIAL, payload });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ISRC Lookup Tool running on http://localhost:${PORT}`);
});
