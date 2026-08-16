<script def>
{
  "navigationBarTitleText": "摇摇乐",
  "description": "当用户明确请求摇头演奏、演奏眼镜、摇头音乐或进入摇摇乐时，打开这个具身音乐页面。普通听歌请求或用户明确拒绝音乐时不要调用。",
  "schema": {
    "data": {
      "type": "object",
      "properties": {}
    }
  }
}
</script>

<script setup>
import wx from 'wx';
import { AudioPlayer, Sound } from 'audio';
import { createMusicPageController } from '../../lib/music-page-controller.js';
import { guardPhysicalTap } from '../../lib/physical-tap-guard.js';

export default {
  lastPhysicalExitAt: null,
  hardwareTapTimer: null,
  hardwareTapGeneration: 0,
  hardwareVoiceTimer: null,
  hardwareVoiceGeneration: 0,
  hardwareVoiceEnterIgnoreUntil: 0,
  hardwareDoubleTapTimer: null,
  hardwareDoubleTapGeneration: 0,
  hardwareGlobalHookDownAt: null,
  hardwareSwipeBackIgnoreUntil: 0,
  pageActive: false,

  data: {
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
    activeKey: '—'
  },

  onLoad() {
    if (this.controller && !this.controller.getSnapshot().destroyed) return false;
    this.controller = createMusicPageController({
      AudioPlayer,
      Sound,
      sensorRecoveryDelayMs: 250,
      AbsoluteOrientationSensor: typeof AbsoluteOrientationSensor === 'function' ? AbsoluteOrientationSensor : null,
      Gyroscope: typeof Gyroscope === 'function' ? Gyroscope : null,
      speech: {
        SpeechRecognition: typeof SpeechRecognition === 'function' ? SpeechRecognition : null,
        SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance === 'function' ? SpeechSynthesisUtterance : null,
        speechSynthesis: typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
      },
      onExit: () => this.navigateExit('voice'),
      onView: (patch) => this.setData(patch),
      logger: console
    });
    this.controller.load();
    this.pageActive = true;
    return true;
  },

  onUnload() {
    this.pageActive = false;
    this.clearHardwareTap();
    this.clearHardwareVoice();
    this.clearHardwareDoubleTap();
    this.hardwareSwipeBackIgnoreUntil = 0;
    if (this.controller) this.controller.destroy();
  },

  onHide() {
    this.pageActive = false;
    this.clearHardwareTap();
    this.clearHardwareVoice();
    this.clearHardwareDoubleTap();
    this.hardwareSwipeBackIgnoreUntil = 0;
    if (this.controller) this.controller.suspend();
  },

  onShow() {
    if (!this.controller || this.controller.getSnapshot().destroyed) return false;
    this.lastPhysicalExitAt = null;
    this.clearHardwareTap();
    this.clearHardwareVoice();
    this.clearHardwareDoubleTap();
    this.hardwareVoiceEnterIgnoreUntil = 0;
    this.hardwareGlobalHookDownAt = null;
    this.hardwareSwipeBackIgnoreUntil = 0;
    this.pageActive = true;
    this.controller.resume();
    return true;
  },

  onVoiceWakeup(event) {
    console.log('MUSIC_VOICE_WAKEUP');
    if (!this.pageActive) {
      console.log('MUSIC_HIDDEN_VOICE_WAKEUP_IGNORED');
      return false;
    }
    return this.controller ? this.controller.startListening() : false;
  },

  onKeyDown(event) {
    const code = event && event.code;
    if (!this.pageActive) return false;
    if (code === 'GlobalHook') {
      if (this.hardwareVoiceTimer === null) {
        const clock = this.hardwareNow || Date.now;
        this.hardwareGlobalHookDownAt = clock();
      }
      return this.scheduleHardwareVoice();
    }
    if (code === 'Enter') return this.handleHardwareEnter(code, 'key-down');
    if (code === 'ArrowRight' || code === 'ArrowLeft' || code === 'ArrowDown' || code === 'ArrowUp') {
      return this.handleHardwareSwipe(code);
    }
    if (this.hardwareVoiceTimer !== null) {
      this.clearHardwareVoice();
      console.log('MUSIC_HARDWARE_GESTURE_RESOLVED', JSON.stringify({ code, result: 'NOT_LONG_PRESS' }));
    }
    if (code === 'Backspace' || code === 'Escape') {
      const clock = this.hardwareNow || Date.now;
      if (code === 'Backspace' && clock() <= this.hardwareSwipeBackIgnoreUntil) {
        console.log('MUSIC_HARDWARE_SWIPE_BACK_IGNORED', JSON.stringify({ code, phase: 'key-down' }));
        return true;
      }
      this.clearHardwareTap();
      this.hardwareSwipeBackIgnoreUntil = 0;
      this.hardwareVoiceEnterIgnoreUntil = 0;
      console.log('MUSIC_HARDWARE_DOUBLE_TAP', JSON.stringify({ code, source: 'firmware-back' }));
      return this.navigateExit('double-tap');
    }
    return false;
  },

  onKeyUp(event) {
    const code = event && event.code;
    if (!this.pageActive) return false;
    if (code === 'GlobalHook') return this.resolveGlobalHookRelease();
    if (code === 'Backspace') {
      const clock = this.hardwareNow || Date.now;
      if (clock() <= this.hardwareSwipeBackIgnoreUntil) {
        console.log('MUSIC_HARDWARE_SWIPE_BACK_IGNORED', JSON.stringify({ code, phase: 'key-up' }));
        return true;
      }
      return false;
    }
    if (code === 'ArrowRight' || code === 'ArrowLeft' || code === 'ArrowDown' || code === 'ArrowUp') {
      return true;
    }
    if (code !== 'Enter') return false;
    const clock = this.hardwareNow || Date.now;
    if (this.hardwareVoiceTimer === null && this.hardwareDoubleTapTimer === null &&
      clock() > this.hardwareVoiceEnterIgnoreUntil) return false;
    return this.handleHardwareEnter(code, 'key-up');
  },

  resolveGlobalHookRelease() {
    const clock = this.hardwareNow || Date.now;
    const releasedAt = clock();
    const pressedAt = this.hardwareGlobalHookDownAt;
    this.hardwareGlobalHookDownAt = null;
    if (this.hardwareVoiceTimer === null) {
      return releasedAt <= this.hardwareVoiceEnterIgnoreUntil;
    }
    this.clearHardwareVoice();
    const heldMs = Number.isFinite(pressedAt) ? Math.max(0, releasedAt - pressedAt) : 0;
    if (heldMs >= 650) {
      this.clearHardwareTap();
      this.hardwareVoiceEnterIgnoreUntil = releasedAt + 1200;
      console.log('MUSIC_HARDWARE_VOICE_TRIGGER', JSON.stringify({
        code: 'GlobalHook',
        source: 'release-long-press',
        heldMs
      }));
      this.startListening();
      return true;
    }
    return this.scheduleFirmwareDoubleTapExit();
  },

  handleHardwareSwipe(code) {
    const hadPendingGesture = this.hardwareVoiceTimer !== null || this.hardwareDoubleTapTimer !== null;
    this.clearHardwareVoice();
    this.clearHardwareDoubleTap();
    this.hardwareGlobalHookDownAt = null;
    if (hadPendingGesture) {
      console.log('MUSIC_HARDWARE_GESTURE_RESOLVED', JSON.stringify({
        code,
        source: 'direction-key',
        result: 'SWIPE'
      }));
    }
    if (code === 'ArrowRight' || code === 'ArrowLeft') {
      const clock = this.hardwareNow || Date.now;
      this.hardwareSwipeBackIgnoreUntil = clock() + 1000;
      console.log('MUSIC_HARDWARE_SWIPE_BACK_GUARD', JSON.stringify({ code, durationMs: 1000 }));
      return this.cycleInstrument(code === 'ArrowRight' ? 1 : -1);
    }
    console.log('MUSIC_HARDWARE_SWIPE_ALIAS_CONSUMED', JSON.stringify({ code }));
    return true;
  },

  handleHardwareEnter(code, source) {
    if (this.hardwareVoiceTimer !== null || this.hardwareDoubleTapTimer !== null) {
      this.clearHardwareVoice();
      this.clearHardwareDoubleTap();
      console.log('MUSIC_HARDWARE_GESTURE_RESOLVED', JSON.stringify({
        code,
        source,
        result: 'TAP'
      }));
    }
    const clock = this.hardwareNow || Date.now;
    const receivedAt = clock();
    if (receivedAt <= this.hardwareVoiceEnterIgnoreUntil) {
      this.hardwareVoiceEnterIgnoreUntil = 0;
      console.log('MUSIC_HARDWARE_VOICE_RELEASE_IGNORED', JSON.stringify({ code, source }));
      return true;
    }
    this.hardwareVoiceEnterIgnoreUntil = 0;
    if (this.hardwareTapTimer !== null) {
      this.clearHardwareTap();
      console.log('MUSIC_HARDWARE_DOUBLE_TAP', JSON.stringify({ code, source: `two-enter-${source}` }));
      return this.navigateExit('double-tap');
    }
    const generation = ++this.hardwareTapGeneration;
    const schedule = this.hardwareSetTimeout || setTimeout;
    let firedSynchronously = false;
    const callback = () => {
      firedSynchronously = true;
      if (generation !== this.hardwareTapGeneration) return;
      this.hardwareTapTimer = null;
      if (!this.pageActive) return;
      console.log('MUSIC_HARDWARE_SINGLE_TAP', JSON.stringify({ code, source }));
      this.togglePlayback();
    };
    const timer = schedule(callback, 280);
    if (firedSynchronously) return true;
    if (timer === null || timer === undefined) {
      console.error('MUSIC_HARDWARE_TAP_TIMER_FAILED');
      return this.togglePlayback();
    }
    this.hardwareTapTimer = timer;
    return true;
  },

  scheduleHardwareVoice() {
    if (this.hardwareVoiceTimer !== null) return true;
    const generation = ++this.hardwareVoiceGeneration;
    const schedule = this.hardwareSetTimeout || setTimeout;
    let firedSynchronously = false;
    const callback = () => {
      firedSynchronously = true;
      if (generation !== this.hardwareVoiceGeneration) return;
      this.hardwareVoiceTimer = null;
      if (!this.pageActive) return;
      this.clearHardwareTap();
      const clock = this.hardwareNow || Date.now;
      this.hardwareVoiceEnterIgnoreUntil = clock() + 1200;
      console.log('MUSIC_HARDWARE_VOICE_TRIGGER', JSON.stringify({
        code: 'GlobalHook',
        source: 'delayed-long-press',
        delayMs: 650
      }));
      this.startListening();
    };
    const timer = schedule(callback, 650);
    if (firedSynchronously) return true;
    if (timer === null || timer === undefined) {
      console.error('MUSIC_HARDWARE_VOICE_TIMER_FAILED');
      return true;
    }
    this.hardwareVoiceTimer = timer;
    console.log('MUSIC_HARDWARE_VOICE_PENDING', JSON.stringify({ delayMs: 650 }));
    return true;
  },

  scheduleFirmwareDoubleTapExit() {
    if (this.hardwareDoubleTapTimer !== null) return true;
    const generation = ++this.hardwareDoubleTapGeneration;
    const schedule = this.hardwareSetTimeout || setTimeout;
    let firedSynchronously = false;
    const callback = () => {
      firedSynchronously = true;
      if (generation !== this.hardwareDoubleTapGeneration) return;
      this.hardwareDoubleTapTimer = null;
      if (!this.pageActive) return;
      console.log('MUSIC_HARDWARE_DOUBLE_TAP', JSON.stringify({
        code: 'GlobalHook',
        source: 'quick-release-without-enter'
      }));
      this.navigateExit('double-tap');
    };
    const timer = schedule(callback, 580);
    if (firedSynchronously) return true;
    if (timer === null || timer === undefined) {
      console.error('MUSIC_HARDWARE_DOUBLE_TAP_TIMER_FAILED');
      return true;
    }
    this.hardwareDoubleTapTimer = timer;
    console.log('MUSIC_HARDWARE_DOUBLE_TAP_PENDING', JSON.stringify({ delayMs: 580 }));
    return true;
  },

  clearHardwareTap() {
    this.hardwareTapGeneration += 1;
    if (this.hardwareTapTimer === null) return false;
    const cancel = this.hardwareClearTimeout || clearTimeout;
    try { cancel(this.hardwareTapTimer); } catch (error) {
      console.error('MUSIC_HARDWARE_TAP_TIMER_CLEAR_FAILED', error);
    }
    this.hardwareTapTimer = null;
    return true;
  },

  clearHardwareVoice() {
    this.hardwareVoiceGeneration += 1;
    if (this.hardwareVoiceTimer === null) return false;
    const cancel = this.hardwareClearTimeout || clearTimeout;
    try { cancel(this.hardwareVoiceTimer); } catch (error) {
      console.error('MUSIC_HARDWARE_VOICE_TIMER_CLEAR_FAILED', error);
    }
    this.hardwareVoiceTimer = null;
    return true;
  },

  clearHardwareDoubleTap() {
    this.hardwareDoubleTapGeneration += 1;
    if (this.hardwareDoubleTapTimer === null) return false;
    const cancel = this.hardwareClearTimeout || clearTimeout;
    try { cancel(this.hardwareDoubleTapTimer); } catch (error) {
      console.error('MUSIC_HARDWARE_DOUBLE_TAP_TIMER_CLEAR_FAILED', error);
    }
    this.hardwareDoubleTapTimer = null;
    return true;
  },

  calibrate() {
    if (this.controller) this.controller.calibrate();
  },

  start() {
    if (this.controller) this.controller.start();
  },

  togglePlayback() {
    return this.controller ? this.controller.togglePlayback() : false;
  },

  pause() {
    if (this.controller) this.controller.pause();
  },

  selectInstrument(instrumentId) {
    return this.controller ? this.controller.setInstrument(instrumentId) : false;
  },

  cycleInstrument(direction) {
    const instruments = ['PIANO', 'MUSIC_BOX', 'GUITAR', 'WOODFISH'];
    const current = Math.max(0, instruments.indexOf(this.data.instrumentId));
    const next = (current + (direction < 0 ? -1 : 1) + instruments.length) % instruments.length;
    return this.selectInstrument(instruments[next]);
  },

  selectPiano() { return this.selectInstrument('PIANO'); },
  selectMusicBox() { return this.selectInstrument('MUSIC_BOX'); },
  selectGuitar() { return this.selectInstrument('GUITAR'); },
  selectWoodfish() { return this.selectInstrument('WOODFISH'); },

  startListening() {
    if (!this.pageActive) return false;
    return this.controller ? this.controller.startListening() : false;
  },

  navigateExit(source = 'button') {
    if (!this.pageActive) return false;
    this.clearHardwareTap();
    this.clearHardwareVoice();
    this.clearHardwareDoubleTap();
    this.hardwareVoiceEnterIgnoreUntil = 0;
    this.hardwareGlobalHookDownAt = null;
    this.hardwareSwipeBackIgnoreUntil = 0;
    if (this.controller) this.controller.pause();
    let failureHandled = false;
    const handleFailure = (error) => {
      if (failureHandled || (this.controller && this.controller.getSnapshot().destroyed)) return;
      failureHandled = true;
      try {
        this.setData({ hint: '退出失败，请再次双击触控板' });
      } catch (viewError) {
        console.error('MUSIC_NAVIGATION_VIEW_UPDATE_FAILED', viewError);
      }
      console.error('MUSIC_NAVIGATION_FAILED', error);
    };
    try {
      const result = wx.navigateBack({ fail: handleFailure });
      if (result === false) {
        handleFailure(new Error('navigateBack returned false'));
        return false;
      }
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then((value) => {
          if (value === false) handleFailure(new Error('navigateBack returned false'));
        }, handleFailure);
      }
      console.log('MUSIC_EXIT_NAVIGATION', JSON.stringify({ source }));
      return true;
    } catch (error) {
      handleFailure(error);
      return false;
    }
  },

  exit(event) {
    if (!this.pageActive) return false;
    const tap = guardPhysicalTap(event, this.lastPhysicalExitAt, { now: this.physicalNow });
    if (!tap.accepted) {
      console.log('MUSIC_DUPLICATE_EXIT_IGNORED', JSON.stringify({ elapsed: tap.elapsed, source: tap.source }));
      return false;
    }
    this.lastPhysicalExitAt = tap.acceptedAt;
    return this.navigateExit('button');
  },

  simulateZone(zone) {
    if (this.controller) this.controller.simulateZone(zone);
  },

  z0() { this.simulateZone(0); },
  z1() { this.simulateZone(1); },
  z2() { this.simulateZone(2); },
  z3() { this.simulateZone(3); },
  z4() { this.simulateZone(4); },
  z5() { this.simulateZone(5); },
  z6() { this.simulateZone(6); },
  z7() { this.simulateZone(7); },
  z8() { this.simulateZone(8); },
  z9() { this.simulateZone(9); },
  z10() { this.simulateZone(10); },
  z11() { this.simulateZone(11); }
}
</script>

