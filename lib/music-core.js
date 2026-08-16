const MUSIC_BASE_CONFIG = Object.freeze({
  bpm: 96,
  beatsPerBar: 4,
  gridDivision: 2,
  harmonyGridMs: 60000 / 96 / 2,
  yawLimitDeg: 36,
  pitchLimitDeg: 27,
  progression: ['C', 'G', 'Am', 'F']
});

export const MUSIC_INSTRUMENTS = Object.freeze({
  PIANO: Object.freeze({
    id: 'PIANO',
    label: '钢琴',
    assetPrefix: 'note',
    notesPerSecond: 4,
    gridMs: 250,
    deadZoneDeg: 3,
    rearmDeadZoneDeg: 2,
    cooldownMs: 180,
    cadenceLabel: '最多 4 音/秒'
  }),
  MUSIC_BOX: Object.freeze({
    id: 'MUSIC_BOX',
    label: '八音盒',
    assetPrefix: 'music-box-note',
    notesPerSecond: 2,
    gridMs: 500,
    deadZoneDeg: 3,
    rearmDeadZoneDeg: 2,
    cooldownMs: 350,
    cadenceLabel: '最多 2 音/秒'
  }),
  GUITAR: Object.freeze({
    id: 'GUITAR',
    label: '吉他',
    assetPrefix: 'guitar-note',
    notesPerSecond: 2,
    gridMs: 500,
    deadZoneDeg: 3,
    rearmDeadZoneDeg: 2,
    cooldownMs: 420,
    cadenceLabel: '最多 2 音/秒'
  }),
  WOODFISH: Object.freeze({
    id: 'WOODFISH',
    label: '木鱼',
    assetPrefix: 'woodfish-note',
    notesPerSecond: 4 / 3,
    gridMs: 750,
    deadZoneDeg: 3,
    rearmDeadZoneDeg: 2,
    cooldownMs: 650,
    cadenceLabel: '约 1 音 / 0.75 秒'
  })
});

// Product-retired profiles stay outside MUSIC_INSTRUMENTS so neither UI nor runtime can select them.
// Keeping the profile here makes a later reviewed reintroduction explicit and reversible.
export const RETIRED_MUSIC_INSTRUMENTS = Object.freeze({
  BOWL: Object.freeze({
    id: 'BOWL',
    label: '钵',
    assetPrefix: 'bowl-note',
    notesPerSecond: 2 / 3,
    gridMs: 1500,
    deadZoneDeg: 6,
    rearmDeadZoneDeg: 3,
    cooldownMs: 1200,
    cadenceLabel: '最多 1 音 / 1.5 秒'
  })
});

export const MUSIC_CONFIG = Object.freeze({
  ...MUSIC_BASE_CONFIG,
  ...MUSIC_INSTRUMENTS.PIANO
});

export const MUSIC_AUDIO_CONFIG = Object.freeze({
  backgroundVolume: 0.55,
  noteVolume: 0.55
});

export const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

export const MUSIC_PLAYABLE_MIDI = Object.freeze([
  48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83
]);

const CHORD_PALETTES = Object.freeze({
  C: [0, 4, 7, 9],
  G: [7, 11, 2, 9],
  Am: [9, 0, 4, 7],
  F: [5, 9, 0, 4]
});

export function normalizeQuaternion(input) {
  const q = input || [0, 0, 0, 1];
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map((value) => value / length);
}

