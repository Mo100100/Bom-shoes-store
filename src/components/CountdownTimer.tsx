import { useEffect, useState } from 'react'

type TimeLeft = { days: number; hours: number; minutes: number; seconds: number }

const ZERO: TimeLeft = { days: 0, hours: 0, minutes: 0, seconds: 0 }

function timeLeft(target: Date): TimeLeft {
  const ms = target.getTime() - Date.now()
  if (ms <= 0) return ZERO
  const totalSeconds = Math.floor(ms / 1000)
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  }
}

type CountdownTimerProps = {
  target: Date
  // Required, not defaulted: an English fallback baked in here would slip past
  // the translation object and render untranslated on the Arabic homepage.
  labels: { days: string; hours: string; minutes: string; seconds: string }
  className?: string
}

// DAYS / HRS / MINS / SECS countdown -- large number over a small tracked
// label. Ticks every second off a single interval; once `target` has passed
// it clamps to all zeros instead of going negative.
export default function CountdownTimer({ target, labels, className = '' }: CountdownTimerProps) {
  const [left, setLeft] = useState(() => timeLeft(target))

  useEffect(() => {
    setLeft(timeLeft(target))
    const id = setInterval(() => setLeft(timeLeft(target)), 1000)
    return () => clearInterval(id)
  }, [target])

  const units: [number, string][] = [
    [left.days, labels.days],
    [left.hours, labels.hours],
    [left.minutes, labels.minutes],
    [left.seconds, labels.seconds],
  ]

  return (
    <div className={`flex items-start gap-3 md:gap-5 ${className}`}>
      {units.map(([value, label], i) => (
        // display:contents -- the injected prop from this project's dev tooling
        // (vite-plugin-source-identifier) can't land on a Fragment, so this div
        // stands in for one; contents removes it from the box model entirely so
        // the colon and digit-group still participate directly in the flex row.
        <div key={label} className="contents">
          {i > 0 && <p className="font-display text-4xl md:text-5xl opacity-30 -mt-1">:</p>}
          <div className="text-center">
            <p className="font-display text-4xl md:text-5xl tabular-nums">{String(value).padStart(2, '0')}</p>
            <p className="text-[10px] tracking-[0.3em] uppercase opacity-60 mt-1">{label}</p>
          </div>
        </div>
      ))}
    </div>
  )
}
