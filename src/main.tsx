import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { AuthProvider } from './contexts/AuthContext'
import { CartProvider } from './contexts/CartContext'
import { CurrencyProvider } from './contexts/CurrencyContext'
import { CategoriesProvider } from './contexts/CategoriesContext'
import { BrandsProvider } from './contexts/BrandsContext'
import { StoreSettingsProvider } from './contexts/StoreSettingsContext'
import { LanguageProvider } from './contexts/LanguageContext'
import { WishlistProvider } from './contexts/WishlistContext'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <LanguageProvider>
          <CurrencyProvider>
            <CategoriesProvider>
              <BrandsProvider>
                <StoreSettingsProvider>
                  <AuthProvider>
                    <WishlistProvider>
                      <CartProvider>
                        <App />
                      <Toaster
                        position="top-center"
                        toastOptions={{
                          style: {
                            background: 'hsl(var(--card))',
                            color: 'hsl(var(--foreground))',
                            border: '1px solid hsl(var(--border))',
                            fontSize: '0.875rem',
                          },
                        }}
                        />
                      </CartProvider>
                    </WishlistProvider>
                  </AuthProvider>
                </StoreSettingsProvider>
              </BrandsProvider>
            </CategoriesProvider>
          </CurrencyProvider>
        </LanguageProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