<page>
  <view class="container instrument-{{instrumentId}}">
    <view class="topline">
      <view class="brand"><text class="brand-label">摇摇乐</text></view>
      <view class="instrument-switcher">
        <view class="instrument-chip {{instrumentId === 'PIANO' ? 'active' : ''}}" bindtap="selectPiano"><text class="instrument-label">钢琴</text></view>
        <view class="instrument-chip instrument-chip-wide {{instrumentId === 'MUSIC_BOX' ? 'active' : ''}}" bindtap="selectMusicBox"><text class="instrument-label">八音盒</text></view>
        <view class="instrument-chip {{instrumentId === 'GUITAR' ? 'active' : ''}}" bindtap="selectGuitar"><text class="instrument-label">吉他</text></view>
        <view class="instrument-chip {{instrumentId === 'WOODFISH' ? 'active' : ''}}" bindtap="selectWoodfish"><text class="instrument-label">木鱼</text></view>
        <text class="switch-hint">左右滑切换</text>
      </view>
      <view class="status-copy">
        <text class="listening" ink:if="{{recognitionState === 'LISTENING'}}">正在听</text>
        <text class="playing-status">{{status === 'PLAYING' ? '正在演奏' : status === 'PAUSED' ? '已暂停' : '等待开始'}}</text>
        <text class="sensor-status">{{sensorMode === 'IMU_ACTIVE' ? '动作已连接' : sensorMode === 'IMU_WAITING' ? '正在连接' : '体验模式'}}</text>
      </view>
    </view>

    <view class="music-stage {{pulse ? 'pulse-a' : 'pulse-b'}}">
      <view class="note-focus"></view>
      <view class="tone-line">
        <text class="current-note">{{note}}</text>
        <text class="tone-meta">{{instrumentLabel}} · {{cadenceLabel}}</text>
      </view>

      <view class="keyboard">
        <button class="piano-key {{activeKey === 'C' ? 'active' : ''}}" bindtap="z4"><text>C</text></button>
        <button class="piano-key {{activeKey === 'D' ? 'active' : ''}}" bindtap="z5"><text>D</text></button>
        <button class="piano-key {{activeKey === 'E' ? 'active' : ''}}" bindtap="z6"><text>E</text></button>
        <button class="piano-key {{activeKey === 'F' ? 'active' : ''}}" bindtap="z7"><text>F</text></button>
        <button class="piano-key {{activeKey === 'G' ? 'active' : ''}}" bindtap="z8"><text>G</text></button>
        <button class="piano-key {{activeKey === 'A' ? 'active' : ''}}" bindtap="z9"><text>A</text></button>
        <button class="piano-key {{activeKey === 'B' ? 'active' : ''}}" bindtap="z10"><text>B</text></button>
      </view>
    </view>

    <view class="bottom-guide">
      <text>轻摇头部演奏　单击：{{status === 'PLAYING' ? '暂停' : '开始 / 继续'}}　双击：退出　长按：语音</text>
    </view>
  </view>
