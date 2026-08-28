import React from 'react';
import { translations, Lang } from '@/lib/translations';

// This boundary wraps the whole app, including LanguageProvider (see
// main.tsx), so it can catch a crash from a provider itself -- which means
// its fallback renders outside the React language context and cannot call
// useT(). It reads the same localStorage key LanguageContext initializes
// from instead, so the crash screen still speaks the customer's language.
const LANG_KEY = 'bom-store-lang';

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'ar' || stored === 'en') return stored;
  } catch { /* localStorage unavailable: fall through to the default */ }
  return 'ar';
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // The stack trace is for us, not the customer -- log it here instead of
    // rendering it, so production never shows a shopper a raw JS stack.
    console.error('ErrorBoundary caught an error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const t = translations[detectLang()];
      return (
        <div className="min-h-screen flex flex-col items-center justify-center text-center px-6 bg-cream gap-4">
          <p className="text-muted-foreground">{t.errorBoundaryMessage}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm border-b border-foreground pb-0.5 cursor-pointer"
          >
            {t.errorBoundaryReload}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
