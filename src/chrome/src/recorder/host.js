/**
 * Service-worker-side recorder orchestration.
 *
 * Two callers share this:
 *   • background.js's runtime.onMessage routes — for the sidepanel's
 *     button-driven flow.
 *   • agent.js's executor — for the prompt-driven `record_tab` /
 *     `stop_recording` tools the agent can call.
 *
 * Without this shared module, the two paths would either duplicate the
 * orchestration or have to round-trip messages through each other. Both
 * are ugly.
 *
 * Exports
 *   • getRecordingState()        — current state snapshot (read-only)
 *   • startTabRecording(tabId, options) — gets tabCapture streamId,
 *     boots the offscreen recorder, persists state, broadcasts a
 *     `recording_update` event:'started' to sidepanels.
 *   • stopTabRecording()         — halts the offscreen recorder, saves
 *     the .webm to Downloads, broadcasts event:'stopped', kicks off
 *     transcription if it was requested.
 *
 * Transcription provider lookup is done lazily via setProviderManager()
 * so we can wire it from background.js without a circular import.
 */

import { ensureOffscreen } from '../offscreen/ensure.js';
import { transcribeAudio } from '../agent/transcribe.js';

let recordingState = { active: false };
const RECORDING_STATE_KEY = 'recordingState';
let recordingStateReady = null;

let providerManagerRef = null;

export function setProviderManager(pm) {
  providerManagerRef = pm;
}

export function getRecordingState() {
  return recordingState;
}

async function loadRecordingState() {
  try {
    const stored = await chrome.storage.session.get(RECORDING_STATE_KEY);
    if (stored[RECORDING_STATE_KEY]) recordingState = stored[RECORDING_STATE_KEY];
  } catch { /* session storage unavailable */ }
}
recordingStateReady = loadRecordingState();

async function ensureRecordingStateLoaded() {
  try { await recordingStateReady; } catch {}
}

function saveRecordingState() {
  chrome.storage.session?.set({ [RECORDING_STATE_KEY]: recordingState }).catch(() => {});
}

export async function getRecordingStateFresh() {
  await ensureRecordingStateLoaded();
  return recordingState;
}

function broadcast(event, payload = {}) {
  try {
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      action: 'recording_update',
      event,
      ...payload,
    }).catch(() => {});
  } catch {}
}

/**
 * Start recording the given tab.
 *
 * @param {number} tabId
 * @param {object} options
 *   • video       (default true)
 *   • mic         (default true)
 *   • transcribeAfter (default false)
 *   • mimeType    (optional override for MediaRecorder)
 * @returns {Promise<{ok:true, state}|{ok:false, error}>}
 */
export async function startTabRecording(tabId, options = {}) {
  await ensureRecordingStateLoaded();
  if (recordingState.active) {
    return {
      ok: false,
      error: `A recording is already in progress on tab ${recordingState.tabId}.`,
    };
  }
  if (!tabId) return { ok: false, error: 'No tab ID supplied.' };

  // tabCapture.getMediaStreamId requires the target tab to be active in
  // its window. Activate first if needed.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && !tab.active) await chrome.tabs.update(tabId, { active: true });
  } catch { /* let the next step's error speak for it */ }

  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tabId },
        (id) => {
          const err = chrome.runtime.lastError;
          if (err || !id) reject(new Error(err?.message || 'getMediaStreamId returned no id'));
          else resolve(id);
        }
      );
    });
  } catch (e) {
    return { ok: false, error: `tabCapture failed: ${e.message}` };
  }

  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `offscreen setup failed: ${e.message}` };
  }

  let recResult;
  try {
    recResult = await chrome.runtime.sendMessage({
      type: 'recorder-start',
      streamId,
      tabId,
      options: {
        video: options.video !== false,
        mic: options.mic !== false,
        mimeType: options.mimeType || null,
      },
    });
  } catch (e) {
    return { ok: false, error: `recorder-start dispatch failed: ${e.message}` };
  }
  if (!recResult?.ok) {
    return { ok: false, error: recResult?.error || 'recorder failed to start' };
  }

  recordingState = {
    active: true,
    tabId,
    startedAt: Date.now(),
    mimeType: recResult.mimeType,
    hasVideo: recResult.hasVideo,
    hasMic: recResult.hasMic,
    micError: recResult.micError || null,
    transcribeAfter: !!options.transcribeAfter,
  };
  saveRecordingState();
  broadcast('started', { state: recordingState });

  return { ok: true, state: recordingState };
}

