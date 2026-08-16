<script def>
{
  "navigationBarTitleText": "Attention Back"
}
</script>

<script setup>
import wx from 'wx';
import { createHomePageController, INITIAL_HOME_VIEW } from '../../lib/home-page-controller.js';
import { guardPhysicalTap } from '../../lib/physical-tap-guard.js';

export default {
  lastPhysicalEntryAt: null,
  hardwareVoiceTimer: null,
  hardwareVoiceGeneration: 0,
  hardwareGlobalHookPressed: false,
  pageActive: false,

  data: {
    title: 'Attention Back',
    subtitle: '把注意力交还给你',
    selectedEntry: 'EASYGO',
    entryGuide: '当前 EasyGo · 单击进入',
    switchGuide: '向右滑 · 切换摇摇乐',
    ...INITIAL_HOME_VIEW
  },

  onLoad() {
    if (this.controller && !this.controller.getSnapshot().destroyed) return false;
    this.controller = createHomePageController({
      navigate: (url) => {
        let failureHandled = false;
        const handleFailure = (error) => {
          if (failureHandled || (this.controller && this.controller.getSnapshot().destroyed)) return;
          failureHandled = true;
          try {
            this.setData({ voiceHint: '页面打开失败，请点击入口重试。' });
          } catch (viewError) {
            console.error('HOME_NAVIGATION_VIEW_UPDATE_FAILED', viewError);
          }
          console.error('HOME_NAVIGATION_FAILED', error);
        };
        try {
          const result = wx.navigateTo({ url, fail: handleFailure });
          if (result === false) {
            handleFailure(new Error('navigateTo returned false'));
            return false;
          }
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).then((value) => {
              if (value === false) handleFailure(new Error('navigateTo returned false'));
            }, handleFailure);
          }
          return result;
        } catch (error) {
          handleFailure(error);
          return false;
        }
      },
      onView: (patch) => this.setData(patch),
      speech: {
        SpeechRecognition: typeof SpeechRecognition === 'function' ? SpeechRecognition : null,
        SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance === 'function' ? SpeechSynthesisUtterance : null,
        speechSynthesis: typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
      },
      logger: console
    });
    this.controller.load();
    this.pageActive = true;
    console.log('HOME_READY');
    return true;
  },

  onHide() {
    this.pageActive = false;
    this.hardwareGlobalHookPressed = false;
    this.clearHardwareVoice();
    if (this.controller) this.controller.stopListening();
  },

  onShow() {
    if (!this.controller || this.controller.getSnapshot().destroyed) return false;
    this.lastPhysicalEntryAt = null;
    this.hardwareGlobalHookPressed = false;
    this.clearHardwareVoice();
    this.pageActive = true;
    return true;
  },

  onUnload() {
    this.pageActive = false;
    this.hardwareGlobalHookPressed = false;
    this.clearHardwareVoice();
    if (this.controller) this.controller.destroy();
  },

  onVoiceWakeup(event) {
    console.log('HOME_VOICE_WAKEUP');
    if (!this.pageActive) {
      console.log('HOME_HIDDEN_VOICE_WAKEUP_IGNORED');
      return false;
    }
    return this.controller ? this.controller.startListening() : false;
  },

  onKeyDown(event) {
    const code = event && event.code;
    if (!this.pageActive) return false;
    if (code === 'GlobalHook') {
      if (this.hardwareGlobalHookPressed) return true;
      this.hardwareGlobalHookPressed = true;
      if (this.hardwareVoiceTimer !== null) {
        this.clearHardwareVoice();
        return this.pushRootBackGuard();
      }
      return this.scheduleHardwareVoice();
    }
    if (code === 'Backspace' || code === 'Escape') {
      this.clearHardwareVoice();
      console.log('HOME_ROOT_BACK_CONSUMED', JSON.stringify({ code }));
      return true;
    }
    if (code === 'ArrowLeft' || code === 'ArrowUp') {
      this.clearHardwareVoice();
      return this.selectEntry('EASYGO', code);
    }
    if (code === 'ArrowRight' || code === 'ArrowDown') {
      this.clearHardwareVoice();
      return this.selectEntry('MUSIC', code);
    }
    if (code !== 'Enter') return false;
    this.clearHardwareVoice();
    const selectedEntry = this.data.selectedEntry === 'MUSIC' ? 'MUSIC' : 'EASYGO';
    console.log('HOME_HARDWARE_OPEN', JSON.stringify({ code, selectedEntry }));
    return selectedEntry === 'MUSIC'
      ? Boolean(this.controller && this.controller.goMusic('hardware'))
      : Boolean(this.controller && this.controller.goEasyGo('', 'hardware'));
  },

  onKeyUp(event) {
    const code = event && event.code;
    if (code === 'GlobalHook') this.hardwareGlobalHookPressed = false;
    return Boolean(this.pageActive && (
      code === 'GlobalHook' || code === 'Enter' ||
      code === 'Backspace' || code === 'Escape' ||
      code === 'ArrowLeft' || code === 'ArrowRight' ||
      code === 'ArrowUp' || code === 'ArrowDown'
    ));
  },

  pushRootBackGuard() {
    if (!this.pageActive) return false;
    let failureHandled = false;
    const handleFailure = (error) => {
      if (failureHandled) return;
      failureHandled = true;
      console.error('HOME_ROOT_BACK_GUARD_FAILED', error);
    };
    try {
      const result = wx.navigateTo({
        url: '/pages/index/index?source=root-back-guard',
        fail: handleFailure
      });
      if (result === false) handleFailure(new Error('root back guard navigateTo returned false'));
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then((value) => {
          if (value === false) handleFailure(new Error('root back guard navigateTo returned false'));
        }, handleFailure);
      }
      console.log('HOME_ROOT_BACK_GUARD_PUSHED');
      return true;
    } catch (error) {
      handleFailure(error);
      return true;
    }
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
      console.log('HOME_HARDWARE_VOICE_TRIGGER', JSON.stringify({
        code: 'GlobalHook',
        source: 'delayed-fallback',
        delayMs: 650
      }));
      this.startListening();
    };
    const timer = schedule(callback, 650);
    if (firedSynchronously) return true;
    if (timer === null || timer === undefined) {
      console.error('HOME_HARDWARE_VOICE_TIMER_FAILED');
      return false;
    }
    this.hardwareVoiceTimer = timer;
    console.log('HOME_HARDWARE_VOICE_PENDING', JSON.stringify({ delayMs: 650 }));
    return true;
  },

  clearHardwareVoice() {
    this.hardwareVoiceGeneration += 1;
    if (this.hardwareVoiceTimer === null) return false;
    const cancel = this.hardwareClearTimeout || clearTimeout;
    try { cancel(this.hardwareVoiceTimer); } catch (error) {
      console.error('HOME_HARDWARE_VOICE_TIMER_CLEAR_FAILED', error);
    }
    this.hardwareVoiceTimer = null;
    return true;
  },

  selectEntry(selectedEntry, code = '') {
    if (!this.pageActive || (selectedEntry !== 'EASYGO' && selectedEntry !== 'MUSIC')) return false;
    this.setData(selectedEntry === 'MUSIC'
      ? {
          selectedEntry,
          entryGuide: '当前摇摇乐 · 单击进入',
          switchGuide: '向左滑 · 切换 EasyGo'
        }
      : {
          selectedEntry,
          entryGuide: '当前 EasyGo · 单击进入',
          switchGuide: '向右滑 · 切换摇摇乐'
        });
    console.log('HOME_HARDWARE_SELECTION', JSON.stringify({ code, selectedEntry }));
    return true;
  },

  startListening() {
    if (!this.pageActive) return false;
    return this.controller ? this.controller.startListening() : false;
  },

  acceptPhysicalEntry(event) {
    if (!this.pageActive) return false;
    const result = guardPhysicalTap(event, this.lastPhysicalEntryAt, { now: this.physicalNow });
    if (!result.accepted) {
      console.log('HOME_DUPLICATE_TAP_IGNORED', JSON.stringify({ elapsed: result.elapsed, source: result.source }));
      return false;
    }
    this.lastPhysicalEntryAt = result.acceptedAt;
    return true;
  },

  goEasyGo(event) {
    if (!this.acceptPhysicalEntry(event)) return false;
    if (this.controller) this.controller.goEasyGo();
    return true;
  },

  goMusic(event) {
    if (!this.acceptPhysicalEntry(event)) return false;
    if (this.controller) this.controller.goMusic();
    return true;
  }
}
</script>

