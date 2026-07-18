// 实时变声引擎（Web Audio API）。
//
// 说明：浏览器端无法做真正的「明星声音克隆」（那需要 AI 语音模型）。
// 这里通过 音高偏移(pitch shift) + 共振峰滤波(formant) + 失真/回声/颤音 等
// 组合，做出卡通角色风格的趣味变声预设。音高偏移采用业界公开的
// "Jungle" 双延时线交叉淡化算法（Chris Wilson, Web Audio 官方示例，可实时运行）。

export interface VoicePreset {
  id: string
  name: string
  emoji: string
  desc: string
  pitch: number // -1(降八度) ~ +1(升八度)
  filter?: { type: BiquadFilterType; freq: number; q?: number }
  drive?: number // 0~1 轻微失真（角色沙哑/机械感）
  echo?: { time: number; feedback: number; mix: number } // 汤姆猫式回声
  tremolo?: { rate: number; depth: number } // 颤音（抖动搞笑）
}

export const PRESETS: VoicePreset[] = [
  { id: 'off', name: '原声', emoji: '🎙️', desc: '不做处理', pitch: 0 },
  {
    id: 'tomcat', name: '汤姆猫', emoji: '🐱', desc: '升调 + 复读回声',
    pitch: 0.45, filter: { type: 'highpass', freq: 220 },
    echo: { time: 0.18, feedback: 0.35, mix: 0.5 },
  },
  {
    id: 'peppa', name: '小猪佩奇', emoji: '🐷', desc: '高亢鼻音',
    pitch: 0.6, filter: { type: 'bandpass', freq: 1700, q: 1.2 }, tremolo: { rate: 6, depth: 0.15 },
  },
  {
    id: 'goat', name: '喜羊羊', emoji: '🐑', desc: '明亮童声',
    pitch: 0.68, filter: { type: 'highshelf', freq: 3000, q: 0.7 },
  },
  {
    id: 'wukong', name: '孙悟空', emoji: '🐵', desc: '灵动 + 精气神',
    pitch: 0.3, filter: { type: 'bandpass', freq: 1200, q: 0.8 }, drive: 0.25,
  },
  {
    id: 'bajie', name: '猪八戒', emoji: '🐗', desc: '低沉憨厚',
    pitch: -0.4, filter: { type: 'lowpass', freq: 2200 }, drive: 0.15,
  },
  {
    id: 'chipmunk', name: '花栗鼠', emoji: '🐿️', desc: '超高速捏嗓',
    pitch: 0.9,
  },
  {
    id: 'robot', name: '机器人', emoji: '🤖', desc: '金属机械音',
    pitch: 0, filter: { type: 'bandpass', freq: 900, q: 6 }, drive: 0.5, tremolo: { rate: 24, depth: 0.5 },
  },
  {
    id: 'giant', name: '大魔王', emoji: '👹', desc: '低沉恐怖',
    pitch: -0.7, filter: { type: 'lowpass', freq: 1400 }, drive: 0.3,
  },
]

// ---- Jungle 音高偏移算法（TypeScript 移植，实时无需 worklet） ----
const DELAY_TIME = 0.1
const FADE_TIME = 0.05
const BUFFER_TIME = 0.1

function createFadeBuffer(ctx: BaseAudioContext, activeTime: number, fadeTime: number): AudioBuffer {
  const length1 = activeTime * ctx.sampleRate
  const length2 = (activeTime - 2 * fadeTime) * ctx.sampleRate
  const length = length1 + length2
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const p = buffer.getChannelData(0)
  const fadeLength = fadeTime * ctx.sampleRate
  const fadeIndex1 = fadeLength
  const fadeIndex2 = length1 - fadeLength
  for (let i = 0; i < length1; ++i) {
    let value
    if (i < fadeIndex1) value = Math.sqrt(i / fadeLength)
    else if (i >= fadeIndex2) value = Math.sqrt(1 - (i - fadeIndex2) / fadeLength)
    else value = 1
    p[i] = value
  }
  for (let i = length1; i < length; ++i) p[i] = 0
  return buffer
}

