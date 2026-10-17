<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { withBase } from 'vitepress'
import DotField from './components/DotField.vue'
import SignalStrip from './components/SignalStrip.vue'
import { EASE, hasFinePointer, initSmoothScroll, loadMotion, prefersReduced } from './motion/engine'
import shotLive from '../../guide/screenshots/live.png'
import shotPrograms from '../../guide/screenshots/programs.png'
import shotAnchors from '../../guide/screenshots/anchors.png'
import shotKnowledge from '../../guide/screenshots/knowledge.png'
import shotVoices from '../../guide/screenshots/voices.png'
import shotSessions from '../../guide/screenshots/sessions.png'
import shotStats from '../../guide/screenshots/stats.png'

/* lucide 风格线性图标（stroke, 24x24 viewBox）；v-html 需要完整 svg 外壳，只给内部路径点不渲染 */
const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const ICONS = {
  pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  waveform: svg('<path d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2"/>'),
  message: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  monitor: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  play: svg('<path d="M6 4.5v15l13-7.5Z"/>'),
  arrow: svg('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
  noAccount: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>'),
  drive: svg('<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>'),
  key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>')
}

/** 首屏数字条：只放本仓库可验证的实测值，不编造"用户数 / 客户 logo"这类背书 */
const stats = [
  { value: '712 ms', label: '单句合成实测延迟', note: '阿里云百炼 qwen3-tts-flash，本机实测' },
  { value: '8 段 · 约 4 分钟', label: '一次预合成的量', note: '点合成前先报段数与预估时长' },
  { value: '6 次/秒', label: '状态广播合并上限', note: '优化前 18.5 次/秒；流式期间长任务 0' },
  { value: '0 服务端', label: '数据只落本机', note: '除你自配的云 API 外不外发任何数据' }
]

/** 三条主线：写稿 / 播出 / 互动。每条 = 一句主张 + 四条能力 + 一个文档出口 */
const tracks = [
  {
    id: 'write',
    name: '写稿',
    lead: '绑好剧本与知识范围，说一句「给这场写稿」，它按场景逐段写、查商品资料核对价格，产出进底稿库等你过目。',
    to: '/guide/quickstart',
    toText: '看写稿流程',
    items: [
      { t: '按剧本分幕', d: '开场、痛点、讲解、收尾各写各的，不用你交代结构' },
      { t: '报价必须查证', d: '价格只认知识库核过的口径，查不到会明说而不是编' },
      { t: '逐条可改', d: '改一条只影响这一条，已经合成好的音频不会被动' },
      { t: '过程留痕', d: '思考过程、调用过哪些工具，时间线上都看得见' }
    ]
  },
  {
    id: 'play',
    name: '播出',
    lead: '三种播出方式覆盖不同场景，声音在合成那一刻定死，之后换主播、改人设都不会改写已经出好的音频。',
    to: '/guide/concepts',
    toText: '看播出机制',
    items: [
      { t: '现场发挥', d: '没有底稿，说一句合成一句，像真人一样接话' },
      { t: '边播边准备', d: '边播边合成，随时改后面的稿，已播的不受影响' },
      { t: '全部做好再播', d: '整本合成完，过门禁才开播，缺项不静默跳过' },
      { t: '四档话术池', d: '打断 / 下一条 / 常规 / 垫底，人工播报可以插队' }
    ]
  },
  {
    id: 'chat',
    name: '互动',
    lead: '评论先进事件流去重、归组、按批交给主播；回一条还是回一批由它判断，拿不准的事会递一张请示卡给你。',
    to: '/guide/interface',
    toText: '看界面说明',
    items: [
      { t: '先聚合再给主播', d: '30 秒同人同内容去重、5–30 秒自适应聚合、每分钟最多 6 次唤醒' },
      { t: '自己判断回不回', d: '不值得回的话就不回，不会为了热闹硬刷话' },
      { t: '人工随时插播', d: '人工播报可插为下一条，打断优先级最高的是它' },
      { t: '拿不准就问你', d: '价格、承诺、违规风险这类，弹请示卡等你点一下' }
    ]
  }
]

/** 更新日志：只写仓库里查得到的事实 */
const changelog = [
  {
    v: 'v0.1.3',
    when: '最新',
    items: [
      '工作台重做：吸底播放条、可停靠/悬浮的导演面板、场次记录与统计拆页',
      '声音统一到一个选择器，合成那一刻选定并冻结进每段产物',
      '时间线与流式的性能改造：状态广播 18.5 → 6.0 次/秒，长任务 0'
    ]
  },
  {
    v: 'v0.1.2',
    when: '修复版',
    items: ['结束节目会同时停掉播放循环，存货保留但不再续播', 'Debian 包元数据补全']
  },
  {
    v: 'v0.1.1',
    when: '首个公开版',
    items: ['三端发布；写稿、合成、播出、评论互动跑通', '节目音频导出与用量看板']
  }
]

/** 本地优先：把"数据在哪"讲清楚，比喊口号有用 */
const localFirst = [
  {
    icon: ICONS.noAccount,
    t: '没有账号，也没有我们的服务器',
    d: '下载即用，不注册、不登录、不收集遥测。',
    chips: ['无账号', '无登录', '无遥测']
  },
  {
    icon: ICONS.drive,
    t: '数据只落本机',
    d: '剧本、底稿、音频、评论记录都在用户数据目录；卸载不会删，整目录拷走即备份。'
  },
  {
    icon: ICONS.key,
    t: '云 API 只走你配的 Key',
    d: 'LLM 与 TTS 直连服务商，用多少、花多少在「统计 → 用量」里按节目可查。'
  },
  {
    icon: ICONS.code,
    t: '源码开放，可自行核对',
    d: 'MIT 许可，主进程与界面都在同一个仓库里，没有黑盒组件。',
    chips: ['主进程 / 界面同仓', '无黑盒组件', '可自行构建']
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
  },
  {
    q: '平台会不会判定成录播、违规？',
    a: '判定规则在平台，不在软件。软件这边能保证的是：声音由模型实时合成而不是播录音、话术按你绑定的知识范围生成、涉及价格必须查过知识库口径。建议先用小号试播一场，把话术和承诺逐条审一遍。'
  },
  {
    q: '需要什么配置的电脑？',
    a: 'Windows 10 及以上、macOS 13 及以上（只有 Apple 芯片版本）、主流 64 位 Linux。做推流时建议 8GB 内存以上；不推流、只做预制内容导出的话，普通办公本也够。'
  },
  {
    q: '能在多个平台同时播吗？',
    a: '软件与平台无关：它只负责出声，声音经虚拟声卡或推流进入你的直播软件，要同时推几个平台由那套软件决定。评论接入目前提供的是抖音连接器，其他平台需要对应连接器。'
  }
]

/** 跑马灯词带：能力关键词，滚动一遍不重复 */
const marquee = [
  '写稿',
  '声音克隆',
  '四档话术池',
  '评论去重',
  '直播台',
  '场次留档',
  '用量统计',
  '有声书导出',
  '播客双人',
  '导入外部音频',
  '知识库核价',
  '虚拟声卡'
]

/* ---------- 动效：滚入 / 数字滚动 / 指示器 / 平滑滚动 ---------- */
const heroEl = ref<HTMLElement | null>(null)
const shotEl = ref<HTMLElement | null>(null)
const tabsEl = ref<HTMLElement | null>(null)
const progressEl = ref<HTMLElement | null>(null)
const railEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const finalEl = ref<HTMLElement | null>(null)
const spotEl = ref<HTMLElement | null>(null)
let stopScroll: (() => void) | null = null
const teardowns: (() => void)[] = []

/* 首屏大标题按字拆开做错峰上浮。
   在模板里拆（每字一个 span），不做 DOM 变异——否则 Vue 重渲染时会和拆出来的节点打架。
   进场动画走纯 CSS（见 .hero-title .ch），所以脚本没加载完也不会留白。 */
const heroLines = ['不会直播，', '也能自己开一场。']
const heroOffset = heroLines[0].length

onMounted(async () => {
  /* JSON-LD（FAQPage）与页面上的 FAQ 同步。放在任何 await 之前，尽早注入。 */
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

  const reduced = prefersReduced()
  if (!reduced) stopScroll = await initSmoothScroll()

  let M: typeof import('motion')
  try {
    M = await loadMotion()
  } catch {
    /* 动效引擎没加载成功（离线 / 被拦）：把所有可能被藏起来的元素放出来，页面保持完整 */
    for (const el of document.querySelectorAll('.reveal-pre')) el.classList.remove('reveal-pre')
    return
  }
  const { animate, inView, scroll } = M

  /* 滚动入场：先把「视口下方」的元素藏起来，滚到时用弹簧放出来。
     首屏内容不参与（首屏进场由 CSS 动画负责，不依赖 JS 也不会闪）。 */
  /* 错峰时间有两个来源：单个元素用 d1–d4 档位，网格用行内 transitionDelay（每格递增） */
  const STAGGER: Record<string, number> = { d1: 0.07, d2: 0.14, d3: 0.21, d4: 0.28 }
  const staggerOf = (el: HTMLElement) => {
    for (const k in STAGGER) if (el.classList.contains(k)) return STAGGER[k]
    return (parseFloat(el.style.transitionDelay) || 0) / 1000
  }
  if (!reduced && 'IntersectionObserver' in window) {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('.reveal'))
    for (const el of targets) {
      if (el.getBoundingClientRect().top > window.innerHeight * 0.92) el.classList.add('reveal-pre')
    }
    for (const el of targets) {
      if (!el.classList.contains('reveal-pre')) continue
      /* 行内 transitionDelay 读完就清掉，不留死样式 */
      const delay = staggerOf(el)
      el.style.transitionDelay = ''
      teardowns.push(
        inView(
          el,
          () => {
            el.classList.remove('reveal-pre')
            animate(el, { opacity: [0, 1], y: [16, 0] }, { duration: 0.66, delay, easing: EASE })
          },
          { amount: 0.12, margin: '0px 0px -6% 0px' }
        )
      )
    }
    /* 兜底：2.5s 后只要在视口附近的，一律显示（防观察器在某些环境下不触发） */
    const t = window.setTimeout(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.reveal-pre')) {
        if (el.getBoundingClientRect().top < window.innerHeight * 1.2) {
          el.classList.remove('reveal-pre')
          animate(el, { opacity: [0, 1], y: [16, 0] }, { duration: 0.5, easing: EASE })
        }
      }
    }, 2500)
    teardowns.push(() => clearTimeout(t))

    /* 兜底：拖滚动条、按 End、深链跳转时，IntersectionObserver 不会为「被跳过」的中间元素回调，
       这些元素会一直停在隐藏态。所以每次滚动后再按位置扫一遍：顶端已进视口就必须显示。 */
    const sweep = () => {
      sweepRaf = 0
      for (const el of document.querySelectorAll<HTMLElement>('.reveal-pre')) {
        if (el.getBoundingClientRect().top < window.innerHeight * 0.98) {
          el.classList.remove('reveal-pre')
          animate(el, { opacity: [0, 1], y: [16, 0] }, { duration: 0.5, easing: EASE })
        }
      }
    }
    let sweepRaf = 0
    const onScroll = () => {
      if (!sweepRaf) sweepRaf = requestAnimationFrame(sweep)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    teardowns.push(() => {
      cancelAnimationFrame(sweepRaf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    })
  }

  /* 流水线导轨：线从左画出来，五个节点依次点亮。
     初始态只在「确实要播这段动画」时才设（这里在视口下方），
     避免脚本没跑起来时元素停在隐藏态 */
  const rail = railEl.value
  if (rail && !reduced && rail.getBoundingClientRect().top > window.innerHeight * 0.92) {
    const line = rail.querySelector<HTMLElement>('.rail-line')
    const dots = Array.from(rail.querySelectorAll<HTMLElement>('.rail-dot'))
    if (line) line.style.transform = 'scaleX(0)'
    for (const d of dots) d.style.transform = 'scale(0)'
    teardowns.push(
      inView(
        rail,
        () => {
          if (line) animate(line, { scaleX: [0, 1] }, { duration: 0.95, easing: EASE })
          dots.forEach((d, i) =>
            animate(d, { scale: [0, 1] }, { type: 'spring', stiffness: 430, damping: 22, delay: 0.1 + i * 0.13 })
          )
        },
        { amount: 0.6 }
      )
    )
  }

  /* 界面截图与演示影片：从 1.045 收到 1，做出"浮上来"的层次
     （父级 .shot / .reveal 的淡入仍由 .reveal 负责，所以不会出现先亮后淡的跳变） */
  if (!reduced) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.shot .window, .video-wrap'))) {
      teardowns.push(
        inView(
          el,
          () => animate(el, { scale: [1.045, 1], opacity: [0, 1] }, { duration: 0.72, easing: EASE }),
          { amount: 0.2 }
        )
      )
    }
  }

  /* 对比表：逐行滑入，"以前 / 现在"两列的差别靠行序自己讲 */
  const rows = Array.from(document.querySelectorAll<HTMLElement>('table.compare tbody tr'))
  if (rows.length && !reduced) {
    teardowns.push(
      inView(
        'table.compare',
        () => {
          rows.forEach((r, i) =>
            animate(r, { opacity: [0, 1], y: [10, 0] }, { duration: 0.5, delay: i * 0.07, easing: EASE })
          )
        },
        { amount: 0.25 }
      )
    )
  }

  /* 数字条：进入视口时从 0 滚到目标值（等宽数字，滚动过程中不跳位） */
  if (!reduced) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.stat strong'))) {
      const m = (el.textContent ?? '').trim().match(/^(\d+(?:\.\d+)?)(.*)$/)
      if (!m) continue
      const target = Number(m[1])
      const suffix = m[2]
      const dec = (m[1].split('.')[1] ?? '').length
      el.textContent = (0).toFixed(dec) + suffix
      teardowns.push(
        inView(
          el,
          () => {
            animate(0, target, {
              duration: 1.15,
              easing: EASE,
              onUpdate: (v: number) => {
                el.textContent = v.toFixed(dec) + suffix
              }
            })
          },
          { amount: 'all' }
        )
      )
    }
  }

  /* 收尾深色带：柔和光斑跟随指针，移出淡出（用极淡的品牌蓝，不是装饰渐变） */
  const fin = finalEl.value
  const spot = spotEl.value
  if (fin && spot && !reduced && hasFinePointer()) {
    const to = (x: number, y: number, opacity: number, stiffness: number) => {
      ctrlSpot?.stop()
      ctrlSpot = animate(spot, { x, y, opacity }, { type: 'spring', stiffness, damping: 26 })
    }
    let ctrlSpot: { stop: () => void } | null = null
    const onMove = (e: PointerEvent) => {
      const r = fin.getBoundingClientRect()
      to(e.clientX - r.left, e.clientY - r.top, 1, 130)
    }
    const onLeave = () => to(0, 0, 0, 90)
    fin.addEventListener('pointermove', onMove, { passive: true })
    fin.addEventListener('pointerleave', onLeave)
    teardowns.push(() => {
      ctrlSpot?.stop()
      fin.removeEventListener('pointermove', onMove)
      fin.removeEventListener('pointerleave', onLeave)
    })
  }

  /* 三条主线的下划线指示器：位置与宽度用弹簧滑过去，而不是跟着 class 跳 */
  const tabs = tabsEl.value
  if (tabs && !reduced) {
    const bar = tabs.querySelector<HTMLElement>('.tab-bar')
    const barNow = bar
    if (barNow) {
      const place = (animated: boolean) => {
        const on = tabs.querySelector<HTMLElement>('.tab.on')
        if (!on) return
        const a = tabs.getBoundingClientRect()
        const b = on.getBoundingClientRect()
        const x = b.left - a.left
        if (animated) animate(barNow, { x, width: b.width }, { type: 'spring', stiffness: 430, damping: 34 })
        else Object.assign(barNow.style, { transform: `translateX(${x}px)`, width: `${b.width}px` })
      }
      place(false)
      const stopW = watch(track, () =>
        nextTick(() => {
          place(true)
          /* 面板内容交叉淡入：切主线时不再硬切 */
          const panel = panelEl.value
          if (panel) animate(panel, { opacity: [0, 1], y: [8, 0] }, { duration: 0.34, easing: EASE })
        })
      )
      const onResize = () => place(false)
      window.addEventListener('resize', onResize)
      teardowns.push(stopW, () => window.removeEventListener('resize', onResize))
    }
  }

  /* 阅读进度条：整页滚动进度直接驱动一条 2px 细线 */
  const bar = progressEl.value
  if (bar && !reduced) {
    teardowns.push(scroll(animate(bar, { scaleX: [0, 1] }, { ease: 'linear' })))
  }

  /* 首屏点阵随滚动缓慢上移：做出前后景的深度差 */
  const hero = heroEl.value
  const field = hero?.querySelector<HTMLElement>('.dot-field')
  if (hero && field && !reduced) {
    teardowns.push(scroll(animate(field, { y: [0, -64] }, { ease: 'linear' }), { target: hero, offset: ['start start', 'end start'] }))
  }

  /* 产品窗：指针倾斜（幅度很小、弹簧跟随，回到 0 时也走弹簧，不会突然弹回去） */
  const frame = shotEl.value
  if (frame && !reduced && hasFinePointer()) {
    let ctrl: { stop: () => void } | null = null
    const aim = (rx: number, ry: number, stiffness = 150) => {
      ctrl?.stop()
      ctrl = animate(frame, { rotateX: rx, rotateY: ry }, { type: 'spring', stiffness, damping: 22 })
    }
    const onMove = (e: PointerEvent) => {
      const r = frame.getBoundingClientRect()
      const nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
      const ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
      const cx = Math.max(-1, Math.min(1, nx))
      const cy = Math.max(-1, Math.min(1, ny))
      aim(-cy * 2.4, cx * 3.2)
    }
    const reset = () => aim(0, 0, 190)
    window.addEventListener('pointermove', onMove, { passive: true })
    frame.addEventListener('pointerleave', reset)
    teardowns.push(() => {
      ctrl?.stop()
      window.removeEventListener('pointermove', onMove)
      frame.removeEventListener('pointerleave', reset)
    })
  }

  /* FAQ：把 <details> 的原生瞬开改成高度 + 透明度过渡 */
  if (!reduced) {
    const items = Array.from(document.querySelectorAll<HTMLDetailsElement>('.faq-item'))
    for (const d of items) {
      const body = d.querySelector<HTMLElement>('p')
      if (!body) continue
      const onClick = (e: MouseEvent) => {
        if (!(e.target as Element).closest('summary')) return
        e.preventDefault()
        body.style.overflow = 'hidden'
        if (d.open) {
          animate(body, { height: [`${body.offsetHeight}px`, '0px'], opacity: [1, 0] }, { duration: 0.24, easing: EASE }).then(() => {
            d.open = false
            body.style.overflow = ''
            body.style.height = ''
            body.style.opacity = ''
          })
        } else {
          d.open = true
          animate(body, { height: ['0px', `${body.offsetHeight}px`], opacity: [0, 1] }, { duration: 0.3, easing: EASE }).then(() => {
            body.style.overflow = ''
            body.style.height = ''
          })
        }
      }
      d.addEventListener('click', onClick)
      teardowns.push(() => d.removeEventListener('click', onClick))
    }
  }
})

