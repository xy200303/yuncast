/**
 * AudioWorklet：把麦克风 Float32 单声道采样转成 s16le 立体声交错帧，
 * 经 port 发给主线程（再转 IPC 到主进程混音器，供 FFmpeg 直推使用）。
 */
class MicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]
    if (ch && ch[0] && ch[0].length > 0) {
      const mono = ch[0]
      const s16 = new Int16Array(mono.length * 2)
      for (let i = 0; i < mono.length; i++) {
        const v = Math.max(-1, Math.min(1, mono[i]))
        const s = Math.round(v * 32767)
        s16[i * 2] = s
        s16[i * 2 + 1] = s
      }
      this.port.postMessage(s16.buffer, [s16.buffer])
    }
    return true
  }
}

registerProcessor('mic-processor', MicProcessor)
