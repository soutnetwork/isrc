// ============================================================
//  Sout Network — ISRC Lookup Tool  (v2, no API keys needed)
//  Deezer (metadata + label + UPC) + iTunes + Odesli (all links)
// ============================================================

const express = require('express');
const path = require('path');

const PORT = 4090;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory cache so repeated lookups are instant
// and we stay well within Odesli's rate limits
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours for complete results
const CACHE_TTL_PARTIAL = 1000 * 60 * 20; // 20 min for incomplete (brand-new track, still indexing)

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
    const [deezerR, itunesR] = await Promise.allSettled([
      lookupDeezerTrack(isrc),
      lookupItunes(isrc)
    ]);

    const deezer = deezerR.status === 'fulfilled' ? deezerR.value : null;
    const itunes = itunesR.status === 'fulfilled' ? itunesR.value : null;

    if (!deezer && !itunes) {
      return res.status(404).json({
        error: 'No track found for this ISRC on Deezer or iTunes. It may not be delivered to these platforms yet.'
      });
    }

    // Album details from Deezer → label + UPC
    let album = null;
    if (deezer && deezer.album && deezer.album.id) {
      try { album = await lookupDeezerAlbum(deezer.album.id); } catch (e) { /* non-critical */ }
    }

    // All platform links from Odesli.
    // Apple/Spotify are the most-crawled anchors, so seed from Apple first;
    // if Spotify is still missing, try again seeded from Deezer and merge.
    let platformLinks = null;
    const appleSeed = itunes && itunes.trackViewUrl;
    const deezerSeed = deezer && deezer.link;

    if (appleSeed) {
      try { platformLinks = await lookupOdesli(appleSeed); } catch (e) { /* non-critical */ }
    }
    const gotSpotify = platformLinks && platformLinks.spotify;
    if ((!platformLinks || !gotSpotify) && deezerSeed) {
      try {
        const alt = await lookupOdesli(deezerSeed);
        if (alt) platformLinks = Object.assign({}, alt, platformLinks || {});
      } catch (e) { /* non-critical */ }
    }
    const seedUrl = appleSeed || deezerSeed;

    const pick = key => platformLinks && platformLinks[key] ? platformLinks[key].url : null;

    const core = {
      isrc,
      title: (deezer && deezer.title) || (itunes && itunes.trackName),
      artists: deezer
        ? (deezer.contributors ? deezer.contributors.map(c => c.name) : [deezer.artist.name])
        : [itunes.artistName],
      album: (deezer && deezer.album && deezer.album.title) || (itunes && itunes.collectionName) || null,
      releaseDate: (deezer && deezer.release_date) || (album && album.release_date) ||
                   (itunes && itunes.releaseDate ? itunes.releaseDate.slice(0, 10) : null),
      durationMs: deezer ? deezer.duration * 1000 : (itunes ? itunes.trackTimeMillis : null),
      explicit: deezer ? !!deezer.explicit_lyrics : null,
      label: album ? album.label : null,
      upc: album ? album.upc : null,
      bpm: deezer && deezer.bpm ? deezer.bpm : null,
      artwork: (deezer && deezer.album && deezer.album.cover_xl) ||
               (itunes && itunes.artworkUrl100 ? itunes.artworkUrl100.replace('100x100', '600x600') : null),
      preview: (deezer && deezer.preview) || (itunes && itunes.previewUrl) || null
    };

    const links = {
      spotify: pick('spotify'),
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