/* ---------- 三条主线的 tab 状态 ---------- */
const track = ref('write')

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
  for (const off of teardowns) off()
  stopScroll?.()
  if (onKey) window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="landing">
    <!-- 阅读进度：一条细线，随滚动增长 -->
    <div ref="progressEl" class="progress" aria-hidden="true" />
    <!-- ============ Hero ============ -->
    <section ref="heroEl" class="hero">
      <DotField class="hero-field" :gap="22" :radius="140" :push="34" />
      <a
        class="notice reveal"
        href="https://github.com/xy200303/yuncast/releases/latest"
        target="_blank"
        rel="noreferrer"
      >
        <span class="notice-tag">v0.1.3</span>
        <span class="notice-text">刚发布：工作台重做、声音合成统一入口 · 查看更新说明</span>
        <span class="notice-arrow" v-html="ICONS.arrow" />
      </a>
      <div class="hero-inner">
        <h1 class="hero-title">
          <span v-for="(line, li) in heroLines" :key="li" class="line">
            <span
              v-for="(ch, ci) in [...line]"
              :key="ci"
              class="ch"
              :style="{ '--ci': (li ? heroOffset : 0) + ci }"
              >{{ ch }}</span
            >
          </span>
        </h1>
        <p class="hero-sub reveal d1">
          写稿、配音、播出、控场、互动，一条流水线都在一个桌面工作台里。
        </p>
        <div class="hero-cta reveal d2">
          <a v-press class="btn primary" :href="withBase('/download')">
            下载安装包
            <span class="arw" v-html="ICONS.arrow" />
          </a>
          <button v-press class="btn ghost" type="button" @click="openVideo">
            <span class="btn-ico" v-html="ICONS.play" />
            看演示（1 分 44 秒）
          </button>
          <a v-press class="btn ghost" :href="withBase('/guide/quickstart')">使用文档</a>
        </div>

        <div class="hero-shot">
          <div ref="shotEl" class="shot-frame">
            <div class="window">
              <div class="window-bar"><i /><i /><i /><span class="window-url">小云播客坊 YunCast</span></div>
              <video class="hero-video" src="/demo-loop.mp4" poster="/demo-poster.jpg" autoplay muted loop playsinline />
              <button v-press class="play-hint" type="button" @click="openVideo" aria-label="播放产品自述">
                <span v-html="ICONS.play" />
              </button>
            </div>
            <!-- 细线标注：把界面上的三个位置直接指出来，比下面的说明文字更有用 -->
            <span class="call call--left call-a"><em>四档话术池</em><i /></span>
            <span class="call call--left call-b"><em>吸底播放条</em><i /></span>
            <span class="call call--right call-c"><i /><em>导演面板</em></span>
          </div>
        </div>
      </div>
      <SignalStrip class="hero-signal" :height="72" :lines="3" />
    </section>

    <!-- ============ 数字条（只放实测值） ============ -->
    <section class="section statband">
      <div class="inner">
        <ul class="stats">
          <li v-for="(s, i) in stats" :key="s.label" class="stat reveal" :style="{ transitionDelay: i * 70 + 'ms' }">
            <strong>{{ s.value }}</strong>
            <span class="stat-label">{{ s.label }}</span>
            <span class="stat-note">{{ s.note }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- ============ 能力跑马灯：一条会走的词带，给版面带节奏 ============ -->
    <div class="marquee" aria-hidden="true">
      <div class="marquee-track">
        <span v-for="(w, i) in [...marquee, ...marquee]" :key="i" class="marquee-word">
          {{ w }}<i>·</i>
        </span>
      </div>
    </div>

    <!-- ============ 三条主线：写稿 / 播出 / 互动 ============ -->
    <section class="section tracks-section">
      <div class="inner">
        <span class="eyebrow reveal"><i>01</i>三条主线</span>
        <h2 class="display reveal">写稿 · 播出 · 互动，<span>三件事各有一套界面</span></h2>
        <p class="lead reveal d1">点开看每条主线具体能做什么。</p>
        <div ref="tabsEl" class="tabs reveal d2" role="tablist">
          <button
            v-for="t in tracks"
            :key="t.id"
            v-press
            type="button"
            role="tab"
            :aria-selected="track === t.id"
            :class="['tab', track === t.id && 'on']"
            @click="track = t.id"
          >
            {{ t.name }}
          </button>
          <span class="tab-bar" aria-hidden="true" />
        </div>
        <div ref="panelEl" class="track-panel reveal d3">
          <template v-for="t in tracks" :key="t.id">
            <div v-if="track === t.id" class="track-body">
              <p class="track-lead">{{ t.lead }}</p>
              <ul class="track-items">
                <li v-for="it in t.items" :key="it.t">
                  <strong>{{ it.t }}</strong>
                  <span>{{ it.d }}</span>
                </li>
              </ul>
              <a class="track-link" :href="withBase(t.to)">
                {{ t.toText }} <span v-html="ICONS.arrow" />
              </a>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- ============ 流水线 ============ -->
    <section class="section pipeline-section">
      <div class="inner">
        <span class="eyebrow reveal"><i>02</i>一条流水线</span>
        <h2 class="display reveal">一条流水线，<span>从写稿到复盘</span></h2>
        <p class="lead reveal d1">每一步都有对应的界面，改哪一步都不会动到已经做好的部分。</p>
        <div ref="railEl" class="pipe-rail" aria-hidden="true">
          <span class="rail-line" />
          <span v-for="n in 5" :key="n" class="rail-dot" />
        </div>
        <ol class="pipeline">
          <li
            v-for="(p, i) in pipeline"
            :key="p.title"
            v-lift="3"
            v-spot
            class="pipe reveal"
            :style="{ transitionDelay: (i % 5) * 70 + 'ms' }"
          >
            <span class="pipe-step">{{ String(i + 1).padStart(2, '0') }}</span>
            <div class="pipe-icon" v-html="p.icon" />
            <h3>{{ p.title }}</h3>
            <p>{{ p.desc }}</p>
          </li>
        </ol>
      </div>
    </section>

    <!-- ============ 本地优先 ============ -->
    <section class="section alt">
      <div class="inner">
        <span class="eyebrow reveal"><i>03</i>免费开源</span>
        <h2 class="display reveal">免费、开源、<span>数据在本机</span></h2>
        <p class="lead reveal d1">软件本身 MIT 免费，运行成本只有你自配的语言模型与语音合成，用量在应用里可查。</p>
        <div class="bento">
          <article
            v-for="(l, i) in localFirst"
            :key="l.t"
            v-lift="4"
            v-spot
            class="card reveal"
            :style="{ transitionDelay: i * 60 + 'ms' }"
          >
            <div class="card-icon" v-html="l.icon" />
            <h3>{{ l.t }}</h3>
            <p>{{ l.d }}</p>
            <ul v-if="l.chips" class="card-chips">
              <li v-for="c in l.chips" :key="c">{{ c }}</li>
            </ul>
          </article>
        </div>
        <p class="more reveal">
          花费怎么估、按什么选模型，见 <a :href="withBase('/guide/cost')">费用与选型</a>
        </p>
      </div>
    </section>

    <!-- ============ 三种播出方式 ============ -->
    <section class="section">
      <div class="inner">
        <span class="eyebrow reveal"><i>04</i>播出方式</span>
        <h2 class="display reveal">三种播出方式，<span>先想清楚再开播</span></h2>
        <p class="lead reveal d1">节目上选一次，之后合成与播放都按它来。</p>
        <div class="modes">
          <article
            v-for="(m, i) in modes"
            :key="m.name"
            v-lift="4"
            v-spot
            class="mode reveal"
            :style="{ transitionDelay: i * 80 + 'ms' }"
          >
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
        <span class="eyebrow reveal"><i>05</i>产品自述</span>
        <h2 class="display reveal">产品自述</h2>
        <p class="lead reveal d1">
          1 分 44 秒，这一场没有第三方解说：稿子存在底稿库，声音由应用自己合成，
          开播后按章节顺序念出来——听到的就是屏幕上写着的那 12 条。
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
          <li>节目是自己建的：内容类型「单人」、播出方式「全部做好再播」、播完即停</li>
          <li>12 条底稿先整体合成，再开播；播到哪一条，画面上就高亮哪一条</li>
          <li>声音来自应用内的语音合成（出镜主播「小陶」，苏瑶音色，语速 1.12）</li>
          <li>演示里的底稿、节目与评论是样例数据，用来展示流程</li>
          <li>想看每一步的细节说明，翻 <a :href="withBase('/guide/interface')">界面一览</a></li>
        </ul>
      </div>
    </section>

    <!-- ============ 界面 ============ -->
    <section class="section">
      <div class="inner">
        <span class="eyebrow reveal"><i>06</i>界面一览</span>
        <h2 class="display reveal">界面<span>一览</span></h2>
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
        <span class="eyebrow reveal"><i>07</i>前后对比</span>
        <h2 class="display reveal">以前怎么做，<span>现在谁做</span></h2>
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
      <div class="inner">
        <span class="eyebrow reveal"><i>08</i>技术规格</span>
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
        <span class="eyebrow reveal"><i>09</i>本地运行</span>
        <h2 class="display reveal">开源，<span>本地跑</span></h2>
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

    <!-- ============ 更新日志 ============ -->
    <section class="section">
      <div class="inner">
        <span class="eyebrow reveal"><i>10</i>持续迭代</span>
        <h2 class="display reveal">在持续迭代</h2>
        <p class="lead reveal d1">
          每个版本都发布三端安装包与更新说明，应用内「设置 → 关于」可以直接检查更新。
        </p>
        <ol class="releases">
          <li
            v-for="(r, i) in changelog"
            :key="r.v"
            v-lift="3"
            v-spot
            class="rel reveal"
            :style="{ transitionDelay: i * 70 + 'ms' }"
          >
            <div class="rel-head">
              <span class="rel-v">{{ r.v }}</span>
              <span class="rel-when">{{ r.when }}</span>
            </div>
            <ul>
              <li v-for="item in r.items" :key="item">{{ item }}</li>
            </ul>
          </li>
        </ol>
        <p class="more reveal">
          完整历史见
          <a href="https://github.com/xy200303/yuncast/releases" target="_blank" rel="noreferrer">GitHub Releases</a>
        </p>
      </div>
    </section>

    <!-- ============ FAQ（与 JSON-LD 一致） ============ -->
    <section class="section faq-section alt">
      <div class="inner narrow">
        <span class="eyebrow reveal"><i>11</i>常见问题</span>
        <h2 class="display reveal">常见问题</h2>
        <div class="faq-list">
          <details
            v-for="(f, i) in faqs"
            :key="f.q"
            class="faq-item reveal"
            :open="i === 0"
            :style="{ transitionDelay: (i % 3) * 50 + 'ms' }"
          >
            <summary>{{ f.q }}</summary>
            <p>{{ f.a }}</p>
          </details>
        </div>
      </div>
    </section>

    <!-- ============ 收尾 ============ -->
    <section ref="finalEl" class="final">
      <div ref="spotEl" class="spot" aria-hidden="true" />
      <div class="final-inner reveal">
        <h2 class="display">下载，配好两把钥匙，<span>开一场试试</span></h2>
        <p class="final-sub">
          语言模型负责写与想，语音合成负责出声。两个 Key 填完就能开播，剩下的都在界面里。
        </p>
        <div class="hero-cta center">
          <a v-press class="btn primary big" href="https://github.com/xy200303/yuncast/releases/latest" target="_blank" rel="noreferrer">
            下载最新版
            <span class="arw" v-html="ICONS.arrow" />
          </a>
          <a v-press class="btn ghost" :href="withBase('/guide/quickstart')">四步上手</a>
          <a v-press class="btn ghost" href="https://github.com/xy200303/yuncast" target="_blank" rel="noreferrer">GitHub</a>
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
            <span>1 分 44 秒 · 产品自述</span>
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
}
/* 分区只用「浅底 + 上下 hairline」，不用渐变 */
.section.alt {
  background: var(--yc-bg-alt);
  border-top: 1px solid var(--yc-line-soft);
  border-bottom: 1px solid var(--yc-line-soft);
}
.display {
  font-family: var(--font-display);
  /* 中文大标题：40px 封顶、行高 1.32、字距 0（照飞书：中文不压字距） */
  font-size: clamp(26px, 3.2vw, 40px);
  font-weight: 540;
  line-height: 1.32;
  letter-spacing: 0;
  text-align: center;
  text-wrap: balance;
  margin: 0 0 16px;
}
/* 标题里的重点短语用品牌色点出来（实色，不做渐变字） */
.display > span { color: var(--yc-accent); }

