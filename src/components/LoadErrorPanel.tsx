import { useT } from '@/contexts/LanguageContext'

// What an admin list renders INSTEAD of its empty state when the read failed,
// so "you have nothing" and "I could not look" never draw the same thing.
//
// Extracted rather than copied a ninth time: the eight admin screens all say
// the same two strings, and the copies had already started to drift apart. The
// three screens that need a more specific message (bundles, homepage,
// settings) keep their own panels, so this one takes no message prop.
export default function LoadErrorPanel({ onRetry }: { onRetry: () => void }) {
  const t = useT()
  return (
    <div className="border border-terracotta bg-card p-12 text-center">
      <p className="text-terracotta">{t.adminLoadError}</p>
      <button
        onClick={onRetry}
        className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
      >
        {t.failedTryAgain}
      </button>
    </div>
  )
}
