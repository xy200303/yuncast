<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { withBase } from 'vitepress'
import shotLive from '../../guide/screenshots/live.png'
import shotPrograms from '../../guide/screenshots/programs.png'
import shotAnchors from '../../guide/screenshots/anchors.png'
import shotVoices from '../../guide/screenshots/voices.png'
import shotStats from '../../guide/screenshots/stats.png'

const features = [
  { icon: '🎙️', title: '智能主播 Agent', desc: '人设卡 + 编剧模式，主播自己写稿自己播。评论回不回、怎么回，它像真人一样看着办。' },
  { icon: '📻', title: '四种节目形态', desc: '一个人讲、多人聊天、照着稿子读、分角色表演——直播带货、有声书、播客、FM 全覆盖。' },
  { icon: '🔀', title: '三种播出方式', desc: '现场发挥、边播边准备、全部做好再播。预制节目有门禁：音频不齐，不开播。' },
  { icon: '🗣️', title: '克隆店家的声音', desc: '火山引擎 / 阿里云百炼 / 播客专用大模型多 TTS 适配，一段录音克隆音色。' },
  { icon: '💬', title: '像真人一样看评论', desc: '评论先进收件箱：去重、归组、自适应聚合。洪峰一批批看，冷清一条不漏。' },
  { icon: '🎚️', title: '导演级播出控制', desc: '话术池车道、BGM ducking、麦克风真人接管、一键急停。人在场控，随时抢过话筒。' },
  { icon: '📤', title: '音频导出', desc: '整场导出 MP3/WAV，分章或合并、响度归一，直接上传喜马拉雅、小宇宙。' },
  { icon: '📊', title: '用量看板', desc: 'LLM tokens 与 TTS 字符按节目归组，30 天趋势可视化，花多少心里有数。' }
]

const showcase = [
  { src: shotPrograms, title: '节目', desc: '形态 × 播出方式 × 播完策略' },
  { src: shotAnchors, title: '主播团', desc: '人设卡点击弹窗配置' },
  { src: shotVoices, title: '音色库', desc: '云端音色 + 声音克隆' },
  { src: shotStats, title: '数据', desc: '画像 · 摘要 · 用量看板' }
]

let observer: IntersectionObserver | null = null
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
    { threshold: 0.12 }
  )
  document.querySelectorAll('.reveal').forEach((el) => observer!.observe(el))
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div class="landing">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-blobs" aria-hidden="true">
        <span class="blob b1" /><span class="blob b2" /><span class="blob b3" />
      </div>
      <div class="hero-inner">
        <div class="badge reveal">v0.1.1 · Windows / macOS / Linux 同步发布</div>
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
          <div class="card-icon">{{ f.icon }}</div>
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

    <!-- Final CTA -->
    <section class="final">
      <div class="final-inner reveal">
        <h2 class="display"><span class="grad-text">下一场直播，</span><br>让主播自己上。</h2>
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
  background: #0a0a0a;
}

/* ---------- Hero ---------- */
.hero {
  position: relative;
  padding: 96px 24px 64px;
  background: transparent;
}
.hero-blobs { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(110px);
  opacity: 0.1;
  background: #ffffff;
  animation: drift 18s ease-in-out infinite alternate;
}
.b1 { width: 560px; height: 560px; top: -260px; left: -140px; }
.b2 { width: 480px; height: 480px; top: -180px; right: -100px; animation-delay: -6s; opacity: 0.07; }
.b3 { width: 420px; height: 420px; top: 260px; left: 42%; animation-delay: -12s; opacity: 0.05; }
@keyframes drift {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(60px, 40px) scale(1.12); }
}

