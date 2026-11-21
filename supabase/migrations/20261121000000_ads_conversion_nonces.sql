-- One-time proof that send-transactional-email accepted a contact or Style Book
-- inquiry. The thank-you page may only send a Google Ads form conversion after
-- redeeming one of these, so the thank-you URL alone is never proof of a lead.
-- Only a SHA-256 hash of the nonce is stored; the raw value lives in the
-- browser that submitted the inquiry.
CREATE TABLE IF NOT EXISTS public.ads_conversion_nonces (
  nonce_hash TEXT PRIMARY KEY,
  form TEXT NOT NULL CHECK (form IN ('contact', 'stylebook')),
  -- One nonce per notification idempotency key, so replaying a key that the
  -- sender deduplicates cannot mint extra conversions.
  idempotency_key TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON public.ads_conversion_nonces FROM anon, authenticated;
GRANT ALL ON public.ads_conversion_nonces TO service_role;

ALTER TABLE public.ads_conversion_nonces ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role can manage ads conversion nonces"
    ON public.ads_conversion_nonces FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ads_conversion_nonces_expires
  ON public.ads_conversion_nonces(expires_at);

-- Redeems a nonce in a single UPDATE so the unused/unexpired/form check and the
-- write that spends it cannot be separated: of two concurrent redeems for the
-- same nonce, exactly one gets a row back.
CREATE OR REPLACE FUNCTION public.redeem_ads_conversion_nonce(p_nonce_hash TEXT, p_form TEXT)
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ads_conversion_nonces
     SET redeemed_at = now()
   WHERE nonce_hash = p_nonce_hash
     AND form = p_form
     AND redeemed_at IS NULL
     AND expires_at > now()
  RETURNING form;
$$;

REVOKE EXECUTE ON FUNCTION public.redeem_ads_conversion_nonce(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_ads_conversion_nonce(TEXT, TEXT) TO service_role;
