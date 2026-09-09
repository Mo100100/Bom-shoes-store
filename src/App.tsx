import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Shop from './pages/Shop'
import Brands from './pages/Brands'
import Policies from './pages/Policies'
import ProductDetail from './pages/ProductDetail'
import Cart from './pages/Cart'
import Checkout from './pages/Checkout'
import CheckoutSuccess from './pages/CheckoutSuccess'
import CheckoutFailed from './pages/CheckoutFailed'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Account from './pages/Account'
import AdminLayout from './pages/admin/AdminLayout'
import AdminDashboard from './pages/admin/AdminDashboard'
import AdminProducts from './pages/admin/AdminProducts'
import AdminOrders from './pages/admin/AdminOrders'
import AdminCoupons from './pages/admin/AdminCoupons'
import AdminBundles from './pages/admin/AdminBundles'
import AdminBanners from './pages/admin/AdminBanners'
import AdminHomepage from './pages/admin/AdminHomepage'
import AdminUsers from './pages/admin/AdminUsers'
import AdminActivityLog from './pages/admin/AdminActivityLog'
import AdminSettings from './pages/admin/AdminSettings'
import ProtectedRoute from './components/ProtectedRoute'
import { useT } from './contexts/LanguageContext'

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="/shop" element={<Shop />} />
        <Route path="/brands" element={<Brands />} />
        <Route path="/policies" element={<Policies />} />
        <Route path="/product/:slug" element={<ProductDetail />} />
        <Route path="/cart" element={<Cart />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/checkout/success" element={<CheckoutSuccess />} />
        <Route path="/checkout/failed" element={<CheckoutFailed />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/account" element={<ProtectedRoute><Account /></ProtectedRoute>} />
        <Route path="/admin" element={<ProtectedRoute requireAdmin><AdminLayout /></ProtectedRoute>}>
          <Route index element={<AdminDashboard />} />
          <Route path="products" element={<AdminProducts />} />
          <Route path="orders" element={<AdminOrders />} />
          <Route path="coupons" element={<AdminCoupons />} />
          <Route path="bundles" element={<AdminBundles />} />
          <Route path="banners" element={<AdminBanners />} />
          <Route path="homepage" element={<AdminHomepage />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="activity" element={<AdminActivityLog />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

function NotFound() {
  const t = useT()
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center px-6 text-center">
      <p className="text-zen text-muted-foreground mb-6">{t.notFoundEyebrow}</p>
      <h1 className="font-display text-6xl md:text-8xl text-primary mb-4">{t.notFoundTitle}</h1>
      <p className="text-muted-foreground max-w-md">
        {t.notFoundDesc}
      </p>
      <a href="/" className="mt-10 text-sm tracking-widest uppercase border-b border-foreground pb-1">
        {t.notFoundCta}
      </a>
    </div>
  )
}

export default App