/**
 * Stop the active recording, save the .webm, optionally transcribe.
 *
 * @returns {Promise<{ok:true, filename, downloadId, ...}|{ok:false, error}>}
 */
export async function stopTabRecording() {
  await ensureRecordingStateLoaded();
  if (!recordingState.active) {
    // Nothing active. Still broadcast 'stopped' so any sidepanel showing a
    // stale banner clears it, and report success — the user's goal (no active
    // recording) is already met.
    broadcast('stopped', { result: { ok: false, error: 'No active recording.' } });
    return { ok: true, alreadyStopped: true };
  }
  let res = null;
  let stopError = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'recorder-stop' });
  } catch (e) {
    stopError = `recorder-stop dispatch failed: ${e.message}`;
  }

  // If the offscreen recorder is gone or refused to stop, the recording is no
  // longer recoverable (e.g. the service worker was suspended for hours and the
  // offscreen session was evicted, but recordingState.active stuck around in
  // session storage). Force the state clear and tell the panel — otherwise the
  // banner can tick forever with no way to dismiss it.
  if (stopError || !res?.ok) {
    const error = stopError || res?.error || 'recorder failed to stop';
    recordingState = { active: false };
    saveRecordingState();
    broadcast('stopped', { result: { ok: false, error } });
    return { ok: true, cleared: true, warning: error };
  }

  // Save webm to Downloads. The data URL is safe — recorder.js strips
  // the codecs param before passing it to FileReader.readAsDataURL, so
  // chrome.downloads.download's URL parser doesn't get tripped up.
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/T/, '_')
    .slice(0, 19);
  const filename = `webbrain-recording-${stamp}.webm`;
  let downloadId = null;
  let saveError = null;
  try {
    downloadId = await chrome.downloads.download({
      url: res.dataUrl,
      filename,
      saveAs: false,
    });
  } catch (e) {
    saveError = `download failed: ${e.message}`;
  }

  const wantTranscribe = recordingState.transcribeAfter && !saveError;
  const final = {
    ok: !saveError,
    filename: saveError ? null : filename,
    downloadId,
    error: saveError || undefined,
    sizeBytes: res.sizeBytes,
    durationMs: res.durationMs,
    mimeType: res.mimeType,
    transcribeAfter: wantTranscribe,
  };

  // Always clear the recording state once the recorder has stopped, even if the
  // download failed — the capture is over and the banner must not linger.
  recordingState = { active: false };
  saveRecordingState();
  broadcast('stopped', { result: final });

  if (wantTranscribe) {
    runTranscription({
      dataUrl: res.dataUrl,
      mimeType: res.mimeType,
      baseFilename: filename.replace(/\.webm$/, ''),
    }).catch((e) => {
      console.error('[WebBrain] runTranscription crashed:', e);
    });
  }

  return final;
}

async function runTranscription({ dataUrl, mimeType, baseFilename }) {
  broadcast('transcribing');

  let blob;
  try {
    const r = await fetch(dataUrl);
    blob = await r.blob();
  } catch (e) {
    return broadcastTranscribed({ ok: false, error: `Couldn't read recording bytes: ${e.message}` });
  }

  if (!providerManagerRef) {
    return broadcastTranscribed({
      ok: false,
      error: 'No provider manager wired — internal error. Transcription unavailable until background.js calls setProviderManager().',
    });
  }

  const ext = mimeType?.startsWith('audio/') ? 'webm' : 'webm';
  const result = await transcribeAudio(providerManagerRef.providers, blob, {
    filename: `${baseFilename}.${ext}`,
  });

  if (!result.ok) {
    return broadcastTranscribed({ ok: false, error: result.error });
  }

  const txtFilename = `${baseFilename}.txt`;
  const txtDataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(result.text);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url: txtDataUrl,
      filename: txtFilename,
      saveAs: false,
    });
  } catch (e) {
    return broadcastTranscribed({
      ok: false,
      error: `Transcript text generated but download failed: ${e.message}`,
      text: result.text,
      providerId: result.providerId,
      model: result.model,
    });
  }

  return broadcastTranscribed({
    ok: true,
    text: result.text,
    transcriptDownloadId: downloadId,
    transcriptFilename: txtFilename,
    providerId: result.providerId,
    model: result.model,
    latencyMs: result.latencyMs,
  });
}

function broadcastTranscribed(result) {
  broadcast('transcribed', { result });
  return result;
}
