import { useId, type ReactNode } from 'react'
import type { AvatarColor } from '../../protocol/src/index.ts'
import whaleAvatars from './assets/whale-avatars.png'

/** A6 uses the supplied artwork; identity varies by color only. */
export const AVATAR_COLORS = ['#30343B', '#4176E6', '#329B91', '#9781C7', '#D3A747', '#D98079'] as const
export const AVATAR_PALETTE: Record<AvatarColor, string> = { charcoal: AVATAR_COLORS[0], blue: AVATAR_COLORS[1], teal: AVATAR_COLORS[2], violet: AVATAR_COLORS[3], amber: AVATAR_COLORS[4], coral: AVATAR_COLORS[5] }

const CELL = 512
const INSET = 48
// Tight source bounds plus four transparent pixels. The original artwork is
// not a regular grid: the charcoal tail crosses the nominal first-cell edge.
const CROPS = [
  [38, 120, 490, 351], [541, 126, 471, 344], [1026, 120, 479, 351],
  [42, 556, 479, 341], [541, 557, 473, 338], [1028, 550, 478, 346],
] as const

export function WhaleAvatar({ color = AVATAR_COLORS[0], size = 40, label }: { color?: string; size?: number; label?: string }): ReactNode {
  const clipId = useId()
  const index = Math.max(0, AVATAR_COLORS.findIndex(value => value.toLowerCase() === color.toLowerCase()))
  const crop = CROPS[index] ?? CROPS[0]
  return <svg width={size} height={size} viewBox={`0 0 ${CELL} ${CELL}`} preserveAspectRatio="xMidYMid meet" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="bots-avatar">
    <defs><clipPath id={clipId}><circle cx={CELL / 2} cy={CELL / 2} r={CELL / 2} /></clipPath></defs>
    <g clipPath={`url(#${clipId})`}>
      <svg x={INSET} y={INSET} width={CELL - 2 * INSET} height={CELL - 2 * INSET} viewBox={crop.join(' ')} preserveAspectRatio="xMidYMid meet" overflow="hidden">
        <image href={whaleAvatars} width={CELL * 3} height={CELL * 2} preserveAspectRatio="xMidYMid meet" />
      </svg>
    </g>
  </svg>
}
