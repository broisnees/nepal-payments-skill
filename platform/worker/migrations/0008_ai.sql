-- Ask paynp questions per project per UTC day (src/ai/routes.ts caps them).
CREATE TABLE ai_usage (project_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, day));
