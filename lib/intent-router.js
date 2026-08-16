import { EASYGO_EVENT, EASYGO_STATUS } from './easygo-core.js';

export const ATTENTION_INTENT = Object.freeze({
  EASYGO_FITNESS: 'EASYGO_FITNESS',
  EASYGO_VIDEO: 'EASYGO_VIDEO',
  EASYGO_READING: 'EASYGO_READING',
  MUSIC: 'MUSIC',
  CALIBRATE: 'CALIBRATE',
  EXIT: 'EXIT',
  DONE: 'DONE',
  TOO_HARD: 'TOO_HARD',
  PAUSE: 'PAUSE',
  RESTART: 'RESTART',
  UNKNOWN: 'UNKNOWN'
});

const VIDEO_WORDS = ['刷视频', '短视频', '抖音', '小红书', 'reels', 'youtube', '哔哩哔哩', 'b站'];
const VIDEO_ESCAPE_WORDS = [
  '停不下来', '停不了', '刷个不停', '不想刷', '不想再刷', '不再刷', '停止刷', '停下刷',
  '别刷', '别再刷', '少刷', '戒掉', '控制不住', '刷太久', '一直刷', '离不开', '越刷越久'
];
const VIDEO_ESCAPE_NEGATIONS = [
  '不想停止刷', '不想停下刷', '不要停止刷', '不要停下刷', '别让我停止刷', '不想少刷', '不想戒掉'
];
const FITNESS_WORDS = ['健身', '锻炼', '运动', '训练', '健身房'];
const FITNESS_GOAL_WORDS = [
  '想健身', '要健身', '准备健身', '打算健身', '去健身', '开始健身',
  '想锻炼', '要锻炼', '准备锻炼', '打算锻炼', '开始锻炼',
  '想运动', '要运动', '准备运动', '打算运动', '开始运动',
  '想训练', '要训练', '准备训练', '打算训练', '开始训练'
];
const FITNESS_FRICTION_WORDS = [
  '没动力', '没有动力', '提不起劲', '拖延', '开始不了', '动不起来', '不想动',
  '懒得动', '坚持不了', '不知道怎么开始', '不知怎么开始', '迟迟没开始'
];
const FITNESS_DIRECT_ENTRY_WORDS = ['easygo健身', '健身easygo', '健身最小行动', '进入健身模式', '打开健身模式'];
const FITNESS_NEGATIONS = [
  '不想健身', '不想锻炼', '不想运动', '别让我健身', '不要健身', '停止健身', '拒绝健身',
  '不要进入健身模式', '不想进入健身模式', '别打开健身模式'
];
const READING_WORDS = ['论文', '文献', '文章', '书', '材料'];
const READING_GOAL_WORDS = [
  '想读', '要读', '准备读', '打算读', '开始读',
  '想看', '要看', '准备看', '打算看', '开始看'
];
const READING_FRICTION_WORDS = [
  '迟迟没开始', '迟迟没有开始', '还没开始', '没有开始', '没开始', '开始不了',
  '不知道怎么开始', '不知怎么开始', '一直拖延', '拖延', '读不进去', '看不进去',
  '但一直'
];
const READING_DIRECT_ENTRY_WORDS = ['easygo阅读', '阅读easygo', '论文最小行动', '进入阅读模式', '打开阅读模式'];
const READING_NEGATIONS = [
  '不要读', '别让我读', '拒绝读', '不要看论文', '别让我看论文',
  '不要进入阅读模式', '别打开阅读模式'
];
const MUSIC_ENTRY_WORDS = ['摇摇乐', '摇头音乐', '摇头演奏', '演奏眼镜', '用眼镜演奏', '眼镜演奏', '开始摇头'];
const MUSIC_CONTROL_WORDS = ['开始演奏', '继续演奏', '演奏音乐'];
const MUSIC_EXIT_WORDS = ['退出摇摇乐', '关闭摇摇乐', '结束摇摇乐', '离开摇摇乐', '退出音乐'];
const MUSIC_EXIT_NEGATIONS = ['不要退出摇摇乐', '不想退出摇摇乐', '别退出摇摇乐', '不要关闭摇摇乐', '别关闭摇摇乐'];
const MUSIC_NEGATIONS = [
  '停止音乐', '停下音乐', '别放音乐', '不要音乐', '不想听音乐', '退出音乐',
  '不想摇头演奏', '不要摇头演奏', '别让我摇头演奏', '不想用眼镜演奏',
  '不要用眼镜演奏', '不要开始演奏', '别开始演奏', '不要继续演奏', '别继续演奏',
  '不要进入摇摇乐', '不想进入摇摇乐', '退出摇摇乐'
];
const CALIBRATE_WORDS = ['校准', '重新校准', '平视校准'];
const CALIBRATE_NEGATIONS = ['不要校准', '不想校准', '别校准', '先别校准', '无需校准', '不用校准'];
const DONE_WORDS = [
  '我做到了', '做到了', '完成了', '完成', '好了', '弄好了', '可以了', '搞定了', '搞定', '已经做完', '做完了', '拿到了'
];
const DONE_NEGATIONS = [
  '没做到', '没有做到', '还没做到', '没完成', '没有完成', '还没完成',
  '没做完', '没有做完', '还没做完', '没弄好', '没有弄好', '还没弄好',
  '没搞定', '没有搞定', '还没搞定', '不可以了'
];
const HARD_WORDS = ['还是太难', '太难', '做不到', '不行', '更简单', '太困难', '难一点', '我卡住了'];
const HARD_NEGATIONS = ['不太难', '没那么难', '没有那么难', '不是不行', '可以做到', '做得到'];
const PAUSE_WORDS = ['先停一下', '暂停', '先停', '退出', '不做了', '算了', '停一下', '休息一下', '先这样'];
const PAUSE_NEGATIONS = ['不要暂停', '不想暂停', '别暂停', '不用暂停', '无需暂停', '不要退出', '不想退出', '别退出'];
const RESTART_WORDS = ['重新选择', '重新开始', '重来', '再来一次', '从头开始'];
const RESTART_NEGATIONS = ['不要重新选择', '不想重新开始', '不要重新开始', '别重新开始', '不想重来', '不要重来', '别重来'];
const DISCOMFORT_WORDS = ['头晕', '眩晕', '不舒服', '难受', '恶心', '想吐', '脖子疼', '颈部不适', '眼睛不适', '眼疼', '眼花'];
const DISCOMFORT_NEGATIONS = [
  '不头晕', '没头晕', '没有头晕', '不眩晕', '没眩晕', '没有眩晕',
  '没有不舒服', '没不舒服', '不难受', '没难受', '没有难受',
  '不恶心', '没恶心', '没有恶心', '不想吐', '没想吐', '没有想吐',
  '颈部没有不适', '颈部没不适', '眼睛没有不适', '眼睛没不适', '不眼花', '没眼花'
];

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

