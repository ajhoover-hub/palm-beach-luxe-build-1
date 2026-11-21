import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import {
  hashConversionNonce,
  isConversionForm,
  isWellFormedConversionNonce,
} from '../_shared/ads-conversion-nonce.ts'

// Spends a nonce issued by send-transactional-email. Responds
// { accepted: true, form } at most once per nonce, and only for the form it
// was issued for and before it expires; every other request gets
// { accepted: false }.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables')
    return json({ error: 'Server configuration error' }, 500)
  }

  let nonce: unknown
  let form: unknown
  try {
    const body = await req.json()
    nonce = body?.nonce
    form = body?.form
  } catch {
    return json({ accepted: false }, 400)
  }

  if (!isWellFormedConversionNonce(nonce) || !isConversionForm(form)) {
    return json({ accepted: false })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)
  const { data, error } = await supabase.rpc('redeem_ads_conversion_nonce', {
    p_nonce_hash: await hashConversionNonce(nonce),
    p_form: form,
  })

  if (error) {
    console.error('Conversion nonce redeem failed', { error })
    return json({ accepted: false }, 500)
  }

  if (data !== form) {
    return json({ accepted: false })
  }

  return json({ accepted: true, form: data })
})