.hero-inner { position: relative; max-width: 960px; margin: 0 auto; text-align: center; }
.badge {
  display: inline-block;
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--vp-c-text-2);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
}
.hero-title {
  margin: 28px 0 20px;
  font-size: clamp(2.8rem, 7.5vw, 5.2rem);
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: -0.02em;
  border: none;
  color: #fafafa;
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
  background: linear-gradient(120deg, #fafafa 20%, #a1a1aa);
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
  transition: transform 0.25s, box-shadow 0.25s, background 0.25s, border-color 0.25s, opacity 0.25s;
}
.btn.primary {
  color: #0a0a0a;
  background: #fafafa;
  box-shadow: 0 8px 30px rgba(255, 255, 255, 0.12);
}
.btn.primary:hover { transform: translateY(-2px); background: #e4e4e7; color: #0a0a0a; box-shadow: 0 14px 38px rgba(255, 255, 255, 0.18); }
.btn.ghost {
  color: var(--vp-c-text-1);
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
}
.btn.ghost:hover { transform: translateY(-2px); border-color: rgba(255, 255, 255, 0.38); color: #fafafa; }
.btn.big { padding: 16px 44px; font-size: 17px; }

.hero-shot { margin-top: 64px; }
.window {
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: #111113;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.65);
  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.35s;
}
.window:hover { transform: translateY(-6px) scale(1.005); border-color: rgba(255, 255, 255, 0.2); }
.window-bar {
  display: flex;
  gap: 7px;
  padding: 10px 14px;
  background: #111113;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.window-bar i { width: 10px; height: 10px; border-radius: 50%; background: #3f3f46; }
.window img { display: block; width: 100%; }
.caption { margin-top: 14px; font-size: 14px; color: var(--vp-c-text-3); }

/* ---------- Sections ---------- */
.section { padding: 110px 24px; max-width: 1152px; margin: 0 auto; }
.section.alt { max-width: none; background: #0e0e10; }
.section.alt > * { max-width: 1152px; margin-left: auto; margin-right: auto; }
.display {
  font-size: clamp(2rem, 4.6vw, 3.4rem);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.25;
  text-align: center;
  margin: 0 auto 56px;
  border: none;
  color: #fafafa;
}
.grad-text {
  background: linear-gradient(120deg, #fafafa 20%, #71717a);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; }
.card {
  padding: 26px 22px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #111113;
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.35s, border-color 0.35s;
}
.card:hover {
  transform: translateY(-6px);
  border-color: rgba(255, 255, 255, 0.24);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
}
.card-icon { font-size: 26px; margin-bottom: 12px; }
.card h3 { margin: 0 0 8px; font-size: 16px; border: none; color: #fafafa; }
.card p { margin: 0; font-size: 14px; line-height: 1.8; color: var(--vp-c-text-2); }

/* ---------- Showcase ---------- */
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.shot h3 { margin: 14px 0 4px; border: none; font-size: 16px; color: #fafafa; }
.shot p { margin: 0; font-size: 14px; color: var(--vp-c-text-2); }
.window.sm { box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5); }
.more { margin-top: 32px; text-align: center; font-size: 14px; color: var(--vp-c-text-3); }
.more a { color: #fafafa; }
@media (max-width: 720px) { .shots { grid-template-columns: 1fr; } }

/* ---------- Dev ---------- */
.dev-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 720px) { .dev-grid { grid-template-columns: 1fr; } }
.dev-card {
  padding: 28px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #111113;
}
.dev-card h3 { margin-top: 0; border: none; color: #fafafa; }
.dev-card p { color: var(--vp-c-text-2); line-height: 1.9; margin-bottom: 0; }
.dev-card pre {
  margin: 12px 0 0;
  padding: 18px;
  border-radius: 10px;
  background: #000000;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #d4d4d8;
  font-size: 13.5px;
  line-height: 1.9;
  overflow-x: auto;
}

/* ---------- Final ---------- */
.final {
  padding: 130px 24px;
  text-align: center;
  background:
    radial-gradient(640px 320px at 50% 120%, rgba(255, 255, 255, 0.09), transparent),
    #0a0a0a;
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
  .blob { animation: none; }
}
</style>
