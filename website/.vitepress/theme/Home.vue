<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import shotLive from '../../guide/screenshots/live.png'
import shotPrograms from '../../guide/screenshots/programs.png'
import shotAnchors from '../../guide/screenshots/anchors.png'
import shotVoices from '../../guide/screenshots/voices.png'
import shotStats from '../../guide/screenshots/stats.png'

/* lucide 风格线性图标（stroke, 24x24 viewBox），v-html 注入 svg 内部 */
const svg = (inner: string) => inner
const ICONS = {
  mic: svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'),
  layers: svg('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  shuffle: svg('<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.8-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>'),
  waveform: svg('<path d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2"/>'),
  message: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/>'),
  sliders: svg('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>')
}

const features = [
  { icon: ICONS.mic, title: '智能主播 Agent', desc: '人设卡 + 编剧模式，主播自己写稿自己播。评论回不回、怎么回，它像真人一样看着办。' },
  { icon: ICONS.layers, title: '四种节目形态', desc: '一个人讲、多人聊天、照着稿子读、分角色表演——直播带货、有声书、播客、FM 全覆盖。' },
  { icon: ICONS.shuffle, title: '三种播出方式', desc: '现场发挥、边播边准备、全部做好再播。预制节目有门禁：音频不齐，不开播。' },
  { icon: ICONS.waveform, title: '克隆店家的声音', desc: '火山引擎 / 阿里云百炼 / 播客专用大模型多 TTS 适配，一段录音克隆音色。' },
  { icon: ICONS.message, title: '像真人一样看评论', desc: '评论先进收件箱：去重、归组、自适应聚合。洪峰一批批看，冷清一条不漏。' },
  { icon: ICONS.sliders, title: '导演级播出控制', desc: '话术池车道、BGM ducking、麦克风真人接管、一键急停。人在场控，随时抢过话筒。' },
  { icon: ICONS.download, title: '音频导出', desc: '整场导出 MP3/WAV，分章或合并、响度归一，直接上传喜马拉雅、小宇宙。' },
  { icon: ICONS.chart, title: '用量看板', desc: 'LLM tokens 与 TTS 字符按节目归组，30 天趋势可视化，花多少心里有数。' }
]

const showcase = [
  { src: shotPrograms, title: '节目', desc: '形态 × 播出方式 × 播完策略' },
  { src: shotAnchors, title: '主播团', desc: '人设卡点击弹窗配置' },
  { src: shotVoices, title: '音色库', desc: '云端音色 + 声音克隆' },
  { src: shotStats, title: '数据', desc: '画像 · 摘要 · 用量看板' }
]

/* GEO：可见 FAQ 与 FAQPage JSON-LD 保持一致，供搜索引擎与 AI 答案引擎引用 */
const faqs = [
  { q: '小云播客坊 YunCast 是什么？', a: '一款开源免费（MIT）的 AI 直播工作台桌面软件：AI 主播自己写稿、用克隆的声音播报、看到评论自己决定怎么回。商品宣讲、直播带货、有声书、播客节目，一个工作台全包。' },
  { q: '小云播客坊收费吗？', a: '软件本身完全免费且开源（MIT 协议）。运行时需自配 LLM 和 TTS 云服务的 API Key，用量费用按服务商计价，应用内的用量看板可以看到每笔消耗。' },
  { q: '不会写直播稿能用吗？', a: '可以，这正是它的主业。主播 Agent 有人设卡和编剧模式：说一句「给这场写稿」，它自己查资料、写稿、合成、排进播出队列，全程不用你动笔。' },
  { q: '能克隆店家自己的声音吗？', a: '能。在音色库上传一段 10 秒以上的干净录音即可克隆音色，支持火山引擎、阿里云百炼和播客专用大模型等多家 TTS 服务。' },
  { q: '支持哪些直播平台和场景？', a: '软件本身平台无关：合成声音经虚拟声卡/OBS 推流到任意直播平台，评论通过平台连接器接入。除直播带货外，还支持有声书、播客、FM 等预制节目，可整场导出 MP3/WAV 上传喜马拉雅、小宇宙。' },
  { q: '数据会上传到云端吗？', a: '不会。除调用你自配的 LLM/TTS 云 API 外，所有数据（剧本、音频、评论记录、用量）都存在你自己电脑上，软件无服务端。' }
]

/* ---------- hero 声波音浪：三层正弦波叠加，logo 三色渐变，鼠标视差 ---------- */
const waveCanvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
let observer: IntersectionObserver | null = null
let onResize: (() => void) | null = null
let onPointer: ((e: PointerEvent) => void) | null = null

onMounted(() => {
  const ld = document.createElement('script')
  ld.type = 'application/ld+json'
  ld.id = 'faq-jsonld'
  ld.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }
    }))
  })
  document.head.appendChild(ld)

  observer = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
    { threshold: 0.12 }
  )
  document.querySelectorAll('.reveal').forEach((el) => observer!.observe(el))

  const canvas = waveCanvas.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let w = 0
  let h = 0
  let mx = 0.5 // 鼠标水平位置 0-1，驱动视差
  let mxTarget = 0.5

  onResize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  onResize()
  window.addEventListener('resize', onResize)
  onPointer = (e) => {
    mxTarget = e.clientX / window.innerWidth
  }
  window.addEventListener('pointermove', onPointer)

  // 三层波：离视线越近振幅越大、透明度越高
  const layers = [
    { amp: 22, len: 0.0042, speed: 0.00035, base: 0.42, alpha: 0.10 },
    { amp: 30, len: 0.0033, speed: 0.0005, base: 0.58, alpha: 0.14 },
    { amp: 38, len: 0.0026, speed: 0.0007, base: 0.74, alpha: 0.18 }
  ]

  const grad = () => {
    const g = ctx.createLinearGradient(0, 0, w, 0)
    g.addColorStop(0, '#38bdf8')
    g.addColorStop(0.55, '#6366f1')
    g.addColorStop(1, '#a855f7')
    return g
  }

  const draw = (t: number) => {
    ctx.clearRect(0, 0, w, h)
    mx += (mxTarget - mx) * 0.04
    const g = grad()
    for (const [i, layer] of layers.entries()) {
      const parallax = (mx - 0.5) * (i + 1) * 14
      ctx.beginPath()
      ctx.moveTo(-4, h + 4)
      for (let x = -4; x <= w + 4; x += 4) {
        const y =
          h * layer.base +
          Math.sin(x * layer.len + t * layer.speed + i * 2.1) * layer.amp +
          Math.sin(x * layer.len * 0.5 - t * layer.speed * 0.7) * layer.amp * 0.5 +
          parallax
        ctx.lineTo(x, y)
      }
      ctx.lineTo(w + 4, h + 4)
      ctx.closePath()
      ctx.globalAlpha = layer.alpha
      ctx.fillStyle = g
      ctx.fill()
    }
    ctx.globalAlpha = 1
    if (!reduced) raf = requestAnimationFrame(draw)
  }
  draw(0)
})
onUnmounted(() => {
  document.getElementById('faq-jsonld')?.remove()
  observer?.disconnect()
  cancelAnimationFrame(raf)
  if (onResize) window.removeEventListener('resize', onResize)
  if (onPointer) window.removeEventListener('pointermove', onPointer)
})
</script>

