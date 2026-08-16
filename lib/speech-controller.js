export const SPEECH_STATE = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  LISTENING: 'LISTENING',
  STOPPING: 'STOPPING',
  RECOGNIZED: 'RECOGNIZED',
  NO_MATCH: 'NO_MATCH',
  ERROR: 'ERROR'
});

function messageOf(error) {
  return error && error.message ? error.message : String(error || 'unknown error');
}

export function extractRecognitionCandidates(event) {
  const resultIndex = Number.isInteger(event && event.resultIndex) ? event.resultIndex : 0;
  const result = event && event.results && event.results[resultIndex];
  if (!result) return [];
  const candidates = [];
  for (let index = 0; index < result.length; index += 1) {
    const item = result[index];
    const transcript = item && item.transcript ? String(item.transcript).trim() : '';
    if (!transcript) continue;
    candidates.push({
      transcript,
      confidence: Number.isFinite(item.confidence) ? item.confidence : null
    });
  }
  return candidates;
}

export function createSpeechController(options = {}) {
  const onView = options.onView || (() => {});
  const onTranscript = options.onTranscript || (() => {});
  const logger = options.logger || console;
  const scheduleTimeout = options.setTimeout || ((callback, delay) => setTimeout(callback, delay));
  const cancelTimeout = options.clearTimeout || ((timer) => clearTimeout(timer));
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) && options.startTimeoutMs > 0
    ? options.startTimeoutMs
    : 4000;
  const stopTimeoutMs = Number.isFinite(options.stopTimeoutMs) && options.stopTimeoutMs > 0
    ? options.stopTimeoutMs
    : 1500;
  const listeningTimeoutMs = Number.isFinite(options.listeningTimeoutMs) && options.listeningTimeoutMs > 0
    ? options.listeningTimeoutMs
    : 0;
  const maxAutomaticStartRetries = Number.isInteger(options.maxAutomaticStartRetries) &&
    options.maxAutomaticStartRetries >= 0
    ? options.maxAutomaticStartRetries
    : 1;
  let recognition = null;
  let sessionWatchdog = null;
  let state = SPEECH_STATE.UNAVAILABLE;
  let loaded = false;
  let destroyed = false;
  let endedWithError = false;
  let sessionActive = false;
  let resultHandled = false;
  let latestInterimResult = null;
  let sessionGeneration = 0;
  let recognitionNeedsRotation = false;
  let automaticStartRetries = 0;
  let view = {
    speechAvailable: false,
    ttsAvailable: false,
    recognitionState: SPEECH_STATE.UNAVAILABLE,
    lastTranscript: '',
    speechError: ''
  };

  function log(level, event, detail) {
    const writer = logger && typeof logger[level] === 'function' ? logger[level] : logger && logger.log;
    if (!writer) return;
    try {
      writer.call(logger, event, detail === undefined ? '' : JSON.stringify(detail));
    } catch (_) {}
  }

  function patchView(patch) {
    if (destroyed) return;
    view = { ...view, ...patch };
    try {
      onView(patch);
    } catch (error) {
      log('error', 'SPEECH_VIEW_UPDATE_FAILED', { message: messageOf(error) });
    }
  }

  function setState(next, patch = {}) {
    state = next;
    patchView({ recognitionState: next, ...patch });
  }

  function observeHostResult(result, event, onFailure) {
    const handleFailure = (error, asynchronous) => {
      if (typeof onFailure === 'function') {
        try {
          onFailure(error, asynchronous);
        } catch (handlerError) {
          log('error', `${event}_HANDLER_FAILED`, {
            message: messageOf(handlerError),
            ...(asynchronous ? { asynchronous: true } : {})
          });
        }
        return;
      }
      log('error', event, {
        message: messageOf(error),
        ...(asynchronous ? { asynchronous: true } : {})
      });
    };
    try {
      if (result === false) {
        handleFailure(new Error(`${event} returned false`), false);
        return false;
      }
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(
          (value) => {
            if (value === false) handleFailure(new Error(`${event} returned false`), true);
          },
          (error) => handleFailure(error, true)
        );
      }
      return true;
    } catch (error) {
      handleFailure(error, false);
      return false;
    }
  }

  function abortRecognition(target = recognition) {
    if (!target || typeof target.abort !== 'function') return false;
    try {
      const result = target.abort();
      return observeHostResult(result, 'SPEECH_ABORT_FAILED');
    } catch (error) {
      log('error', 'SPEECH_ABORT_FAILED', { message: messageOf(error) });
      return false;
    }
  }

  function clearSessionWatchdog() {
    if (sessionWatchdog === null) return false;
    try {
      cancelTimeout(sessionWatchdog);
    } catch (error) {
      log('error', 'SPEECH_WATCHDOG_CLEAR_FAILED', { message: messageOf(error) });
    }
    sessionWatchdog = null;
    return true;
  }

  function armStartWatchdog() {
    clearSessionWatchdog();
    try {
      const scheduledWatchdog = scheduleTimeout(() => {
        sessionWatchdog = null;
        if (destroyed || !sessionActive || state !== SPEECH_STATE.STARTING) return;
        const timedOutRecognition = recognition;
        sessionActive = false;
        endedWithError = true;
        log('error', 'SPEECH_START_TIMEOUT', {
          timeoutMs: startTimeoutMs,
          automaticRetry: automaticStartRetries < maxAutomaticStartRetries
        });
        abortRecognition(timedOutRecognition);
        if (automaticStartRetries < maxAutomaticStartRetries) {
          automaticStartRetries += 1;
          recognition = null;
          if (!initializeRecognition(view.ttsAvailable)) return;
          log('log', 'SPEECH_START_AUTOMATIC_RETRY', {
            attempt: automaticStartRetries,
            maximum: maxAutomaticStartRetries
          });
          start({ automaticRetry: true });
          return;
        }
        setState(SPEECH_STATE.ERROR, { speechError: 'recognition-start-timeout' });
      }, startTimeoutMs);
      if (scheduledWatchdog === null || scheduledWatchdog === undefined) {
        throw new Error('start watchdog provider returned no handle');
      }
      sessionWatchdog = scheduledWatchdog;
      return true;
    } catch (error) {
      sessionWatchdog = null;
      log('error', 'SPEECH_WATCHDOG_START_FAILED', { message: messageOf(error) });
      return false;
    }
  }

  function armStopWatchdog() {
    clearSessionWatchdog();
    try {
      const scheduledWatchdog = scheduleTimeout(() => {
        sessionWatchdog = null;
        if (destroyed || !sessionActive || state !== SPEECH_STATE.STOPPING) return;
        log('error', 'SPEECH_STOP_TIMEOUT', { timeoutMs: stopTimeoutMs });
        recoverStaleSession();
      }, stopTimeoutMs);
      if (scheduledWatchdog === null || scheduledWatchdog === undefined) {
        throw new Error('stop watchdog provider returned no handle');
      }
      sessionWatchdog = scheduledWatchdog;
      return true;
    } catch (error) {
      sessionWatchdog = null;
      log('error', 'SPEECH_WATCHDOG_START_FAILED', { message: messageOf(error), phase: 'stop' });
      return false;
    }
  }

  function armListeningWatchdog() {
    if (!listeningTimeoutMs) return true;
    clearSessionWatchdog();
    try {
      let firedSynchronously = false;
      const scheduledWatchdog = scheduleTimeout(() => {
        firedSynchronously = true;
        sessionWatchdog = null;
        if (destroyed || !sessionActive || state !== SPEECH_STATE.LISTENING) return;
        log('log', 'SPEECH_LISTENING_WINDOW_ENDED', { timeoutMs: listeningTimeoutMs });
        if (!resultHandled && latestInterimResult) {
          const { best, alternatives } = latestInterimResult;
          resultHandled = true;
          setState(SPEECH_STATE.RECOGNIZED, { lastTranscript: best.transcript, speechError: '' });
          log('log', 'SPEECH_INTERIM_RESULT_PROMOTED', {
            confidence: best.confidence,
            characters: best.transcript.length,
            alternatives: alternatives.length,
            reason: 'LISTENING_TIMEOUT'
          });
          try {
            onTranscript({ ...best, alternatives });
          } catch (error) {
            endedWithError = true;
            setState(SPEECH_STATE.ERROR, { speechError: messageOf(error) });
            log('error', 'SPEECH_ROUTE_FAILED', { message: messageOf(error) });
          }
        }
        stop();
      }, listeningTimeoutMs);
      if (firedSynchronously) return true;
      if (scheduledWatchdog === null || scheduledWatchdog === undefined) {
        throw new Error('listening watchdog provider returned no handle');
      }
      sessionWatchdog = scheduledWatchdog;
      return true;
    } catch (error) {
      sessionWatchdog = null;
      log('error', 'SPEECH_WATCHDOG_START_FAILED', {
        message: messageOf(error),
        phase: 'listening'
      });
      return false;
    }
  }

  function initializeRecognition(ttsAvailable) {
    try {
      const nextRecognition = new options.SpeechRecognition();
      nextRecognition.lang = options.lang || 'zh-CN';
      nextRecognition.continuous = false;
      nextRecognition.interimResults = false;
      nextRecognition.maxAlternatives = options.maxAlternatives || 3;
      nextRecognition.onstart = () => {
        if (destroyed || recognition !== nextRecognition || !sessionActive || state !== SPEECH_STATE.STARTING) return;
        clearSessionWatchdog();
        sessionActive = true;
        endedWithError = false;
        setState(SPEECH_STATE.LISTENING, { speechError: '' });
        log('log', 'SPEECH_LISTENING');
        if (!armListeningWatchdog()) {
          sessionActive = false;
          endedWithError = true;
          recognitionNeedsRotation = true;
          abortRecognition(nextRecognition);
          setState(SPEECH_STATE.ERROR, { speechError: 'recognition-listening-watchdog-unavailable' });
        }
      };
      nextRecognition.onresult = (event) => {
        if (destroyed || recognition !== nextRecognition || !sessionActive ||
          state === SPEECH_STATE.IDLE || state === SPEECH_STATE.ERROR) return;
        const resultIndex = Number.isInteger(event && event.resultIndex) ? event.resultIndex : 0;
        const recognitionResult = event && event.results && event.results[resultIndex];
        if (recognitionResult && recognitionResult.isFinal === false) {
          const alternatives = extractRecognitionCandidates(event);
          const best = alternatives[0];
          if (best) latestInterimResult = { best, alternatives };
          log('log', 'SPEECH_INTERIM_RESULT_CACHED', {
            resultIndex,
            characters: best ? best.transcript.length : 0,
            ...(event && event.sessionId ? { sessionId: event.sessionId } : {})
          });
          return;
        }
        clearSessionWatchdog();
        if (resultHandled) {
          log('log', 'SPEECH_DUPLICATE_RESULT_IGNORED');
          return;
        }
        const alternatives = extractRecognitionCandidates(event);
        const best = alternatives[0];
        if (!best) {
          setState(SPEECH_STATE.NO_MATCH);
          log('log', 'SPEECH_NO_MATCH');
          return;
        }
        resultHandled = true;
        latestInterimResult = null;
        setState(SPEECH_STATE.RECOGNIZED, { lastTranscript: best.transcript, speechError: '' });
        log('log', 'SPEECH_RESULT', {
          confidence: best.confidence,
          characters: best.transcript.length,
          alternatives: alternatives.length
        });
        try {
          onTranscript({ ...best, alternatives });
        } catch (error) {
          endedWithError = true;
          setState(SPEECH_STATE.ERROR, { speechError: messageOf(error) });
          log('error', 'SPEECH_ROUTE_FAILED', { message: messageOf(error) });
        }
      };
      nextRecognition.onnomatch = () => {
        if (destroyed || recognition !== nextRecognition || !sessionActive ||
          state === SPEECH_STATE.IDLE || state === SPEECH_STATE.STOPPING || state === SPEECH_STATE.ERROR) return;
        clearSessionWatchdog();
        resultHandled = true;
        setState(SPEECH_STATE.NO_MATCH);
        log('log', 'SPEECH_NO_MATCH');
      };
      nextRecognition.onerror = (event) => {
        if (destroyed || recognition !== nextRecognition || !sessionActive) return;
        clearSessionWatchdog();
        endedWithError = true;
        resultHandled = true;
        const code = event && event.error ? event.error : 'recognition-error';
        const message = event && event.message ? event.message : code;
        setState(SPEECH_STATE.ERROR, { speechError: message });
        log('error', 'SPEECH_ERROR', { code, message });
      };
      nextRecognition.onend = () => {
        if (destroyed || recognition !== nextRecognition || !sessionActive) return;
        clearSessionWatchdog();
        sessionActive = false;
        recognitionNeedsRotation = true;
        if (!endedWithError) setState(SPEECH_STATE.IDLE);
        else if (state !== SPEECH_STATE.ERROR) setState(SPEECH_STATE.ERROR);
        log('log', 'SPEECH_ENDED', { error: endedWithError });
      };
      recognition = nextRecognition;
      recognitionNeedsRotation = false;
      setState(SPEECH_STATE.IDLE, { speechAvailable: true, ttsAvailable });
      log('log', 'SPEECH_READY', { lang: recognition.lang });
      return true;
    } catch (error) {
      recognition = null;
      setState(SPEECH_STATE.UNAVAILABLE, {
        speechAvailable: false,
        ttsAvailable,
        speechError: messageOf(error)
      });
      log('error', 'SPEECH_INIT_FAILED', { message: messageOf(error) });
      return false;
    }
  }

  function recoverStaleSession() {
    const staleState = state;
    const staleRecognition = recognition;
    clearSessionWatchdog();
    sessionActive = false;
    recognition = null;
    abortRecognition(staleRecognition);
    if (!initializeRecognition(view.ttsAvailable)) return false;
    log('error', 'SPEECH_STALE_SESSION_RECOVERED', { state: staleState });
    return true;
  }

  function load() {
    if (loaded || destroyed) return false;
    loaded = true;
    const ttsAvailable = typeof options.SpeechSynthesisUtterance === 'function' &&
      options.speechSynthesis && typeof options.speechSynthesis.speak === 'function';
    if (typeof options.SpeechRecognition !== 'function') {
      setState(SPEECH_STATE.UNAVAILABLE, { speechAvailable: false, ttsAvailable });
      log('log', 'SPEECH_UNAVAILABLE');
      return true;
    }

    initializeRecognition(ttsAvailable);
    return true;
  }

  function start(startOptions = {}) {
    if (destroyed || !recognition) return false;
    if (startOptions.automaticRetry !== true) automaticStartRetries = 0;
    if (!sessionActive && state === SPEECH_STATE.IDLE && recognitionNeedsRotation) {
      recognition = null;
      if (!initializeRecognition(view.ttsAvailable)) return false;
      log('log', 'SPEECH_SESSION_ROTATED');
    }
    if (!sessionActive && state === SPEECH_STATE.ERROR && !recoverStaleSession()) return false;
    if (sessionActive) {
      const recoverable = state === SPEECH_STATE.STARTING ||
        state === SPEECH_STATE.RECOGNIZED ||
        state === SPEECH_STATE.NO_MATCH ||
        state === SPEECH_STATE.STOPPING ||
        state === SPEECH_STATE.ERROR;
      if (!recoverable || !recoverStaleSession()) return false;
    }
    endedWithError = false;
    resultHandled = false;
    latestInterimResult = null;
    sessionActive = true;
    const activeRecognition = recognition;
    const activeGeneration = ++sessionGeneration;
    setState(SPEECH_STATE.STARTING, { speechError: '', lastTranscript: '' });
    const failStart = (error, asynchronous) => {
      if (destroyed || recognition !== activeRecognition || sessionGeneration !== activeGeneration ||
        !sessionActive || (state !== SPEECH_STATE.STARTING && state !== SPEECH_STATE.LISTENING)) return;
      clearSessionWatchdog();
      sessionActive = false;
      endedWithError = true;
      setState(SPEECH_STATE.ERROR, { speechError: messageOf(error) });
      log('error', 'SPEECH_START_FAILED', {
        message: messageOf(error),
        ...(asynchronous ? { asynchronous: true } : {})
      });
      abortRecognition(activeRecognition);
    };
    try {
      const result = activeRecognition.start();
      if (!observeHostResult(result, 'SPEECH_START_FAILED', failStart)) return false;
      if (sessionActive && state === SPEECH_STATE.STARTING && !armStartWatchdog()) {
        failStart(new Error('recognition start watchdog unavailable'), false);
        return false;
      }
      return true;
    } catch (error) {
      failStart(error, false);
      return false;
    }
  }

  function stop() {
    if (destroyed || !recognition) return false;
    if (!sessionActive || state === SPEECH_STATE.STOPPING) return false;
    clearSessionWatchdog();
    setState(SPEECH_STATE.STOPPING);
    const activeRecognition = recognition;
    const activeGeneration = sessionGeneration;
    const failStop = (error, asynchronous) => {
      if (destroyed || recognition !== activeRecognition || sessionGeneration !== activeGeneration ||
        !sessionActive || state !== SPEECH_STATE.STOPPING) return;
      clearSessionWatchdog();
      sessionActive = false;
      endedWithError = true;
      recognitionNeedsRotation = true;
      abortRecognition(activeRecognition);
      setState(SPEECH_STATE.ERROR, { speechError: messageOf(error) });
      log('error', 'SPEECH_STOP_FAILED', {
        message: messageOf(error),
        ...(asynchronous ? { asynchronous: true } : {})
      });
    };
    try {
      const result = activeRecognition.stop();
      if (!observeHostResult(result, 'SPEECH_STOP_FAILED', failStop)) return false;
      if (sessionActive && state === SPEECH_STATE.STOPPING && !armStopWatchdog()) {
        failStop(new Error('recognition stop watchdog unavailable'), false);
        return false;
      }
      return true;
    } catch (error) {
      failStop(error, false);
      return false;
    }
  }

  function speak(text, mode = 'immediate') {
    const content = String(text || '').trim();
    if (destroyed || !content || typeof options.SpeechSynthesisUtterance !== 'function' ||
      !options.speechSynthesis || typeof options.speechSynthesis.speak !== 'function') return false;
    try {
      const utterance = new options.SpeechSynthesisUtterance(content);
      utterance.lang = options.lang || 'zh-CN';
      const result = options.speechSynthesis.speak(utterance, mode);
      if (!observeHostResult(result, 'TTS_FAILED')) return false;
      log('log', 'TTS_SPOKEN', { characters: content.length, mode });
      return true;
    } catch (error) {
      log('error', 'TTS_FAILED', { message: messageOf(error) });
      return false;
    }
  }

  function destroy() {
    if (destroyed) return false;
    destroyed = true;
    clearSessionWatchdog();
    sessionActive = false;
    resultHandled = false;
    latestInterimResult = null;
    recognitionNeedsRotation = false;
    abortRecognition();
    recognition = null;
    return true;
  }

  function getSnapshot() {
    return {
      view: { ...view },
      state,
      loaded,
      destroyed,
      sessionActive,
      resultHandled,
      recognitionNeedsRotation,
      automaticStartRetries,
      hasRecognition: Boolean(recognition)
    };
  }

  return { load, start, stop, speak, destroy, getSnapshot };
}
