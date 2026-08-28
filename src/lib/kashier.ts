// Kashier.io payment integration
// Documentation: https://developers.kashier.io/
//
// All merchant-id/API-key lookup, hosted-checkout URL building, and
// HMAC-SHA256 signing now happens server-side in
// supabase/functions/create-order (and the webhook is verified in
// supabase/functions/kashier-webhook). No Kashier secret and no
// signature-building logic may live in this frontend -- these types just
// describe the shape of the create-order edge function's request/response
// for callers like src/pages/Checkout.tsx.

export type CreateOrderItem = {
  product_id: string
  size: string
  color: string
  quantity: number
}

export type CreateOrderCustomer = {
  fullName: string
  // Optional: an Egyptian COD store reaches the customer by phone; email is a
  // nice-to-have for the receipt only.
  email?: string
  phone: string
  address: string
  city: string
  country: string
  notes?: string
}

export type CreateOrderRequest = {
  items: CreateOrderItem[]
  customer: CreateOrderCustomer
  couponCode?: string
  // Governorate code -- the server prices shipping from this (site_content.shipping).
  regionCode: string
  // Only sets the language of Kashier's hosted payment page.
  lang?: string
  // 'cash' = Cash on Delivery; anything else (default) = pay online.
  paymentMethod?: 'online' | 'cash'
  // Idempotency key kept across a lost response, so retrying a Cash on
  // Delivery submit returns the first order instead of placing a second one.
  clientRequestId?: string
}

export type CreateOrderResponse = {
  orderId: string
  // null for Cash on Delivery (no Kashier redirect); a payments.kashier.io
  // session URL for online payment.
  checkoutUrl: string | null
  discountAmount: number
  // true when the order was placed as Cash on Delivery.
  cod?: boolean
}