export function normalizeTranscript(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?；;：:"“”'‘’（）()【】\[\]…—_\-]+/g, '');
}

export function routeTranscript(value) {
  const normalized = normalizeTranscript(value);
  if (!normalized) return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'EMPTY' };

  if (hasAny(normalized, DISCOMFORT_WORDS) && hasAny(normalized, DISCOMFORT_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'DISCOMFORT_NEGATED' };
  }
  if (hasAny(normalized, DISCOMFORT_WORDS)) {
    return { intent: ATTENTION_INTENT.PAUSE, normalized, reason: 'USER_DISCOMFORT' };
  }

  const hasVideo = hasAny(normalized, VIDEO_WORDS);
  if (hasVideo && hasAny(normalized, VIDEO_ESCAPE_WORDS) && hasAny(normalized, VIDEO_ESCAPE_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'VIDEO_ESCAPE_NEGATED' };
  }
  if (hasVideo && hasAny(normalized, VIDEO_ESCAPE_WORDS)) {
    return { intent: ATTENTION_INTENT.EASYGO_VIDEO, normalized, reason: 'VIDEO_ESCAPE' };
  }

  const hasFitness = hasAny(normalized, FITNESS_WORDS);
  if (hasFitness && hasAny(normalized, FITNESS_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'FITNESS_NEGATED' };
  }
  const hasFitnessGoal = hasAny(normalized, FITNESS_GOAL_WORDS);
  const hasFitnessFriction = hasAny(normalized, FITNESS_FRICTION_WORDS);
  const hasDirectFitnessEntry = hasAny(normalized, FITNESS_DIRECT_ENTRY_WORDS);
  if (hasFitness && ((hasFitnessGoal && hasFitnessFriction) || hasDirectFitnessEntry)) {
    return { intent: ATTENTION_INTENT.EASYGO_FITNESS, normalized, reason: 'FITNESS_START' };
  }

  const hasReading = hasAny(normalized, READING_WORDS);
  if (hasReading && hasAny(normalized, READING_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'READING_NEGATED' };
  }
  const hasReadingGoal = hasAny(normalized, READING_GOAL_WORDS);
  const hasReadingFriction = hasAny(normalized, READING_FRICTION_WORDS);
  const hasDirectReadingEntry = hasAny(normalized, READING_DIRECT_ENTRY_WORDS);
  if (hasReading && ((hasReadingGoal && hasReadingFriction) || hasDirectReadingEntry)) {
    return { intent: ATTENTION_INTENT.EASYGO_READING, normalized, reason: 'READING_START' };
  }

  if (hasAny(normalized, MUSIC_EXIT_WORDS) && hasAny(normalized, MUSIC_EXIT_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'MUSIC_EXIT_NEGATED' };
  }
  if (hasAny(normalized, MUSIC_EXIT_WORDS)) {
    return { intent: ATTENTION_INTENT.EXIT, normalized, reason: 'MUSIC_EXIT' };
  }
  if (hasAny(normalized, MUSIC_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.PAUSE, normalized, reason: 'MUSIC_STOP' };
  }
  if (hasAny(normalized, CALIBRATE_WORDS) && hasAny(normalized, CALIBRATE_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'MUSIC_CALIBRATION_NEGATED' };
  }
  if (hasAny(normalized, CALIBRATE_WORDS)) {
    return { intent: ATTENTION_INTENT.CALIBRATE, normalized, reason: 'MUSIC_CALIBRATE' };
  }
  if (hasAny(normalized, MUSIC_ENTRY_WORDS)) {
    return { intent: ATTENTION_INTENT.MUSIC, normalized, reason: 'MUSIC_ENTRY' };
  }
  if (hasAny(normalized, MUSIC_CONTROL_WORDS)) {
    return { intent: ATTENTION_INTENT.MUSIC, normalized, reason: 'MUSIC_CONTROL' };
  }

  if (hasAny(normalized, DONE_WORDS) && !hasAny(normalized, DONE_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.DONE, normalized, reason: 'OBSERVED_DONE' };
  }
  if (hasAny(normalized, HARD_WORDS) && !hasAny(normalized, HARD_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.TOO_HARD, normalized, reason: 'OBSERVED_DIFFICULTY' };
  }
  if (hasAny(normalized, PAUSE_WORDS) && !hasAny(normalized, PAUSE_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.PAUSE, normalized, reason: 'OBSERVED_PAUSE' };
  }
  if (hasAny(normalized, RESTART_WORDS) && !hasAny(normalized, RESTART_NEGATIONS)) {
    return { intent: ATTENTION_INTENT.RESTART, normalized, reason: 'OBSERVED_RESTART' };
  }
  return { intent: ATTENTION_INTENT.UNKNOWN, normalized, reason: 'NO_RULE_MATCH' };
}

