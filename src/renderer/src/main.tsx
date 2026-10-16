import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
// streamdown 的进场动画关键帧（sd-fadeIn/blurIn/slideUp）
import 'streamdown/styles.css'
import { applyAppearance, readCachedTheme } from './theme/applyAppearance'

applyAppearance(readCachedTheme(), undefined, false)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
