<script def>
{
  "navigationBarTitleText": "EasyGo",
  "description": "当用户明确表达想开始健身但缺少动力、想停止刷短视频却停不下来，或想读论文/文献但迟迟没开始时，调用这个最小行动引导页面。不要在用户仅询问知识、摘要或内容时调用。",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "scenario": {
          "type": "string",
          "enum": ["FITNESS", "VIDEO", "READING"],
          "description": "FITNESS 表示想健身但没动力；VIDEO 表示想停止刷视频但停不下来；READING 表示想读论文或文献但迟迟没开始。"
        }
      },
      "required": ["scenario"]
    }
  }
}
</script>

<script setup>
import {
  createEasyGoPageController,
  INITIAL_EASYGO_PAGE_VIEW
} from '../../lib/easygo-page-controller.js';
import { guardPhysicalTap } from '../../lib/physical-tap-guard.js';

export default {
  lastPhysicalCompleteAt: null,
  hardwareVoiceTimer: null,
  hardwareVoiceGeneration: 0,
  pageActive: false,

  data: {
    ...INITIAL_EASYGO_PAGE_VIEW
  },

  onLoad(query) {
    if (this.controller && !this.controller.getSnapshot().destroyed) return false;
    this.controller = createEasyGoPageController({
      onView: (patch) => this.setData(patch),
      speech: {
        SpeechRecognition: typeof SpeechRecognition === 'function' ? SpeechRecognition : null,
        SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance === 'function' ? SpeechSynthesisUtterance : null,
        speechSynthesis: typeof speechSynthesis !== 'undefined' ? speechSynthesis : null,
        listeningTimeoutMs: 8000
      },
      logger: console
    });
    this.controller.load(query || {});
    this.pageActive = true;
    return true;
  },

  onHide() {
    this.pageActive = false;
    this.clearHardwareVoice();
    if (this.controller) this.controller.stopListening();
  },

  onShow() {
    if (!this.controller || this.controller.getSnapshot().destroyed) return false;
    this.lastPhysicalCompleteAt = null;
    this.clearHardwareVoice();
    this.pageActive = true;
    return true;
  },

  onUnload() {
    this.pageActive = false;
    this.clearHardwareVoice();
    if (this.controller) this.controller.destroy();
  },

  onVoiceWakeup(event) {
    console.log('EASYGO_VOICE_WAKEUP');
    if (!this.pageActive) {
      console.log('EASYGO_HIDDEN_VOICE_WAKEUP_IGNORED');
      return false;
    }
    return this.controller ? this.controller.startListening() : false;
  },

  onKeyDown(event) {
    const code = event && event.code;
    if (!this.pageActive || (code !== 'Enter' && code !== 'GlobalHook')) return false;
    if (code === 'GlobalHook') return this.scheduleHardwareVoice();
    const resolvedPendingGesture = this.clearHardwareVoice();
    console.log('EASYGO_HARDWARE_VOICE_TRIGGER', JSON.stringify({
      code,
      source: resolvedPendingGesture ? 'single-tap-resolved' : 'direct-enter'
    }));
    return this.startListening();
  },

  onKeyUp(event) {
    const code = event && event.code;
    return Boolean(this.pageActive && (code === 'Enter' || code === 'GlobalHook'));
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
      console.log('EASYGO_HARDWARE_VOICE_TRIGGER', JSON.stringify({
        code: 'GlobalHook',
        source: 'delayed-fallback',
        delayMs: 650
      }));
      this.startListening();
    };
    const timer = schedule(callback, 650);
    if (firedSynchronously) return true;
    if (timer === null || timer === undefined) {
      console.error('EASYGO_HARDWARE_VOICE_TIMER_FAILED');
      return false;
    }
    this.hardwareVoiceTimer = timer;
    console.log('EASYGO_HARDWARE_VOICE_PENDING', JSON.stringify({ delayMs: 650 }));
    return true;
  },

  clearHardwareVoice() {
    this.hardwareVoiceGeneration += 1;
    if (this.hardwareVoiceTimer === null) return false;
    const cancel = this.hardwareClearTimeout || clearTimeout;
    try { cancel(this.hardwareVoiceTimer); } catch (error) {
      console.error('EASYGO_HARDWARE_VOICE_TIMER_CLEAR_FAILED', error);
    }
    this.hardwareVoiceTimer = null;
    return true;
  },

  startListening() {
    if (!this.pageActive) return false;
    return this.controller ? this.controller.startListening() : false;
  },
  handleStartFitness() { if (this.controller) this.controller.startFitness(); },
  handleStartVideo() { if (this.controller) this.controller.startVideo(); },
  handleStartReading() { if (this.controller) this.controller.startReading(); },
  handleComplete(event) {
    if (!this.pageActive) return false;
    const result = guardPhysicalTap(event, this.lastPhysicalCompleteAt, { now: this.physicalNow });
    if (!result.accepted) {
      console.log('EASYGO_DUPLICATE_TAP_IGNORED', JSON.stringify({
        control: 'complete', elapsed: result.elapsed, source: result.source
      }));
      return false;
    }
    this.lastPhysicalCompleteAt = result.acceptedAt;
    if (this.controller) this.controller.complete();
    return true;
  },
  handleTooHard() { if (this.controller) this.controller.tooHard(); },
  handlePause() { if (this.controller) this.controller.pause(); },
  handleRestart() { if (this.controller) this.controller.restart(); }
}
</script>

