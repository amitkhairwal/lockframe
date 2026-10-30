// one stroke weight for every icon, so they read as a set
const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

export const Play = ({ size = 16 }: { size?: number }) => (
  <svg {...p} width={size} height={size} fill="currentColor" stroke="none">
    <path d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.6-6.8a.6.6 0 0 0 0-1L8.92 4.7A.6.6 0 0 0 8 5.2Z" />
  </svg>
)
export const Logo = () => (
  <svg width={22} height={22} viewBox="0 0 32 32" aria-hidden>
    <rect width="32" height="32" rx="8" fill="currentColor" />
    <path d="M13 10.5v11l9-5.5z" fill="var(--bg)" />
  </svg>
)
export const Grid = () => (
  <svg {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </svg>
)
export const UploadIcon = () => (
  <svg {...p}>
    <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
)
export const FlagIcon = () => (
  <svg {...p}>
    <path d="M5 21V4.5m0 0h11.5l-2 4 2 4H5" />
  </svg>
)
export const Film = () => (
  <svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4" />
  </svg>
)
export const Dots = () => (
  <svg {...p}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </svg>
)
export const Expand = () => (
  <svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
)
export const Close = () => (
  <svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)
export const Check = () => (
  <svg {...p} width={12} height={12} strokeWidth={2.4}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
)
export const Search = () => (
  <svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </svg>
)
export const Back = () => (
  <svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
)
export const Share = () => (
  <svg {...p}>
    <path d="M16 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM16 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10.6 13.5l2.8 1.6M13.4 6.9l-2.8 1.6" />
  </svg>
)
export const Chart = () => (
  <svg {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
)
export const Trash = () => (
  <svg {...p}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
)
export const LogOut = () => (
  <svg {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4" />
  </svg>
)
export const Sun = () => (
  <svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)
export const Moon = () => (
  <svg {...p}>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
  </svg>
)
export const Monitor = () => (
  <svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
)
