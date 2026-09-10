import { useT } from '@/contexts/LanguageContext'

// What an admin list renders INSTEAD of its empty state when the read failed,
// so "you have nothing" and "I could not look" never draw the same thing.
//
// Extracted rather than copied a ninth time: the eight admin screens all say
// the same two strings, and the copies had already started to drift apart. The
// three screens that need a more specific message (bundles, homepage,
// settings) keep their own panels.
//
// The two call sites OUTSIDE the admin (the homepage grid, the guest order
// lookup) pass `message` instead: the default is owner-voiced ("this list has
// not been emptied") and a shopper is not the owner of a list.
export default function LoadErrorPanel({ onRetry, message }: { onRetry: () => void; message?: string }) {
  const t = useT()
  return (
    <div className="border border-terracotta bg-card p-12 text-center">
      <p className="text-terracotta">{message || t.adminLoadError}</p>
      {/* onRetry is called with NO arguments, deliberately. `onClick={onRetry}`
          hands React's SyntheticMouseEvent to the retry function as its first
          argument, so a retry that takes an optional parameter (a page size, a
          limit) silently receives an event object instead of its default and
          can never succeed. TypeScript does not catch it: (n?: number) => void
          is assignable to () => void. */}
      <button
        onClick={() => onRetry()}
        className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
      >
        {t.failedTryAgain}
      </button>
    </div>
  )
}
