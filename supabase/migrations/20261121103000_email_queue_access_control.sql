-- Lock the email queue RPCs to service_role on databases that already applied
-- 20260603215630_email_infra.sql, which only revoked EXECUTE from PUBLIC.

-- RPC wrappers so Edge Functions can interact with pgmq via supabase.rpc()
-- (PostgREST only exposes functions in the public schema; pgmq functions are in the pgmq schema)
-- The privileged implementations live in the unexposed email_queue schema and
-- run as the owner, so they only accept the email queues and their dead-letter
-- queues, and only service_role may execute them. The public functions are
-- SECURITY INVOKER entry points: a caller without EXECUTE on the implementation
-- is refused there with 401.
-- The implementations auto-create the queue on undefined_table (42P01) so emails
-- are never lost if the queue was dropped (extension upgrade, restore, etc.).
CREATE SCHEMA IF NOT EXISTS email_queue;
REVOKE ALL ON SCHEMA email_queue FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA email_queue TO service_role;

CREATE OR REPLACE FUNCTION email_queue.enqueue_email(queue_name TEXT, payload JSONB)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF queue_name IS NULL OR queue_name NOT IN
    ('auth_emails', 'transactional_emails', 'auth_emails_dlq', 'transactional_emails_dlq') THEN
    RAISE EXCEPTION 'unknown email queue' USING ERRCODE = '22023';
  END IF;
  RETURN pgmq.send(queue_name, payload);
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN pgmq.send(queue_name, payload);
END;
$$;

CREATE OR REPLACE FUNCTION email_queue.read_email_batch(queue_name TEXT, batch_size INT, vt INT)
RETURNS TABLE(msg_id BIGINT, read_ct INT, message JSONB)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF queue_name IS NULL OR queue_name NOT IN
    ('auth_emails', 'transactional_emails', 'auth_emails_dlq', 'transactional_emails_dlq') THEN
    RAISE EXCEPTION 'unknown email queue' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.message FROM pgmq.read(queue_name, vt, batch_size) r;
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION email_queue.delete_email(queue_name TEXT, message_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF queue_name IS NULL OR queue_name NOT IN
    ('auth_emails', 'transactional_emails', 'auth_emails_dlq', 'transactional_emails_dlq') THEN
    RAISE EXCEPTION 'unknown email queue' USING ERRCODE = '22023';
  END IF;
  RETURN pgmq.delete(queue_name, message_id);
EXCEPTION WHEN undefined_table THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION email_queue.move_to_dlq(
  source_queue TEXT, dlq_name TEXT, message_id BIGINT, payload JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE new_id BIGINT;
BEGIN
  IF source_queue IS NULL OR source_queue NOT IN ('auth_emails', 'transactional_emails')
    OR dlq_name IS DISTINCT FROM source_queue || '_dlq' THEN
    RAISE EXCEPTION 'unknown email queue' USING ERRCODE = '22023';
  END IF;
  SELECT pgmq.send(dlq_name, payload) INTO new_id;
  PERFORM pgmq.delete(source_queue, message_id);
  RETURN new_id;
EXCEPTION WHEN undefined_table THEN
  BEGIN
    PERFORM pgmq.create(dlq_name);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  SELECT pgmq.send(dlq_name, payload) INTO new_id;
  BEGIN
    PERFORM pgmq.delete(source_queue, message_id);
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;
  RETURN new_id;
END;
$$;

-- Supabase's default privileges grant EXECUTE on new functions directly to anon
-- and authenticated, so revoking from PUBLIC alone is not enough.
REVOKE ALL ON FUNCTION email_queue.enqueue_email(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION email_queue.enqueue_email(TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION email_queue.read_email_batch(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION email_queue.read_email_batch(TEXT, INT, INT) TO service_role;

REVOKE ALL ON FUNCTION email_queue.delete_email(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION email_queue.delete_email(TEXT, BIGINT) TO service_role;

REVOKE ALL ON FUNCTION email_queue.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION email_queue.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_email(queue_name TEXT, payload JSONB)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN email_queue.enqueue_email(queue_name, payload);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'not authorized for the email queue' USING ERRCODE = 'PT401';
END;
$$;

CREATE OR REPLACE FUNCTION public.read_email_batch(queue_name TEXT, batch_size INT, vt INT)
RETURNS TABLE(msg_id BIGINT, read_ct INT, message JSONB)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.message
    FROM email_queue.read_email_batch(queue_name, batch_size, vt) r;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'not authorized for the email queue' USING ERRCODE = 'PT401';
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_email(queue_name TEXT, message_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN email_queue.delete_email(queue_name, message_id);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'not authorized for the email queue' USING ERRCODE = 'PT401';
END;
$$;

CREATE OR REPLACE FUNCTION public.move_to_dlq(
  source_queue TEXT, dlq_name TEXT, message_id BIGINT, payload JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN email_queue.move_to_dlq(source_queue, dlq_name, message_id, payload);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'not authorized for the email queue' USING ERRCODE = 'PT401';
END;
$$;

-- anon is refused by the grant itself; signed-in callers reach the entry point
-- and are refused there because they cannot execute the implementation.
REVOKE ALL ON FUNCTION public.enqueue_email(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.read_email_batch(TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_email(TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) TO authenticated, service_role;
