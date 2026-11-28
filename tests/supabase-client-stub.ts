// Test double for the browser Supabase client. The real module embeds the
// project's publishable key; tests talk to the local function server instead.
import { FunctionsClient } from "npm:@supabase/functions-js@2.91.0"

const functionsUrl = Deno.env.get("LEAD_FUNCTION_URL") ?? "http://127.0.0.1:8000"

export const supabase = {
  functions: new FunctionsClient(functionsUrl),
}
