const DEFAULT_MAX_CHARS = 6000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 6000;
const CAPTION_FETCH_TIMEOUT_MS = 15000;
const TRANSCRIPT_CACHE_TTL_MS = 10 * 60 * 1000;

const transcriptCache = new Map();
const transcriptInflight = new Map();

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function isYoutubeUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || '')).hostname.toLowerCase();
    return host === 'youtu.be' ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com');
  } catch {
    return false;
  }
}

function youtubeVideoIdentity(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.toLowerCase();
    let videoId = '';
    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v') || '';
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      videoId = match ? match[1] : '';
    }
    if (videoId) return `video:${videoId}`;
    return `page:${host}${url.pathname}${url.search}`;
  } catch {
    return `raw:${String(rawUrl || '')}`;
  }
}

function normalizedTrackArgs(args = {}) {
  const trackIndex = Number(args.trackIndex);
  const normalizedIndex = Number.isInteger(trackIndex) && trackIndex >= 0 ? String(trackIndex) : '';
  return [
    String(args.language || '').trim().toLowerCase(),
    String(args.track || 'default').trim().toLowerCase() || 'default',
    normalizedIndex,
  ].join('|');
}

export function youtubeTranscriptCacheKey(tabId, pageUrl, args = {}) {
  return `${tabId || ''}|${youtubeVideoIdentity(pageUrl)}|${normalizedTrackArgs(args)}`;
}

export function clearYoutubeTranscriptCache() {
  transcriptCache.clear();
  transcriptInflight.clear();
}

function isAllowedCaptionHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtube-nocookie.com' ||
    h.endsWith('.youtube-nocookie.com');
}

function decodeEntities(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[lower] || match;
  });
}

function normalizeText(text) {
  return decodeEntities(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function attrValue(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, 'i');
  const match = String(attrs || '').match(re);
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function findJsonObjectAfterMarker(text, marker, fromIndex = 0) {
  const markerIndex = text.indexOf(marker, fromIndex);
  if (markerIndex < 0) return null;
  const open = text.indexOf('{', markerIndex);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: text.slice(open, i + 1), nextIndex: i + 1 };
    }
  }
  return null;
}

function looksLikePlayerResponse(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    (value.videoDetails || value.captions || value.streamingData || value.playabilityStatus)
  );
}

function compactPlayerResponse(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    videoDetails: value.videoDetails || null,
    captions: value.captions || null,
  };
}

export function extractYoutubePlayerResponseFromHtml(html) {
  const text = String(html || '');
  let from = 0;
  while (from < text.length) {
    const found = findJsonObjectAfterMarker(text, 'ytInitialPlayerResponse', from);
    if (!found) return null;
    from = found.nextIndex;
    try {
      const parsed = JSON.parse(found.json);
      if (looksLikePlayerResponse(parsed)) return compactPlayerResponse(parsed);
    } catch {
      // Keep scanning; YouTube pages can contain escaped copies too.
    }
  }
  return null;
}

function trackName(name) {
  if (!name) return '';
  if (typeof name.simpleText === 'string') return name.simpleText;
  if (Array.isArray(name.runs)) return name.runs.map(run => run?.text || '').join('');
  return '';
}

export function normalizeYoutubePlayerResponse(response, pageTitle = '') {
  const root = response?.captions?.playerCaptionsTracklistRenderer || {};
  const rawTracks = Array.isArray(root.captionTracks) ? root.captionTracks : [];
  const tracks = rawTracks
    .map((track, index) => ({
      index,
      baseUrl: typeof track.baseUrl === 'string' ? track.baseUrl : '',
      languageCode: String(track.languageCode || ''),
      name: normalizeText(trackName(track.name) || track.languageCode || `Track ${index + 1}`),
      kind: track.kind === 'asr' ? 'asr' : 'manual',
      vssId: String(track.vssId || ''),
      isTranslatable: !!track.isTranslatable,
    }))
    .filter(track => track.baseUrl);

  const details = response?.videoDetails || {};
  return {
    video: {
      id: details.videoId || '',
      title: normalizeText(details.title || pageTitle || ''),
      author: normalizeText(details.author || ''),
      lengthSeconds: details.lengthSeconds ? Number(details.lengthSeconds) : null,
    },
    tracks,
  };
}

export function extractYoutubeTranscriptDataFromHtml(html, pageTitle = '') {
  const response = extractYoutubePlayerResponseFromHtml(html);
  return normalizeYoutubePlayerResponse(response, pageTitle);
}