<template>
  <div class="landing">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-dots" aria-hidden="true" />
      <canvas ref="waveCanvas" class="hero-waves" aria-hidden="true" />
      <div class="hero-inner">
        <div class="badge reveal">v0.1.2 · Windows / macOS / Linux 同步发布</div>
        <h1 class="hero-title">
          <span class="line"><span class="word">专为</span> <span class="word">不会</span> <span class="word">直播的</span></span>
          <span class="line"><span class="word grad">商家</span> <span class="word grad">和</span> <span class="word grad">企业</span> <span class="word grad">而生。</span></span>
        </h1>
        <p class="hero-sub reveal d1">
          致力于帮助商家、企业低成本开播——AI 主播自己写稿、用克隆的声音播报、看到评论自己决定怎么回。<br>
          商品宣讲、直播带货、有声书、播客节目，一个工作台全包。
        </p>
        <div class="hero-cta reveal d2">
          <a class="btn primary" :href="withBase('/download')">立即下载</a>
          <a class="btn ghost" :href="withBase('/guide/quickstart')">使用文档</a>
          <a class="btn ghost" href="https://github.com/xy200303/yuncast" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <div class="hero-shot reveal d3">
          <div class="window">
            <div class="window-bar"><i /><i /><i /></div>
            <img :src="shotLive" alt="直播台" />
          </div>
          <p class="caption">直播台：话术池队列 + 评论流 + 事件流，右侧直接和主播对话</p>
        </div>
      </div>
    </section>

    <!-- Features -->
    <section class="section">
      <h2 class="display reveal">
        <span class="grad-text">写稿。播报。互动。</span><br>一个主播全干了。
      </h2>
      <div class="grid">
        <div v-for="(f, i) in features" :key="f.title" class="card reveal" :style="{ transitionDelay: (i % 4) * 60 + 'ms' }">
          <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="f.icon" /></div>
          <h3>{{ f.title }}</h3>
          <p>{{ f.desc }}</p>
        </div>
      </div>
    </section>

    <!-- Showcase -->
    <section class="section alt">
      <h2 class="display reveal">开播该有的样子，<br><span class="grad-text">都在这里。</span></h2>
      <div class="shots">
        <div v-for="(s, i) in showcase" :key="s.title" class="shot reveal" :style="{ transitionDelay: (i % 2) * 80 + 'ms' }">
          <div class="window sm">
            <div class="window-bar"><i /><i /><i /></div>
            <img :src="s.src" :alt="s.title" loading="lazy" />
          </div>
          <h3>{{ s.title }}</h3>
          <p>{{ s.desc }}</p>
        </div>
      </div>
      <p class="more reveal">更多界面见 <a :href="withBase('/guide/interface')">界面一览</a></p>
    </section>

    <!-- 开发者 -->
    <section class="section">
      <h2 class="display reveal">开源，<span class="grad-text">免费</span>，本地跑。</h2>
      <div class="dev-grid">
        <div class="dev-card reveal">
          <h3>三分钟跑起来</h3>
          <pre><code>$ git clone https://github.com/xy200303/yuncast
