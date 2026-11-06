-- 0006 dropped these. They were recreated empty on production for the few minutes the old build kept running
-- after 0006 (a Workers API outage held the deploy back); this removes them again.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS login_tokens;