/* 章节头：编号眉标 + 左对齐标题/说明。
   整页都居中是最像模板的做法，所以正文各节改成左对齐；
   首屏与收尾保持居中，形成"首尾收拢、中间松散"的节奏 */
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 14px;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--vp-c-text-3);
}
.eyebrow i { font-style: normal; color: var(--yc-accent); }
.section .inner > .display {
  text-align: left;
  font-size: clamp(23px, 2.6vw, 33px);
}
.section .inner > .lead {
  text-align: left;
  max-width: 620px;
  margin: 0 0 48px;
}
.lead {
  text-align: center;
  color: var(--vp-c-text-2);
  font-size: 16.5px;
  line-height: 1.75;
  max-width: 660px;
  margin: 0 auto 52px;
  text-wrap: pretty;
}
.more { text-align: center; color: var(--vp-c-text-3); font-size: 13.5px; margin-top: 30px; }

/* ---------- 阅读进度条 ---------- */
.progress {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 2px;
  z-index: 60;
  background: var(--yc-accent);
  transform: scaleX(0);
  transform-origin: 0 50%;
  pointer-events: none;
}

/* ---------- 能力跑马灯 ---------- */
.marquee {
  overflow: hidden;
  padding: 20px 0;
  background: #fff;
  border-top: 1px solid var(--yc-line-soft);
  border-bottom: 1px solid var(--yc-line-soft);
  mask-image: linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent);
}
.marquee-track {
  display: flex;
  width: max-content;
  animation: yc-marquee 52s linear infinite;
}
.marquee:hover .marquee-track { animation-play-state: paused; }
.marquee-word {
  display: inline-flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}
