# Audio assets

由 `scripts/generate-audio-assets.mjs` 确定性生成，无外部采样。背景为 96 BPM、四小节 C–G–Am–F 合成音垫；脚本同时输出本地播放用的 Ogg/Opus 和审计用 WAV。

- `note-*.wav`：21 个钢琴音色，250 ms 输入网格，最多 4 音/秒。
- `music-box-note-*.wav`：21 个八音盒音色，500 ms 输入网格，最多 2 音/秒。
- `guitar-note-*.wav`：21 个确定性拨弦吉他音色，500 ms 输入网格，最多 2 音/秒。
- `woodfish-note-*.wav`：21 个短促木鱼音色，750 ms 输入网格，约 1 音 / 0.75 秒。
- `bowl-note-*.wav`：钵的历史生成样本，当前不在产品音色列表中，仅为以后可能恢复保留。

四组当前音色都与引擎可播放 MIDI 集合严格一致，并由 `scripts/audio-quality.mjs` 分别执行时长、静音、削波、可闻度与对应节拍下的最坏重叠余量检查。
