export type ConversionForm = 'contact' | 'stylebook'

export const CONVERSION_FORM_BY_TEMPLATE: Record<string, ConversionForm> = {
  'contact-notification': 'contact',
  'style-book-notification': 'stylebook',
}

export const CONVERSION_NONCE_TTL_MS = 15 * 60 * 1000

export function isConversionForm(value: unknown): value is ConversionForm {
  return value === 'contact' || value === 'stylebook'
}

export function generateConversionNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function isWellFormedConversionNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export async function hashConversionNonce(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