.marquee-word i { font-style: normal; color: var(--yc-blue-300); }
@keyframes yc-marquee {
  to {
    transform: translate3d(-50%, 0, 0);
  }
}

/* ---------- 顶部公告条（迭代可见性） ---------- */
.notice {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  width: fit-content;
  max-width: 100%;
  margin: 0 auto 28px;
  padding: 6px 12px 6px 7px;
  border-radius: var(--yc-radius-xs);
  font-size: 13px;
  color: var(--vp-c-text-2);
  background: #fff;
  border: 1px solid var(--yc-line);
  transition: border-color 0.2s, color 0.2s;
}
.notice:hover { border-color: var(--yc-line-strong); color: var(--vp-c-text-1); }
.notice-tag {
  flex: none;
  padding: 2px 7px;
  border-radius: var(--yc-radius-xs);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #fff;
  background: var(--yc-accent);
  font-variant-numeric: tabular-nums;
}
.notice-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notice-arrow {
  flex: none;
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: var(--vp-c-text-3);
  transition: transform 0.2s, color 0.2s;
}
.notice:hover .notice-arrow { transform: translateX(2px); color: var(--vp-c-text-1); }
.notice-arrow :deep(svg) { width: 100%; height: 100%; }

/* ---------- 数字条：一条带竖分隔的规格带，不是四张浮卡 ---------- */
.statband { padding: 56px 0 12px; }
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  list-style: none;
  margin: 0;
  padding: 0;
  background: #fff;
  border: 1px solid var(--yc-line);
  border-radius: var(--yc-radius);
  overflow: hidden;
}
.stat { padding: 22px 24px; border-left: 1px solid var(--yc-line-soft); }
.stat:first-child { border-left: none; }
.stat strong {
  display: block;
  font-family: var(--font-display);
  font-size: 25px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.018em;
  font-variant-numeric: tabular-nums;
  /* 中文不成词内断行：「8 段 · 约 4 分钟」在窄栏里断在分隔号后，而不是"分/钟"中间 */
  word-break: keep-all;
  color: var(--yc-accent);
}
.stat-label { display: block; margin-top: 8px; font-size: 13.5px; color: var(--vp-c-text-1); }
.stat-note { display: block; margin-top: 3px; font-size: 12px; color: var(--vp-c-text-3); line-height: 1.6; }

