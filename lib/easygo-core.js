export const EASYGO_STATUS = Object.freeze({
  IDLE: 'IDLE',
  STEP1_WAIT: 'STEP1_WAIT',
  STEP2_WAIT: 'STEP2_WAIT',
  STEP3_WAIT: 'STEP3_WAIT',
  RESIZED: 'RESIZED',
  VALID_PAUSE: 'VALID_PAUSE',
  OFFLINE_HANDOFF: 'OFFLINE_HANDOFF',
  COMPLETE: 'COMPLETE'
});

export const EASYGO_EVENT = Object.freeze({
  START_FITNESS: 'START_FITNESS',
  START_VIDEO: 'START_VIDEO',
  START_READING: 'START_READING',
  DONE: 'DONE',
  TOO_HARD: 'TOO_HARD',
  PAUSE: 'PAUSE',
  RESTART: 'RESTART'
});

const SCENARIOS = Object.freeze({
  FITNESS: {
    label: '想去健身，但没动力',
    actions: [
      '站起来，把运动鞋拿到脚边',
      '穿上鞋，不要求现在出门',
      '做 3 分钟热身，之后可自由继续或停'
    ],
    resized: [
      '双脚先落地',
      '只穿一只鞋',
      '只做 30 秒热身'
    ],
    terminalStatus: EASYGO_STATUS.COMPLETE,
    terminalAction: '完成了。接下来继续或停，都由你决定。'
  },
  VIDEO: {
    label: '想停止刷视频，但停不下来',
    actions: [
      '暂停当前视频',
      '说出现在更想把注意力给哪件事'
    ],
    resized: [
      '把手指离开屏幕 5 秒',
      '只在心里选一件事'
    ],
    terminalStatus: EASYGO_STATUS.OFFLINE_HANDOFF,
    terminalAction: '把手机扣在桌上。无需回复。'
  },
  READING: {
    label: '想读论文，但迟迟没开始',
    actions: [
      '打开论文，只读标题',
      '读摘要第一句话',
      '再读摘要一段，之后可自由继续或停'
    ],
    resized: [
      '只把论文打开',
      '只看摘要第一个词',
      '只读一行'
    ],
    terminalStatus: EASYGO_STATUS.COMPLETE,
    terminalAction: '已经开始了。接下来继续或停，都由你决定。'
  }
});

const TERMINAL = new Set([
  EASYGO_STATUS.VALID_PAUSE,
  EASYGO_STATUS.OFFLINE_HANDOFF,
  EASYGO_STATUS.COMPLETE
]);

export function initialEasyGoState() {
  return {
    scenario: '',
    scenarioLabel: '',
    stepIndex: 0,
    stepCount: 0,
    status: EASYGO_STATUS.IDLE,
    action: '',
    petState: 'idle',
    terminal: false
  };
}

function waitStatus(stepIndex) {
  return `STEP${stepIndex}_WAIT`;
}

function activeState(scenario, stepIndex, resized = false) {
  const config = SCENARIOS[scenario];
  return {
    scenario,
    scenarioLabel: config.label,
    stepIndex,
    stepCount: config.actions.length,
    status: resized ? EASYGO_STATUS.RESIZED : waitStatus(stepIndex),
    action: resized ? config.resized[stepIndex - 1] : config.actions[stepIndex - 1],
    petState: resized ? 'encourage' : stepIndex === 2 && scenario === 'VIDEO' ? 'listening' : 'guide',
    terminal: false
  };
}

function terminalState(state, status, action, petState) {
  return {
    ...state,
    status,
    action,
    petState,
    terminal: true
  };
}

function receipt(event, accepted, reason, previous, next) {
  return {
    event,
    accepted,
    reason,
    from: previous.status,
    to: next.status,
    scenario: next.scenario,
    stepIndex: next.stepIndex
  };
}

export function transitionEasyGo(previous, event) {
  const state = previous || initialEasyGoState();
  let next = state;
  let reason = 'EVENT_NOT_ALLOWED';

  if (event === EASYGO_EVENT.RESTART) {
    next = initialEasyGoState();
    reason = 'RESTARTED';
  } else if (TERMINAL.has(state.status)) {
    reason = 'TERMINAL_STATE';
  } else if (state.status === EASYGO_STATUS.IDLE && event === EASYGO_EVENT.START_FITNESS) {
    next = activeState('FITNESS', 1);
    reason = 'SCENARIO_STARTED';
  } else if (state.status === EASYGO_STATUS.IDLE && event === EASYGO_EVENT.START_VIDEO) {
    next = activeState('VIDEO', 1);
    reason = 'SCENARIO_STARTED';
  } else if (state.status === EASYGO_STATUS.IDLE && event === EASYGO_EVENT.START_READING) {
    next = activeState('READING', 1);
    reason = 'SCENARIO_STARTED';
  } else if (!state.terminal && state.scenario && event === EASYGO_EVENT.PAUSE) {
    next = terminalState(state, EASYGO_STATUS.VALID_PAUSE, '已暂停。现在停下来也算完成。', 'rest');
    reason = 'USER_PAUSED';
  } else if (!state.terminal && state.scenario && event === EASYGO_EVENT.TOO_HARD && state.status !== EASYGO_STATUS.RESIZED) {
    next = activeState(state.scenario, state.stepIndex, true);
    reason = 'ACTION_RESIZED';
  } else if (!state.terminal && state.scenario && event === EASYGO_EVENT.DONE) {
    const config = SCENARIOS[state.scenario];
    if (state.stepIndex < config.actions.length) {
      next = activeState(state.scenario, state.stepIndex + 1);
      reason = 'OBSERVED_DONE_ADVANCED';
    } else {
      next = terminalState(state, config.terminalStatus, config.terminalAction, 'celebrate');
      reason = state.scenario === 'VIDEO' ? 'OFFLINE_HANDOFF' : 'SCENARIO_COMPLETE';
    }
  }

  const validation = validateEasyGoState(next);
  if (!validation.ok) {
    throw new Error(`Invalid EasyGo transition: ${validation.errors.join('; ')}`);
  }

  return {
    state: next,
    receipt: receipt(event, next !== state, reason, state, next)
  };
}

export function validateEasyGoState(state) {
  const errors = [];
  const statusValues = Object.values(EASYGO_STATUS);
  if (!statusValues.includes(state.status)) errors.push(`unknown status ${state.status}`);
  if (state.status === EASYGO_STATUS.IDLE) {
    if (state.scenario || state.stepIndex !== 0 || state.action || state.terminal) {
      errors.push('IDLE must not carry an active scenario');
    }
  } else {
    const config = SCENARIOS[state.scenario];
    if (!config) errors.push(`unknown scenario ${state.scenario}`);
    if (config && (state.stepIndex < 1 || state.stepIndex > config.actions.length)) {
      errors.push(`step ${state.stepIndex} is outside scenario bounds`);
    }
    if (!state.action) errors.push('non-IDLE state must expose exactly one action');
  }
  if (TERMINAL.has(state.status) !== Boolean(state.terminal)) {
    errors.push('terminal flag and status disagree');
  }
  if (state.status === EASYGO_STATUS.OFFLINE_HANDOFF && !/无需回复/.test(state.action)) {
    errors.push('offline handoff must not request a response');
  }
  return { ok: errors.length === 0, errors };
}

export function getEasyGoScenario(scenario) {
  return SCENARIOS[scenario] || null;
}