<page>
  <view class="container">
    <view class="brand-panel">
      <text class="eyebrow">ATTENTION</text>
      <text class="title">BACK</text>
      <text class="subtitle">{{ subtitle }}</text>
    </view>

    <view class="scene-panel">
      <view class="scene-list">
        <button
          class="scene-card {{selectedEntry === 'EASYGO' ? 'selected' : ''}}"
          bindtap="goEasyGo"
        >
          <text class="scene-name">EasyGo</text>
          <text class="scene-desc">最小行动引导</text>
        </button>

        <button
          class="scene-card {{selectedEntry === 'MUSIC' ? 'selected' : ''}}"
          bindtap="goMusic"
        >
          <text class="scene-name">摇摇乐</text>
          <text class="scene-desc">摇头演奏音符</text>
        </button>
      </view>
      <view class="entry-guide">
        <text class="entry-guide-primary">{{entryGuide}}</text>
        <text class="entry-guide-secondary">{{switchGuide}}</text>
      </view>
    </view>

    <view class="voice-panel">
      <button class="voice-btn" bindtap="startListening">
        {{recognitionState === 'LISTENING' ? '…' : '声'}}
      </button>
      <text class="voice-title">说出想做的事</text>
      <text class="voice-hint">{{voiceHint}}</text>
    </view>
  </view>
