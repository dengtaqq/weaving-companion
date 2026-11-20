/** 按版本顺序执行的 SQLite 迁移；已应用版本由 schema_migration 记录。 */
export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE session (
        session_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('NORMAL', 'MERCHANT')),
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        model_alias TEXT NOT NULL,
        pi_sdk_adapter_version TEXT NOT NULL,
        pi_session_file TEXT,
        lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE',
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE message (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content_json TEXT NOT NULL,
        client_turn_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, client_turn_id)
      );
      CREATE INDEX message_session_created ON message(session_id, created_at, message_id);
      CREATE TABLE agent_run (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        runtime_plan_json TEXT NOT NULL,
        runtime_snapshot_ref TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_run_queue ON agent_run(status, created_at);
      CREATE TABLE runtime_event (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );
      CREATE TABLE api_operation (
        operation_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE artifact (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        blob_hash TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: "ALTER TABLE api_operation ADD COLUMN request_hash TEXT;",
  },
  {
    version: 3,
    sql: "ALTER TABLE agent_run ADD COLUMN usage_json TEXT;",
  },
  {
    version: 4,
    sql: "ALTER TABLE agent_run ADD COLUMN cancel_requested_at TEXT;",
  },
  {
    version: 5,
    sql: `CREATE TABLE global_system_prompt (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL,
      revision INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE merchant (
        merchant_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'ACTIVE'),
        profile_revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE merchant_profile_revision (
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        revision INTEGER NOT NULL,
        fields_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (merchant_id, revision)
      );
      CREATE TABLE merchant_platform_link (
        link_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX merchant_link_owner ON merchant_platform_link(merchant_id, status);
      CREATE TABLE merchant_platform_link_revision (
        link_id TEXT NOT NULL REFERENCES merchant_platform_link(link_id),
        revision INTEGER NOT NULL,
        platform TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (link_id, revision)
      );
      CREATE TABLE merchant_context_snapshot (
        snapshot_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        profile_revision INTEGER NOT NULL,
        link_refs_json TEXT NOT NULL,
        diagnosis_report_id TEXT,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE merchant_public_evidence (
        evidence_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        source_url TEXT NOT NULL,
        final_url TEXT,
        title TEXT NOT NULL,
        visible_text TEXT NOT NULL,
        links_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('COLLECTED', 'LIMITED', 'BLOCKED', 'FAILED')),
        error_code TEXT,
        collected_at TEXT NOT NULL
      );
      CREATE INDEX merchant_public_evidence_owner ON merchant_public_evidence(merchant_id, collected_at DESC);
      CREATE TABLE account_diagnosis (
        diagnosis_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT NOT NULL UNIQUE REFERENCES agent_run(run_id),
        profile_revision INTEGER NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'DRAFT'),
        created_at TEXT NOT NULL
      );
      CREATE INDEX account_diagnosis_owner ON account_diagnosis(merchant_id, created_at DESC);
    `,
  },
  {
    version: 8,
    sql: "CREATE UNIQUE INDEX merchant_public_evidence_run_url ON merchant_public_evidence(run_id, source_url);",
  },
  {
    version: 9,
    sql: `
      CREATE TABLE delegation (
        delegation_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES session(session_id),
        parent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_run(run_id),
        child_session_id TEXT NOT NULL UNIQUE,
        child_run_id TEXT NOT NULL UNIQUE,
        target_expert_id TEXT NOT NULL CHECK (target_expert_id = 'writer'),
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX delegation_parent_session ON delegation(parent_session_id, created_at);
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE delegation ADD COLUMN input_snapshot_json TEXT;
      ALTER TABLE delegation ADD COLUMN child_plan_json TEXT;
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE merchant_public_evidence RENAME TO previous_public_evidence;
      CREATE TABLE merchant_public_evidence (
        evidence_id TEXT PRIMARY KEY,
        merchant_id TEXT REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        source_url TEXT NOT NULL,
        final_url TEXT,
        title TEXT NOT NULL,
        visible_text TEXT NOT NULL,
        links_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('COLLECTED', 'LIMITED', 'BLOCKED', 'FAILED')),
        error_code TEXT,
        collected_at TEXT NOT NULL
      );
      INSERT INTO merchant_public_evidence SELECT * FROM previous_public_evidence;
      DROP TABLE previous_public_evidence;
      CREATE INDEX merchant_public_evidence_owner ON merchant_public_evidence(merchant_id, collected_at DESC);
      CREATE UNIQUE INDEX merchant_public_evidence_run_url ON merchant_public_evidence(run_id, source_url);

      ALTER TABLE account_diagnosis RENAME TO previous_account_diagnosis;
      CREATE TABLE account_diagnosis (
        diagnosis_id TEXT PRIMARY KEY,
        merchant_id TEXT REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT NOT NULL UNIQUE REFERENCES agent_run(run_id),
        profile_revision INTEGER,
        evidence_ids_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'DRAFT'),
        created_at TEXT NOT NULL
      );
      INSERT INTO account_diagnosis SELECT * FROM previous_account_diagnosis;
      DROP TABLE previous_account_diagnosis;
      CREATE INDEX account_diagnosis_owner ON account_diagnosis(merchant_id, created_at DESC);
    `,
  },
  {
    version: 12,
    sql: "ALTER TABLE merchant_public_evidence ADD COLUMN visible_text_sha256 TEXT;",
  },
  {
    version: 13,
    sql: "ALTER TABLE merchant_public_evidence ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'PUBLIC_UNAUTHENTICATED' CHECK (access_mode IN ('PUBLIC_UNAUTHENTICATED', 'USER_AUTHORIZED'));",
  },
  {
    version: 14,
    sql: `ALTER TABLE account_diagnosis ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE account_diagnosis ADD COLUMN revises_diagnosis_id TEXT REFERENCES account_diagnosis(diagnosis_id);
      ALTER TABLE account_diagnosis ADD COLUMN evidence_refs_json TEXT;
      ALTER TABLE account_diagnosis ADD COLUMN request_sha256 TEXT;
      CREATE UNIQUE INDEX account_diagnosis_revision_parent ON account_diagnosis(revises_diagnosis_id)
        WHERE revises_diagnosis_id IS NOT NULL;`,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE delegation RENAME TO previous_delegation;
      CREATE TABLE delegation (
        delegation_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES session(session_id),
        parent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_run(run_id),
        child_session_id TEXT NOT NULL UNIQUE,
        child_run_id TEXT NOT NULL UNIQUE,
        target_expert_id TEXT NOT NULL CHECK (target_expert_id IN ('writer', 'visual', 'reviewer')),
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        input_snapshot_json TEXT,
        child_plan_json TEXT
      );
      INSERT INTO delegation SELECT * FROM previous_delegation;
      DROP TABLE previous_delegation;
      CREATE INDEX delegation_parent_session ON delegation(parent_session_id, created_at);
    `,
  },
  {
    version: 16,
    sql: `
      ALTER TABLE delegation RENAME TO previous_delegation;
      CREATE TABLE delegation (
        delegation_id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES session(session_id),
        parent_run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        task_key TEXT NOT NULL,
        child_session_id TEXT NOT NULL UNIQUE,
        child_run_id TEXT NOT NULL UNIQUE,
        target_expert_id TEXT NOT NULL CHECK (target_expert_id IN ('writer', 'visual', 'reviewer')),
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING_INPUT', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        input_snapshot_json TEXT,
        child_plan_json TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        question_text TEXT,
        answer_text TEXT,
        result_submitted_at TEXT,
        parent_ack_at TEXT,
        UNIQUE(parent_run_id, task_key)
      );
      INSERT INTO delegation (delegation_id, parent_session_id, parent_run_id, task_key,
        child_session_id, child_run_id, target_expert_id, input_hash, input_json, status,
        result_json, error_code, created_at, updated_at, input_snapshot_json, child_plan_json,
        attempt, result_submitted_at, parent_ack_at)
      SELECT delegation_id, parent_session_id, parent_run_id, 'legacy', child_session_id, child_run_id,
        target_expert_id, input_hash, input_json, status, result_json, error_code, created_at,
        updated_at, input_snapshot_json, child_plan_json, CASE WHEN status = 'QUEUED' THEN 0 ELSE 1 END,
        CASE WHEN status = 'SUCCEEDED' THEN updated_at ELSE NULL END, NULL FROM previous_delegation;
      DROP TABLE previous_delegation;
      CREATE INDEX delegation_parent_session ON delegation(parent_session_id, created_at);
      CREATE INDEX delegation_parent_run ON delegation(parent_run_id, created_at);
      CREATE TABLE delegation_instruction (
        instruction_id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES delegation(delegation_id),
        version INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ANSWER', 'STEER')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(delegation_id, version)
      );
      CREATE TABLE delegation_attempt (
        delegation_id TEXT NOT NULL REFERENCES delegation(delegation_id),
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'WAITING_INPUT', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT,
        PRIMARY KEY (delegation_id, attempt)
      );
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE context_checkpoint (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'COMMITTED', 'FAILED', 'ABORTED')),
        reason TEXT NOT NULL,
        anchor_message_id TEXT,
        merchant_snapshot_id TEXT,
        merchant_snapshot_hash TEXT,
        summary_template_version TEXT NOT NULL DEFAULT 'host-business-v1',
        adapter_version TEXT,
        source_snapshot_ref TEXT,
        source_snapshot_hash TEXT,
        final_snapshot_ref TEXT,
        final_snapshot_hash TEXT,
        first_kept_entry_id TEXT,
        summary TEXT,
        summary_hash TEXT,
        tokens_before INTEGER,
        estimated_tokens_after INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, ordinal)
      );
      CREATE INDEX context_checkpoint_session ON context_checkpoint(session_id, created_at);
    `,
  },
  {
    version: 18,
    sql: `
      ALTER TABLE delegation_instruction RENAME TO previous_delegation_instruction;
      CREATE TABLE delegation_instruction (
        instruction_id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES delegation(delegation_id),
        version INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('QUESTION', 'ANSWER', 'STEER')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(delegation_id, version)
      );
      INSERT INTO delegation_instruction SELECT * FROM previous_delegation_instruction;
      DROP TABLE previous_delegation_instruction;
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE merchant_memory (
        memory_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        revision INTEGER NOT NULL, origin_key TEXT UNIQUE
      );
      CREATE INDEX merchant_memory_owner ON merchant_memory(merchant_id);
      CREATE TABLE merchant_memory_revision (
        memory_id TEXT NOT NULL REFERENCES merchant_memory(memory_id), revision INTEGER NOT NULL,
        body_json TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(memory_id, revision)
      );
      ALTER TABLE merchant_context_snapshot ADD COLUMN memory_refs_json TEXT;
      CREATE TABLE memory_job (
        job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(session_id),
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id), status TEXT NOT NULL,
        source_json TEXT NOT NULL, source_hash TEXT NOT NULL, omitted_count INTEGER NOT NULL,
        model_json TEXT, attempt INTEGER NOT NULL DEFAULT 0, recovery_count INTEGER NOT NULL DEFAULT 0,
        attempts_json TEXT NOT NULL DEFAULT '[]', result_json TEXT, error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id, source_hash)
      );
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE public_diagnosis_report (
        report_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        diagnosis_id TEXT NOT NULL UNIQUE REFERENCES account_diagnosis(diagnosis_id),
        source_version INTEGER NOT NULL,
        artifact_id TEXT NOT NULL UNIQUE REFERENCES artifact(artifact_id),
        blob_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX public_diagnosis_report_owner ON public_diagnosis_report(merchant_id, created_at DESC);
    `,
  },
  {
    version: 21,
    sql: `
      CREATE TABLE memory_job_versioned (
        job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(session_id),
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
        template_version TEXT NOT NULL, source_json TEXT NOT NULL, source_hash TEXT NOT NULL,
        omitted_count INTEGER NOT NULL, model_json TEXT, attempt INTEGER NOT NULL DEFAULT 0,
        recovery_count INTEGER NOT NULL DEFAULT 0, attempts_json TEXT NOT NULL DEFAULT '[]',
        result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(session_id, source_hash, template_version)
      );
      INSERT INTO memory_job_versioned (job_id, session_id, merchant_id, status, template_version,
        source_json, source_hash, omitted_count, model_json, attempt, recovery_count, attempts_json,
        result_json, error_code, created_at, updated_at)
      SELECT job_id, session_id, merchant_id, status, 'merchant-memory-v1', source_json, source_hash,
        omitted_count, model_json, attempt, recovery_count, attempts_json, result_json, error_code,
        created_at, updated_at FROM memory_job;
      DROP TABLE memory_job;
      ALTER TABLE memory_job_versioned RENAME TO memory_job;
    `,
  },
  {
    version: 22,
    sql: `
      ALTER TABLE session ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE session ADD COLUMN deleted_at TEXT;
      ALTER TABLE session ADD COLUMN trash_expires_at TEXT;
      ALTER TABLE session ADD COLUMN trash_previous_status TEXT;
      CREATE TABLE session_read_cursor (
        session_id TEXT PRIMARY KEY REFERENCES session(session_id),
        message_rowid INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE message_search USING fts5(message_id UNINDEXED, body, tokenize='trigram');
      INSERT INTO message_search(rowid, message_id, body)
        SELECT rowid, message_id, json_extract(content_json, '$.text') FROM message;
      CREATE TRIGGER message_search_insert AFTER INSERT ON message BEGIN
        INSERT INTO message_search(rowid, message_id, body)
          VALUES (new.rowid, new.message_id, json_extract(new.content_json, '$.text'));
      END;
      CREATE TRIGGER message_search_delete AFTER DELETE ON message BEGIN
        DELETE FROM message_search WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER message_search_update AFTER UPDATE OF content_json ON message BEGIN
        DELETE FROM message_search WHERE rowid = old.rowid;
        INSERT INTO message_search(rowid, message_id, body)
          VALUES (new.rowid, new.message_id, json_extract(new.content_json, '$.text'));
      END;
      CREATE INDEX session_lifecycle_page ON session(lifecycle_status, updated_at DESC, session_id DESC);
    `,
  },
  {
    version: 23,
    sql: `
      CREATE TABLE session_purge (
        session_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL CHECK (phase IN ('PREPARED', 'COMMITTED', 'FINALIZED')),
        artifact_hashes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 24,
    sql: `
      CREATE TABLE blob_gc (
        blob_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX blob_gc_session ON blob_gc(session_id);
    `,
  },
  {
    version: 25,
    sql: `
      -- 保留升级前的排队消息，由旧前驱契约串行消化；禁止再受理重叠任务。
      CREATE UNIQUE INDEX agent_run_one_running_per_session ON agent_run(session_id)
        WHERE status = 'RUNNING';
      CREATE TRIGGER agent_run_single_admission BEFORE INSERT ON agent_run
      WHEN NEW.status IN ('QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_CONFIRMATION')
        AND EXISTS (SELECT 1 FROM agent_run WHERE session_id = NEW.session_id
          AND status IN ('QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_CONFIRMATION'))
      BEGIN
        SELECT RAISE(ABORT, 'SESSION_RUN_ACTIVE');
      END;
    `,
  },
  {
    version: 26,
    sql: `
      CREATE TABLE merchant_catalog_entry (
        entry_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        kind TEXT NOT NULL CHECK (kind IN ('PRODUCT','KEYWORD','TREND','COMPETITOR','MERCHANT_UPDATE')),
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE merchant_catalog_revision (
        entry_id TEXT NOT NULL REFERENCES merchant_catalog_entry(entry_id),
        revision INTEGER NOT NULL,
        name TEXT NOT NULL,
        detail TEXT NOT NULL,
        source_url TEXT,
        evidence_id TEXT REFERENCES merchant_public_evidence(evidence_id),
        observed_at TEXT,
        provenance TEXT NOT NULL CHECK (provenance IN ('MERCHANT_CONFIRMED','USER_PROVIDED_LEAD','PUBLIC_EVIDENCE')),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (entry_id, revision)
      );
      CREATE INDEX merchant_catalog_owner ON merchant_catalog_entry(merchant_id, kind, status, updated_at DESC);
      ALTER TABLE merchant_context_snapshot ADD COLUMN catalog_refs_json TEXT;
    `,
  },
  {
    version: 27,
    sql: `
      CREATE TABLE content_draft (
        draft_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        merchant_id TEXT REFERENCES merchant(merchant_id),
        source_message_id TEXT NOT NULL UNIQUE REFERENCES message(message_id),
        source_run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        current_revision INTEGER NOT NULL DEFAULT 1,
        approved_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE content_revision (
        draft_id TEXT NOT NULL REFERENCES content_draft(draft_id),
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('AGENT','USER')),
        artifact_id TEXT UNIQUE REFERENCES artifact(artifact_id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (draft_id, revision)
      );
      CREATE INDEX content_draft_session ON content_draft(session_id, updated_at DESC);
    `,
  },
  {
    version: 28,
    sql: `
      CREATE TABLE generation_job (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(session_id),
        merchant_id TEXT REFERENCES merchant(merchant_id),
        intent TEXT NOT NULL CHECK (intent IN ('CREATE','MODIFY')),
        kind TEXT NOT NULL CHECK (kind IN ('IMAGE','TEXT')),
        status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','READY_FOR_REVIEW','UNKNOWN_EXTERNAL','FAILED')),
        prompt TEXT NOT NULL, input_hash TEXT NOT NULL,
        model_id TEXT NOT NULL, model_version TEXT NOT NULL,
        size TEXT, quality TEXT,
        title TEXT, template_id TEXT, template_version TEXT, template_hash TEXT,
        product_entry_id TEXT, product_revision INTEGER, product_hash TEXT,
        target_draft_id TEXT REFERENCES content_draft(draft_id), target_revision INTEGER, target_hash TEXT,
        source_run_id TEXT REFERENCES agent_run(run_id),
        result_draft_id TEXT REFERENCES content_draft(draft_id),
        reference_artifact_id TEXT REFERENCES artifact(artifact_id),
        reference_hash TEXT, result_artifact_id TEXT REFERENCES artifact(artifact_id),
        provider_request_id TEXT, error_code TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        request_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX generation_job_session ON generation_job(session_id, created_at DESC);
      CREATE TABLE generation_step_attempt (
        job_id TEXT NOT NULL REFERENCES generation_job(job_id),
        step_key TEXT NOT NULL, attempt INTEGER NOT NULL,
        input_hash TEXT NOT NULL, strategy_version TEXT NOT NULL,
        status TEXT NOT NULL, provider_request_id TEXT,
        output_artifact_id TEXT REFERENCES artifact(artifact_id),
        error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT,
        PRIMARY KEY(job_id, step_key, attempt)
      );
    `,
  },
  {
    version: 29,
    sql: `
      ALTER TABLE session ADD COLUMN research_scope_json TEXT;
      ALTER TABLE merchant_context_snapshot ADD COLUMN research_scope_json TEXT;
      ALTER TABLE merchant_context_snapshot ADD COLUMN research_refs_json TEXT;
      CREATE TABLE merchant_research_batch (
        batch_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        snapshot_id TEXT NOT NULL REFERENCES merchant_context_snapshot(snapshot_id),
        batch_key TEXT NOT NULL,
        body_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, batch_key)
      );
      CREATE INDEX merchant_research_batch_owner ON merchant_research_batch(merchant_id, created_at DESC);
      CREATE TABLE merchant_research_item (
        item_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        kind TEXT NOT NULL CHECK(kind IN ('KEYWORD','TREND','COMPETITOR_DIFFERENCE')),
        normalized_title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')),
        UNIQUE(merchant_id, kind, normalized_title)
      );
      CREATE TABLE merchant_research_revision (
        item_id TEXT NOT NULL REFERENCES merchant_research_item(item_id),
        revision INTEGER NOT NULL,
        source_batch_id TEXT NOT NULL REFERENCES merchant_research_batch(batch_id),
        body_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY(item_id, revision)
      );
    `,
  },
  {
    version: 30,
    sql: `
      CREATE TABLE merchant_research_report (
        report_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        source_attempt INTEGER NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES merchant_context_snapshot(snapshot_id),
        body_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, source_attempt)
      );
      CREATE INDEX merchant_research_report_owner ON merchant_research_report(merchant_id, created_at DESC);
    `,
  },
  {
    version: 31,
    sql: `
      CREATE TABLE merchant_content_analysis (
        analysis_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL UNIQUE REFERENCES session(session_id),
        scope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        latest_ready_report_id TEXT REFERENCES merchant_research_report(report_id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX merchant_content_analysis_owner ON merchant_content_analysis(merchant_id, updated_at DESC);
      CREATE TABLE merchant_content_analysis_attempt (
        analysis_id TEXT NOT NULL REFERENCES merchant_content_analysis(analysis_id),
        run_id TEXT NOT NULL REFERENCES agent_run(run_id),
        run_attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES merchant_context_snapshot(snapshot_id),
        snapshot_hash TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        gaps_json TEXT NOT NULL,
        report_id TEXT REFERENCES merchant_research_report(report_id),
        error_code TEXT,
        started_at TEXT NOT NULL, finished_at TEXT,
        PRIMARY KEY(run_id, run_attempt)
      );
    `,
  },
  {
    version: 32,
    sql: `
      ALTER TABLE generation_job ADD COLUMN purpose TEXT NOT NULL DEFAULT 'CONTENT';
      ALTER TABLE generation_job ADD COLUMN source_json TEXT;
      CREATE INDEX generation_job_run ON generation_job(source_run_id);
      CREATE TABLE merchant_topic (
        topic_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        revision INTEGER NOT NULL,
        planning_job_id TEXT NOT NULL REFERENCES generation_job(job_id),
        source_report_id TEXT NOT NULL REFERENCES merchant_research_report(report_id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX merchant_topic_owner ON merchant_topic(merchant_id, session_id, created_at DESC);
      CREATE TABLE merchant_topic_revision (
        topic_id TEXT NOT NULL REFERENCES merchant_topic(topic_id),
        revision INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY(topic_id, revision)
      );
    `,
  },
  {
    version: 33,
    sql: `
      ALTER TABLE merchant_topic_revision RENAME TO merchant_topic_revision_v32;
      ALTER TABLE merchant_topic RENAME TO merchant_topic_v32;
      DROP INDEX merchant_topic_owner;
      CREATE TABLE merchant_topic (
        topic_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT NOT NULL REFERENCES session(session_id),
        revision INTEGER NOT NULL,
        planning_job_id TEXT NOT NULL REFERENCES generation_job(job_id),
        source_report_id TEXT REFERENCES merchant_research_report(report_id),
        created_at TEXT NOT NULL
      );
      INSERT INTO merchant_topic SELECT * FROM merchant_topic_v32;
      CREATE INDEX merchant_topic_owner ON merchant_topic(merchant_id, session_id, created_at DESC);
      CREATE TABLE merchant_topic_revision (
        topic_id TEXT NOT NULL REFERENCES merchant_topic(topic_id),
        revision INTEGER NOT NULL, body_json TEXT NOT NULL,
        PRIMARY KEY(topic_id, revision)
      );
      INSERT INTO merchant_topic_revision SELECT * FROM merchant_topic_revision_v32;
      DROP TABLE merchant_topic_revision_v32;
      DROP TABLE merchant_topic_v32;
      CREATE TABLE content_publication (
        draft_id TEXT PRIMARY KEY REFERENCES content_draft(draft_id),
        revision INTEGER NOT NULL, body_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE content_publication_export (
        export_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES content_draft(draft_id),
        artifact_id TEXT NOT NULL REFERENCES artifact(artifact_id),
        draft_revision INTEGER NOT NULL, publication_revision INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(draft_id, draft_revision, publication_revision)
      );
    `,
  },
  {
    version: 34,
    sql: `
      CREATE TABLE capability_skill (
        name TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL,
        roles_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE capability_skill_revision (
        name TEXT NOT NULL REFERENCES capability_skill(name), revision INTEGER NOT NULL,
        body_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(name, revision)
      );
      CREATE TABLE capability_configuration (
        configuration_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('EXPERT','TEAM')),
        revision INTEGER NOT NULL, body_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE capability_configuration_revision (
        configuration_id TEXT NOT NULL REFERENCES capability_configuration(configuration_id),
        revision INTEGER NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(configuration_id,revision)
      );
    `,
  },
  {
    version: 35,
    sql: `
      CREATE TABLE work_plan (
        plan_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        session_id TEXT REFERENCES session(session_id), draft_id TEXT REFERENCES content_draft(draft_id),
        scheduled_for TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('TODO','DONE','CANCELLED')),
        revision INTEGER NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX work_plan_day ON work_plan(scheduled_for,merchant_id,status);
      CREATE TABLE merchant_media (
        media_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
        product_entry_id TEXT REFERENCES merchant_catalog_entry(entry_id), title TEXT NOT NULL,
        blob_hash TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')), revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX merchant_media_owner ON merchant_media(merchant_id,product_entry_id,status);
      CREATE TABLE merchant_media_reference (
        artifact_id TEXT PRIMARY KEY REFERENCES artifact(artifact_id), media_id TEXT NOT NULL REFERENCES merchant_media(media_id)
      );
      CREATE TABLE publication_record (
        record_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES content_draft(draft_id),
        export_artifact_id TEXT NOT NULL REFERENCES artifact(artifact_id), revision INTEGER NOT NULL,
        body_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE image_reconciliation (
        job_id TEXT PRIMARY KEY REFERENCES generation_job(job_id), resolution TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifact(artifact_id), note TEXT NOT NULL,
        prior_error_code TEXT, provider_request_id TEXT, created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 36,
    sql: `CREATE TABLE publication_review (
      review_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES content_draft(draft_id),
      job_id TEXT NOT NULL UNIQUE REFERENCES generation_job(job_id), draft_revision INTEGER NOT NULL,
      publication_revision INTEGER NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX publication_review_draft ON publication_review(draft_id,created_at);`,
  },
  { version: 37, sql: "ALTER TABLE content_revision ADD COLUMN internal_notes TEXT NOT NULL DEFAULT '';" },
  {
    version: 38,
    // 为新对话用途的恢复查询建索引；回退旧Host需恢复迁移前备份，避免误消费新任务。
    sql: "CREATE INDEX generation_publication_chat_state ON generation_job(purpose,json_extract(source_json,'$.workflow.state')) WHERE purpose='PUBLICATION_CHAT';",
  },
  {
    version: 39,
    sql: `CREATE TABLE task_context (
      context_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(session_id),
      root_job_id TEXT NOT NULL, draft_id TEXT UNIQUE REFERENCES content_draft(draft_id),
      current_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX task_context_session ON task_context(session_id,root_job_id);
    CREATE TABLE task_context_revision (
      context_id TEXT NOT NULL REFERENCES task_context(context_id), revision INTEGER NOT NULL,
      body_json TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(context_id,revision)
    );`,
  },
  {
    version: 40,
    sql: `ALTER TABLE session ADD COLUMN pi_session_hash TEXT;
    ALTER TABLE agent_run ADD COLUMN runtime_snapshot_hash TEXT;
    UPDATE session SET pi_session_hash = (
      SELECT final_snapshot_hash FROM context_checkpoint
      WHERE context_checkpoint.session_id = session.session_id AND status = 'COMMITTED'
        AND final_snapshot_ref = session.pi_session_file AND final_snapshot_hash IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    );
    CREATE TABLE runtime_attempt_snapshot (
      run_id TEXT NOT NULL REFERENCES agent_run(run_id), attempt INTEGER NOT NULL,
      session_id TEXT NOT NULL REFERENCES session(session_id), source_snapshot_ref TEXT,
      source_snapshot_hash TEXT, source_verification TEXT NOT NULL
        CHECK(source_verification IN ('EMPTY','VERIFIED','LEGACY_UNVERIFIED')),
      working_snapshot_ref TEXT NOT NULL, working_snapshot_hash TEXT,
      file_exists INTEGER NOT NULL CHECK(file_exists IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('PREPARED','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(run_id,attempt)
    );
    CREATE INDEX runtime_attempt_snapshot_session ON runtime_attempt_snapshot(session_id);`,
  },
  {
    version: 41,
    // 先暂存并移除两张子表，再重建角色约束；整个迁移在同一事务内保留旧委派与尝试。
    sql: `CREATE TEMP TABLE saved_delegation_instruction AS SELECT * FROM delegation_instruction;
    CREATE TEMP TABLE saved_delegation_attempt AS SELECT * FROM delegation_attempt;
    DROP TABLE delegation_instruction;
    DROP TABLE delegation_attempt;
    CREATE TABLE delegation_replacement (
      delegation_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL REFERENCES session(session_id),
      parent_run_id TEXT NOT NULL REFERENCES agent_run(run_id), task_key TEXT NOT NULL,
      child_session_id TEXT NOT NULL UNIQUE, child_run_id TEXT NOT NULL UNIQUE,
      target_expert_id TEXT NOT NULL CHECK(target_expert_id IN ('writer','visual','reviewer','researcher')),
      input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','WAITING_INPUT','SUCCEEDED','FAILED','CANCELLED')),
      result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      input_snapshot_json TEXT, child_plan_json TEXT, attempt INTEGER NOT NULL DEFAULT 0,
      question_text TEXT, answer_text TEXT, result_submitted_at TEXT, parent_ack_at TEXT,
      research_memory_json TEXT, research_memory_revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(parent_run_id,task_key)
    );
    INSERT INTO delegation_replacement
      (delegation_id,parent_session_id,parent_run_id,task_key,child_session_id,child_run_id,
      target_expert_id,input_hash,input_json,status,result_json,error_code,created_at,updated_at,
      input_snapshot_json,child_plan_json,attempt,question_text,answer_text,result_submitted_at,parent_ack_at)
      SELECT delegation_id,parent_session_id,parent_run_id,task_key,child_session_id,child_run_id,
      target_expert_id,input_hash,input_json,status,result_json,error_code,created_at,updated_at,
      input_snapshot_json,child_plan_json,attempt,question_text,answer_text,result_submitted_at,parent_ack_at FROM delegation;
    DROP TABLE delegation;
    ALTER TABLE delegation_replacement RENAME TO delegation;
    CREATE INDEX delegation_parent_session ON delegation(parent_session_id,created_at);
    CREATE INDEX delegation_parent_run ON delegation(parent_run_id,created_at);
    CREATE TABLE delegation_instruction (
      instruction_id TEXT PRIMARY KEY, delegation_id TEXT NOT NULL REFERENCES delegation(delegation_id),
      version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('ANSWER','STEER','QUESTION')),
      content TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(delegation_id,version)
    );
    INSERT INTO delegation_instruction SELECT * FROM saved_delegation_instruction;
    CREATE TABLE delegation_attempt (
      delegation_id TEXT NOT NULL REFERENCES delegation(delegation_id), attempt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('RUNNING','WAITING_INPUT','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED')),
      started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT, PRIMARY KEY(delegation_id,attempt)
    );
    INSERT INTO delegation_attempt SELECT * FROM saved_delegation_attempt;
    DROP TABLE saved_delegation_instruction;
    DROP TABLE saved_delegation_attempt;`,
  },
  {
    version: 42,
    sql: `ALTER TABLE merchant_public_evidence ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE merchant_public_evidence ADD COLUMN image_capture_error TEXT;`,
  },
  {
    version: 43,
    sql: `CREATE TABLE merchant_memory_embedding (
      merchant_id TEXT NOT NULL REFERENCES merchant(merchant_id),
      memory_id TEXT NOT NULL, revision INTEGER NOT NULL, memory_sha256 TEXT NOT NULL,
      embedding_key TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 16384),
      vector BLOB NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(memory_id,revision,embedding_key),
      FOREIGN KEY(memory_id,revision) REFERENCES merchant_memory_revision(memory_id,revision) ON DELETE CASCADE,
      CHECK(length(vector)=dimensions*4)
    );
    CREATE INDEX merchant_memory_embedding_owner ON merchant_memory_embedding(merchant_id,embedding_key);`,
  },
  {
    version: 44,
    sql: `ALTER TABLE merchant_context_snapshot ADD COLUMN memory_scope_json TEXT;`,
  },
] as const;