</page>

<style>
.container {
  width: 480px;
  height: 150px;
  box-sizing: border-box;
  padding: 5px 10px;
  background-color: #000000;
  color: #f5f0e7;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
}

.topline {
  width: 100%;
  height: 27px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.brand { width: 70px; height: 25px; display: flex; flex-direction: row; align-items: center; justify-content: flex-start; }
.brand-label { color: #ffd08a; font-size: 16px; font-weight: bold; letter-spacing: 2px; }
.listening { color: #8fffe1; font-size: 8px; margin-right: 5px; }

.instrument-switcher {
  width: 250px;
  height: 25px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.instrument-chip {
  width: 44px;
  height: 22px;
  margin-right: 2px;
  padding: 0;
  border: 1px solid #3d354f;
  border-radius: 11px;
  background-color: #171223;
  color: #8e859d;
  font-size: 9px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.instrument-chip-wide { width: 54px; }
.instrument-label { font-size: 9px; line-height: 10px; }

.instrument-chip.active {
  border-color: #8fffe1;
  background-color: #18302d;
  color: #f5f0e7;
  box-shadow: 0 0 9px rgba(143, 255, 225, 0.2);
}

.instrument-MUSIC_BOX .instrument-chip.active { border-color: #ffd08a; background-color: #332718; }
.instrument-GUITAR .instrument-chip.active { border-color: #ffb477; background-color: #382318; }
.instrument-WOODFISH .instrument-chip.active { border-color: #ef8c72; background-color: #361d19; }
.switch-hint { color: #645c72; font-size: 8px; margin-left: 3px; }

.status-copy {
  width: 120px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
}

.playing-status { color: #d8d0df; font-size: 9px; opacity: 0.48; }
.sensor-status { color: #8e859d; font-size: 8px; opacity: 0.42; margin-left: 6px; }

.music-stage {
  width: 100%;
  height: 92px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  background-image: url('../../assets/icons/music-note.png');
  background-repeat: no-repeat;
  background-position: center 1px;
  background-size: 33px 33px;
}

.music-stage.pulse-a { background-size: 37px 37px; background-position: center 0; }
.music-stage.pulse-b { background-size: 32px 32px; background-position: center 2px; }

.note-focus {
  width: 100px;
  height: 31px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.tone-line {
  width: 220px;
  height: 12px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
}

.current-note { color: #f5f0e7; font-size: 10px; font-weight: bold; min-width: 22px; }
.tone-meta { color: #8e859d; font-size: 8px; opacity: 0.58; margin-left: 5px; }

.keyboard {
  width: 270px;
  height: 46px;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: center;
  opacity: 0.46;
}

.piano-key {
  width: 35px;
  height: 43px;
  margin: 0 2px;
  padding: 0;
  border: 1px solid #8e859d;
  border-radius: 3px 3px 7px 7px;
  background-color: #d8d2dd;
  color: #201a2b;
  font-size: 8px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  opacity: 0.58;
  transition: transform 120ms ease-out, opacity 120ms ease-out;
}

.piano-key.active {
  background-color: #8fffe1;
  border-color: #d9fff4;
  opacity: 1;
  transform: translateY(-3px);
  box-shadow: 0 0 14px rgba(143, 255, 225, 0.7);
}

.instrument-MUSIC_BOX .piano-key.active { background-color: #ffd08a; border-color: #fff0c9; box-shadow: 0 0 14px rgba(255, 208, 138, 0.65); }
.instrument-GUITAR .piano-key.active { background-color: #ffb477; border-color: #ffe0c5; box-shadow: 0 0 14px rgba(255, 180, 119, 0.65); }
.instrument-WOODFISH .piano-key.active { background-color: #ef8c72; border-color: #ffd3c8; box-shadow: 0 0 14px rgba(239, 140, 114, 0.65); }

.bottom-guide {
  width: 100%;
  height: 21px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8e859d;
  font-size: 9px;
  opacity: 0.52;
  border-top: 1px solid #211a2c;
}
</style>