function createDelayTimeBuffer(ctx: BaseAudioContext, activeTime: number, fadeTime: number, shiftUp: boolean): AudioBuffer {
  const length1 = activeTime * ctx.sampleRate
  const length2 = (activeTime - 2 * fadeTime) * ctx.sampleRate
  const length = length1 + length2
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const p = buffer.getChannelData(0)
  for (let i = 0; i < length1; ++i) {
    if (shiftUp) p[i] = (length1 - i) / length
    else p[i] = i / length1
  }
  for (let i = length1; i < length; ++i) p[i] = 0
  return buffer
}

class Jungle {
  input: GainNode
  output: GainNode
  private mod1Gain: GainNode
  private mod2Gain: GainNode
  private mod3Gain: GainNode
  private mod4Gain: GainNode
  private modGain1: GainNode
  private modGain2: GainNode
  private ctx: AudioContext

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    const input = ctx.createGain()
    const output = ctx.createGain()
    this.input = input
    this.output = output

    const mod1 = ctx.createBufferSource()
    const mod2 = ctx.createBufferSource()
    const mod3 = ctx.createBufferSource()
    const mod4 = ctx.createBufferSource()
    const shiftDownBuffer = createDelayTimeBuffer(ctx, BUFFER_TIME, FADE_TIME, false)
    const shiftUpBuffer = createDelayTimeBuffer(ctx, BUFFER_TIME, FADE_TIME, true)
    mod1.buffer = shiftDownBuffer
    mod2.buffer = shiftDownBuffer
    mod3.buffer = shiftUpBuffer
    mod4.buffer = shiftUpBuffer
    mod1.loop = mod2.loop = mod3.loop = mod4.loop = true

    const mod1Gain = ctx.createGain()
    const mod2Gain = ctx.createGain()
    const mod3Gain = ctx.createGain()
    const mod4Gain = ctx.createGain()
    mod3Gain.gain.value = 0
    mod4Gain.gain.value = 0
    mod1.connect(mod1Gain)
    mod2.connect(mod2Gain)
    mod3.connect(mod3Gain)
    mod4.connect(mod4Gain)

    const modGain1 = ctx.createGain()
    const modGain2 = ctx.createGain()
    const delay1 = ctx.createDelay()
    const delay2 = ctx.createDelay()
    mod1Gain.connect(modGain1)
    mod2Gain.connect(modGain2)
    mod3Gain.connect(modGain1)
    mod4Gain.connect(modGain2)
    modGain1.connect(delay1.delayTime)
    modGain2.connect(delay2.delayTime)

    const fade1 = ctx.createBufferSource()
    const fade2 = ctx.createBufferSource()
    const fadeBuffer = createFadeBuffer(ctx, BUFFER_TIME, FADE_TIME)
    fade1.buffer = fadeBuffer
    fade2.buffer = fadeBuffer
    fade1.loop = fade2.loop = true

    const mix1 = ctx.createGain()
    const mix2 = ctx.createGain()
    mix1.gain.value = 0
    mix2.gain.value = 0
    fade1.connect(mix1.gain)
    fade2.connect(mix2.gain)

    input.connect(delay1)
    input.connect(delay2)
    delay1.connect(mix1)
    delay2.connect(mix2)
    mix1.connect(output)
    mix2.connect(output)

    const t = ctx.currentTime + 0.05
    const t2 = t + BUFFER_TIME - FADE_TIME
    mod1.start(t)
    mod2.start(t2)
    mod3.start(t)
    mod4.start(t2)
    fade1.start(t)
    fade2.start(t2)

    this.mod1Gain = mod1Gain
    this.mod2Gain = mod2Gain
    this.mod3Gain = mod3Gain
    this.mod4Gain = mod4Gain
    this.modGain1 = modGain1
    this.modGain2 = modGain2
    this.setDelay(DELAY_TIME)
  }

  private setDelay(t: number) {
    this.modGain1.gain.setTargetAtTime(0.5 * t, this.ctx.currentTime, 0.01)
    this.modGain2.gain.setTargetAtTime(0.5 * t, this.ctx.currentTime, 0.01)
  }

  setPitchOffset(mult: number) {
    const up = mult > 0
    this.mod1Gain.gain.value = up ? 0 : 1
    this.mod2Gain.gain.value = up ? 0 : 1
    this.mod3Gain.gain.value = up ? 1 : 0
    this.mod4Gain.gain.value = up ? 1 : 0
    this.setDelay(DELAY_TIME * Math.abs(mult))
  }
}

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = amount * 100
  const n = 22050
  const curve = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x))
  }
  return curve
}