/* ---------- 三条主线：下划线 tab（不是胶囊切换器） ---------- */
.tracks-section { padding: var(--yc-section-y) 0 84px; }
.tabs {
  position: relative;
  display: flex;
  gap: 32px;
  width: fit-content;
  margin: 0 auto 30px;
  border-bottom: 1px solid var(--yc-line-soft);
}
.tab {
  position: relative;
  padding: 0 2px 12px;
  border: none;
  background: none;
  font-size: 15px;
  font-weight: 500;
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition: color 0.2s;
}
.tab:hover { color: var(--vp-c-text-1); }
.tab.on { color: var(--vp-c-text-1); }
/* 下划线指示器由动效引擎驱动（位置与宽度弹簧滑动），初始位置在 JS 里落位 */
.tab-bar {
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 2px;
  width: 0;
  background: var(--yc-ink);
  border-radius: 1px;
}
.track-panel {
  padding: 30px 32px 28px;
  border-radius: var(--yc-radius-lg);
  background: #fff;
  border: 1px solid var(--yc-line);
}
.track-body { display: flex; flex-direction: column; gap: 20px; }
.track-lead { margin: 0; font-size: 15.5px; line-height: 1.85; color: var(--vp-c-text-2); }
.track-items {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 28px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.track-items li {
  position: relative;
  padding-left: 16px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}
.track-items li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  width: 6px;
  height: 2px;
  background: var(--yc-accent);
}
.track-items strong { display: block; color: var(--vp-c-text-1); font-weight: 500; }
.track-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--yc-accent);
}
.track-link :deep(svg) { width: 15px; height: 15px; transition: transform 0.2s; }
.track-link:hover :deep(svg) { transform: translateX(3px); }