function languageMatches(track, language) {
  const wanted = String(language || '').trim().toLowerCase();
  if (!wanted) return true;
  const code = String(track.languageCode || '').toLowerCase();
  const vss = String(track.vssId || '').toLowerCase();
  return code === wanted || code.startsWith(`${wanted}-`) || vss === wanted || vss.includes(`.${wanted}`);
}

export function selectYoutubeCaptionTrack(tracks, opts = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) return null;

  const index = Number(opts.trackIndex);
  if (Number.isInteger(index) && index >= 0 && index < list.length) return list[index];

  const languageFiltered = opts.language
    ? list.filter(track => languageMatches(track, opts.language))
    : list.slice();
  const candidates = languageFiltered.length ? languageFiltered : list.slice();
  const preference = String(opts.track || 'default').toLowerCase();

  if (preference === 'manual') return candidates.find(track => track.kind !== 'asr') || null;
  if (preference === 'auto') return candidates.find(track => track.kind === 'asr') || null;
  if (preference === 'any') return candidates[0] || null;

  return candidates.find(track => track.kind !== 'asr' && /^en(-|$)/i.test(track.languageCode)) ||
    candidates.find(track => track.kind === 'asr' && /^en(-|$)/i.test(track.languageCode)) ||
    candidates.find(track => track.kind !== 'asr') ||
    candidates[0] ||
    null;
}

export function buildYoutubeCaptionFetchUrls(baseUrl, pageUrl) {
  const original = new URL(baseUrl, pageUrl).href;
  const parsed = new URL(original);
  if (!isAllowedCaptionHost(parsed.hostname)) {
    throw new Error(`YouTube caption URL host is not allowed: ${parsed.hostname}`);
  }

  const json3 = new URL(original);
  json3.searchParams.set('fmt', 'json3');
  return [...new Set([json3.href, original])];
}

function parseJson3CaptionPayload(payload) {
  const data = JSON.parse(payload);
  const events = Array.isArray(data.events) ? data.events : [];
  const segments = [];
  for (const event of events) {
    const text = Array.isArray(event.segs)
      ? normalizeText(event.segs.map(seg => seg?.utf8 || '').join(''))
      : '';
    if (!text) continue;
    segments.push({
      startMs: Number(event.tStartMs) || 0,
      durationMs: Number(event.dDurationMs) || 0,
      text,
    });
  }
  return segments;
}

function parseTextXmlCaptionPayload(payload) {
  const segments = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;
  while ((match = re.exec(payload))) {
    const attrs = match[1] || '';
    const body = normalizeText(String(match[2] || '').replace(/<[^>]+>/g, ' '));
    if (!body) continue;
    segments.push({
      startMs: Math.round((Number(attrValue(attrs, 'start')) || 0) * 1000),
      durationMs: Math.round((Number(attrValue(attrs, 'dur')) || 0) * 1000),
      text: body,
    });
  }
  return segments;
}

function parseSrv3CaptionPayload(payload) {
  const segments = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = re.exec(payload))) {
    const attrs = match[1] || '';
    const body = normalizeText(String(match[2] || '').replace(/<[^>]+>/g, ' '));
    if (!body) continue;
    segments.push({
      startMs: Number(attrValue(attrs, 't')) || 0,
      durationMs: Number(attrValue(attrs, 'd')) || 0,
      text: body,
    });
  }
  return segments;
}

function parseVttCaptionPayload(payload) {
  const segments = [];
  const lines = String(payload || '').split(/\r?\n/);
  const ts = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ts);
    if (!match) continue;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const millis = Number(match[4] || 0);
    const textLines = [];
    i++;
    while (i < lines.length && lines[i].trim()) {
      textLines.push(lines[i]);
      i++;
    }
    const text = normalizeText(textLines.join(' ').replace(/<[^>]+>/g, ' '));
    if (!text) continue;
    segments.push({
      startMs: (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis,
      durationMs: 0,
      text,
    });
  }
  return segments;
}

export function parseYoutubeCaptionPayload(payload, contentType = '') {
  const text = String(payload || '').trim();
  if (!text) return [];
  if (text[0] === '{' || String(contentType || '').toLowerCase().includes('json')) {
    try {
      const segments = parseJson3CaptionPayload(text);
      if (segments.length) return segments;
    } catch {
      // Fall through to XML/VTT parsing.
    }
  }
  if (/<text\b/i.test(text)) return parseTextXmlCaptionPayload(text);
  if (/<p\b/i.test(text)) return parseSrv3CaptionPayload(text);
  if (text.toUpperCase().includes('WEBVTT') || text.includes('-->')) return parseVttCaptionPayload(text);
  return [];
}