/** 变声处理管线：把一个音频源转换为角色声音。 */
export class VoiceFX {
  readonly ctx: AudioContext
  readonly input: GainNode
  readonly output: GainNode
  private jungle: Jungle
  private filter: BiquadFilterNode
  private shaper: WaveShaperNode
  private tremGain: GainNode
  private tremLFO: OscillatorNode
  private tremDepth: GainNode
  private echoDelay: DelayNode
  private echoFeedback: GainNode
  private echoWet: GainNode

  constructor() {
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AC()
    const ctx = this.ctx

    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.jungle = new Jungle(ctx)
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'allpass'
    this.shaper = ctx.createWaveShaper()
    this.tremGain = ctx.createGain()

    // 颤音：LFO -> depth -> tremGain.gain（基准 1）
    this.tremLFO = ctx.createOscillator()
    this.tremDepth = ctx.createGain()
    this.tremDepth.gain.value = 0
    this.tremLFO.frequency.value = 5
    this.tremLFO.connect(this.tremDepth).connect(this.tremGain.gain)
    this.tremLFO.start()

    // 回声：并联 delay + feedback
    this.echoDelay = ctx.createDelay(1.0)
    this.echoFeedback = ctx.createGain()
    this.echoFeedback.gain.value = 0
    this.echoWet = ctx.createGain()
    this.echoWet.gain.value = 0

    // 连线：input -> jungle -> filter -> shaper -> tremGain -> output
    this.input.connect(this.jungle.input)
    this.jungle.output.connect(this.filter)
    this.filter.connect(this.shaper)
    this.shaper.connect(this.tremGain)
    this.tremGain.connect(this.output)
    // 回声支路
    this.tremGain.connect(this.echoDelay)
    this.echoDelay.connect(this.echoFeedback)
    this.echoFeedback.connect(this.echoDelay)
    this.echoDelay.connect(this.echoWet)
    this.echoWet.connect(this.output)

    this.setPreset(PRESETS[0])
  }

  setPreset(p: VoicePreset) {
    const ctx = this.ctx
    this.jungle.setPitchOffset(p.pitch)

    if (p.filter) {
      this.filter.type = p.filter.type
      this.filter.frequency.setTargetAtTime(p.filter.freq, ctx.currentTime, 0.02)
      this.filter.Q.value = p.filter.q ?? 1
    } else {
      this.filter.type = 'allpass'
    }

    this.shaper.curve = p.drive ? makeDistortionCurve(p.drive) : null
    this.shaper.oversample = '2x'

    this.tremGain.gain.value = 1
    if (p.tremolo) {
      this.tremLFO.frequency.setTargetAtTime(p.tremolo.rate, ctx.currentTime, 0.02)
      this.tremDepth.gain.value = p.tremolo.depth
    } else {
      this.tremDepth.gain.value = 0
    }

    if (p.echo) {
      this.echoDelay.delayTime.setTargetAtTime(p.echo.time, ctx.currentTime, 0.02)
      this.echoFeedback.gain.value = p.echo.feedback
      this.echoWet.gain.value = p.echo.mix
    } else {
      this.echoFeedback.gain.value = 0
      this.echoWet.gain.value = 0
    }
  }

  // 用麦克风流作为输入，返回处理后的音频流（可用于录制或 WebRTC 发送）
  connectMic(stream: MediaStream): MediaStream {
    const src = this.ctx.createMediaStreamSource(stream)
    src.connect(this.input)
    const dest = this.ctx.createMediaStreamDestination()
    this.output.connect(dest)
    return dest.stream
  }

  // 试听：把处理结果播放到扬声器
  monitorToSpeakers() {
    this.output.connect(this.ctx.destination)
  }

  resume() {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  dispose() {
    try {
      this.output.disconnect()
      void this.ctx.close()
    } catch {
      // ignore
    }
  }
}