<page>
  <view class="container">
    <view class="topline">
      <text class="brand">EASYGO</text>
      <text class="status-pill">{{status}}</text>
      <button class="voice-btn" bindtap="startListening">
        {{recognitionState === 'LISTENING' ? '…' : '声'}}
      </button>
    </view>

    <view class="content-row">
      <view class="pet {{petState}}">
        <view class="sprout sprout-left"></view>
        <view class="sprout sprout-right"></view>
        <view class="pet-head">
          <view class="eye eye-left"></view>
          <view class="eye eye-right"></view>
          <view class="mouth"></view>
        </view>
        <view class="pet-body"></view>
        <view class="pet-shadow"></view>
      </view>

      <view class="info-panel">
        <view class="intro" ink:if="{{status === 'IDLE'}}">
          <text class="question">先选一个卡点</text>
          <text class="support">不用解释，只做最小一步。</text>
        </view>

        <view class="task" ink:if="{{status !== 'IDLE'}}">
          <text class="scenario">{{scenarioLabel}}</text>
          <text class="counter" ink:if="{{!terminal}}">{{stepIndex}} / {{stepCount}}</text>
          <text class="counter" ink:if="{{terminal}}">本轮结束</text>
          <text class="action">{{action}}</text>
        </view>
        <text class="receipt">{{receipt}}</text>
        <text class="voice-hint">{{voiceHint}}</text>
      </view>

      <view class="controls idle-controls" ink:if="{{status === 'IDLE'}}">
        <button class="choice fitness" bindtap="handleStartFitness">
          <text class="choice-icon">↗</text>
          <text class="choice-title">健身没动力</text>
        </button>
        <button class="choice video" bindtap="handleStartVideo">
          <text class="choice-icon">◫</text>
          <text class="choice-title">刷视频停不下</text>
        </button>
        <button class="choice reading" bindtap="handleStartReading">
          <text class="choice-icon">▤</text>
          <text class="choice-title">论文迟迟没开始</text>
        </button>
      </view>

      <view class="controls active-controls" ink:if="{{!terminal && status !== 'IDLE'}}">
        <button class="primary-btn" bindtap="handleComplete">我做到了</button>
        <view class="secondary-row">
          <button class="secondary-btn" bindtap="handleTooHard" ink:if="{{status !== 'RESIZED'}}">还是太难</button>
          <button class="secondary-btn" bindtap="handlePause">先停一下</button>
        </view>
      </view>

      <view class="controls terminal-controls" ink:if="{{terminal}}">
        <button class="primary-btn" bindtap="handleRestart">重新选择</button>
      </view>
    </view>
  </view>
</page>

<style>
.container {
  width: 480px;
  height: 150px;
  box-sizing: border-box;
  padding: 6px 10px;
  background-color: #000000;
  color: #f4fff9;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
}

.topline {
  width: 100%;
  height: 24px;
  display: flex;
  flex-direction: row;
  align-items: center;
}

.brand {
  color: #74f7ab;
  font-size: 15px;
  font-weight: bold;
  letter-spacing: 3px;
}

