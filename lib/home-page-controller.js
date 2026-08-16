import { ATTENTION_INTENT, routeTranscript } from './intent-router.js';
import { createSpeechController } from './speech-controller.js';

export const INITIAL_HOME_VIEW = Object.freeze({
  speechAvailable: false,
  ttsAvailable: false,
  recognitionState: 'UNAVAILABLE',
  lastTranscript: '',
  speechError: '',
  voiceHint: '长按后说“健身没动力”或“想读论文”'
});

export function createHomePageController(options = {}) {
  const onView = options.onView || (() => {});
  const navigate = options.navigate || (() => false);
  const logger = options.logger || console;
  let view = { ...INITIAL_HOME_VIEW };
  let loaded = false;
  let destroyed = false;

  function patchView(patch) {
    if (destroyed) return;
    view = { ...view, ...patch };
    try {
      onView(patch);
    } catch (error) {
      try {
        if (logger && typeof logger.error === 'function') logger.error('HOME_VIEW_UPDATE_FAILED', error);
      } catch (_) {}
    }
  }

  function log(event, detail) {
    try {
      if (logger && typeof logger.log === 'function') logger.log(event, JSON.stringify(detail || {}));
    } catch (_) {}
  }

  function go(url, intent, source = 'button') {
    if (destroyed) return false;
    const fail = (error) => {
      patchView({ voiceHint: '页面打开失败，请使用下方按钮重试' });
      try {
        if (logger && typeof logger.error === 'function') logger.error('HOME_ROUTE_FAILED', error);
      } catch (_) {}
      return false;
    };
    try {
      const result = navigate(url);
      if (result === false) return fail(new Error('navigation returned false'));
      log('HOME_ROUTE', { intent, source, url });
      return true;
    } catch (error) {
      return fail(error);
    }
  }

  function goEasyGo(scenario = '', source = 'button') {
    const query = scenario ? `?scenario=${scenario}&source=${source}` : '';
    return go(`/pages/easygo/easygo${query}`, scenario || 'EASYGO', source);
  }

  function goMusic(source = 'button') {
    return go(`/pages/music/music?source=${source}`, ATTENTION_INTENT.MUSIC, source);
  }

  function handleTranscript(result) {
    const routed = routeTranscript(result.transcript);
    patchView({ lastTranscript: result.transcript });
    if (routed.intent === ATTENTION_INTENT.EASYGO_FITNESS) return goEasyGo('FITNESS', 'voice');
    if (routed.intent === ATTENTION_INTENT.EASYGO_VIDEO) return goEasyGo('VIDEO', 'voice');
    if (routed.intent === ATTENTION_INTENT.EASYGO_READING) return goEasyGo('READING', 'voice');
    if (routed.intent === ATTENTION_INTENT.MUSIC && routed.reason === 'MUSIC_ENTRY') return goMusic('voice');
    patchView({ voiceHint: '没听懂。请说“健身没动力”“想读论文”或“摇头演奏”。' });
    log('HOME_INTENT_REJECTED', { intent: routed.intent, reason: routed.reason });
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
    speech.load();
    return true;
  }

  function startListening() {
    if (!speech.start()) {
      const snapshot = speech.getSnapshot();
      if (!snapshot.view.speechAvailable) patchView({ voiceHint: '当前环境没有语音识别，请使用下方按钮。' });
      return false;
    }
    patchView({ voiceHint: '正在听，请说出你想做的事…' });
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
    return { view: { ...view }, loaded, destroyed, speech: speech.getSnapshot() };
  }

  return { load, startListening, stopListening, goEasyGo, goMusic, handleTranscript, destroy, getSnapshot };
}
