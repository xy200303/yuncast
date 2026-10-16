import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Home from './Home.vue'
import { vLift, vPress } from './motion/directives'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Home', Home)
    /* 交互手感层：v-press 按钮按压回弹 / v-lift 卡片悬停抬起 */
    app.directive('press', vPress)
    app.directive('lift', vLift)
  }
} satisfies Theme
