// Plain inline-styled HTML for the BOM Store order-confirmation email.
// No React Email / templating library needed for a single transactional email.

type ConfirmationOrderItem = {
  name: string
  size: string
  color: string
  quantity: number
  price: number
}

export function renderOrderConfirmationEmail(opts: {
  customerName: string
  orderRef: string
  items: ConfirmationOrderItem[]
  total: number
}): string {
  const rows = opts.items.map(item => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e5e5e0;font-size:14px;color:#1a1a1a;">
        ${escapeHtml(item.name)}<br>
        <span style="color:#888;font-size:12px;">${escapeHtml(item.color)}, ${escapeHtml(item.size)} &times; ${item.quantity}</span>
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #e5e5e0;font-size:14px;text-align:right;white-space:nowrap;">
        $${(item.price * item.quantity).toFixed(2)}
      </td>
    </tr>`).join('')

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f2;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e5e0;max-width:480px;width:100%;">
            <tr>
              <td style="padding:32px 32px 16px;text-align:center;letter-spacing:2px;text-transform:uppercase;font-size:13px;color:#888;">
                BOM Store
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px;text-align:center;">
                <h1 style="font-size:24px;font-weight:normal;margin:0 0 8px;">Order confirmed</h1>
                <p style="font-size:14px;color:#555;margin:0;">Thank you, ${escapeHtml(opts.customerName)}. Your payment went through.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 16px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888;">
                Order ${escapeHtml(opts.orderRef)}
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${rows}
                  <tr>
                    <td style="padding:16px 0 0;font-size:14px;font-weight:bold;">Total</td>
                    <td style="padding:16px 0 0;font-size:14px;font-weight:bold;text-align:right;">$${opts.total.toFixed(2)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;text-align:center;font-size:12px;color:#999;">
                We'll email you again when your order ships.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

// Renders the confirmation for one order and hands it to Resend. Shared by
// kashier-webhook (payment confirmed by the gateway) and
// send-order-confirmation (payment confirmed by the owner because the webhook
// never arrived), so the customer gets the same email either way.
//
// Throws nothing: an order that is fulfilled but whose email failed is far
// better than the reverse, so every caller treats a send failure as a logged
// non-event.
export async function sendOrderConfirmationEmail(order: {
  customer_name: string | null
  customer_email: string | null
  kashier_order_id: string | null
  items: unknown
  total_amount: number | null
}): Promise<void> {
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL')
  if (!resendApiKey || !fromEmail || !order.customer_email) {
    console.error('sendOrderConfirmationEmail: skipped, missing RESEND config or customer email')
    return
  }

  const html = renderOrderConfirmationEmail({
    customerName: order.customer_name ?? 'there',
    orderRef: order.kashier_order_id ?? '',
    items: Array.isArray(order.items) ? order.items : [],
    total: order.total_amount ?? 0,
  })

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: order.customer_email,
      subject: `Your BOM Store order ${order.kashier_order_id} is confirmed`,
      html,
    }),
  })

  if (!res.ok) {
    console.error('sendOrderConfirmationEmail: Resend send failed', res.status, await res.text())
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