.status-pill {
  color: #8ca39a;
  border: 1px solid #244239;
  border-radius: 10px;
  padding: 2px 7px;
  font-size: 9px;
  margin-left: 9px;
}

.voice-btn {
  width: 32px;
  height: 22px;
  margin-left: auto;
  border-radius: 10px;
  border: 1px solid #285342;
  background-color: #10231c;
  color: #74f7ab;
  font-size: 10px;
  padding: 0;
}

.content-row {
  width: 100%;
  height: 114px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.pet {
  width: 64px;
  height: 72px;
  position: relative;
}

.pet-head {
  width: 38px;
  height: 34px;
  left: 11px;
  top: 14px;
  border-radius: 24px 24px 20px 20px;
  background-color: #b9ffd5;
  border: 2px solid #58db90;
  position: absolute;
  z-index: 3;
}

.pet-body {
  width: 30px;
  height: 20px;
  left: 15px;
  top: 46px;
  border-radius: 12px 12px 18px 18px;
  background-color: #74f7ab;
  border: 2px solid #58db90;
  position: absolute;
  z-index: 2;
}

.sprout {
  position: absolute;
  width: 15px;
  height: 8px;
  top: 6px;
  background-color: #74f7ab;
  border: 1px solid #58db90;
  border-radius: 80% 12% 80% 12%;
  z-index: 4;
}

.sprout-left { left: 20px; transform: rotate(22deg); }
.sprout-right { right: 20px; transform: rotate(68deg); }

.eye {
  width: 5px;
  height: 7px;
  background-color: #07100d;
  border-radius: 6px;
  position: absolute;
  top: 12px;
}

.eye-left { left: 9px; }
.eye-right { right: 9px; }

.mouth {
  position: absolute;
  width: 12px;
  height: 5px;
  border-bottom: 2px solid #176137;
  border-radius: 0 0 12px 12px;
  left: 13px;
  top: 21px;
}

.pet-shadow {
  width: 38px;
  height: 4px;
  left: 13px;
  top: 68px;
  position: absolute;
  border-radius: 50%;
  background-color: #020605;
}

.pet.guide .mouth { border-bottom-color: #0b9c4d; }
.pet.listening .eye { height: 4px; top: 18px; }
.pet.encourage .pet-head { border-color: #9bffd0; }
.pet.rest { opacity: 0.68; }
.pet.celebrate .sprout-left { transform: rotate(-12deg) scale(1.15); }
.pet.celebrate .sprout-right { transform: rotate(100deg) scale(1.15); }

.info-panel {
  width: 205px;
  height: 104px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.intro, .task {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.question {
  font-size: 18px;
  font-weight: bold;
}

.support, .scenario {
  color: #8ca39a;
  font-size: 10px;
  margin-top: 3px;
}

.counter {
  color: #74f7ab;
  font-size: 10px;
  margin-top: 2px;
}

.action {
  color: #f4fff9;
  font-size: 16px;
  line-height: 1.15;
  text-align: center;
  margin-top: 3px;
}

.controls {
  width: 176px;
  height: 104px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.idle-controls { justify-content: space-between; }

.choice {
  width: 176px;
  height: 31px;
  padding: 3px 9px;
  box-sizing: border-box;
  border-radius: 13px;
  border: 1px solid #285342;
  background-color: #10231c;
  color: #f4fff9;
  display: flex;
  flex-direction: row;
  align-items: center;
}

.choice-icon { color: #74f7ab; font-size: 15px; margin-right: 8px; }
.choice-title { font-size: 13px; font-weight: bold; }

.primary-btn {
  width: 176px;
  height: 38px;
  border-radius: 13px;
  border: 0;
  background-color: #74f7ab;
  color: #07100d;
  font-size: 14px;
  font-weight: bold;
}

.secondary-row {
  width: 176px;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  margin-top: 7px;
}

.secondary-btn {
  width: 84px;
  min-width: 0;
  height: 32px;
  margin: 0;
  border-radius: 11px;
  border: 1px solid #285342;
  background-color: #10231c;
  color: #b8cbc3;
  font-size: 11px;
}

.receipt {
  color: #49685b;
  font-size: 8px;
  margin-top: 4px;
  max-width: 200px;
  text-align: center;
}

.voice-hint { color: #8ca39a; font-size: 8px; margin-top: 2px; max-width: 200px; text-align: center; }
</style>
