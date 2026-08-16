import {
  calibrateMusic,
  createMusicEngine,
  flushMusic,
  harmonyAtGrid,
  MUSIC_AUDIO_CONFIG,
  MUSIC_INSTRUMENTS,
  MUSIC_PLAYABLE_MIDI,
  pauseMusic,
  proposeMotion,
  setMusicInstrument,
  startMusic,
  stopMusic
} from './music-core.js';
import { ATTENTION_INTENT, routeTranscript } from './intent-router.js';
import { createSpeechController } from './speech-controller.js';

export const PLAYABLE_MIDI = MUSIC_PLAYABLE_MIDI;

export const INITIAL_MUSIC_VIEW = Object.freeze({
  status: 'CALIBRATING',
  sensorMode: 'SIMULATOR',
  audioMode: 'INITIALIZING',
  chord: 'C',
  note: '—',
  zone: '—',
  hint: '单击开始，然后轻摇头部',
  petState: 'sleep',
  pulse: false,
  instrumentId: 'PIANO',
  instrumentLabel: '钢琴',
  cadenceLabel: '最多 4 音/秒',
  activeKey: '—',
  speechAvailable: false,
  ttsAvailable: false,
  recognitionState: 'UNAVAILABLE',
  lastTranscript: '',
  speechError: ''
});