$ npm install
$ npm run dev</code></pre>
        </div>
        <div class="dev-card reveal d1">
          <h3>MIT 协议</h3>
          <p>Electron 44 · React 19 · TypeScript。LLM/TTS 直连云 API，数据全部存在你自己电脑上，无服务端、不上传。</p>
        </div>
      </div>
    </section>

    <!-- FAQ（GEO：问答式内容，供搜索/AI 引擎引用） -->
    <section class="section faq-section">
      <h2 class="display reveal">常见问题</h2>
      <div class="faq-list">
        <details v-for="(f, i) in faqs" :key="f.q" class="faq-item reveal" :style="{ transitionDelay: (i % 3) * 60 + 'ms' }">
          <summary>{{ f.q }}</summary>
          <p>{{ f.a }}</p>
        </details>
      </div>
    </section>

    <!-- Final CTA -->
    <section class="final">
      <div class="final-inner reveal">
        <h2 class="display"><span class="grad-text">让 AI 的声音</span><br>改变世界。</h2>
        <a class="btn primary big" href="https://github.com/xy200303/yuncast/releases/latest" target="_blank" rel="noreferrer">免费下载</a>
        <p class="footnote">MIT License · © 2026 小云播客坊 YunCast</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing {
  overflow-x: clip;
  color: var(--vp-c-text-1);
  background: #ffffff;
}