/* 两列卡片（本地优先那节） */
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }

/* bento：大小格交错，破掉"几张等大卡"的均质感。
   4 格排成 3 列 —— 第一格与第四格各跨两列，视觉重心左右交替 */
.bento {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.bento > :nth-child(1),
.bento > :nth-child(4) { grid-column: span 2; }
.card-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
}
.card-chips li {
  padding: 3px 8px;
  border: 1px solid var(--yc-line);
  border-radius: var(--yc-radius-xs);
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  color: var(--vp-c-text-3);
}

/* ---------- 卡片内的指针跟随高光 ----------
   指针位置由 v-spot 指令写进元素的 --mx / --my，CSS 只负责画一层极淡的品牌色光。 */
.card,
.pipe,
.mode,
.rel { position: relative; }
.card::after,
.pipe::after,
.mode::after,
.rel::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(
    220px circle at var(--mx, 50%) var(--my, 0%),
    rgba(29, 78, 216, 0.07),
    transparent 68%
  );
  opacity: 0;
  transition: opacity 0.24s;
  pointer-events: none;
}
@media (hover: hover) and (pointer: fine) {
  .card:hover::after,
  .pipe:hover::after,
  .mode:hover::after,
  .rel:hover::after { opacity: 1; }
}

/* ---------- 更新日志 ---------- */
.releases {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.rel {
  padding: 20px 22px;
  border-radius: var(--yc-radius);
  background: #fff;
  border: 1px solid var(--yc-line);
}
.rel-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.rel-v {
  font-family: var(--vp-font-family-mono);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  color: var(--yc-accent);
}
.rel-when { font-size: 12px; color: var(--vp-c-text-3); }
.rel ul { margin: 0; padding: 0; list-style: none; }
.rel li {
  position: relative;
  padding-left: 14px;
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
}
.rel li + li { margin-top: 6px; }
.rel li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 11px;
  width: 6px;
  height: 1px;
  background: var(--vp-c-text-3);
}

