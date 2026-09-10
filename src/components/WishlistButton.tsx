import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Heart } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useWishlist } from '@/contexts/WishlistContext'
import { useT } from '@/contexts/LanguageContext'
import { cn } from '@/lib/utils'

type WishlistButtonProps = {
  productId: string
  className?: string
}

export default function WishlistButton({ productId, className }: WishlistButtonProps) {
  const { user } = useAuth()
  const { isWishlisted, toggleWishlist } = useWishlist()
  const t = useT()
  const navigate = useNavigate()
  const wishlisted = isWishlisted(productId)

  return (
    <button
      type="button"
      onClick={() => {
        if (!user) {
          toast.error(t.wishlistSignIn)
          navigate('/login')
          return
        }
        toggleWishlist(productId)
      }}
      aria-label={wishlisted ? t.wishlistRemove : t.wishlistAdd}
      aria-pressed={wishlisted}
      className={cn(
        'p-2 cursor-pointer transition-colors hover:text-terracotta',
        className
      )}
    >
      <Heart className={cn('w-5 h-5', wishlisted && 'fill-terracotta text-terracotta')} />
    </button>
  )
}
