-- Sign-up form: the name and organization a visitor typed travel with their magic link and are used only when the
-- verify creates a new account. Existing tokens keep NULLs and behave as plain sign-in links.
ALTER TABLE login_tokens ADD COLUMN signup_name TEXT;
ALTER TABLE login_tokens ADD COLUMN signup_org TEXT;
