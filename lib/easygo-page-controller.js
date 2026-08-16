import {
  EASYGO_EVENT,
  initialEasyGoState,
  transitionEasyGo
} from './easygo-core.js';
import {
  ATTENTION_INTENT,
  intentToEasyGoEvent,
  routeTranscript,
  scenarioFromQuery
} from './intent-router.js';
import { createSpeechController } from './speech-controller.js';

export const INITIAL_EASYGO_PAGE_VIEW = Object.freeze({
  ...initialEasyGoState(),
  receipt: '等待选择场景',
  speechAvailable: false,
  ttsAvailable: false,
  recognitionState: 'UNAVAILABLE',
  lastTranscript: '',
  speechError: '',
  voiceHint: '轻点触控板后说出选择或完成情况（需联网）'
});

export function createEasyGoPageController(options = {}) {
  const onView = options.onView || (() => {});
  const logger = options.logger || console;
  let state = initialEasyGoState();
  let view = { ...INITIAL_EASYGO_PAGE_VIEW };
  let loaded = false;
  let destroyed = false;

  function patchView(patch) {
    if (destroyed) return;
    view = { ...view, ...patch };
    try {
      onView(patch);
    } catch (error) {
      log('error', 'EASYGO_VIEW_UPDATE_FAILED', {
        message: error && error.message ? error.message : String(error || 'unknown error')
      });
    }
  }

  function log(level, event, detail) {
    const writer = logger && typeof logger[level] === 'function' ? logger[level] : logger && logger.log;
    if (!writer) return;
    try {
      writer.call(logger, event, JSON.stringify(detail || {}));
    } catch (_) {}
  }

  function dispatch(event, source = 'button') {
    if (destroyed) return null;
    const result = transitionEasyGo(state, event);
    state = result.state;
    patchView({
      ...state,
      receipt: `${result.receipt.accepted ? '✓' : '·'} ${result.receipt.reason}`,
      voiceHint: result.receipt.accepted ? '可以说“完成了”“太难”或“先停一下”' : view.voiceHint
    });
    log('log', 'EASYGO_TRANSITION', { ...result.receipt, source });
    if (result.receipt.accepted && state.action) speech.speak(state.action);
    return result;
  }

  function handleTranscript(result) {
    const routed = routeTranscript(result.transcript);
    const mapped = intentToEasyGoEvent(routed.intent, state.status);
    patchView({ lastTranscript: result.transcript });
    if (!mapped.event) {
      const hints = {
        WAITING_FOR_SCENARIO: '请说“想健身”“停止刷视频”或“想读论文但没开始”。',
        TERMINAL_REQUIRES_RESTART: '本轮已结束；要再来一次，请说“重新开始”。',
        ACTIVE_CONTROL_REQUIRED: '请说“完成了”“太难”或“先停一下”。'
      };
      patchView({ voiceHint: hints[mapped.reason] || '没有匹配到可执行控制词。' });
      log('log', 'EASYGO_VOICE_REJECTED', {
        intent: routed.intent,
        routeReason: routed.reason,
        state: state.status,
        reason: mapped.reason
      });
      return null;
    }
    return dispatch(mapped.event, 'voice');
  }

  const speech = createSpeechController({
    ...options.speech,
    onView: (patch) => {
      const nextPatch = { ...patch };
      if (patch.recognitionState === 'IDLE' && view.voiceHint === '正在听…') {
        nextPatch.voiceHint = '未收到语音结果，请检查眼镜网络或使用右侧按钮。';
      }
      patchView(nextPatch);
    },
    onTranscript: handleTranscript,
    logger
  });

  function load(query = {}) {
    if (loaded || destroyed) return false;
    loaded = true;
    speech.load();
    const scenario = scenarioFromQuery(query && query.scenario);
    if (scenario === 'FITNESS') dispatch(EASYGO_EVENT.START_FITNESS, query.source || 'query');
    if (scenario === 'VIDEO') dispatch(EASYGO_EVENT.START_VIDEO, query.source || 'query');
    if (scenario === 'READING') dispatch(EASYGO_EVENT.START_READING, query.source || 'query');
    log('log', 'EASYGO_READY', { scenario: scenario || 'IDLE' });
    return true;
  }

  function startListening() {
    if (!speech.start()) {
      const snapshot = speech.getSnapshot();
      if (!snapshot.view.speechAvailable) patchView({ voiceHint: '当前环境没有语音识别，请使用按钮。' });
      return false;
    }
    patchView({ voiceHint: '正在听…' });
    return true;
  }

  function destroy() {
    if (destroyed) return false;
    destroyed = true;
    speech.destroy();
    return true;
  }

  function stopListening() {
    return speech.stop();
  }

  function getSnapshot() {
    return { state: { ...state }, view: { ...view }, loaded, destroyed, speech: speech.getSnapshot() };
  }

  return {
    load,
    startListening,
    stopListening,
    handleTranscript,
    dispatch,
    startFitness: () => dispatch(EASYGO_EVENT.START_FITNESS),
    startVideo: () => dispatch(EASYGO_EVENT.START_VIDEO),
    startReading: () => dispatch(EASYGO_EVENT.START_READING),
    complete: () => dispatch(EASYGO_EVENT.DONE),
    tooHard: () => dispatch(EASYGO_EVENT.TOO_HARD),
    pause: () => dispatch(EASYGO_EVENT.PAUSE),
    restart: () => dispatch(EASYGO_EVENT.RESTART),
    destroy,
    getSnapshot,
    intents: ATTENTION_INTENT
  };
}