function isQuaternion(value) {
  if (!value || value.length !== 4) return false;
  const items = Array.from(value);
  return items.every(Number.isFinite) && Math.hypot(...items) > 1e-6;
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

export function createMusicPageController(options = {}) {
  const now = options.now || (() => Date.now());
  const scheduleInterval = options.setInterval || ((callback, delay) => setInterval(callback, delay));
  const cancelInterval = options.clearInterval || ((timer) => clearInterval(timer));
  const scheduleTimeout = options.setTimeout || ((callback, delay) => setTimeout(callback, delay));
  const cancelTimeout = options.clearTimeout || ((timer) => clearTimeout(timer));
  const sensorFirstFrameTimeoutMs = Number.isFinite(options.sensorFirstFrameTimeoutMs) &&
    options.sensorFirstFrameTimeoutMs > 0
    ? options.sensorFirstFrameTimeoutMs
    : 1000;
  const sensorStallTimeoutMs = Number.isFinite(options.sensorStallTimeoutMs) &&
    options.sensorStallTimeoutMs > 0
    ? options.sensorStallTimeoutMs
    : 1500;
  const sensorRecoveryDelayMs = Number.isFinite(options.sensorRecoveryDelayMs) &&
    options.sensorRecoveryDelayMs > 0
    ? options.sensorRecoveryDelayMs
    : 1000;
  const sensorRecoveryMaxAttempts = Number.isInteger(options.sensorRecoveryMaxAttempts) &&
    options.sensorRecoveryMaxAttempts >= 0
    ? options.sensorRecoveryMaxAttempts
    : 2;
  const backgroundReadyTimeoutMs = Number.isFinite(options.backgroundReadyTimeoutMs) &&
    options.backgroundReadyTimeoutMs > 0
    ? options.backgroundReadyTimeoutMs
    : 4000;
  const backgroundInterruptionMaxRetries = Number.isInteger(options.backgroundInterruptionMaxRetries) &&
    options.backgroundInterruptionMaxRetries >= 0
    ? options.backgroundInterruptionMaxRetries
    : 2;
  const onView = options.onView || (() => {});
  const onExit = options.onExit || (() => false);
  const logger = options.logger || console;
  // The Rokid Android decoder reports canplay for the Opus-in-OGG variant but can
  // create a silent AudioTrack on device. PCM WAV is larger but deterministic.
  const backgroundSrc = options.backgroundSrc || '../../assets/audio/background-c-g-am-f.wav';
  const backgroundDurationMs = Number.isFinite(options.backgroundDurationMs) && options.backgroundDurationMs > 0
    ? options.backgroundDurationMs
    : 10000;
  const noteSrc = options.noteSrc || ((midi, instrumentId = 'PIANO') => {
    const instrument = MUSIC_INSTRUMENTS[instrumentId] || MUSIC_INSTRUMENTS.PIANO;
    return `../../assets/audio/${instrument.assetPrefix}-${midi}.wav`;
  });

  let engine = createMusicEngine(options.engineOptions);
  let view = { ...INITIAL_MUSIC_VIEW };
  let background = null;
  let backgroundReady = false;
  let backgroundPlaying = false;
  let backgroundWantsPlayback = false;
  let backgroundPlayGeneration = 0;
  let backgroundInterruptionRetries = 0;
  let backgroundReadyWatchdog = null;
  let backgroundReadyWatchdogGeneration = 0;
  let noteSounds = {};
  let audioSetupStarted = false;
  let orientationSensor = null;
  let gyroscope = null;
  let flushTimer = null;
  let sensorFrameWatchdog = null;
  let sensorFrameWatchdogGeneration = 0;
  let sensorLivenessWatchdog = null;
  let sensorLivenessWatchdogGeneration = 0;
  let sensorRecoveryWatchdog = null;
  let sensorRecoveryWatchdogGeneration = 0;
  let sensorRecoveryAttempts = 0;
  let pageActive = true;
  let startRequested = false;
  let sensorLastFrameAt = null;
  let latestQuaternion = [0, 0, 0, 1];
  let angularSpeed = 1;
  let hasSensorReading = false;
  let sensorsStarted = false;
  let orientationStartGeneration = 0;
  let gyroscopeStartGeneration = 0;
  let sensorClockOffsetMs = null;
  let lastRawSensorTimestamp = null;
  let lastSensorReceivedAt = null;
  let sensorDiagnostics = {
    validReadings: 0,
    firstAt: null,
    lastAt: null,
    previousAt: null,
    intervals: [],
    timestampSource: 'RECEIPT',
    clockRebases: 0
  };
  let loaded = false;
  let destroyed = false;

  function log(level, event, detail) {
    const writer = logger && typeof logger[level] === 'function' ? logger[level] : logger && logger.log;
    if (!writer) return;
    try {
      writer.call(logger, event, detail === undefined ? '' : JSON.stringify(detail));
    } catch (_) {
      // Logging must never interrupt the interaction loop.
    }
  }

  function patchView(patch) {
    if (destroyed) return;
    view = { ...view, ...patch };
    try {
      onView(patch);
    } catch (error) {
      log('error', 'MUSIC_VIEW_UPDATE_FAILED', { message: errorMessage(error) });
    }
  }

  function safeCall(target, method, event, onFailure, args = []) {
    if (!target || typeof target[method] !== 'function') return false;
    const handleFailure = (error, asynchronous) => {
      log('error', event, { message: errorMessage(error), ...(asynchronous ? { asynchronous: true } : {}) });
      if (typeof onFailure === 'function') {
        try {
          onFailure(error);
        } catch (handlerError) {
          log('error', `${event}_HANDLER_FAILED`, { message: errorMessage(handlerError) });
        }
      }
    };
    try {
      const result = target[method](...args);
      if (result === false) {
        handleFailure(new Error(`${method} returned false`), false);
        return false;
      }
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(
          (value) => {
            if (value === false) handleFailure(new Error(`${method} returned false`), true);
          },
          (error) => {
            handleFailure(error, true);
          }
        );
      }
      return true;
    } catch (error) {
      handleFailure(error, false);
      return false;
    }
  }

  function availableAudioMode(hasUsableBackground = Boolean(background)) {
    const loadedNotes = Object.keys(noteSounds).length;
    if (hasUsableBackground && loadedNotes === PLAYABLE_MIDI.length) return 'FULL';
    if (hasUsableBackground && loadedNotes) return 'PARTIAL';
    if (hasUsableBackground) return 'BACKGROUND_ONLY';
    return loadedNotes ? 'NOTES_ONLY' : 'UNAVAILABLE';
  }

  function seekBackground(positionSeconds) {
    if (!background) return false;
    if (typeof background.seek === 'function') {
      return safeCall(background, 'seek', 'BACKGROUND_SEEK_FAILED', undefined, [positionSeconds]);
    }
    try {
      background.currentTime = positionSeconds;
      return true;
    } catch (error) {
      log('error', 'BACKGROUND_SEEK_FAILED', { message: errorMessage(error), legacyFallback: true });
      return false;
    }
  }

  function getSensorStats() {
    const sorted = [...sensorDiagnostics.intervals].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const medianIntervalMs = sorted.length === 0
      ? null
      : sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    return {
      validReadings: sensorDiagnostics.validReadings,
      firstAt: sensorDiagnostics.firstAt,
      lastAt: sensorDiagnostics.lastAt,
      medianIntervalMs,
      effectiveHz: medianIntervalMs === null ? null : Number((1000 / medianIntervalMs).toFixed(2)),
      timestampSource: sensorDiagnostics.timestampSource,
      clockRebases: sensorDiagnostics.clockRebases
    };
  }

  function resetSensorClock() {
    sensorClockOffsetMs = null;
    lastRawSensorTimestamp = null;
    lastSensorReceivedAt = null;
  }

  function normalizeSensorTimestamp(sensor, receivedAt) {
    const rawTimestamp = Number(sensor && sensor.timestamp);
    if (!Number.isFinite(rawTimestamp)) {
      sensorDiagnostics.timestampSource = 'RECEIPT';
      return receivedAt;
    }

    const priorRawTimestamp = lastRawSensorTimestamp;
    const priorReceivedAt = lastSensorReceivedAt;
    const clockRegressed = priorRawTimestamp !== null && rawTimestamp < priorRawTimestamp;
    const clockDiverged = priorRawTimestamp !== null && priorReceivedAt !== null &&
      Math.abs((rawTimestamp - priorRawTimestamp) - (receivedAt - priorReceivedAt)) > 5000;
    if (sensorClockOffsetMs === null || clockRegressed || clockDiverged) {
      if (sensorClockOffsetMs !== null) {
        sensorDiagnostics.clockRebases += 1;
        log('log', 'IMU_CLOCK_REBASED', {
          previousRawTimestamp: priorRawTimestamp,
          rawTimestamp,
          receivedAt,
          reason: clockRegressed ? 'REGRESSION' : 'DIVERGENCE'
        });
      }
      sensorClockOffsetMs = receivedAt - rawTimestamp;
    }
    lastRawSensorTimestamp = rawTimestamp;
    lastSensorReceivedAt = receivedAt;
    sensorDiagnostics.timestampSource = 'SENSOR';
    return rawTimestamp + sensorClockOffsetMs;
  }

  function recordSensorReading(receivedAt) {
    if (!Number.isFinite(receivedAt)) return;
    if (sensorDiagnostics.firstAt === null) sensorDiagnostics.firstAt = receivedAt;
    if (sensorDiagnostics.previousAt !== null && receivedAt > sensorDiagnostics.previousAt) {
      sensorDiagnostics.intervals.push(receivedAt - sensorDiagnostics.previousAt);
      if (sensorDiagnostics.intervals.length > 120) sensorDiagnostics.intervals.shift();
    }
    sensorDiagnostics.previousAt = receivedAt;
    sensorDiagnostics.lastAt = receivedAt;
    sensorDiagnostics.validReadings += 1;
    if (sensorDiagnostics.validReadings === 1) {
      log('log', 'IMU_FIRST_FRAME', { receivedAt });
    } else if (sensorDiagnostics.validReadings % 60 === 0) {
      log('log', 'IMU_RATE', getSensorStats());
    }
  }

  function stopTimer() {
    if (flushTimer !== null) {
      try {
        cancelInterval(flushTimer);
      } catch (error) {
        log('error', 'MUSIC_TIMER_STOP_FAILED', { message: errorMessage(error) });
      }
    }
    flushTimer = null;
  }

  function clearSensorFrameWatchdog() {
    const activeWatchdog = sensorFrameWatchdog;
    sensorFrameWatchdog = null;
    sensorFrameWatchdogGeneration += 1;
    if (activeWatchdog === null) return false;
    try {
      cancelTimeout(activeWatchdog);
    } catch (error) {
      log('error', 'IMU_FIRST_FRAME_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
    }
    return true;
  }

  function clearSensorLivenessWatchdog() {
    const activeWatchdog = sensorLivenessWatchdog;
    sensorLivenessWatchdog = null;
    sensorLivenessWatchdogGeneration += 1;
    if (activeWatchdog === null) return false;
    try {
      cancelTimeout(activeWatchdog);
    } catch (error) {
      log('error', 'IMU_LIVENESS_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
    }
    return true;
  }

  function clearSensorRecoveryWatchdog(resetAttempts = false) {
    const activeWatchdog = sensorRecoveryWatchdog;
    sensorRecoveryWatchdog = null;
    sensorRecoveryWatchdogGeneration += 1;
    if (resetAttempts) sensorRecoveryAttempts = 0;
    if (activeWatchdog === null) return false;
    try {
      cancelTimeout(activeWatchdog);
    } catch (error) {
      log('error', 'IMU_RECOVERY_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
    }
    return true;
  }

  function scheduleSensorLivenessWatchdog(
    activeOrientation,
    activeOrientationGeneration,
    watchdogGeneration,
    delayMs
  ) {
    let scheduling = true;
    let firedSynchronously = false;
    try {
      const callback = () => {
        if (scheduling) {
          firedSynchronously = true;
          return;
        }
        if (destroyed || watchdogGeneration !== sensorLivenessWatchdogGeneration ||
          orientationSensor !== activeOrientation ||
          orientationStartGeneration !== activeOrientationGeneration ||
          !sensorsStarted || !hasSensorReading || sensorLastFrameAt === null) return;
        sensorLivenessWatchdog = null;
        const silentForMs = Math.max(0, now() - sensorLastFrameAt);
        if (silentForMs >= sensorStallTimeoutMs) {
          log('error', 'IMU_STREAM_STALLED', { timeoutMs: sensorStallTimeoutMs, silentForMs });
          degradeSensors(
            'IMU_STREAM_STALLED',
            new Error('orientation sensor stopped producing valid frames'),
            true,
            true
          );
          return;
        }
        scheduleSensorLivenessWatchdog(
          activeOrientation,
          activeOrientationGeneration,
          watchdogGeneration,
          Math.max(1, sensorStallTimeoutMs - silentForMs)
        );
      };
      const scheduledWatchdog = scheduleTimeout(callback, delayMs);
      scheduling = false;
      if (scheduledWatchdog === null || scheduledWatchdog === undefined || firedSynchronously) {
        throw new Error('sensor liveness watchdog provider returned no usable handle');
      }
      if (destroyed || watchdogGeneration !== sensorLivenessWatchdogGeneration ||
        orientationSensor !== activeOrientation ||
        orientationStartGeneration !== activeOrientationGeneration ||
        !sensorsStarted || !hasSensorReading) {
        try {
          cancelTimeout(scheduledWatchdog);
        } catch (error) {
          log('error', 'IMU_LIVENESS_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
        }
        return false;
      }
      sensorLivenessWatchdog = scheduledWatchdog;
      return true;
    } catch (error) {
      scheduling = false;
      if (destroyed || watchdogGeneration !== sensorLivenessWatchdogGeneration ||
        orientationSensor !== activeOrientation ||
        orientationStartGeneration !== activeOrientationGeneration) return false;
      log('error', 'IMU_LIVENESS_WATCHDOG_FAILED', { message: errorMessage(error) });
      degradeSensors('IMU_LIVENESS_WATCHDOG_FAILED', error, true);
      return false;
    }
  }

  function armSensorLivenessWatchdog(activeOrientation, activeOrientationGeneration) {
    clearSensorLivenessWatchdog();
    const watchdogGeneration = ++sensorLivenessWatchdogGeneration;
    return scheduleSensorLivenessWatchdog(
      activeOrientation,
      activeOrientationGeneration,
      watchdogGeneration,
      sensorStallTimeoutMs
    );
  }

  function armSensorFrameWatchdog(phase, activeOrientation, activeOrientationGeneration) {
    clearSensorFrameWatchdog();
    const watchdogGeneration = ++sensorFrameWatchdogGeneration;
    let firedSynchronously = false;
    try {
      const callback = () => {
        firedSynchronously = true;
        if (destroyed || watchdogGeneration !== sensorFrameWatchdogGeneration ||
          orientationSensor !== activeOrientation ||
          orientationStartGeneration !== activeOrientationGeneration ||
          !sensorsStarted || hasSensorReading) return;
        sensorFrameWatchdog = null;
        log('error', 'IMU_FIRST_FRAME_TIMEOUT', { phase, timeoutMs: sensorFirstFrameTimeoutMs });
        degradeSensors(
          'IMU_FIRST_FRAME_TIMEOUT',
          new Error(`orientation sensor emitted no valid frame during ${phase}`),
          true,
          true
        );
      };
      const scheduledWatchdog = scheduleTimeout(callback, sensorFirstFrameTimeoutMs);
      if (scheduledWatchdog === null || scheduledWatchdog === undefined) {
        throw new Error('sensor first-frame watchdog provider returned no handle');
      }
      if (firedSynchronously || destroyed || watchdogGeneration !== sensorFrameWatchdogGeneration ||
        orientationSensor !== activeOrientation ||
        orientationStartGeneration !== activeOrientationGeneration ||
        !sensorsStarted || hasSensorReading) {
        try {
          cancelTimeout(scheduledWatchdog);
        } catch (error) {
          log('error', 'IMU_FIRST_FRAME_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
        }
        return false;
      }
      sensorFrameWatchdog = scheduledWatchdog;
      return true;
    } catch (error) {
      if (destroyed || orientationSensor !== activeOrientation ||
        orientationStartGeneration !== activeOrientationGeneration) return false;
      log('error', 'IMU_FIRST_FRAME_WATCHDOG_FAILED', {
        phase,
        message: errorMessage(error)
      });
      degradeSensors('IMU_FIRST_FRAME_WATCHDOG_FAILED', error, true);
      return false;
    }
  }

  function clearBackgroundReadyWatchdog() {
    const activeWatchdog = backgroundReadyWatchdog;
    backgroundReadyWatchdog = null;
    backgroundReadyWatchdogGeneration += 1;
    if (activeWatchdog === null) return false;
    try {
      cancelTimeout(activeWatchdog);
    } catch (error) {
      log('error', 'BACKGROUND_READY_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
    }
    return true;
  }

  function degradeBackground(event, error, activeBackground = background, alreadyLogged = false) {
    if (destroyed || !activeBackground || background !== activeBackground) return false;
    clearBackgroundReadyWatchdog();
    backgroundPlayGeneration += 1;
    background = null;
    backgroundReady = false;
    backgroundPlaying = false;
    backgroundWantsPlayback = false;
    safeCall(activeBackground, 'destroy', 'BACKGROUND_DESTROY_FAILED');
    const reason = event === 'BACKGROUND_READY_TIMEOUT' || event === 'BACKGROUND_READY_WATCHDOG_FAILED'
      ? '加载超时'
      : '不可用';
    patchView({
      audioMode: availableAudioMode(false),
      hint: Object.keys(noteSounds).length
        ? `背景音乐${reason}，音符仍可演奏`
        : `背景音乐${reason}，请退出后重试`
    });
    if (!alreadyLogged) log('error', event, { message: errorMessage(error) });
    return true;
  }

  function armBackgroundReadyWatchdog(activeBackground) {
    clearBackgroundReadyWatchdog();
    const watchdogGeneration = ++backgroundReadyWatchdogGeneration;
    let firedSynchronously = false;
    try {
      const callback = () => {
        firedSynchronously = true;
        if (destroyed || watchdogGeneration !== backgroundReadyWatchdogGeneration ||
          background !== activeBackground || backgroundReady) return;
        backgroundReadyWatchdog = null;
        log('error', 'BACKGROUND_READY_TIMEOUT', { timeoutMs: backgroundReadyTimeoutMs });
        degradeBackground(
          'BACKGROUND_READY_TIMEOUT',
          new Error('background decoder emitted no canplay event'),
          activeBackground,
          true
        );
      };
      const scheduledWatchdog = scheduleTimeout(callback, backgroundReadyTimeoutMs);
      if (scheduledWatchdog === null || scheduledWatchdog === undefined) {
        throw new Error('background readiness watchdog provider returned no handle');
      }
      if (firedSynchronously || destroyed || watchdogGeneration !== backgroundReadyWatchdogGeneration ||
        background !== activeBackground || backgroundReady) {
        try {
          cancelTimeout(scheduledWatchdog);
        } catch (error) {
          log('error', 'BACKGROUND_READY_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
        }
        return false;
      }
      backgroundReadyWatchdog = scheduledWatchdog;
      return true;
    } catch (error) {
      if (destroyed || background !== activeBackground || backgroundReady) return false;
      log('error', 'BACKGROUND_READY_WATCHDOG_FAILED', { message: errorMessage(error) });
      degradeBackground('BACKGROUND_READY_WATCHDOG_FAILED', error, activeBackground, true);
      return false;
    }
  }

  function playBackground() {
    if (!background) {
      backgroundWantsPlayback = false;
      return false;
    }
    backgroundWantsPlayback = true;
    if (!backgroundReady || backgroundPlaying) return backgroundPlaying;
    const elapsedMs = Math.max(0, now() - engine.startedAt);
    seekBackground((elapsedMs % backgroundDurationMs) / 1000);
    const playGeneration = ++backgroundPlayGeneration;
    const played = safeCall(background, 'play', 'BACKGROUND_PLAY_FAILED', () => {
      if (destroyed || playGeneration !== backgroundPlayGeneration) return;
      backgroundPlaying = false;
      backgroundWantsPlayback = false;
      patchView({
        audioMode: availableAudioMode(false),
        hint: Object.keys(noteSounds).length ? '背景音乐不可用，音符仍可演奏' : '音频不可用，请退出后重试'
      });
    });
    log('log', 'BACKGROUND_PLAY_REQUEST', {
      accepted: played,
      ready: backgroundReady,
      wantsPlayback: backgroundWantsPlayback,
      status: engine.status
    });
    if (played && playGeneration === backgroundPlayGeneration && backgroundWantsPlayback &&
      engine.status === 'PLAYING') backgroundPlaying = true;
    return played;
  }

  function pausePlayback() {
    backgroundPlayGeneration += 1;
    backgroundInterruptionRetries = 0;
    backgroundWantsPlayback = false;
    backgroundPlaying = false;
    safeCall(background, 'pause', 'BACKGROUND_PAUSE_FAILED');
    Object.values(noteSounds).forEach((sound) => safeCall(sound, 'stop', 'NOTE_STOP_FAILED'));
  }

  function releaseNoteSounds() {
    Object.values(noteSounds).forEach((sound) => {
      safeCall(sound, 'stop', 'NOTE_STOP_FAILED');
      safeCall(sound, 'destroy', 'NOTE_DESTROY_FAILED');
    });
    noteSounds = {};
  }

  function loadNoteSounds() {
    if (typeof options.Sound !== 'function') return 0;
    let loadedNotes = 0;
    PLAYABLE_MIDI.forEach((midi) => {
      try {
        const sound = new options.Sound(noteSrc(midi, engine.instrumentId));
        sound.volume = MUSIC_AUDIO_CONFIG.noteVolume;
        noteSounds[midi] = sound;
        loadedNotes += 1;
      } catch (error) {
        log('error', 'NOTE_INIT_FAILED', {
          instrumentId: engine.instrumentId,
          midi,
          message: errorMessage(error)
        });
      }
    });
    return loadedNotes;
  }

  function reloadNoteSounds() {
    releaseNoteSounds();
    const loadedNotes = loadNoteSounds();
    const audioMode = availableAudioMode(backgroundReady);
    patchView({ audioMode });
    log('log', 'NOTE_BANK_READY', { instrumentId: engine.instrumentId, loadedNotes, audioMode });
    return loadedNotes;
  }

  function setupAudio() {
    if (audioSetupStarted || destroyed) return false;
    audioSetupStarted = true;
    let backgroundInitialized = false;
    let loadedNotes = 0;

    if (typeof options.AudioPlayer === 'function') {
      try {
        background = new options.AudioPlayer();
        const activeBackground = background;
        activeBackground.autoplay = false;
        activeBackground.loop = true;
        activeBackground.volume = MUSIC_AUDIO_CONFIG.backgroundVolume;
        if (typeof activeBackground.onCanplay === 'function') {
          activeBackground.onCanplay(() => {
            if (destroyed || background !== activeBackground || backgroundReady) return;
            clearBackgroundReadyWatchdog();
            backgroundReady = true;
            const audioMode = availableAudioMode(true);
            patchView({ audioMode });
            log('log', 'BACKGROUND_READY', { audioMode, loadedNotes: Object.keys(noteSounds).length });
            if (engine.status === 'PLAYING' && backgroundWantsPlayback) playBackground();
          });
        } else {
          backgroundReady = true;
        }
        if (typeof activeBackground.onPlay === 'function') {
          activeBackground.onPlay(() => {
            if (destroyed) return;
            if (!backgroundWantsPlayback || engine.status !== 'PLAYING') {
              backgroundPlaying = false;
              safeCall(activeBackground, 'pause', 'BACKGROUND_LATE_PLAY_PAUSE_FAILED');
              log('log', 'BACKGROUND_LATE_PLAY_SUPPRESSED');
              return;
            }
            backgroundPlaying = true;
            patchView({ audioMode: availableAudioMode(true) });
            log('log', 'BACKGROUND_PLAYING');
          });
        }
        const recoverBackgroundInterruption = (event) => {
          if (destroyed) return;
          backgroundPlaying = false;
          if (backgroundWantsPlayback && engine.status === 'PLAYING') {
            if (backgroundInterruptionRetries >= backgroundInterruptionMaxRetries) {
              backgroundPlayGeneration += 1;
              backgroundWantsPlayback = false;
              log('error', 'BACKGROUND_INTERRUPTION_RECOVERY_EXHAUSTED', {
                event,
                attempts: backgroundInterruptionRetries,
                maxAttempts: backgroundInterruptionMaxRetries
              });
              patchView({
                audioMode: availableAudioMode(false),
                hint: Object.keys(noteSounds).length
                  ? '背景音乐反复中断，音符仍可演奏'
                  : '音频反复中断，请退出后重试'
              });
              return;
            }
            backgroundInterruptionRetries += 1;
            log('log', event);
            try {
              playBackground();
            } finally {
              backgroundInterruptionRetries = Math.max(0, backgroundInterruptionRetries - 1);
            }
          }
        };
        if (typeof activeBackground.onPause === 'function') {
          activeBackground.onPause(() => recoverBackgroundInterruption('BACKGROUND_UNEXPECTED_PAUSE'));
        }
        if (typeof activeBackground.onStop === 'function') {
          activeBackground.onStop(() => recoverBackgroundInterruption('BACKGROUND_UNEXPECTED_STOP'));
        }
        if (typeof activeBackground.onEnded === 'function') {
          activeBackground.onEnded(() => recoverBackgroundInterruption('BACKGROUND_UNEXPECTED_END'));
        }
        if (typeof activeBackground.onError === 'function') {
          activeBackground.onError((error) => {
            degradeBackground('BACKGROUND_AUDIO_ERROR', error, activeBackground);
          });
        }
        // Local assets may become ready synchronously while src is assigned. Register every
        // lifecycle callback first so a cached decoder cannot lose canplay or error.
        activeBackground.src = backgroundSrc;
        if (background === activeBackground && !backgroundReady && typeof activeBackground.onCanplay === 'function') {
          armBackgroundReadyWatchdog(activeBackground);
        }
        backgroundInitialized = background === activeBackground;
      } catch (error) {
        const failedBackground = background;
        background = null;
        backgroundReady = false;
        backgroundPlaying = false;
        backgroundWantsPlayback = false;
        if (failedBackground) safeCall(failedBackground, 'destroy', 'BACKGROUND_DESTROY_FAILED');
        log('error', 'BACKGROUND_INIT_FAILED', { message: errorMessage(error) });
      }
    }

    loadedNotes = loadNoteSounds();

    const audioMode = backgroundInitialized && !backgroundReady
      ? 'INITIALIZING'
      : availableAudioMode(backgroundInitialized && backgroundReady);
    patchView({ audioMode });
    log('log', 'AUDIO_READY', { audioMode, loadedNotes, backgroundReady });
    return true;
  }

  function ensureAudioSetup() {
    return setupAudio();
  }

  function attemptSensorRecovery(trigger) {
    if (destroyed || !loaded || !pageActive || sensorsStarted || orientationSensor ||
      typeof options.AbsoluteOrientationSensor !== 'function') return false;
    if (sensorRecoveryAttempts >= sensorRecoveryMaxAttempts) {
      log('error', 'IMU_RECOVERY_EXHAUSTED', {
        trigger,
        attempts: sensorRecoveryAttempts,
        maxAttempts: sensorRecoveryMaxAttempts
      });
      return false;
    }
    clearSensorRecoveryWatchdog(false);
    sensorRecoveryAttempts += 1;
    log('log', 'IMU_RECOVERY_ATTEMPT', {
      trigger,
      attempt: sensorRecoveryAttempts,
      maxAttempts: sensorRecoveryMaxAttempts
    });
    return setupSensors({ recoveryAttempt: true });
  }

  function scheduleSensorRecovery(trigger) {
    if (destroyed || !loaded || !pageActive || sensorRecoveryMaxAttempts === 0 ||
      sensorRecoveryAttempts >= sensorRecoveryMaxAttempts ||
      typeof options.AbsoluteOrientationSensor !== 'function') {
      if (sensorRecoveryAttempts >= sensorRecoveryMaxAttempts && sensorRecoveryMaxAttempts > 0) {
        log('error', 'IMU_RECOVERY_EXHAUSTED', {
          trigger,
          attempts: sensorRecoveryAttempts,
          maxAttempts: sensorRecoveryMaxAttempts
        });
      }
      return false;
    }
    clearSensorRecoveryWatchdog(false);
    const watchdogGeneration = ++sensorRecoveryWatchdogGeneration;
    let scheduling = true;
    let firedSynchronously = false;
    try {
      const callback = () => {
        if (scheduling) {
          firedSynchronously = true;
          return;
        }
        if (destroyed || !pageActive || watchdogGeneration !== sensorRecoveryWatchdogGeneration ||
          sensorsStarted || orientationSensor) return;
        sensorRecoveryWatchdog = null;
        attemptSensorRecovery(trigger);
      };
      const scheduledWatchdog = scheduleTimeout(callback, sensorRecoveryDelayMs);
      scheduling = false;
      if (scheduledWatchdog === null || scheduledWatchdog === undefined || firedSynchronously) {
        throw new Error('sensor recovery watchdog provider returned no usable handle');
      }
      if (destroyed || !pageActive || watchdogGeneration !== sensorRecoveryWatchdogGeneration ||
        sensorsStarted || orientationSensor) {
        try {
          cancelTimeout(scheduledWatchdog);
        } catch (error) {
          log('error', 'IMU_RECOVERY_WATCHDOG_CLEAR_FAILED', { message: errorMessage(error) });
        }
        return false;
      }
      sensorRecoveryWatchdog = scheduledWatchdog;
      log('log', 'IMU_RECOVERY_SCHEDULED', {
        trigger,
        delayMs: sensorRecoveryDelayMs,
        nextAttempt: sensorRecoveryAttempts + 1,
        maxAttempts: sensorRecoveryMaxAttempts
      });
      return true;
    } catch (error) {
      scheduling = false;
      if (destroyed || watchdogGeneration !== sensorRecoveryWatchdogGeneration) return false;
      log('error', 'IMU_RECOVERY_WATCHDOG_FAILED', { message: errorMessage(error) });
      return false;
    }
  }

  function degradeSensors(event, error, alreadyLogged = false, recoverable = false) {
    if (destroyed) return;
    clearSensorFrameWatchdog();
    clearSensorLivenessWatchdog();
    orientationStartGeneration += 1;
    gyroscopeStartGeneration += 1;
    sensorsStarted = false;
    safeCall(orientationSensor, 'stop', 'ORIENTATION_STOP_FAILED');
    safeCall(gyroscope, 'stop', 'GYROSCOPE_STOP_FAILED');
    orientationSensor = null;
    gyroscope = null;
    hasSensorReading = false;
    sensorLastFrameAt = null;
    sensorDiagnostics.previousAt = null;
    resetSensorClock();
    const recoveryScheduled = recoverable && scheduleSensorRecovery(event);
    ensureAudioSetup();
    patchView({
      sensorMode: 'SIMULATOR',
      hint: recoveryScheduled
        ? 'IMU 暂时中断，模拟方格仍可演奏，正在重连'
        : 'IMU 不可用，使用下方 3×4 模拟摇头'
    });
    if (startRequested) {
      startRequested = false;
      startFromUserAction();
    }
    if (!alreadyLogged) log('error', event, { message: errorMessage(error) });
  }

  function handleSensorReading(timestampMs) {
    if (destroyed || engine.status !== 'PLAYING') return;
    const result = proposeMotion(engine, {
      timestampMs,
      quaternion: latestQuaternion,
      angularSpeed
    });
    engine = result.engine;
    if (result.accepted) {
      patchView({ zone: String(result.candidate.zone + 1), petState: 'anticipate' });
    }
  }

  function setupSensors({ recoveryAttempt = false } = {}) {
    if (typeof options.AbsoluteOrientationSensor !== 'function') {
      patchView({ sensorMode: 'SIMULATOR', hint: '使用下方 3×4 模拟摇头' });
      return false;
    }

    try {
      if (!recoveryAttempt) clearSensorRecoveryWatchdog(true);
      orientationSensor = new options.AbsoluteOrientationSensor({ frequency: 60 });
      const eventOrientation = orientationSensor;
      orientationSensor.addEventListener('activate', () => {
        if (destroyed || !sensorsStarted || orientationSensor !== eventOrientation) return;
        log('log', 'ORIENTATION_SENSOR_ACTIVATED', {
          activated: eventOrientation.activated === true
        });
      });
      orientationSensor.addEventListener('reading', () => {
        if (destroyed || !sensorsStarted || orientationSensor !== eventOrientation ||
          !isQuaternion(eventOrientation.quaternion)) return;
        const receivedAt = now();
        const sensorTimestamp = normalizeSensorTimestamp(eventOrientation, receivedAt);
        latestQuaternion = Array.from(eventOrientation.quaternion);
        const firstValidFrame = !hasSensorReading;
        if (firstValidFrame) clearSensorFrameWatchdog();
        hasSensorReading = true;
        sensorLastFrameAt = receivedAt;
        recordSensorReading(sensorTimestamp);
        if (firstValidFrame) ensureAudioSetup();
        if (firstValidFrame &&
          !armSensorLivenessWatchdog(eventOrientation, orientationStartGeneration)) {
          return;
        }
        if (firstValidFrame && recoveryAttempt) {
          const recoveredAttempt = sensorRecoveryAttempts;
          clearSensorRecoveryWatchdog(true);
          latestQuaternion = Array.from(eventOrientation.quaternion);
          if (engine.calibration) engine = { ...engine, calibration: [...latestQuaternion], armed: true };
          log('log', 'IMU_RECOVERED', { receivedAt, attempt: recoveredAttempt, recalibrated: true });
        }
        if (view.sensorMode !== 'IMU_ACTIVE') {
          patchView({
            sensorMode: 'IMU_ACTIVE',
            hint: recoveryAttempt
              ? engine.status === 'PLAYING'
                ? 'IMU 已恢复，可继续摇头演奏'
                : 'IMU 已恢复 · 单击开始演奏'
              : '动作已连接 · 单击开始演奏'
          });
        }
        if (firstValidFrame && startRequested) {
          startRequested = false;
          log('log', 'MUSIC_DEFERRED_START_READY', { receivedAt });
          startFromUserAction();
        }
        handleSensorReading(sensorTimestamp);
      });
      orientationSensor.addEventListener('error', (event) => {
        if (destroyed || !sensorsStarted) return;
        degradeSensors(
          'ORIENTATION_SENSOR_ERROR',
          event && (event.error || event.message || event),
          false,
          true
        );
      });

      if (typeof options.Gyroscope === 'function') {
        try {
          gyroscope = new options.Gyroscope({ frequency: 60 });
          gyroscope.addEventListener('reading', () => {
            if (destroyed || !sensorsStarted || !gyroscope) return;
            const values = [gyroscope.x, gyroscope.y, gyroscope.z].map((value) => Number(value) || 0);
            angularSpeed = Math.hypot(values[0], values[1], values[2]);
          });
          gyroscope.addEventListener('error', (event) => {
            if (destroyed || !sensorsStarted) return;
            gyroscopeStartGeneration += 1;
            safeCall(gyroscope, 'stop', 'GYROSCOPE_STOP_FAILED');
            gyroscope = null;
            log('error', 'GYROSCOPE_SENSOR_ERROR', {
              message: errorMessage(event && (event.error || event.message || event))
            });
          });
        } catch (error) {
          gyroscope = null;
          log('error', 'GYROSCOPE_INIT_FAILED', { message: errorMessage(error) });
        }
      }

      const activeOrientation = orientationSensor;
      const activeOrientationGeneration = ++orientationStartGeneration;
      sensorsStarted = true;
      const orientationStarted = safeCall(activeOrientation, 'start', 'ORIENTATION_START_FAILED', (error) => {
        if (destroyed || orientationSensor !== activeOrientation ||
          orientationStartGeneration !== activeOrientationGeneration) return;
        degradeSensors('ORIENTATION_START_FAILED', error, true, recoveryAttempt);
      });
      if (!orientationStarted || orientationSensor !== activeOrientation) return false;
      if (gyroscope) {
        const activeGyroscope = gyroscope;
        const activeGyroscopeGeneration = ++gyroscopeStartGeneration;
        safeCall(activeGyroscope, 'start', 'GYROSCOPE_START_FAILED', () => {
          if (destroyed || gyroscope !== activeGyroscope ||
            gyroscopeStartGeneration !== activeGyroscopeGeneration) return;
          gyroscopeStartGeneration += 1;
          safeCall(activeGyroscope, 'stop', 'GYROSCOPE_STOP_FAILED');
          gyroscope = null;
        });
      }
      patchView({
        sensorMode: hasSensorReading ? 'IMU_ACTIVE' : recoveryAttempt ? 'SIMULATOR' : 'IMU_WAITING',
        hint: hasSensorReading
          ? recoveryAttempt ? '动作已恢复 · 单击开始演奏' : '动作已连接 · 单击开始演奏'
          : recoveryAttempt ? 'IMU 重连中，模拟方格仍可演奏' : '等待 IMU 首帧，请保持平视'
      });
      if (!hasSensorReading) {
        armSensorFrameWatchdog(
          recoveryAttempt ? 'recovery' : 'startup',
          activeOrientation,
          activeOrientationGeneration
        );
      }
      return orientationSensor === activeOrientation;
    } catch (error) {
      degradeSensors('SENSOR_INIT_FAILED', error, false, recoveryAttempt);
      return false;
    }
  }

  function handleTranscript(result) {
    const routed = routeTranscript(result.transcript);
    patchView({ lastTranscript: result.transcript });
    let accepted = false;
    let spoken = '';
    if (routed.intent === ATTENTION_INTENT.CALIBRATE) {
      accepted = calibrate();
      spoken = '校准完成';
    } else if (routed.intent === ATTENTION_INTENT.MUSIC) {
      accepted = startFromUserAction();
      spoken = '开始演奏';
    } else if (routed.intent === ATTENTION_INTENT.PAUSE) {
      accepted = pause();
      spoken = '已暂停';
    } else if (routed.intent === ATTENTION_INTENT.EXIT) {
      accepted = requestExit();
      spoken = '已退出';
    }

    if (accepted) {
      speech.speak(spoken);
      log('log', 'MUSIC_VOICE_ACCEPTED', {
        intent: routed.intent,
        reason: routed.reason,
        status: engine.status
      });
      return true;
    }

    const hints = {
      CALIBRATING: '单击或说“开始演奏”。',
      READY: '单击或说“开始演奏”。',
      PLAYING: '轻摇头部弹奏；单击暂停。',
      PAUSED: '单击或说“继续演奏”。',
      STOPPED: '本页已停止，请重新进入。'
    };
    patchView({ hint: hints[engine.status] || '没有匹配到可执行控制词。' });
    log('log', 'MUSIC_VOICE_REJECTED', {
      intent: routed.intent,
      reason: routed.reason,
      status: engine.status
    });
    return false;
  }

  const speech = createSpeechController({
    ...options.speech,
    onView: patchView,
    onTranscript: handleTranscript,
    logger
  });

  function load() {
    if (loaded || destroyed) return false;
    loaded = true;
    log('log', 'MUSIC_LOAD_STARTED', { receivedAt: now() });
    speech.load();
    const sensorStarted = setupSensors();
    if (!sensorStarted) ensureAudioSetup();
    log('log', 'MUSIC_READY', { bpm: engine.config.bpm, gridMs: engine.config.gridMs });
    return true;
  }

  function calibrate() {
    if (destroyed || engine.status === 'STOPPED') return false;
    if (orientationSensor && !hasSensorReading) {
      patchView({ hint: '正在连接动作传感器…' });
      return false;
    }
    if (engine.status === 'PLAYING') {
      engine = pauseMusic(engine, now());
      pausePlayback();
      stopTimer();
    }
    engine = calibrateMusic(engine, latestQuaternion);
    patchView({
      status: 'READY',
      chord: 'C',
      note: '—',
      zone: '—',
      hint: '准备好了 · 单击或说“开始演奏”',
      petState: 'ready',
      pulse: false
    });
    log('log', 'MUSIC_CALIBRATED');
    return true;
  }

  function start() {
    if (destroyed) return false;
    const next = startMusic(engine, now());
    if (next === engine) return false;
    engine = next;
    playBackground();
    stopTimer();
    try {
      const scheduledTimer = scheduleInterval(flushDueNotes, 25);
      if (scheduledTimer === null || scheduledTimer === undefined) {
        throw new Error('timer provider returned no handle');
      }
      flushTimer = scheduledTimer;
    } catch (error) {
      flushTimer = null;
      log('error', 'MUSIC_TIMER_START_FAILED', { message: errorMessage(error) });
      engine = pauseMusic(engine, now());
      pausePlayback();
      patchView({ status: 'PAUSED', hint: '节拍计时器启动失败，请重试', petState: 'ready' });
      return false;
    }
    patchView({ status: 'PLAYING', hint: '轻摇头部，像弹琴一样发出音符', petState: 'playing' });
    log('log', 'MUSIC_STARTED');
    return true;
  }

  function startFromUserAction() {
    if (destroyed || engine.status === 'STOPPED' || engine.status === 'PLAYING') return false;
    if (engine.status === 'CALIBRATING' && orientationSensor && !hasSensorReading) {
      startRequested = true;
      patchView({ hint: '保持平视 · 动作就绪后自动开始' });
      log('log', 'MUSIC_START_DEFERRED_FOR_IMU');
      return true;
    }
    startRequested = false;
    if (engine.status === 'CALIBRATING' && !calibrate()) return false;
    return start();
  }

  function togglePlayback() {
    if (destroyed || engine.status === 'STOPPED') return false;
    return engine.status === 'PLAYING' ? pause() : startFromUserAction();
  }

  function pause() {
    if (destroyed) return false;
    startRequested = false;
    const next = pauseMusic(engine, now());
    if (next === engine) return false;
    engine = next;
    pausePlayback();
    stopTimer();
    patchView({ status: 'PAUSED', hint: '已暂停 · 单击或说“继续演奏”', petState: 'ready' });
    log('log', 'MUSIC_PAUSED');
    return true;
  }

  function setInstrument(instrumentId) {
    if (destroyed || !MUSIC_INSTRUMENTS[instrumentId] || engine.instrumentId === instrumentId) return false;
    const wasPlaying = engine.status === 'PLAYING';
    if (wasPlaying) {
      pausePlayback();
      stopTimer();
    }
    engine = setMusicInstrument(engine, instrumentId);
    if (audioSetupStarted) reloadNoteSounds();
    const instrument = MUSIC_INSTRUMENTS[instrumentId];
    patchView({
      instrumentId,
      instrumentLabel: instrument.label,
      cadenceLabel: instrument.cadenceLabel,
      status: engine.status,
      chord: 'C',
      note: '—',
      zone: '—',
      activeKey: '—',
      pulse: false,
      petState: engine.status === 'CALIBRATING' ? 'sleep' : 'ready',
      hint: `已切换为${instrument.label} · 单击开始`
    });
    log('log', 'MUSIC_INSTRUMENT_CHANGED', {
      instrumentId,
      gridMs: instrument.gridMs,
      deadZoneDeg: instrument.deadZoneDeg,
      rearmDeadZoneDeg: instrument.rearmDeadZoneDeg
    });
    return true;
  }

  function requestExit() {
    if (destroyed) return false;
    startRequested = false;
    try {
      const result = onExit();
      if (result === false) return false;
      log('log', 'MUSIC_EXIT_REQUESTED');
      return true;
    } catch (error) {
      log('error', 'MUSIC_EXIT_REQUEST_FAILED', { message: errorMessage(error) });
      patchView({ hint: '退出失败，请双击触控板重试' });
      return false;
    }
  }

  function stopSensors(exposeState = true) {
    clearSensorFrameWatchdog();
    clearSensorLivenessWatchdog();
    clearSensorRecoveryWatchdog(false);
    if (!sensorsStarted) return false;
    sensorsStarted = false;
    orientationStartGeneration += 1;
    gyroscopeStartGeneration += 1;
    hasSensorReading = false;
    sensorLastFrameAt = null;
    sensorDiagnostics.previousAt = null;
    resetSensorClock();
    safeCall(orientationSensor, 'stop', 'ORIENTATION_STOP_FAILED');
    safeCall(gyroscope, 'stop', 'GYROSCOPE_STOP_FAILED');
    if (exposeState) patchView({ sensorMode: 'IMU_SUSPENDED' });
    log('log', 'SENSORS_SUSPENDED');
    return true;
  }

  function resumeSensors() {
    if (destroyed || sensorsStarted || !orientationSensor) return false;
    const activeOrientation = orientationSensor;
    const activeOrientationGeneration = ++orientationStartGeneration;
    sensorsStarted = true;
    const orientationStarted = safeCall(activeOrientation, 'start', 'ORIENTATION_RESUME_FAILED', (error) => {
      if (destroyed || orientationSensor !== activeOrientation ||
        orientationStartGeneration !== activeOrientationGeneration) return;
      degradeSensors('ORIENTATION_RESUME_FAILED', error, true);
    });
    if (!orientationStarted || orientationSensor !== activeOrientation) return false;
    if (gyroscope) {
      const activeGyroscope = gyroscope;
      const activeGyroscopeGeneration = ++gyroscopeStartGeneration;
      safeCall(activeGyroscope, 'start', 'GYROSCOPE_RESUME_FAILED', () => {
        if (destroyed || gyroscope !== activeGyroscope ||
          gyroscopeStartGeneration !== activeGyroscopeGeneration) return;
        gyroscopeStartGeneration += 1;
        safeCall(activeGyroscope, 'stop', 'GYROSCOPE_STOP_FAILED');
        gyroscope = null;
      });
    }
    patchView({
      sensorMode: hasSensorReading ? 'IMU_ACTIVE' : 'IMU_WAITING',
      hint: hasSensorReading ? '动作已恢复 · 单击继续演奏' : '正在连接动作传感器…'
    });
    if (!hasSensorReading &&
      !armSensorFrameWatchdog('resume', activeOrientation, activeOrientationGeneration)) return false;
    log('log', 'SENSORS_RESUMED', { hasSensorReading });
    return true;
  }

  function suspend() {
    if (destroyed) return false;
    pageActive = false;
    startRequested = false;
    clearSensorRecoveryWatchdog(false);
    const speechStopped = speech.stop();
    const musicPaused = pause();
    const sensorsStopped = stopSensors();
    return speechStopped || musicPaused || sensorsStopped;
  }

  function resume() {
    if (destroyed) return false;
    pageActive = true;
    if (orientationSensor) return resumeSensors();
    if (typeof options.AbsoluteOrientationSensor === 'function' &&
      sensorRecoveryAttempts < sensorRecoveryMaxAttempts) {
      return attemptSensorRecovery('PAGE_RESUME');
    }
    return false;
  }

  function startListening() {
    if (!speech.start()) {
      if (!speech.getSnapshot().view.speechAvailable) patchView({ hint: '当前环境没有语音识别，请使用按钮。' });
      return false;
    }
    patchView({ hint: '正在听…' });
    return true;
  }

  function stopListening() {
    return speech.stop();
  }

  function queuePose(yaw, pitch, speed = 2) {
    if (destroyed) return false;
    const result = proposeMotion(engine, {
      timestampMs: now(),
      yaw,
      pitch,
      angularSpeed: speed
    });
    engine = result.engine;
    if (result.accepted) {
      const harmony = harmonyAtGrid(result.candidate.gridIndex, engine.config);
      patchView({
        chord: harmony.chord,
        zone: String(result.candidate.zone + 1),
        hint: `已对齐第 ${result.candidate.gridIndex} 个动作音符`,
        petState: 'anticipate'
      });
    }
    log('log', 'MUSIC_MOTION', { accepted: result.accepted, reason: result.reason });
    return result.accepted;
  }

  function simulateZone(zone) {
    if (destroyed || engine.status !== 'PLAYING' || !Number.isInteger(zone) || zone < 0 || zone > 11) {
      return false;
    }
    const row = Math.floor(zone / 4);
    const column = zone % 4;
    const yaw = [-27, -9, 9, 27][column];
    const pitch = [18, 0, -18][row];
    const accepted = queuePose(yaw, pitch, 2);
    const centered = proposeMotion(engine, {
      timestampMs: now() + 1,
      yaw: 0,
      pitch: 0,
      angularSpeed: 0
    });
    engine = centered.engine;
    return accepted;
  }

  function quarantineNote(event, sound, error, asynchronous) {
    if (destroyed || noteSounds[event.midi] !== sound) return false;
    delete noteSounds[event.midi];
    log('error', 'NOTE_PLAY_FAILED', {
      midi: event.midi,
      message: errorMessage(error),
      ...(asynchronous ? { asynchronous: true } : {})
    });
    safeCall(sound, 'stop', 'NOTE_STOP_FAILED');
    safeCall(sound, 'destroy', 'NOTE_DESTROY_FAILED');
    const remainingNotes = Object.keys(noteSounds).length;
    patchView({
      audioMode: availableAudioMode(backgroundReady),
      hint: remainingNotes
        ? '部分音符不可用，其余音符仍可演奏'
        : backgroundReady
          ? '音符不可用，背景音乐仍可播放'
          : '音频不可用，请退出后重试'
    });
    log('log', 'NOTE_PLAY_RESULT', {
      gridIndex: event.gridIndex,
      midi: event.midi,
      status: 'REJECTED',
      ...(asynchronous ? { asynchronous: true } : {}),
      message: errorMessage(error)
    });
    return true;
  }

  function playNote(event) {
    const sound = noteSounds[event.midi];
    if (!sound || typeof sound.play !== 'function') {
      log('error', 'NOTE_SAMPLE_MISSING', { midi: event.midi });
      log('log', 'NOTE_PLAY_RESULT', {
        gridIndex: event.gridIndex,
        midi: event.midi,
        status: 'MISSING'
      });
      return { playAccepted: false, playStatus: 'MISSING' };
    }
    try {
      const result = sound.play();
      if (result === false) {
        quarantineNote(event, sound, new Error('play returned false'), false);
        return { playAccepted: false, playStatus: 'REJECTED' };
      }
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(
          (value) => {
            if (destroyed || noteSounds[event.midi] !== sound) return;
            if (value === false) {
              quarantineNote(event, sound, new Error('play returned false'), true);
              return;
            }
            log('log', 'NOTE_PLAY_RESULT', {
              gridIndex: event.gridIndex,
              midi: event.midi,
              status: 'ACCEPTED',
              asynchronous: true
            });
          },
          (error) => quarantineNote(event, sound, error, true)
        );
        return { playAccepted: null, playStatus: 'PENDING' };
      }
      log('log', 'NOTE_PLAY_RESULT', {
        gridIndex: event.gridIndex,
        midi: event.midi,
        status: 'ACCEPTED'
      });
      return { playAccepted: true, playStatus: 'ACCEPTED' };
    } catch (error) {
      quarantineNote(event, sound, error, false);
      return { playAccepted: false, playStatus: 'REJECTED' };
    }
  }

  function flushDueNotes() {
    if (destroyed) return [];
    const result = flushMusic(engine, now());
    engine = result.engine;
    result.events.forEach((event) => {
      const { playAccepted, playStatus } = playNote(event);
      const playedAt = now();
      patchView({
        note: event.note,
        activeKey: event.note[0],
        chord: event.chord,
        zone: String(event.zone + 1),
        pulse: !view.pulse,
        petState: 'hit'
      });
      log('log', 'MUSIC_NOTE', {
        gridIndex: event.gridIndex,
        zone: event.zone,
        note: event.note,
        chord: event.chord,
        sensorTimestamp: event.timestampMs,
        dueAt: event.dueAt,
        playedAt,
        latenessMs: playedAt - event.dueAt,
        playAccepted,
        playStatus
      });
    });
    return result.events;
  }

  function destroy() {
    if (destroyed) return false;
    destroyed = true;
    startRequested = false;
    speech.destroy();
    stopTimer();
    clearSensorFrameWatchdog();
    clearSensorRecoveryWatchdog(true);
    clearBackgroundReadyWatchdog();
    stopSensors(false);
    safeCall(background, 'destroy', 'BACKGROUND_DESTROY_FAILED');
    releaseNoteSounds();
    orientationSensor = null;
    gyroscope = null;
    background = null;
    backgroundReady = false;
    backgroundPlaying = false;
    backgroundWantsPlayback = false;
    backgroundInterruptionRetries = 0;
    engine = stopMusic(engine);
    return true;
  }

  function getSnapshot() {
    return {
      engine,
      view: { ...view },
      loaded,
      destroyed,
      startRequested,
      hasSensorReading,
      sensorStats: getSensorStats(),
      sensorsStarted,
      sensorWatchdogActive: sensorFrameWatchdog !== null,
      sensorLivenessWatchdogActive: sensorLivenessWatchdog !== null,
      sensorRecoveryWatchdogActive: sensorRecoveryWatchdog !== null,
      sensorRecoveryAttempts,
      sensorLastFrameAt,
      timerActive: flushTimer !== null,
      audioSetupStarted,
      noteSoundCount: Object.keys(noteSounds).length,
      hasBackground: Boolean(background),
      backgroundReady,
      audioWatchdogActive: backgroundReadyWatchdog !== null,
      backgroundPlaying,
      backgroundWantsPlayback,
      hasOrientationSensor: Boolean(orientationSensor),
      hasGyroscope: Boolean(gyroscope),
      speech: speech.getSnapshot()
    };
  }

  return {
    load,
    calibrate,
    start,
    startFromUserAction,
    togglePlayback,
    pause,
    setInstrument,
    requestExit,
    suspend,
    resume,
    startListening,
    stopListening,
    handleTranscript,
    queuePose,
    simulateZone,
    flushDueNotes,
    destroy,
    getSnapshot
  };
}