</page>

<style>
.container {
  width: 480px;
  height: 150px;
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: #000000;
  padding: 8px 12px;
  overflow: hidden;
}

.brand-panel {
  width: 112px;
  height: 126px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  border-left: 3px solid var(--color-primary);
  padding-left: 10px;
  box-sizing: border-box;
}

.eyebrow {
  font-size: 10px;
  letter-spacing: 2px;
  color: var(--color-text-secondary);
}

.title {
  font-size: 25px;
  font-weight: bold;
  color: var(--color-primary);
  line-height: 1;
  margin-top: 2px;
}

.subtitle {
  font-size: 11px;
  color: var(--color-text-secondary);
  margin-top: 7px;
  line-height: 1.25;
}

.scene-panel {
  width: 220px;
  height: 126px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.scene-list {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  width: 220px;
}

.scene-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  padding: 9px 10px;
  background-color: var(--color-surface);
  border: var(--border-width-default) solid var(--card-border-color);
  border-radius: var(--radius-md);
  width: 106px;
  height: 88px;
  text-align: left;
  box-sizing: border-box;
}

.scene-card.selected {
  border-color: var(--color-primary);
  background-color: #102b22;
  box-shadow: 0 0 12px rgba(64, 255, 94, 0.35);
}

.scene-name {
  font-size: 17px;
  font-weight: bold;
  color: var(--color-text-primary);
}

.scene-desc {
  font-size: 10px;
  color: var(--color-text-secondary);
  margin-top: 7px;
  line-height: 1.3;
}

.entry-guide {
  width: 220px;
  height: 29px;
  margin-top: 5px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  padding: 0 7px;
  border: 1px solid var(--color-primary);
  border-radius: 8px;
  background-color: #102b22;
}

.entry-guide-primary {
  font-size: 10px;
  font-weight: bold;
  color: var(--color-text-primary);
}

.entry-guide-secondary {
  font-size: 9px;
  color: var(--color-primary);
}

.voice-panel {
  width: 116px;
  height: 126px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.voice-btn {
  width: 48px;
  height: 38px;
  border: var(--border-width-default) solid var(--card-border-color);
  border-radius: 18px;
  background-color: var(--color-surface);
  color: var(--color-primary);
  font-size: 15px;
}

.voice-title { font-size: 11px; color: var(--color-text-primary); margin-top: 6px; }
.voice-hint { font-size: 9px; color: var(--color-text-secondary); margin-top: 4px; text-align: center; line-height: 1.25; }

</style>
