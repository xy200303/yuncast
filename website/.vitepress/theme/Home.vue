<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import shotLive from '../../guide/screenshots/live.png'
import shotPrograms from '../../guide/screenshots/programs.png'
import shotAnchors from '../../guide/screenshots/anchors.png'
import shotKnowledge from '../../guide/screenshots/knowledge.png'
import shotVoices from '../../guide/screenshots/voices.png'
import shotSessions from '../../guide/screenshots/sessions.png'
import shotStats from '../../guide/screenshots/stats.png'

/* lucide 风格线性图标（stroke, 24x24 viewBox），v-html 注入 svg 内部 */
const svg = (inner: string) => inner
const ICONS = {
  pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  waveform: svg('<path d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2"/>'),
  layers: svg('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  message: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/>'),
  sliders: svg('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  receipt: svg('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/>'),
  plug: svg('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v2a6 6 0 0 1-12 0V8Z"/>'),
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  monitor: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  play: svg('<path d="M6 4.5v15l13-7.5Z"/>'),
  arrow: svg('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>')
}

const features = [
  {
    icon: ICONS.pen,
    title: '按剧本写整版底稿',
    desc: '绑好剧本与知识范围，说一句「给这场写稿」，它按场景逐段写、查商品资料核对价格口径，产出的底稿进底稿库，你可以逐条改。'
  },
  {
    icon: ICONS.waveform,
    title: '声音克隆与逐段配音',
    desc: '火山引擎、阿里云百炼、火山播客专用模型三种 TTS 走同一套选择器：接入 → 模型 → 音色。克隆店家嗓音要 10–30 秒干净人声。'
  },
  {
    icon: ICONS.layers,
    title: '按场景挑播出方式',
    desc: '现场发挥（无稿纯互动）、边播边准备（边播边合成，随时改后面的稿）、全部做好再播（整本合成，过门禁才开播）。'
  },
  {
    icon: ICONS.message,
    title: '评论按批喂给主播',
    desc: '同人同内容 30 秒去重、按观众归组、5–30 秒自适应聚合、每分钟最多唤醒 6 次。回一条还是回一批，由主播自己判断。'
  },
  {
    icon: ICONS.sliders,
    title: '四档话术池与手动接管',
    desc: '打断 / 下一条 / 常规 / 垫底四条优先级，人工播报插队；暂停、跳过、急停声音、主音量都在吸底播放条上。'
  },
  {
    icon: ICONS.download,
    title: '整场导出成音频',
    desc: '预制节目导出 MP3/WAV，分章或合并、响度归一，直接传喜马拉雅、小宇宙；场次记录里也能导出某一整场。'
  },
  {
    icon: ICONS.chart,
    title: '用量与复盘',
    desc: '统计页按节目归组 LLM tokens 与 TTS 字符，30 天趋势；场次记录留档每场逐条话术、评论、事件与观众画像。'
  },
  {
    icon: ICONS.plug,
    title: '平台无关，接口解耦',
    desc: '主程序不带平台 SDK：评论由独立的连接器小软件经本机 MCP 接入，声音经虚拟声卡或推流进入任意直播软件。'
  }
]

/** 三种播出方式：对应「合成策略 / 播放策略」，写法与节目编辑弹窗里的选项一致 */
const modes = [
  {
    name: '现场发挥',
    tag: '无底稿',
    synth: '说一句合成一句',
    play: '不循环，播完即停',
    fit: '纯互动：陪聊、答疑、带货时临场答观众'
  },
  {
    name: '边播边准备',
    tag: '滚动',
    synth: '一段一段滚动合成，池子水位低了自动续',
    play: '循环复用已合成音频，随时插播改稿',
    fit: '直播带货：边播边写，后面的稿子还能改'
  },
  {
    name: '全部做好再播',
    tag: '预制',
    synth: '整本一次合成完，逐单元可重试、可导入外部录音',
    play: '开播前过门禁，音频不齐不会静默开播',
    fit: '有声书、播客、需要导出的成片内容'
  }
]

/** 一条流水线：从写稿到复盘 */
const pipeline = [
  { icon: ICONS.pen, title: '写稿', desc: '导演按剧本与知识库写底稿，进底稿库等你过目' },
  { icon: ICONS.waveform, title: '配音', desc: '在「合成声音」里定这次用哪把嗓子，选完冻结进每段音频' },
  { icon: ICONS.monitor, title: '播出', desc: '直播台启动节目，话术池按四档优先级出声音' },
  { icon: ICONS.message, title: '互动', desc: '评论进事件流，主播看一条回一条，或攒一批一起回' },
  { icon: ICONS.chart, title: '留档', desc: '每场留下逐条话术、评论与用量，方便复盘和再播' }
]

const showcase = [
  { src: shotPrograms, title: '节目', desc: '内容类型 × 播出方式 × 播完策略，底稿与音频状态直接标在卡上' },
  { src: shotAnchors, title: '主播团', desc: '人设卡：名字、音色、性格、口癖、禁区，一个主播串多个节目' },
  { src: shotKnowledge, title: '知识库', desc: '条目 / 资料文件 / 剧本三栏，报价只认这里核过的价格' },
  { src: shotVoices, title: '音色库', desc: '云端音色与克隆音色，克隆前可试听，音色绑死接入与模型' },
  { src: shotSessions, title: '场次记录', desc: '每场留档，逐条试听、整场导出、观众画像' },
  { src: shotStats, title: '统计', desc: '概览、排行与热词、用量，按节目归组看 30 天趋势' }
]

/** 技术规格：给专业用户的一张表 */
const specs = [
  { k: '语言模型接入', v: 'OpenAI 兼容协议（DeepSeek / 通义千问 / 豆包 / Kimi / 智谱）、OpenAI 官方 Responses、Anthropic（含 Kimi 编程端点）、自定义地址' },
  { k: '语音合成接入', v: '火山引擎（豆包语音）、阿里云百炼、火山播客专用大模型（双人整期合成）' },
  { k: '声音克隆', v: '10–30 秒干净人声；百炼复刻需要公网可访问的样本地址（界面内提供临时上传）' },
  { k: '评论接入', v: '独立的平台连接器小软件，经本机 MCP（Bearer 令牌 + 端口）接入，默认端口 8102' },
  { k: '输出与推流', v: '伴侣模式（本应用只出声，画面交给直播软件）或直推 RTMP（FFmpeg 随包分发）' },
  { k: '导出', v: 'MP3 / WAV，分章文件或合并单文件，响度归一' },
  { k: '数据落盘', v: '全部存本机：Windows %APPDATA%\\YunCast、macOS ~/Library/Application Support/YunCast、Linux ~/.config/YunCast' },
  { k: '运行环境', v: 'Windows 10+ / macOS 13+（Apple 芯片）/ 主流 64 位 Linux；推流场景建议 8GB 内存以上' },
  { k: '许可与技术栈', v: 'MIT 许可 · Electron + React + TypeScript · 无服务端，除你自配的云 API 外不发数据' }
]

/** 常见做法 vs 用工作台：写得客观，不贬低别的做法 */
const compare = [
  { scene: '开播前准备', manual: '手写话术、逐个试听、临时找配乐', app: '导演按剧本写底稿，底稿库逐条过目，合成前先出「本次合成 N 段」的清单' },
  { scene: '出声', manual: '真人一直守在麦前，或者放一段录好的音频循环', app: '主播按人设讲话，四档话术池排顺序；真人想接手随时插播' },
  { scene: '评论', manual: '边讲边瞄弹幕，回不过来就漏掉', app: '评论去重聚合后按批交给主播，它自己判断回一条还是回一批' },
  { scene: '改稿', manual: '改完得重新录一遍', app: '边播边准备模式下，改稿只影响还没播的段，已播的音频不动' },
  { scene: '收尾', manual: '凭印象复盘，数据靠平台后台翻', app: '每场留档：逐条话术、评论、事件、观众画像与用量统计' }
]

/* GEO：可见 FAQ 与 FAQPage JSON-LD 保持一致，供搜索引擎与 AI 答案引擎引用 */
const faqs = [
  {
    q: '小云播客坊 YunCast 是什么？',
    a: '一款桌面软件（Electron + React，MIT 开源），把一场直播需要的写稿、配音、播出、控场、互动、留档放在同一个工作台里。适合不会直播的商家、实体店，也适合做有声书与播客的人。'
  },
  {
    q: '收费吗？运行成本大概多少？',
    a: '软件本身免费且开源（MIT），没有账号也没有服务端。运行时需要自配语言模型与语音合成的 API Key，按服务商单价计费；用量在「统计 → 用量」里按节目归组查看。估算方法见使用文档的「费用与选型」。'
  },
  {
    q: '不会写直播稿能用吗？',
    a: '可以。绑好剧本与知识范围后，直接对导演说「给这场写稿」，它按场景逐段写、查商品资料核对价格口径，产出进底稿库，你可以逐条改；改完再合成音频。'
  },
  {
    q: '能克隆店家的声音吗？',
    a: '能。在音色库上传 10–30 秒干净人声即可克隆，支持火山引擎、阿里云百炼；克隆出的音色绑定在指定接入与模型下，合成时用统一选择器挑选。百炼复刻需要公网可访问的样本地址，界面里有「上传样本并取地址」。'
  },
  {
    q: '支持哪些直播平台？',
    a: '软件本身与平台无关：合成声音走虚拟声卡或直接推流进入任意直播软件（伴侣模式 / 直推 RTMP 两种走法），评论通过独立的平台连接器小软件接入，目前提供抖音的连接器。'
  },
  {
    q: '直播听起来像真人吗？',
    a: '声音来自你选的克隆音色或云端音色，本身是真人录音训练的模型；说话内容由语言模型按人设卡生成（性格、口癖、禁区都能约束）。口播质量取决于所选模型与你的底稿，建议先跑一两场校对口径。'
  },
  {
    q: '一边播一边改稿，已播的音频会变吗？',
    a: '不会。每次合成选定的声音会冻结进那一段产物，改稿只让还没播或文稿已变的段落重新合成；「全部做好再播」的节目开播前会过一道门禁，音频不齐不会静默开播。'
  },
  {
    q: '数据会上传到云端吗？',
    a: '不会。除了调用你自己配置的 LLM / TTS 云 API，其余数据（剧本、底稿、音频、评论记录、用量）都存在本机用户数据目录里，软件没有服务端，也不收集遥测。'
  }
]

/* ---------- hero 声波音浪：三层正弦波叠加，品牌三色渐变，鼠标视差 ---------- */
const waveCanvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
let observer: IntersectionObserver | null = null
let onResize: (() => void) | null = null
let onPointer: ((e: PointerEvent) => void) | null = null

onMounted(() => {
  /* JSON-LD（FAQPage）与页面上的 FAQ 同步 */
  const faqLd = document.createElement('script')
  faqLd.id = 'faq-jsonld'
  faqLd.type = 'application/ld+json'
  faqLd.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }
    }))
  })
  document.head.appendChild(faqLd)

  /* 滚动入场：只把「视口下方」的元素先藏起来（.reveal-pre），其余直接可见。
     这样脚本挂了页面也是完整的，不会白屏。 */
  const revealTargets = Array.from(document.querySelectorAll('.reveal'))
  const belowFold = (el: Element) => el.getBoundingClientRect().top > window.innerHeight * 0.92
  if (!('IntersectionObserver' in window)) {
    /* 不支持观察器：什么都不做，全部保持可见 */
  } else {
    for (const el of revealTargets) if (belowFold(el)) el.classList.add('reveal-pre')
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            observer?.unobserve(e.target)
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
    )
    for (const el of revealTargets) if (el.classList.contains('reveal-pre')) observer.observe(el)
    /* 兜底：2.5s 后只要在视口附近的，一律显示 */
    window.setTimeout(() => {
      for (const el of document.querySelectorAll('.reveal-pre:not(.in)')) {
        if (el.getBoundingClientRect().top < window.innerHeight * 1.2) el.classList.add('in')
      }
    }, 2500)
  }

  /* 声波 */
  const canvas = waveCanvas.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let w = 0
  let h = 0
  let mx = 0.5
  let mxTarget = 0.5

  onResize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  onResize()
  window.addEventListener('resize', onResize)
  onPointer = (e) => {
    mxTarget = e.clientX / window.innerWidth
  }
  window.addEventListener('pointermove', onPointer)

  const layers = [
    { amp: 22, len: 0.0042, speed: 0.00035, base: 0.42, alpha: 0.1 },
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

/* ---------- 演示视频弹窗 ---------- */
const videoOpen = ref(false)
const videoEl = ref<HTMLVideoElement | null>(null)
let onKey: ((e: KeyboardEvent) => void) | null = null

const openVideo = () => {
  videoOpen.value = true
}
const closeVideo = () => {
  videoOpen.value = false
  videoEl.value?.pause()
}

onMounted(() => {
  onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && videoOpen.value) closeVideo()
  }
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  document.getElementById('faq-jsonld')?.remove()
  observer?.disconnect()
  cancelAnimationFrame(raf)
  if (onResize) window.removeEventListener('resize', onResize)
  if (onPointer) window.removeEventListener('pointermove', onPointer)
  if (onKey) window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="landing">
    <!-- ============ Hero ============ -->
    <section class="hero">
      <div class="fx-aurora" aria-hidden="true"><i /><i /><i /><i /></div>
      <div class="fx-dots hero-dots" aria-hidden="true" />
      <canvas ref="waveCanvas" class="hero-waves" aria-hidden="true" />

      <div class="hero-inner">
        <div class="badge reveal">
          <span class="badge-dot" />
          v0.1.3 · Windows / macOS（Apple 芯片）/ Linux
        </div>
        <h1 class="hero-title">
          <span class="line"><span class="word">不会直播，</span></span>
          <span class="line"><span class="word grad-text">也能自己开一场。</span></span>
        </h1>
        <p class="hero-sub reveal d1">
          桌面工作台把写稿、配音、播出、控场、互动串成一条流水线。声音可以克隆成店家的，成品音频能整场导出。<br />
          直播带货、商品宣讲、有声书、播客，同一套流程。
        </p>
        <div class="hero-cta reveal d2">
          <a class="btn primary" :href="withBase('/download')">下载安装包</a>
          <button class="btn ghost" type="button" @click="openVideo">
            <span class="btn-ico" v-html="ICONS.play" />
            看演示（1 分 52 秒）
          </button>
          <a class="btn ghost" :href="withBase('/guide/quickstart')">使用文档</a>
        </div>

        <div class="hero-shot reveal d3">
          <div class="window">
            <div class="window-bar"><i /><i /><i /><span class="window-url">小云播客坊 YunCast</span></div>
            <video class="hero-video" src="/demo-loop.mp4" poster="/demo-poster.jpg" autoplay muted loop playsinline />
            <button class="play-hint" type="button" @click="openVideo" aria-label="播放完整演示">
              <span v-html="ICONS.play" />
            </button>
          </div>
          <p class="caption">
            直播台：左栏「接下来 / 评论流 / 事件流」，底部吸底播放条，右下角唤起导演面板
          </p>
        </div>

        <ul class="hero-facts reveal d4">
          <li><span v-html="ICONS.check" />MIT 开源，无账号、无服务端</li>
          <li><span v-html="ICONS.check" />LLM 与 TTS 直连你自配的云 API</li>
          <li><span v-html="ICONS.check" />数据全部存在本机</li>
        </ul>
      </div>
    </section>

    <!-- ============ 流水线 ============ -->
    <section class="section pipeline-section">
      <div class="fx-grid" aria-hidden="true" />
      <div class="inner">
        <h2 class="display reveal">一条流水线，<span class="grad-text">从写稿到复盘</span></h2>
        <p class="lead reveal d1">每一步都有对应的界面，改哪一步都不会动到已经做好的部分。</p>
        <ol class="pipeline">
          <li v-for="(p, i) in pipeline" :key="p.title" class="pipe reveal" :style="{ transitionDelay: (i % 5) * 70 + 'ms' }">
            <span class="pipe-step">{{ i + 1 }}</span>
            <div class="pipe-icon" v-html="p.icon" />
            <h3>{{ p.title }}</h3>
            <p>{{ p.desc }}</p>
          </li>
        </ol>
      </div>
    </section>

    <!-- ============ 功能 ============ -->
    <section class="section alt">
      <div class="inner">
        <h2 class="display reveal">它具体<span class="grad-text">怎么用</span></h2>
        <p class="lead reveal d1">下面每一条都是界面上真实存在的能力，不是概念。</p>
        <div class="grid">
          <article v-for="(f, i) in features" :key="f.title" class="card reveal" :style="{ transitionDelay: (i % 4) * 60 + 'ms' }">
            <div class="card-icon" v-html="f.icon" />
            <h3>{{ f.title }}</h3>
            <p>{{ f.desc }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- ============ 三种播出方式 ============ -->
    <section class="section">
      <div class="fx-aurora soft" aria-hidden="true"><i /><i /></div>
      <div class="inner">
        <h2 class="display reveal">三种播出方式，<span class="grad-text">先想清楚再开播</span></h2>
        <p class="lead reveal d1">节目上选一次，之后合成与播放都按它来。</p>
        <div class="modes">
          <article v-for="(m, i) in modes" :key="m.name" class="mode reveal" :style="{ transitionDelay: i * 80 + 'ms' }">
            <header>
              <h3>{{ m.name }}</h3>
              <span class="chip">{{ m.tag }}</span>
            </header>
            <dl>
              <dt>合成</dt>
              <dd>{{ m.synth }}</dd>
              <dt>播放</dt>
              <dd>{{ m.play }}</dd>
              <dt>适合</dt>
              <dd>{{ m.fit }}</dd>
            </dl>
          </article>
        </div>
        <p class="more reveal">
          形态与播出方式怎么搭配，见 <a :href="withBase('/guide/concepts')">核心概念</a>
        </p>
      </div>
    </section>

    <!-- ============ 演示视频 ============ -->
    <section id="demo" class="section alt video-section">
      <div class="inner">
        <h2 class="display reveal">完整演示</h2>
        <p class="lead reveal d1">
          1 分 52 秒，从直播台、导演面板，到节目配置、底稿库、合成声音与逐页浏览。
        </p>
        <div class="video-wrap reveal d2">
          <video
            ref="videoEl"
            class="video-player"
            src="/demo.mp4"
            poster="/demo-poster.jpg"
            controls
            preload="none"
            playsinline
          />
        </div>
        <ul class="video-notes reveal d3">
          <li>配音由应用内的语音合成生成（用的是演示主播的嗓音），画面为真实操作录制</li>
          <li>演示里的对话、节目与数据都是样例，用来展示界面布局与交互</li>
          <li>想看每一步的细节说明，翻 <a :href="withBase('/guide/interface')">界面一览</a></li>
        </ul>
      </div>
    </section>

    <!-- ============ 界面 ============ -->
    <section class="section">
      <div class="inner">
        <h2 class="display reveal">界面<span class="grad-text">一览</span></h2>
        <div class="shots">
          <figure v-for="(s, i) in showcase" :key="s.title" class="shot reveal" :style="{ transitionDelay: (i % 2) * 80 + 'ms' }">
            <div class="window sm">
              <div class="window-bar"><i /><i /><i /></div>
              <img :src="s.src" :alt="s.title" loading="lazy" />
            </div>
            <figcaption>
              <h3>{{ s.title }}</h3>
              <p>{{ s.desc }}</p>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>

    <!-- ============ 对照 ============ -->
    <section class="section alt">
      <div class="inner">
        <h2 class="display reveal">以前怎么做，<span class="grad-text">现在谁做</span></h2>
        <div class="table-wrap reveal d1">
          <table class="compare">
            <thead>
              <tr><th>环节</th><th>没有工作台时</th><th>用工作台</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in compare" :key="c.scene">
                <td class="scene">{{ c.scene }}</td>
                <td>{{ c.manual }}</td>
                <td class="app">{{ c.app }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ============ 技术规格 ============ -->
    <section class="section">
      <div class="fx-grid faint" aria-hidden="true" />
      <div class="inner">
        <h2 class="display reveal">技术规格</h2>
        <p class="lead reveal d1">给要评估接入的同学：下面是实际支持的协议、服务与落盘位置。</p>
        <div class="table-wrap reveal d2">
          <table class="specs">
            <tbody>
              <tr v-for="s in specs" :key="s.k">
                <th>{{ s.k }}</th>
                <td>{{ s.v }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ============ 开源 ============ -->
    <section class="section alt">
      <div class="inner">
        <h2 class="display reveal">开源，<span class="grad-text">本地跑</span></h2>
        <div class="dev-grid">
          <div class="dev-card reveal">
            <h3>本地起一个开发环境</h3>
            <pre><code>$ git clone https://github.com/xy200303/yuncast
$ npm install
$ npm run dev</code></pre>
            <p class="muted">打包用 <code>npm run dist:win</code>（或 <code>dist</code> 走三平台配置）。</p>
          </div>
          <div class="dev-card reveal d1">
            <h3>技术栈与边界</h3>
            <ul class="dev-list">
              <li>Electron + React + TypeScript，主进程负责音频调度与数据落盘</li>
              <li>MIT 许可，无服务端：除调用你自配的云 API 外不发数据</li>
              <li>平台连接器独立分发，主程序不内置任何平台 SDK</li>
              <li>遇到问题先看<a :href="withBase('/guide/troubleshooting')">运行要求与排错</a></li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- ============ FAQ（与 JSON-LD 一致） ============ -->
    <section class="section faq-section">
      <div class="inner narrow">
        <h2 class="display reveal">常见问题</h2>
        <div class="faq-list">
          <details v-for="(f, i) in faqs" :key="f.q" class="faq-item reveal" :style="{ transitionDelay: (i % 3) * 50 + 'ms' }">
            <summary>{{ f.q }}</summary>
            <p>{{ f.a }}</p>
          </details>
        </div>
      </div>
    </section>

    <!-- ============ 收尾 ============ -->
    <section class="final">
      <div class="fx-aurora" aria-hidden="true"><i /><i /><i /></div>
      <div class="final-inner reveal">
        <h2 class="display">下载，配好两把钥匙，<span class="grad-text">开一场试试</span></h2>
        <p class="final-sub">
          语言模型负责写与想，语音合成负责出声。两个 Key 填完就能开播，剩下的都在界面里。
        </p>
        <div class="hero-cta center">
          <a class="btn primary big" href="https://github.com/xy200303/yuncast/releases/latest" target="_blank" rel="noreferrer">下载最新版</a>
          <a class="btn ghost" :href="withBase('/guide/quickstart')">四步上手</a>
          <a class="btn ghost" href="https://github.com/xy200303/yuncast" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <p class="footnote">MIT License · © 2026 小云播客坊 YunCast · 安装包未做代码签名，安装提示按文档处理</p>
      </div>
    </section>

    <!-- ============ 视频弹窗 ============ -->
    <div v-if="videoOpen" class="video-modal" @click.self="closeVideo">
      <div class="video-modal-inner">
        <header>
          <div>
            <strong>小云播客坊 · 功能演示</strong>
            <span>1 分 52 秒 · 含配音</span>
          </div>
          <button type="button" class="modal-close" aria-label="关闭" @click="closeVideo">✕</button>
        </header>
        <video src="/demo.mp4" controls autoplay playsinline />
      </div>
    </div>
  </div>
</template>

<style scoped>
.landing {
  overflow-x: clip;
  color: var(--vp-c-text-1);
  background: #ffffff;
}
.inner {
  position: relative;
  max-width: var(--yc-container);
  margin: 0 auto;
  padding: 0 24px;
}
.inner.narrow { max-width: 860px; }

/* ---------- 通用区块 ---------- */
.section {
  position: relative;
  padding: var(--yc-section-y) 0;
  overflow: hidden;
}
.section.alt { background: linear-gradient(180deg, #fbfbfe 0%, #f7f8fc 100%); border-top: 1px solid rgba(15, 23, 42, 0.05); border-bottom: 1px solid rgba(15, 23, 42, 0.05); }
.display {
  font-family: var(--font-display);
  font-size: clamp(28px, 3.6vw, 42px);
  line-height: 1.28;
  letter-spacing: 0.005em;
  text-align: center;
  margin: 0 0 14px;
}
.lead {
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 16px;
  max-width: 720px;
  margin: 0 auto 44px;
}
.more { text-align: center; color: var(--vp-c-text-3); font-size: 14px; margin-top: 28px; }

/* ---------- Hero ---------- */
.hero {
  position: relative;
  padding: 92px 24px 0;
  background: linear-gradient(180deg, #f8faff 0%, #ffffff 72%);
  overflow: hidden;
}
.hero-dots {
  mask-image: radial-gradient(ellipse 75% 55% at 50% 30%, #000 30%, transparent 75%);
}
.hero-waves { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 240px; pointer-events: none; }
.hero-inner { position: relative; max-width: 1020px; margin: 0 auto; text-align: center; }

.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 13px;
  color: #4338ca;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(99, 102, 241, 0.22);
  box-shadow: var(--yc-shadow-sm);
  backdrop-filter: blur(8px);
}
.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.16);
}

.hero-title {
  font-family: var(--font-display);
  font-size: clamp(34px, 6vw, 68px);
  line-height: 1.14;
  letter-spacing: 0.005em;
  margin: 26px 0 0;
}
.hero-title .line { display: block; }
.hero-sub {
  margin: 22px auto 0;
  max-width: 660px;
  font-size: 17px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}

.hero-cta { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; margin-top: 32px; }
.hero-cta.center { margin-top: 26px; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.24s, background 0.24s, color 0.24s;
}
.btn.primary {
  color: #fff;
  background: var(--yc-grad-brand);
  box-shadow: 0 14px 30px -12px rgba(79, 70, 229, 0.6);
}
.btn.primary:hover { transform: translateY(-2px); box-shadow: 0 20px 40px -14px rgba(79, 70, 229, 0.65); }
.btn.ghost {
  color: var(--vp-c-text-1);
  background: rgba(255, 255, 255, 0.86);
  border-color: rgba(15, 23, 42, 0.1);
  box-shadow: var(--yc-shadow-sm);
}
.btn.ghost:hover { transform: translateY(-2px); border-color: rgba(99, 102, 241, 0.35); color: var(--vp-c-brand-1); }
.btn.big { padding: 14px 30px; font-size: 16px; }
.btn-ico { display: inline-flex; width: 15px; height: 15px; }
.btn-ico :deep(svg), .hero-facts :deep(svg), .card-icon :deep(svg), .pipe-icon :deep(svg), .dev-list :deep(svg) {
  width: 100%;
  height: 100%;
  stroke-width: 1.8;
}

/* 窗口 / 截图框 */
.hero-shot { position: relative; margin-top: 56px; }
.window {
  position: relative;
  border-radius: var(--yc-radius-lg);
  overflow: hidden;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: var(--yc-shadow-lg);
}
.window-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: linear-gradient(180deg, #ffffff, #f7f8fc);
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
}
.window-bar i { width: 10px; height: 10px; border-radius: 50%; background: #e2e8f0; }
.window-bar i:nth-child(1) { background: #fda4af; }
.window-bar i:nth-child(2) { background: #fcd34d; }
.window-bar i:nth-child(3) { background: #86efac; }
.window-url { margin-left: 8px; font-size: 12px; color: var(--vp-c-text-3); }
.window.sm { border-radius: var(--yc-radius); }
.window img, .hero-video { display: block; width: 100%; }
.hero-video { aspect-ratio: 1440 / 902; object-fit: cover; }
.play-hint {
  position: absolute;
  right: 18px;
  bottom: 18px;
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: none;
  color: #fff;
  background: rgba(15, 23, 42, 0.62);
  backdrop-filter: blur(6px);
  cursor: pointer;
  transition: transform 0.24s, background 0.24s;
}
.play-hint:hover { transform: scale(1.06); background: rgba(79, 70, 229, 0.92); }
.play-hint :deep(svg) { width: 22px; height: 22px; fill: currentColor; stroke: none; }
.caption { margin-top: 14px; font-size: 13.5px; color: var(--vp-c-text-3); }

.hero-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 26px;
  justify-content: center;
  margin: 30px 0 0;
  padding: 0 0 68px;
  list-style: none;
  font-size: 13.5px;
  color: var(--vp-c-text-2);
}
.hero-facts li { display: inline-flex; align-items: center; gap: 6px; }
.hero-facts li span { display: inline-flex; width: 14px; height: 14px; color: #10b981; }

/* ---------- 流水线 ---------- */
.pipeline-section .fx-grid {
  opacity: 0.55;
  mask-image: radial-gradient(ellipse 70% 62% at 50% 45%, #000 20%, transparent 78%);
}
.pipeline {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
  list-style: none;
  padding: 0;
  margin: 0;
  position: relative;
}
.pipe {
  position: relative;
  padding: 22px 18px;
  border-radius: var(--yc-radius);
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: var(--yc-shadow-sm);
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s, border-color 0.3s;
}
.pipe:hover { transform: translateY(-4px); box-shadow: var(--yc-shadow); border-color: rgba(99, 102, 241, 0.28); }
.pipe-step {
  position: absolute;
  top: -10px;
  left: 16px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: var(--yc-grad-brand);
  box-shadow: 0 6px 14px -6px rgba(79, 70, 229, 0.7);
}
.pipe-icon { width: 22px; height: 22px; color: var(--vp-c-brand-1); margin-bottom: 10px; }
.pipe h3 { font-size: 15px; margin: 0 0 6px; }
.pipe p { font-size: 13.5px; color: var(--vp-c-text-2); margin: 0; line-height: 1.7; }

/* ---------- 功能卡 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.card {
  position: relative;
  padding: 22px 20px 20px;
  border-radius: var(--yc-radius);
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: var(--yc-shadow-sm);
  overflow: hidden;
  transition: transform 0.34s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.34s, border-color 0.34s;
}
.card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--yc-grad-brand);
  opacity: 0;
  transition: opacity 0.34s;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
.card:hover { transform: translateY(-5px); box-shadow: var(--yc-shadow); }
.card:hover::before { opacity: 1; }
.card-icon {
  width: 40px;
  height: 40px;
  padding: 9px;
  border-radius: 12px;
  color: var(--vp-c-brand-1);
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.14), rgba(168, 85, 247, 0.14));
  margin-bottom: 14px;
}
.card h3 { font-size: 15.5px; margin: 0 0 8px; }
.card p { font-size: 13.5px; line-height: 1.72; color: var(--vp-c-text-2); margin: 0; }

/* ---------- 三种播出方式 ---------- */
.modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.mode {
  padding: 24px 22px;
  border-radius: var(--yc-radius);
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: var(--yc-shadow-sm);
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s;
}
.mode:hover { transform: translateY(-4px); box-shadow: var(--yc-shadow); }
.mode header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.mode h3 { font-size: 17px; margin: 0; }
.chip {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.mode dl { display: grid; grid-template-columns: 52px 1fr; gap: 8px 10px; margin: 0; font-size: 13.5px; }
.mode dt { color: var(--vp-c-text-3); }
.mode dd { margin: 0; color: var(--vp-c-text-2); line-height: 1.65; }

/* ---------- 视频 ---------- */
.video-wrap {
  max-width: 980px;
  margin: 0 auto;
  border-radius: var(--yc-radius-lg);
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, 0.1);
  box-shadow: var(--yc-shadow-lg);
  background: #0b1020;
}
.video-player { display: block; width: 100%; aspect-ratio: 1920 / 1202; }
.video-notes {
  max-width: 980px;
  margin: 18px auto 0;
  padding-left: 20px;
  font-size: 13.5px;
  color: var(--vp-c-text-3);
  line-height: 1.9;
}
.video-notes a { color: var(--vp-c-brand-1); }

/* 视频弹窗 */
.video-modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(9, 12, 24, 0.72);
  backdrop-filter: blur(6px);
}
.video-modal-inner {
  width: min(1100px, 100%);
  border-radius: var(--yc-radius);
  overflow: hidden;
  background: #0b1020;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.7);
}
.video-modal-inner header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  color: #fff;
}
.video-modal-inner header strong { font-size: 15px; }
.video-modal-inner header span { margin-left: 10px; font-size: 12.5px; color: rgba(255, 255, 255, 0.6); }
.modal-close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: #fff;
  cursor: pointer;
}
.modal-close:hover { background: rgba(255, 255, 255, 0.12); }
.video-modal-inner video { display: block; width: 100%; background: #000; }

/* ---------- 截图 ---------- */
.shots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; }
.shot { margin: 0; }
.shot .window { transition: transform 0.36s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.36s; }
.shot:hover .window { transform: translateY(-4px); box-shadow: var(--yc-shadow-lg); }
.shot figcaption { padding: 12px 4px 0; }
.shot h3 { font-size: 15px; margin: 0 0 4px; }
.shot p { font-size: 13px; color: var(--vp-c-text-3); margin: 0; line-height: 1.7; }

/* ---------- 表格 ---------- */
.table-wrap {
  overflow-x: auto;
  border-radius: var(--yc-radius);
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #fff;
  box-shadow: var(--yc-shadow-sm);
}
table.compare, table.specs { width: 100%; border-collapse: collapse; font-size: 14.5px; }
table.compare th {
  text-align: left;
  padding: 14px 18px;
  background: #f7f8fc;
  font-weight: 600;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
}
table.compare td { padding: 14px 18px; border-bottom: 1px solid rgba(15, 23, 42, 0.05); vertical-align: top; line-height: 1.7; color: var(--vp-c-text-2); }
table.compare tr:last-child td { border-bottom: none; }
table.compare td.scene { color: var(--vp-c-text-1); font-weight: 500; white-space: nowrap; }
table.compare td.app { color: var(--vp-c-text-1); background: rgba(99, 102, 241, 0.04); }
table.specs th {
  text-align: left;
  width: 190px;
  padding: 14px 18px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: #f7f8fc;
  border-bottom: 1px solid rgba(15, 23, 42, 0.05);
  white-space: nowrap;
}
table.specs td { padding: 14px 18px; border-bottom: 1px solid rgba(15, 23, 42, 0.05); line-height: 1.7; color: var(--vp-c-text-1); }
table.specs tr:last-child th, table.specs tr:last-child td { border-bottom: none; }

/* ---------- 开发者 ---------- */
.dev-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 18px; }
.dev-card {
  padding: 24px;
  border-radius: var(--yc-radius);
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: var(--yc-shadow-sm);
}
.dev-card h3 { font-size: 16px; margin: 0 0 14px; }
.dev-card pre {
  margin: 0;
  padding: 16px;
  border-radius: var(--yc-radius-sm);
  background: #0f172a;
  color: #e2e8f0;
  font-size: 13px;
  line-height: 1.7;
  overflow-x: auto;
}
.dev-card code { font-family: var(--vp-font-family-mono); }
.muted { font-size: 13px; color: var(--vp-c-text-3); margin: 12px 0 0; }
.dev-list { margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.9; color: var(--vp-c-text-2); }
.dev-list a { color: var(--vp-c-brand-1); }

/* ---------- FAQ ---------- */
.faq-list { display: flex; flex-direction: column; gap: 10px; }
.faq-item {
  border-radius: var(--yc-radius-sm);
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: #fff;
  box-shadow: var(--yc-shadow-sm);
  transition: border-color 0.28s, box-shadow 0.28s;
}
.faq-item[open] { border-color: rgba(99, 102, 241, 0.3); box-shadow: var(--yc-shadow); }
.faq-item summary {
  cursor: pointer;
  padding: 16px 20px;
  font-size: 15px;
  font-weight: 500;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 10px;
}
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--yc-grad-brand);
  flex: none;
}
.faq-item p { margin: 0; padding: 0 20px 18px 36px; font-size: 14px; line-height: 1.85; color: var(--vp-c-text-2); }

/* ---------- 收尾 ---------- */
.final { position: relative; padding: 108px 24px 96px; text-align: center; overflow: hidden; background: linear-gradient(180deg, #ffffff, #f6f7fd); }
.fx-aurora.soft i { opacity: 0.28; }
.fx-grid.faint { opacity: 0.5; mask-image: radial-gradient(ellipse 60% 60% at 50% 40%, #000 25%, transparent 75%); }
.final-inner { position: relative; max-width: 820px; margin: 0 auto; }
.final-sub { color: var(--vp-c-text-2); font-size: 15.5px; line-height: 1.8; max-width: 620px; margin: 16px auto 0; }
.footnote { margin-top: 34px; font-size: 12.5px; color: var(--vp-c-text-3); }

/* ---------- 响应式 ---------- */
@media (max-width: 1080px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .shots { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pipeline { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 860px) {
  .modes { grid-template-columns: 1fr; }
  .dev-grid { grid-template-columns: 1fr; }
}
@media (max-width: 680px) {
  .grid, .shots, .pipeline { grid-template-columns: 1fr; }
  .hero { padding-top: 68px; }
  .hero-facts { padding-bottom: 48px; }
  table.specs th { width: auto; }
}
</style>
