/**
 * 品牌 Logo：云朵（小云）+ 声波柱（播客坊）。与 resources/icon.png 同一图形，
 * 这里用 SVG 内联保证侧边栏任意缩放都清晰。渐变 id 带组件内前缀，避免多实例撞 id。
 */
let logoSeq = 0

export function BrandLogo({ className }: { className?: string }) {
  const gid = `brand-logo-${++logoSeq}`
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${gid}-bg`} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#38BDF8" />
          <stop offset="0.55" stopColor="#818CF8" />
          <stop offset="1" stopColor="#C084FC" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="10.8" fill={`url(#${gid}-bg)`} />
      <g fill="#fff">
        <circle cx="17" cy="23.5" r="6" />
        <circle cx="24" cy="19.5" r="8" />
        <circle cx="31" cy="23.5" r="6" />
        <rect x="10" y="24" width="28" height="9.5" rx="4.75" />
      </g>
      <g fill="#4F46E5">
        <rect x="13.5" y="24.25" width="2.6" height="5.5" rx="1.3" />
        <rect x="18.1" y="22.5" width="2.6" height="9" rx="1.3" />
        <rect x="22.7" y="20.75" width="2.6" height="12.5" rx="1.3" />
        <rect x="27.3" y="22.5" width="2.6" height="9" rx="1.3" />
        <rect x="31.9" y="24.25" width="2.6" height="5.5" rx="1.3" />
      </g>
    </svg>
  )
}