export function intentToEasyGoEvent(intent, status) {
  if (status === EASYGO_STATUS.IDLE) {
    if (intent === ATTENTION_INTENT.EASYGO_FITNESS) {
      return { event: EASYGO_EVENT.START_FITNESS, reason: 'START_FITNESS' };
    }
    if (intent === ATTENTION_INTENT.EASYGO_VIDEO) {
      return { event: EASYGO_EVENT.START_VIDEO, reason: 'START_VIDEO' };
    }
    if (intent === ATTENTION_INTENT.EASYGO_READING) {
      return { event: EASYGO_EVENT.START_READING, reason: 'START_READING' };
    }
    return { event: null, reason: 'WAITING_FOR_SCENARIO' };
  }

  const terminal = status === EASYGO_STATUS.VALID_PAUSE ||
    status === EASYGO_STATUS.OFFLINE_HANDOFF ||
    status === EASYGO_STATUS.COMPLETE;
  if (terminal) {
    return intent === ATTENTION_INTENT.RESTART
      ? { event: EASYGO_EVENT.RESTART, reason: 'RESTART' }
      : { event: null, reason: 'TERMINAL_REQUIRES_RESTART' };
  }

  if (intent === ATTENTION_INTENT.DONE) return { event: EASYGO_EVENT.DONE, reason: 'DONE' };
  if (intent === ATTENTION_INTENT.TOO_HARD) return { event: EASYGO_EVENT.TOO_HARD, reason: 'TOO_HARD' };
  if (intent === ATTENTION_INTENT.PAUSE) return { event: EASYGO_EVENT.PAUSE, reason: 'PAUSE' };
  return { event: null, reason: 'ACTIVE_CONTROL_REQUIRED' };
}

export function scenarioFromQuery(value) {
  const normalized = normalizeTranscript(value);
  if (['fitness', '健身', 'exercise', 'workout'].includes(normalized)) return 'FITNESS';
  if (['video', '刷视频', '短视频', 'escape'].includes(normalized)) return 'VIDEO';
  if (['reading', 'read', '阅读', '读论文', '论文', '文献'].includes(normalized)) return 'READING';
  return '';
}