export function conjugateQuaternion(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function multiplyQuaternion(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

export function relativeEulerDegrees(calibration, reading) {
  const base = normalizeQuaternion(calibration);
  const current = normalizeQuaternion(reading);
  const [x, y, z, w] = normalizeQuaternion(multiplyQuaternion(conjugateQuaternion(base), current));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const toDegrees = 180 / Math.PI;
  return { yaw: yaw * toDegrees, pitch: pitch * toDegrees, roll: roll * toDegrees };
}

export function zoneFromPose(yaw, pitch, config = MUSIC_CONFIG) {
  if (Math.abs(yaw) < config.deadZoneDeg && Math.abs(pitch) < config.deadZoneDeg) return null;
  const clampedYaw = Math.max(-config.yawLimitDeg, Math.min(config.yawLimitDeg, yaw));
  const clampedPitch = Math.max(-config.pitchLimitDeg, Math.min(config.pitchLimitDeg, pitch));
  const column = Math.min(3, Math.floor(((clampedYaw + config.yawLimitDeg) / (2 * config.yawLimitDeg)) * 4));
  const row = Math.min(2, Math.floor(((config.pitchLimitDeg - clampedPitch) / (2 * config.pitchLimitDeg)) * 3));
  return row * 4 + column;
}

export function quantizeGrid(timestampMs, config = MUSIC_CONFIG) {
  const grid = config.gridMs;
  if (Math.abs(timestampMs) < 1e-9) return 0;
  return Math.ceil((timestampMs - 1e-9) / grid) * grid;
}

export function harmonyAtGrid(gridIndex, config = MUSIC_CONFIG) {
  const gridsPerBar = config.beatsPerBar * config.gridDivision;
  const barIndex = Math.floor(gridIndex / gridsPerBar);
  const chord = config.progression[((barIndex % config.progression.length) + config.progression.length) % config.progression.length];
  const gridInBar = ((gridIndex % gridsPerBar) + gridsPerBar) % gridsPerBar;
  return {
    chord,
    barIndex,
    gridInBar,
    strong: gridInBar % config.gridDivision === 0
  };
}

function pitchClassForZone(zone, harmony) {
  const column = zone % 4;
  const palette = CHORD_PALETTES[harmony.chord];
  return palette[harmony.strong ? column % 3 : column];
}

export function chooseVoicedMidi(zone, harmony, previousMidi = null) {
  const row = Math.floor(zone / 4);
  const desiredPitchClass = pitchClassForZone(zone, harmony);
  const palette = CHORD_PALETTES[harmony.chord];
  const allowedPitchClasses = harmony.strong ? palette.slice(0, 3) : palette;
  const registerCenter = [52, 64, 76][row];
  const candidates = MUSIC_PLAYABLE_MIDI.filter((midi) => allowedPitchClasses.includes(midi % 12));
  const target = previousMidi == null ? registerCenter : previousMidi;
  const exact = candidates.filter((midi) => midi % 12 === desiredPitchClass);
  const exactWithinLeap = previousMidi == null ? exact : exact.filter((midi) => Math.abs(midi - previousMidi) <= 7);
  const anyWithinLeap = previousMidi == null ? candidates : candidates.filter((midi) => Math.abs(midi - previousMidi) <= 7);
  const pool = exactWithinLeap.length ? exactWithinLeap : anyWithinLeap.length ? anyWithinLeap : exact.length ? exact : candidates;
  pool.sort((a, b) => {
    const distance = Math.abs(a - target) - Math.abs(b - target);
    if (distance !== 0) return distance;
    const registerDistance = Math.abs(a - registerCenter) - Math.abs(b - registerCenter);
    return registerDistance || a - b;
  });
  return pool[0];
}

export function noteName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

export function createMusicEngine(options = {}) {
  const instrument = MUSIC_INSTRUMENTS[options.instrumentId] || MUSIC_INSTRUMENTS.PIANO;
  const config = { ...MUSIC_BASE_CONFIG, ...instrument, ...(options.config || {}) };
  return {
    instrumentId: instrument.id,
    status: 'CALIBRATING',
    calibration: null,
    startedAt: 0,
    pausedAt: null,
    previousMidi: null,
    lastAcceptedAt: -Infinity,
    lastAcceptedPose: null,
    armed: true,
    pendingByGrid: {},
    sequence: 0,
    config
  };
}

export function calibrateMusic(engine, quaternion = [0, 0, 0, 1]) {
  return {
    ...engine,
    status: 'READY',
    calibration: normalizeQuaternion(quaternion),
    startedAt: 0,
    pausedAt: null,
    previousMidi: null,
    lastAcceptedAt: -Infinity,
    lastAcceptedPose: null,
    armed: true,
    pendingByGrid: {},
    sequence: 0
  };
}

export function startMusic(engine, timestampMs = 0) {
  if (engine.status !== 'READY' && engine.status !== 'PAUSED') return engine;
  const resumedAt = Number.isFinite(timestampMs) ? timestampMs : 0;
  const pausedDuration = engine.status === 'PAUSED' && Number.isFinite(engine.pausedAt)
    ? Math.max(0, resumedAt - engine.pausedAt)
    : 0;
  return {
    ...engine,
    status: 'PLAYING',
    startedAt: engine.status === 'READY' ? resumedAt : engine.startedAt + pausedDuration,
    pausedAt: null,
    armed: true
  };
}

export function pauseMusic(engine, timestampMs = null) {
  return engine.status === 'PLAYING'
    ? {
        ...engine,
        status: 'PAUSED',
        pausedAt: Number.isFinite(timestampMs) ? timestampMs : null,
        pendingByGrid: {},
        armed: true
      }
    : engine;
}

export function stopMusic(engine) {
  return { ...engine, status: 'STOPPED', pausedAt: null, pendingByGrid: {}, armed: true };
}

export function setMusicInstrument(engine, instrumentId) {
  const instrument = MUSIC_INSTRUMENTS[instrumentId];
  if (!instrument || engine.instrumentId === instrumentId) return engine;
  const status = engine.status === 'CALIBRATING' || engine.status === 'STOPPED'
    ? engine.status
    : 'READY';
  return {
    ...engine,
    instrumentId,
    config: { ...MUSIC_BASE_CONFIG, ...instrument },
    status,
    startedAt: 0,
    pausedAt: null,
    previousMidi: null,
    lastAcceptedAt: -Infinity,
    lastAcceptedPose: null,
    armed: true,
    pendingByGrid: {},
    sequence: 0
  };
}

export function proposeMotion(engine, motion) {
  if (engine.status !== 'PLAYING') return { engine, accepted: false, reason: 'NOT_PLAYING' };
  const timestampMs = motion.timestampMs;
  const pose = motion.quaternion
    ? relativeEulerDegrees(engine.calibration, motion.quaternion)
    : { yaw: motion.yaw || 0, pitch: motion.pitch || 0, roll: motion.roll || 0 };
  const zone = zoneFromPose(pose.yaw, pose.pitch, engine.config);
  if (zone == null) {
    const withinRearm = Math.abs(pose.yaw) <= engine.config.rearmDeadZoneDeg &&
      Math.abs(pose.pitch) <= engine.config.rearmDeadZoneDeg;
    return {
      engine: { ...engine, armed: engine.armed || withinRearm },
      accepted: false,
      reason: withinRearm ? 'REARMED' : 'DEAD_ZONE_HYSTERESIS'
    };
  }
  if (!engine.armed) {
    return { engine, accepted: false, reason: 'WAIT_FOR_CENTER' };
  }
  if (timestampMs - engine.lastAcceptedAt < engine.config.cooldownMs) {
    return {
      engine,
      accepted: false,
      reason: 'COOLDOWN'
    };
  }

  const dueAt = quantizeGrid(timestampMs - engine.startedAt, engine.config) + engine.startedAt;
  const gridIndex = Math.round((dueAt - engine.startedAt) / engine.config.gridMs);
  const harmonyGridIndex = Math.floor((dueAt - engine.startedAt + 1e-9) / engine.config.harmonyGridMs);
  const harmony = harmonyAtGrid(harmonyGridIndex, engine.config);
  const candidate = {
    id: engine.sequence + 1,
    timestampMs,
    dueAt,
    gridIndex,
    harmonyGridIndex,
    zone,
    yaw: pose.yaw,
    pitch: pose.pitch,
    strength: Math.abs(motion.angularSpeed || 0),
    harmony
  };
  const key = String(gridIndex);
  const existing = engine.pendingByGrid[key];
  const wins = !existing || candidate.strength > existing.strength ||
    (candidate.strength === existing.strength && candidate.timestampMs > existing.timestampMs);
  const pendingByGrid = { ...engine.pendingByGrid, ...(wins ? { [key]: candidate } : {}) };
  const next = {
    ...engine,
    pendingByGrid,
    lastAcceptedAt: timestampMs,
    lastAcceptedPose: { yaw: pose.yaw, pitch: pose.pitch },
    armed: false,
    sequence: candidate.id
  };
  return { engine: next, accepted: wins, reason: wins ? 'QUEUED' : 'COLLISION_LOST', candidate };
}

export function flushMusic(engine, timestampMs) {
  const ready = Object.values(engine.pendingByGrid)
    .filter((candidate) => candidate.dueAt <= timestampMs)
    .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
  let previousMidi = engine.previousMidi;
  const events = ready.map((candidate) => {
    const midi = chooseVoicedMidi(candidate.zone, candidate.harmony, previousMidi);
    previousMidi = midi;
    return { ...candidate, midi, note: noteName(midi), chord: candidate.harmony.chord };
  });
  const flushed = new Set(ready.map((candidate) => String(candidate.gridIndex)));
  const pendingByGrid = Object.fromEntries(
    Object.entries(engine.pendingByGrid).filter(([key]) => !flushed.has(key))
  );
  return { engine: { ...engine, pendingByGrid, previousMidi }, events };
}