export function formatYoutubeTranscriptText(segments, opts = {}) {
  const includeTimestamps = opts.includeTimestamps !== false;
  return (Array.isArray(segments) ? segments : [])
    .map(segment => includeTimestamps ? `${formatTimestamp(segment.startMs)} ${segment.text}` : segment.text)
    .join('\n')
    .trim();
}

function clampInteger(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function collectYoutubeTranscriptSnapshot() {
  const compact = (value) => {
    if (!value || typeof value !== 'object') return null;
    return {
      videoDetails: value.videoDetails || null,
      captions: value.captions || null,
    };
  };
  const looksLikePlayerResponse = (value) => !!(
    value &&
    typeof value === 'object' &&
    (value.videoDetails || value.captions || value.streamingData || value.playabilityStatus)
  );
  const findJsonObjectAfterMarker = (text, marker, fromIndex = 0) => {
    const markerIndex = text.indexOf(marker, fromIndex);
    if (markerIndex < 0) return null;
    const open = text.indexOf('{', markerIndex);
    if (open < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return { json: text.slice(open, i + 1), nextIndex: i + 1 };
      }
    }
    return null;
  };
  const extractFromHtml = (html) => {
    const text = String(html || '');
    let from = 0;
    while (from < text.length) {
      const found = findJsonObjectAfterMarker(text, 'ytInitialPlayerResponse', from);
      if (!found) return null;
      from = found.nextIndex;
      try {
        const parsed = JSON.parse(found.json);
        if (looksLikePlayerResponse(parsed)) return compact(parsed);
      } catch {}
    }
    return null;
  };

  let playerResponse = null;
  try {
    if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
      playerResponse = compact(JSON.parse(JSON.stringify(window.ytInitialPlayerResponse)));
    }
  } catch {}
  if (!playerResponse) {
    try {
      playerResponse = extractFromHtml(document.documentElement ? document.documentElement.innerHTML : '');
    } catch {}
  }
  return {
    pageUrl: location.href,
    pageTitle: document.title || '',
    playerResponse,
  };
}

async function executeSnapshotScript(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: collectYoutubeTranscriptSnapshot,
  });
  return results?.[0]?.result || null;
}