/* ---------- Hero ---------- */
.hero {
  position: relative;
  padding: 96px 24px 0;
  background: linear-gradient(180deg, #f8faff 0%, #ffffff 78%);
  overflow: hidden;
}
.hero-dots {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(99, 102, 241, 0.14) 1px, transparent 1px);
  background-size: 26px 26px;
  mask-image: radial-gradient(ellipse 75% 55% at 50% 32%, #000 30%, transparent 75%);
}
.hero-waves {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 240px;
  pointer-events: none;
}

.hero-inner { position: relative; max-width: 960px; margin: 0 auto; text-align: center; }
.badge {
  display: inline-block;
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 13px;
  color: #4f46e5;
  background: rgba(99, 102, 241, 0.09);
  border: 1px solid rgba(99, 102, 241, 0.22);
}
.hero-title {
  margin: 28px 0 20px;
  font-family: 'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: clamp(2.8rem, 7.5vw, 5.2rem);
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: 0.01em;
  border: none;
  color: #0f172a;
}
.hero-title .line { display: block; overflow: hidden; }
.hero-title .word {
  display: inline-block;
  animation: rise 0.9s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.hero-title .line:nth-child(2) .word { animation-delay: 0.15s; }
.hero-title .line:nth-child(2) .word:nth-child(2) { animation-delay: 0.25s; }
.hero-title .line:nth-child(2) .word:nth-child(3) { animation-delay: 0.35s; }
@keyframes rise {
  from { transform: translateY(110%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.grad {
  background: linear-gradient(120deg, #0ea5e9, #4f46e5 55%, #a855f7);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.hero-sub { font-size: clamp(1rem, 2vw, 1.2rem); line-height: 1.9; color: var(--vp-c-text-2); }

.hero-cta { margin-top: 32px; display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
.btn {
  padding: 12px 30px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 15px;
  text-decoration: none;
  transition: transform 0.25s, box-shadow 0.25s, background 0.25s, border-color 0.25s;
}
.btn.primary {
  color: #fff;
  background: linear-gradient(120deg, #4f46e5, #7c6cf8);
  box-shadow: 0 10px 30px rgba(99, 102, 241, 0.35);
}
.btn.primary:hover { transform: translateY(-2px); color: #fff; box-shadow: 0 16px 40px rgba(99, 102, 241, 0.45); }
.btn.ghost {
  color: var(--vp-c-text-1);
  border: 1px solid rgba(15, 23, 42, 0.14);
  background: #ffffff;
}
.btn.ghost:hover { transform: translateY(-2px); border-color: #6366f1; color: #4f46e5; }
.btn.big { padding: 16px 44px; font-size: 17px; }

.hero-shot { margin-top: 64px; padding-bottom: 56px; }
.window {
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, 0.09);
  background: #ffffff;
  box-shadow: 0 24px 70px rgba(30, 41, 82, 0.16), 0 4px 14px rgba(30, 41, 82, 0.06);
  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.5s;
}
.window:hover { transform: translateY(-6px) scale(1.005); box-shadow: 0 34px 90px rgba(30, 41, 82, 0.22), 0 6px 18px rgba(30, 41, 82, 0.08); }
.window-bar {
  display: flex;
  gap: 7px;
  padding: 10px 14px;
  background: #f8fafc;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
}
.window-bar i { width: 10px; height: 10px; border-radius: 50%; }
.window-bar i:nth-child(1) { background: #fca5a5; }
.window-bar i:nth-child(2) { background: #fcd34d; }
.window-bar i:nth-child(3) { background: #86efac; }
.window img { display: block; width: 100%; }
.caption {
  display: inline-block;
  margin-top: 14px;
  padding: 4px 14px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(6px);
}

/* ---------- Sections ---------- */
.section { padding: 110px 24px; max-width: 1152px; margin: 0 auto; }
.section.alt { max-width: none; background: #f6f7fb; }
.section.alt > * { max-width: 1152px; margin-left: auto; margin-right: auto; }
.display {
  font-family: 'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: clamp(2rem, 4.6vw, 3.4rem);
  font-weight: 800;
  letter-spacing: 0.01em;
  line-height: 1.25;
  text-align: center;
  margin: 0 auto 56px;
  border: none;
  color: #0f172a;
}
.grad-text {
  background: linear-gradient(120deg, #0ea5e9, #4f46e5 55%, #a855f7);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; }
.card {
  padding: 26px 22px;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #ffffff;
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.35s, border-color 0.35s;
}
.card:hover {
  transform: translateY(-6px);
  border-color: rgba(99, 102, 241, 0.4);
  box-shadow: 0 20px 48px rgba(79, 70, 229, 0.13);
}
.card-icon {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
  color: #4f46e5;
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.12), rgba(99, 102, 241, 0.14) 55%, rgba(168, 85, 247, 0.12));
  border: 1px solid rgba(99, 102, 241, 0.16);
}
.card-icon svg { width: 21px; height: 21px; }
.card h3 { margin: 0 0 8px; font-size: 16px; border: none; color: #0f172a; }
.card p { margin: 0; font-size: 14px; line-height: 1.8; color: var(--vp-c-text-2); }

/* ---------- Showcase ---------- */
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.shot h3 { margin: 14px 0 4px; border: none; font-size: 16px; color: #0f172a; }
.shot p { margin: 0; font-size: 14px; color: var(--vp-c-text-2); }
.window.sm { box-shadow: 0 12px 36px rgba(30, 41, 82, 0.1); }
.more { margin-top: 32px; text-align: center; font-size: 14px; color: var(--vp-c-text-3); }
.more a { color: #4f46e5; }
@media (max-width: 720px) { .shots { grid-template-columns: 1fr; } }

/* ---------- Dev ---------- */
.dev-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 720px) { .dev-grid { grid-template-columns: 1fr; } }
.dev-card {
  padding: 28px;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #ffffff;
}
.dev-card h3 { margin-top: 0; border: none; color: #0f172a; }
.dev-card p { color: var(--vp-c-text-2); line-height: 1.9; margin-bottom: 0; }
.dev-card pre {
  margin: 12px 0 0;
  padding: 18px;
  border-radius: 10px;
  background: #0f172a;
  color: #93c5fd;
  font-size: 13.5px;
  line-height: 1.9;
  overflow-x: auto;
}

/* ---------- FAQ ---------- */
.faq-list { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.faq-item {
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 14px;
  background: #ffffff;
  padding: 0 22px;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}
.faq-item:hover { border-color: rgba(99, 102, 241, 0.35); }
.faq-item[open] {
  border-color: rgba(99, 102, 241, 0.4);
  box-shadow: 0 8px 30px -12px rgba(99, 102, 241, 0.25);
}
.faq-item summary {
  cursor: pointer;
  list-style: none;
  padding: 18px 28px 18px 0;
  font-size: 15.5px;
  font-weight: 600;
  color: #0f172a;
  position: relative;
}
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::after {
  content: '+';
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  font-size: 20px;
  font-weight: 400;
  color: #6366f1;
  transition: transform 0.25s ease;
}
.faq-item[open] summary::after { transform: translateY(-50%) rotate(45deg); }
.faq-item p {
  margin: 0;
  padding: 0 0 18px;
  font-size: 14px;
  line-height: 1.9;
  color: var(--vp-c-text-2);
}

/* ---------- Final ---------- */
.final {
  padding: 130px 24px;
  text-align: center;
  background:
    radial-gradient(680px 340px at 50% 120%, rgba(99, 102, 241, 0.16), transparent),
    linear-gradient(180deg, #ffffff, #f4f6fe);
}
.final .display { margin-bottom: 40px; }
.footnote { margin-top: 36px; font-size: 13px; color: var(--vp-c-text-3); }

/* ---------- Scroll reveal ---------- */
.reveal {
  opacity: 0;
  transform: translateY(26px);
  transition: opacity 0.8s cubic-bezier(0.22, 1, 0.36, 1), transform 0.8s cubic-bezier(0.22, 1, 0.36, 1);
}
.reveal.in { opacity: 1; transform: none; }
.reveal.d1 { transition-delay: 0.12s; }
.reveal.d2 { transition-delay: 0.24s; }
.reveal.d3 { transition-delay: 0.36s; }
@media (prefers-reduced-motion: reduce) {
  .reveal, .hero-title .word { opacity: 1 !important; transform: none !important; animation: none !important; }
}
</style>
