// Run with: node --test scripts/whatsapp-phone.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the pure helper in src/lib/whatsappPhone.ts.
// Node 22 strips the TypeScript types on import, so no build step is needed.
//
// useWhatsApp's stated job is that a dead wa.me link never renders. Every case
// here is a shape the store's owner can actually type into the admin's phone
// field, which is the only place a dead link can come from.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeWhatsAppPhone, PLACEHOLDER_PHONE } from '../src/lib/whatsappPhone.ts'

test('every spelling of the seeded placeholder normalises to the placeholder', () => {
  // Whichever of these the owner leaves in the field, no WhatsApp action may
  // render: the number is not theirs.
  assert.equal(normalizeWhatsAppPhone('+20 123 456 7890'), PLACEHOLDER_PHONE)
  assert.equal(normalizeWhatsAppPhone('201234567890'), PLACEHOLDER_PHONE)
  assert.equal(normalizeWhatsAppPhone('00201234567890'), PLACEHOLDER_PHONE)
  assert.equal(normalizeWhatsAppPhone('01234567890'), PLACEHOLDER_PHONE)
})

test('a real Egyptian number typed the way it is said gets its country code', () => {
  assert.equal(normalizeWhatsAppPhone('0100 123 4567'), '201001234567')
  assert.equal(normalizeWhatsAppPhone('01001234567'), '201001234567')
  assert.equal(normalizeWhatsAppPhone('+201001234567'), '201001234567')
  assert.equal(normalizeWhatsAppPhone('00201001234567'), '201001234567')
  assert.equal(normalizeWhatsAppPhone('201001234567'), '201001234567')
  // Copied out of a contact card that dropped the trunk zero.
  assert.equal(normalizeWhatsAppPhone('1001234567'), '201001234567')
})

test('punctuation and spacing are not part of the number', () => {
  assert.equal(normalizeWhatsAppPhone('+20 (100) 123-4567'), '201001234567')
  assert.equal(normalizeWhatsAppPhone('  01001234567  '), '201001234567')
})

test('anything that is not a dialable number yields no link', () => {
  assert.equal(normalizeWhatsAppPhone(''), '')
  assert.equal(normalizeWhatsAppPhone('0'), '')
  assert.equal(normalizeWhatsAppPhone('call me'), '')
  assert.equal(normalizeWhatsAppPhone('123'), '') // too short for E.164
  assert.equal(normalizeWhatsAppPhone('1234567890123456'), '') // too long for E.164
  // Not a string at all: the value comes out of a jsonb column.
  assert.equal(normalizeWhatsAppPhone(null), '')
  assert.equal(normalizeWhatsAppPhone(undefined), '')
  assert.equal(normalizeWhatsAppPhone(201001234567), '')
})

test('Arabic-Indic digits fail closed: no link, rather than a wrong one', () => {
  // src/lib/phone.ts converts these for the CUSTOMER's phone field, where a
  // rejection costs a sale. Here the input is the owner's own number, typed
  // once in the admin, and rendering no button is the safe failure. Reusing
  // that helper would cost this module its only property worth having: no
  // imports, so `node --test` can reach it without the @/ alias.
  assert.equal(normalizeWhatsAppPhone('٠١٠١٢٣٤٥٦٧٨'), '')
})

test('a full international number that is not Egyptian is left alone', () => {
  assert.equal(normalizeWhatsAppPhone('+966 50 123 4567'), '966501234567')
  assert.equal(normalizeWhatsAppPhone('+44 7911 123456'), '447911123456')
})