async function fetchCaptionText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTION_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.url) {
      const finalUrl = new URL(res.url);
      if (!isAllowedCaptionHost(finalUrl.hostname)) {
        return {
          success: false,
          status: res.status,
          error: `Caption fetch redirected outside YouTube (${finalUrl.hostname}); body discarded.`,
        };
      }
    }
    return {
      success: res.status < 400,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      url: res.url || url,
      text: await res.text(),
    };
  } catch (error) {
    return { success: false, error: error?.name === 'AbortError' ? 'Caption fetch timed out.' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCaptionSegments(track, pageUrl) {
  const attempts = [];
  const urls = buildYoutubeCaptionFetchUrls(track.baseUrl, pageUrl);
  for (const url of urls) {
    const result = await fetchCaptionText(url);
    attempts.push({
      status: result.status || null,
      ok: !!result.success,
      contentType: result.contentType || '',
      error: result.error || null,
    });
    if (!result.success || !result.text) continue;
    const segments = parseYoutubeCaptionPayload(result.text, result.contentType);
    if (segments.length) {
      return {
        success: true,
        segments,
        status: result.status,
        contentType: result.contentType,
      };
    }
  }
  return {
    success: false,
    error: attempts.some(a => a.ok)
      ? 'Caption track was fetched but no transcript segments could be parsed.'
      : (attempts.find(a => a.error)?.error || 'Caption track could not be fetched.'),
    attempts,
  };
}

function publicTrack(track) {
  return {
    index: track.index,
    languageCode: track.languageCode,
    name: track.name,
    kind: track.kind,
    isTranslatable: track.isTranslatable,
  };
}

function publicTrackList(tracks) {
  return tracks.map(({ index, languageCode, name, kind, isTranslatable }) => ({ index, languageCode, name, kind, isTranslatable }));
}

function buildTranscriptResult(entry, args = {}, cached = false) {
  const fullText = formatYoutubeTranscriptText(entry.segments, { includeTimestamps: args.includeTimestamps !== false });
  const offset = clampInteger(args.offset, 0, 0, Math.max(0, fullText.length));
  const maxChars = clampInteger(args.maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS);
  const text = fullText.slice(offset, offset + maxChars);
  const nextOffset = offset + text.length;

  return {
    success: true,
    source: 'youtube_captionTracks.baseUrl',
    cached,
    pageUrl: entry.pageUrl,
    video: entry.video,
    track: entry.track,
    availableTracks: entry.availableTracks,
    text,
    offset,
    maxChars,
    nextOffset: nextOffset < fullText.length ? nextOffset : null,
    hasMore: nextOffset < fullText.length,
    originalLength: fullText.length,
    segmentCount: entry.segments.length,
    note: nextOffset < fullText.length
      ? 'Transcript chunk returned. Call read_youtube_transcript again with offset=nextOffset to read the next chunk before summarizing the whole video.'
      : 'Transcript read from YouTube captionTracks mechanically; summarize from this transcript instead of inferring from the title or comments.',
  };
}

async function loadYoutubeTranscriptEntry(tabId, args, tab, pageUrl) {
  let snapshot = null;
  try {
    snapshot = await executeSnapshotScript(tabId);
  } catch (error) {
    return { success: false, error: `read_youtube_transcript: could not inspect the YouTube page (${error.message}).` };
  }

  const data = normalizeYoutubePlayerResponse(snapshot?.playerResponse, snapshot?.pageTitle || tab?.title || '');
  if (!data.tracks.length) {
    return {
      success: false,
      pageUrl,
      video: data.video,
      error: 'No YouTube captionTracks were exposed on this page. The video may have captions disabled or YouTube has not loaded the player response yet.',
    };
  }

  const selected = selectYoutubeCaptionTrack(data.tracks, args);
  if (!selected) {
    return {
      success: false,
      pageUrl,
      video: data.video,
      availableTracks: publicTrackList(data.tracks),
      error: `No caption track matched language=${args.language || '(any)'} track=${args.track || 'default'}.`,
    };
  }

  let fetched;
  try {
    fetched = await fetchCaptionSegments(selected, pageUrl);
  } catch (error) {
    return { success: false, pageUrl, video: data.video, error: `Caption fetch failed: ${error.message}` };
  }
  if (!fetched.success) {
    return {
      success: false,
      pageUrl,
      video: data.video,
      track: publicTrack(selected),
      error: fetched.error,
      attempts: fetched.attempts,
    };
  }

  return {
    success: true,
    pageUrl,
    video: data.video,
    track: publicTrack(selected),
    availableTracks: publicTrackList(data.tracks),
    segments: fetched.segments,
    fetchedAt: Date.now(),
  };
}

async function getYoutubeTranscriptEntry(tabId, args = {}) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return { success: false, error: `read_youtube_transcript: could not read active tab (${error.message}).` };
  }
  const pageUrl = tab?.url || '';
  if (!isYoutubeUrl(pageUrl)) {
    return { success: false, error: 'read_youtube_transcript is only available on YouTube watch/shorts pages.' };
  }

  const key = youtubeTranscriptCacheKey(tabId, pageUrl, args);
  const cached = transcriptCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TRANSCRIPT_CACHE_TTL_MS) {
    return { ...cached, cacheHit: true };
  }

  const existing = transcriptInflight.get(key);
  if (existing) {
    const entry = await existing;
    return entry.success ? { ...entry, cacheHit: true } : entry;
  }

  const promise = loadYoutubeTranscriptEntry(tabId, args, tab, pageUrl)
    .then(entry => {
      if (entry.success) transcriptCache.set(key, entry);
      return entry;
    })
    .finally(() => transcriptInflight.delete(key));
  transcriptInflight.set(key, promise);
  return await promise;
}

export async function prewarmYoutubeTranscript(tabId, args = {}) {
  const entry = await getYoutubeTranscriptEntry(tabId, args || {});
  if (!entry.success) return { ...entry, prefetched: false };
  return {
    success: true,
    prefetched: true,
    cached: !!entry.cacheHit,
    pageUrl: entry.pageUrl,
    video: entry.video,
    track: entry.track,
    availableTracks: entry.availableTracks,
    segmentCount: entry.segments.length,
  };
}

export async function readYoutubeTranscript(tabId, args = {}) {
  const entry = await getYoutubeTranscriptEntry(tabId, args || {});
  if (!entry.success) return entry;
  return buildTranscriptResult(entry, args || {}, !!entry.cacheHit);
}
