// Stand-in for npm:@supabase/supabase-js@2/cors, copied from
// @supabase/supabase-js 2.119.2 package/src/cors.ts. The edge import is
// unpinned (`npm:@supabase/supabase-js@2`); 2.119.2 is the latest 2.x
// resolved while these tests were written. The send function only spreads
// these headers onto its HTTP responses.
const SUPABASE_HEADERS = [
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'x-retry-count',
  'traceparent',
  'tracestate',
  'baggage',
].join(', ')

const SUPABASE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].join(', ')

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': SUPABASE_HEADERS,
  'Access-Control-Allow-Methods': SUPABASE_METHODS,
}
