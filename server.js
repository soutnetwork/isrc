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
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

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
  const res = await fetch(`https://itunes.apple.com/lookup?isrc=${encodeURIComponent(isrc)}&entity=song`);
  if (!res.ok) return null;
  const data = await res.json();
  const song = data.results && data.results.find(r => r.wrapperType === 'track');
  return song || null;
}

// ---- Odesli / song.link: all platform links from one URL ----
async function lookupOdesli(sourceUrl) {
  const res = await fetch(
    `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(sourceUrl)}&userCountry=EG`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.linksByPlatform || null;
}

// ---- Main API endpoint ----
app.get('/api/lookup', async (req, res) => {
  const isrc = (req.query.isrc || '').trim().toUpperCase().replace(/[-\s]/g, '');

  if (!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) {
    return res.status(400).json({ error: 'Invalid ISRC format. Expected 12 characters, e.g. EGA032500123' });
  }

  // Serve from cache if fresh
  const cached = cache.get(isrc);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
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

    // All platform links from Odesli, seeded by the best URL we have
    let platformLinks = null;
    const seedUrl = (deezer && deezer.link) || (itunes && itunes.trackViewUrl);
    if (seedUrl) {
      try { platformLinks = await lookupOdesli(seedUrl); } catch (e) { /* non-critical */ }
    }

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
      appleMusic: pick('appleMusic') || (itunes && itunes.trackViewUrl) || null,
      deezer: pick('deezer') || (deezer && deezer.link) || null,
      youtubeMusic: pick('youtubeMusic'),
      youtube: pick('youtube'),
      amazonMusic: pick('amazonMusic'),
      tidal: pick('tidal'),
      anghami: pick('anghami'),
      songlink: seedUrl ? `https://song.link/${encodeURIComponent(seedUrl)}` : null
    };

    const payload = { core, links };
    cache.set(isrc, { time: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ISRC Lookup Tool running on http://localhost:${PORT}`);
});