/* ---------- Hero ---------- */
/* 版面靠留白和字号跨度撑；背景是一层可交互的点阵（DotField），不是光效 */
.hero {
  position: relative;
  overflow: hidden;
  padding: 96px 24px 0;
  background: #fbfbfa;
}
.hero-field {
  /* 只在上半屏露面，往下淡出，避免和正文抢注意力 */
  mask-image: linear-gradient(#000 0 42%, transparent 88%);
}
.hero-inner { position: relative; max-width: 1020px; margin: 0 auto; text-align: center; }
/* 首屏信号带：出血到两侧，做 hero 的收口 */
.hero-signal { margin: 56px -24px 0; width: calc(100% + 48px); }

.hero-title {
  font-family: var(--font-display);
  font-size: clamp(30px, 4.6vw, 54px);
  font-weight: 540;
  line-height: 1.2;
  letter-spacing: -0.01em;
  margin: 10px 0 0;
}
/* 每行一个裁切盒：字从下方升上来，被行盒切住 */
.hero-title .line {
  display: block;
  overflow: hidden;
  padding-bottom: 0.14em;
  margin-bottom: -0.14em;
}
.hero-title .ch {
  display: inline-block;
  animation: yc-rise 0.92s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--ci, 0) * 45ms + 0.12s);
  will-change: transform;
}
/* 第一行铺垫、第二行主张：主张那句用品牌色点出来 */
.hero-title .line:last-child .ch { color: var(--yc-accent); }
@keyframes yc-rise {
  from {
    transform: translate3d(0, 108%, 0);
  }
  to {
    transform: translate3d(0, 0, 0);
  }
}
.hero-sub {
  margin: 24px auto 0;
  max-width: 620px;
  font-size: 16.5px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
  animation: yc-fade-up 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.62s;
}
@keyframes yc-fade-up {
  from {
    opacity: 0;
    transform: translate3d(0, 12px, 0);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.hero-cta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  margin-top: 34px;
  animation: yc-fade-up 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.74s;
}
.hero-cta.center { margin-top: 26px; animation: none; }
/* ---------- 按钮：固定高度档位 + 内高光，光学居中对齐（不靠 padding 撑高） ---------- */
.btn {
  --btn-h: 42px;
  --btn-px: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: var(--btn-h);
  padding: 0 var(--btn-px);
  border-radius: 8px;
  font-family: var(--font-display);
  font-size: 14.5px;
  font-weight: 500;
  letter-spacing: -0.003em;
  line-height: 1;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.18s, border-color 0.18s, color 0.18s, box-shadow 0.18s;
}
.btn.sm { --btn-h: 34px; --btn-px: 14px; font-size: 13.5px; }
.btn.big { --btn-h: 48px; --btn-px: 26px; font-size: 15.5px; }
/* 主按钮：内高光让它在浅底上像"成型的实体"而不是一块纯色 */
.btn.primary {
  color: #fff;
  background: var(--yc-btn);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 1px 2px rgba(0, 0, 0, 0.18);
}
.btn.primary:hover {
  background: #000;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 2px 6px rgba(0, 0, 0, 0.2);
}
.btn.ghost {
  color: var(--vp-c-text-1);
  background: #fff;
  border-color: var(--yc-line);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 2px rgba(9, 9, 11, 0.04);
}
.btn.ghost:hover { background: var(--yc-gray-50); border-color: var(--yc-line-strong); }
/* 三级：只有文字，hover 给一层浅底 */
.btn.quiet { background: transparent; color: var(--vp-c-text-2); --btn-px: 12px; }
.btn.quiet:hover { background: var(--yc-gray-100); color: var(--vp-c-text-1); }
/* 尾部箭头随 hover 右移 */
.btn .arw {
  display: inline-flex;
  width: 15px;
  height: 15px;
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}
.btn:hover .arw { transform: translateX(3px); }
.btn-ico { display: inline-flex; width: 15px; height: 15px; }
.btn-ico :deep(svg), .btn .arw :deep(svg), .card-icon :deep(svg), .pipe-icon :deep(svg), .dev-list :deep(svg) {
  width: 100%;
  height: 100%;
  stroke-width: 1.8;
}

/* 窗口 / 截图框：细边 + 收紧的投影，像真的应用窗口 */
.hero-shot {
  position: relative;
  margin-top: 56px;
  perspective: 1600px;
  animation: yc-window-in 1s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.86s;
}
@keyframes yc-window-in {
  from {
    opacity: 0;
    transform: translate3d(0, 26px, 0) scale(0.986);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.shot-frame { position: relative; }
/* 标注：极小号等宽字 + 1px 引线 + 端点圆点 */
.call {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
  white-space: nowrap;
  opacity: 0;
  animation: yc-fade-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.call em {
  font-style: normal;
  padding: 3px 7px;
  border-radius: var(--yc-radius-xs);
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--yc-line);
}
.call i {
  position: relative;
  display: block;
  width: 58px;
  height: 1px;
  background: var(--yc-line-strong);
}
.call i::after {
  content: '';
  position: absolute;
  top: -2.5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--yc-accent);
}
.call--left i::after { right: 0; }
.call--right i::after { left: 0; }
.call-a { left: 26px; top: 21%; animation-delay: 1.3s; }
.call-b { left: 30%; bottom: 13%; animation-delay: 1.44s; }
.call-c { right: 26px; top: 15%; animation-delay: 1.58s; }
.window {
  position: relative;
  border-radius: var(--yc-radius-lg);
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--yc-line);
  box-shadow: var(--yc-shadow-lg);
}
.window-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: #fbfbfa;
  border-bottom: 1px solid var(--yc-line-soft);
}
.window-bar i { width: 10px; height: 10px; border-radius: 50%; background: #e4e4e7; }
.window-bar i:nth-child(1) { background: #ff5f57; }
.window-bar i:nth-child(2) { background: #febc2e; }
.window-bar i:nth-child(3) { background: #28c840; }
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
  background: rgba(23, 23, 22, 0.72);
  cursor: pointer;
  transition: background 0.18s;
}
.play-hint:hover { background: #1a1a19; }
.play-hint :deep(svg) { width: 22px; height: 22px; fill: currentColor; stroke: none; }

/* ---------- 流水线：一条五格的流程带，靠竖 hairline 分隔 ---------- */
/* 上方导轨：进入视口时线从左画出来，五个节点依次点亮（由动效引擎驱动） */
.pipe-rail {
  position: relative;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 0 0 20px;
}
.rail-line {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: var(--yc-line);
  transform-origin: 0 50%;
}
.rail-dot {
  justify-self: center;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--yc-accent);
  box-shadow: 0 0 0 4px #fff;
}
.pipeline {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  list-style: none;
  padding: 0;
  margin: 0;
  background: #fff;
  border: 1px solid var(--yc-line);
  border-radius: var(--yc-radius);
  overflow: hidden;
}
.pipe { padding: 24px 22px; border-left: 1px solid var(--yc-line-soft); }
.pipe:first-child { border-left: none; }
.pipe-step {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  color: var(--yc-accent);
  margin-bottom: 14px;
}
.pipe-icon { width: 20px; height: 20px; color: var(--yc-accent); margin-bottom: 12px; }
.pipe h3 { font-size: 15px; font-weight: 500; margin: 0 0 6px; }
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
  border: 1px solid var(--yc-line);
  transition: border-color 0.2s;
}
.card:hover { border-color: var(--yc-line-strong); }
.card-icon {
  width: 34px;
  height: 34px;
  padding: 7px;
  border-radius: 8px;
  color: var(--yc-accent);
  background: rgba(29, 78, 216, 0.07);
  border: 1px solid rgba(29, 78, 216, 0.14);
  margin-bottom: 14px;
}
.card h3 { font-size: 15.5px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.005em; }
.card p { font-size: 13.5px; line-height: 1.72; color: var(--vp-c-text-2); margin: 0; }

/* ---------- 三种播出方式 ---------- */
.modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.mode {
  padding: 24px 22px;
  border-radius: var(--yc-radius);
  background: #fff;
  border: 1px solid var(--yc-line);
}
.mode header { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
.mode h3 { font-size: 16.5px; font-weight: 600; margin: 0; letter-spacing: -0.005em; }
.chip {
  font-size: 11.5px;
  padding: 2px 7px;
  border-radius: var(--yc-radius-xs);
  color: #1a44be;
  background: rgba(29, 78, 216, 0.07);
  border: 1px solid rgba(29, 78, 216, 0.16);
}
.mode dl { display: grid; grid-template-columns: 52px 1fr; gap: 10px 10px; margin: 0; font-size: 13.5px; }
.mode dt { color: var(--vp-c-text-3); }
.mode dd { margin: 0; color: var(--vp-c-text-2); line-height: 1.65; }

/* ---------- 视频 ---------- */
.video-wrap {
  max-width: 980px;
  margin: 0 auto;
  border-radius: var(--yc-radius-lg);
  overflow: hidden;
  border: 1px solid var(--yc-line);
  box-shadow: var(--yc-shadow-lg);
  background: #1a1a19;
}
.video-player { display: block; width: 100%; aspect-ratio: 1920 / 1202; }
.video-notes {
  max-width: 980px;
  margin: 20px auto 0;
  padding-left: 18px;
  font-size: 13.5px;
  color: var(--vp-c-text-3);
  line-height: 1.9;
}
.video-notes a { color: var(--yc-accent); }

/* 视频弹窗 */
.video-modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(23, 23, 22, 0.76);
  backdrop-filter: blur(8px);
}
.video-modal-inner {
  width: min(1100px, 100%);
  border-radius: var(--yc-radius);
  overflow: hidden;
  background: #1a1a19;
  border: 1px solid rgba(255, 255, 255, 0.14);
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
.video-modal-inner header strong { font-size: 15px; font-weight: 600; }
.video-modal-inner header span { margin-left: 10px; font-size: 12.5px; color: rgba(255, 255, 255, 0.6); font-variant-numeric: tabular-nums; }
.modal-close {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: transparent;
  color: #fff;
  cursor: pointer;
}
.modal-close:hover { background: rgba(255, 255, 255, 0.14); }
.video-modal-inner video { display: block; width: 100%; background: #000; }

/* ---------- 截图：静态展示，不做悬浮放大 ---------- */
.shots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.shot { margin: 0; }
.shot figcaption { padding: 14px 2px 0; }
.shot h3 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
.shot p { font-size: 13px; color: var(--vp-c-text-3); margin: 0; line-height: 1.7; }

/* ---------- 表格 ---------- */
.table-wrap {
  overflow-x: auto;
  border-radius: var(--yc-radius);
  border: 1px solid var(--yc-line);
  background: #fff;
}
table.compare, table.specs { width: 100%; border-collapse: collapse; font-size: 14.5px; }
table.compare th {
  text-align: left;
  padding: 14px 18px;
  background: var(--yc-bg-alt);
  font-weight: 600;
  border-bottom: 1px solid var(--yc-line);
}
table.compare td { padding: 14px 18px; border-bottom: 1px solid var(--yc-line-soft); vertical-align: top; line-height: 1.7; color: var(--vp-c-text-2); }
table.compare tr:last-child td { border-bottom: none; }
table.compare td.scene { color: var(--vp-c-text-1); font-weight: 500; white-space: nowrap; }
table.compare td.app { color: var(--vp-c-text-1); background: rgba(29, 78, 216, 0.035); }
table.specs th {
  text-align: left;
  width: 190px;
  padding: 14px 18px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: var(--yc-bg-alt);
  border-bottom: 1px solid var(--yc-line-soft);
  white-space: nowrap;
}
table.specs td { padding: 14px 18px; border-bottom: 1px solid var(--yc-line-soft); line-height: 1.7; color: var(--vp-c-text-1); }
table.specs tr:last-child th, table.specs tr:last-child td { border-bottom: none; }

/* ---------- 开发者 ---------- */
.dev-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 18px; }
.dev-card {
  padding: 24px;
  border-radius: var(--yc-radius);
  background: #fff;
  border: 1px solid var(--yc-line);
}
.dev-card h3 { font-size: 15.5px; font-weight: 600; margin: 0 0 14px; }
.dev-card pre {
  margin: 0;
  padding: 16px;
  border-radius: var(--yc-radius-sm);
  background: #1c1b1a;
  color: #e4e4e7;
  font-size: 13px;
  line-height: 1.7;
  overflow-x: auto;
}
.dev-card code { font-family: var(--vp-font-family-mono); }
.muted { font-size: 13px; color: var(--vp-c-text-3); margin: 12px 0 0; }
.dev-list { margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.9; color: var(--vp-c-text-2); }
.dev-list a { color: var(--yc-accent); }

/* ---------- FAQ：hairline 行，不是卡片堆 ---------- */
.faq-list { border-top: 1px solid var(--yc-line); }
.faq-item { border-bottom: 1px solid var(--yc-line); }
.faq-item summary {
  cursor: pointer;
  padding: 18px 4px;
  font-size: 15px;
  font-weight: 500;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  transition: color 0.18s;
}
.faq-item summary:hover { color: var(--yc-accent); }
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::after {
  content: '';
  flex: none;
  width: 8px;
  height: 8px;
  border-right: 1.5px solid var(--vp-c-text-3);
  border-bottom: 1.5px solid var(--vp-c-text-3);
  transform: rotate(45deg) translate(-2px, -2px);
  transition: transform 0.22s;
}
.faq-item[open] summary::after { transform: rotate(-135deg) translate(-2px, -2px); }
.faq-item p { margin: 0; padding: 0 4px 20px; font-size: 14px; line-height: 1.85; color: var(--vp-c-text-2); max-width: 760px; }

/* ---------- 收尾：一条深色带，给长页面一个落点 ---------- */
.final {
  position: relative;
  overflow: hidden;
  padding: 108px 24px 96px;
  text-align: center;
  background: #151513;
  color: #fff;
}
/* 跟随指针的柔和光斑（极淡品牌蓝，不是装饰渐变） */
.spot {
  position: absolute;
  left: 0;
  top: 0;
  width: 640px;
  height: 640px;
  margin: -320px 0 0 -320px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(147, 176, 255, 0.18), rgba(147, 176, 255, 0) 62%);
  opacity: 0;
  pointer-events: none;
}
.final .display { color: #fff; }
.final .display > span { color: #9db4ff; }
.final-inner { position: relative; max-width: 820px; margin: 0 auto; }
.final-sub { color: rgba(255, 255, 255, 0.66); font-size: 15.5px; line-height: 1.8; max-width: 620px; margin: 18px auto 0; }
.footnote { margin-top: 36px; font-size: 12.5px; color: rgba(255, 255, 255, 0.44); }
.final .btn.primary { background: var(--yc-accent); }
.final .btn.primary:hover { background: #1a44be; }
.final .btn.ghost { background: transparent; border-color: rgba(255, 255, 255, 0.24); color: #fff; }
.final .btn.ghost:hover { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.42); }

/* ---------- 响应式 ---------- */
@media (max-width: 1080px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .shots { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pipeline { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .pipe:nth-child(3n + 1) { border-left: none; }
  .pipe:nth-child(n + 4) { border-top: 1px solid var(--yc-line-soft); }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(odd) { border-left: none; }
  .stat:nth-child(n + 3) { border-top: 1px solid var(--yc-line-soft); }
  .releases { grid-template-columns: 1fr; }
  .track-items { grid-template-columns: 1fr; }
}
@media (max-width: 860px) {
  .modes { grid-template-columns: 1fr; }
  .grid.two { grid-template-columns: 1fr; }
  .bento { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bento > :nth-child(3) { grid-column: span 2; }
  .bento > :nth-child(4) { grid-column: span 1; }
  .notice-text { white-space: normal; }
  .track-panel { padding: 22px 20px; }
  .dev-grid { grid-template-columns: 1fr; }
}
@media (max-width: 680px) {
  .grid, .shots, .pipeline, .bento { grid-template-columns: 1fr; }
  .bento > :nth-child(1),
  .bento > :nth-child(3),
  .bento > :nth-child(4) { grid-column: auto; }
  .pipe { border-left: none; border-top: 1px solid var(--yc-line-soft); }
  .pipe:first-child { border-top: none; }
  .hero { padding-top: 68px; }
  .stat { border-left: none; }
  .stat:nth-child(n + 2) { border-top: 1px solid var(--yc-line-soft); }
  .stat strong { font-size: 21px; }
  .tabs { gap: 22px; }
  table.specs th { width: auto; }
  /* 窄屏不放细线标注：窗口本身已经装不下了 */
  .call { display: none; }
}
/* 减少动效：跑马灯与首屏逐字动画都停，内容保持完整 */
@media (prefers-reduced-motion: reduce) {
  .marquee-track { animation: none; }
  .hero-title .ch,
  .hero-sub,
  .hero-cta,
  .hero-shot,
  .call { animation: none; opacity: 1; transform: none; }
}
</style>
