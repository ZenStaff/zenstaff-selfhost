// SQLite schema for the hub. One file, no server: a self-hosted hub is one container and a volume.
// Migrations are numbered and applied once, in order, inside a transaction.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Index + 1 is the version. A `null` entry is an unused slot (v10-v11 security reserve, v16 left
 * free by wave/perms-fine): it is skipped and not recorded, so a real migration can still land in
 * it later and apply once, even after a later version.
 * Release 0.2.4: v12 payments, v13 hosted memory, v14 client approvals, v15 platform admin,
 * v17 personal memory and memory zones. v18 growth (funnel events, leads, partner codes, opt-outs).
 */
export const MIGRATIONS: ReadonlyArray<string | null> = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE login_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    link_hash TEXT NOT NULL,
    poll_hash TEXT NOT NULL,
    approved_at INTEGER,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER
  );
  CREATE INDEX login_codes_email ON login_codes(email);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE memberships (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (company_id, user_id)
  );
  CREATE INDEX memberships_user ON memberships(user_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_by TEXT REFERENCES users(id),
    accepted_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE,
    runner_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'company', 'handover')),
    audience_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    handover_state TEXT CHECK (handover_state IN ('pending', 'completed', 'declined')),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX shares_company ON shares(company_id);
  CREATE INDEX shares_audience ON shares(audience_user_id);
  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_share ON comments(share_id);
  `,
  // v2: two-factor auth, device keys, sessions list, grants and settings (the hub as source of
  // truth for roles), notifications, audit log, sign-in with Google / Microsoft.
  `
  ALTER TABLE sessions ADD COLUMN mfa_at INTEGER;
  ALTER TABLE sessions ADD COLUMN last_used_at INTEGER;
  ALTER TABLE sessions ADD COLUMN ip TEXT;
  ALTER TABLE sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'email';
  CREATE INDEX sessions_user ON sessions(user_id);
  ALTER TABLE login_codes ADD COLUMN provider TEXT NOT NULL DEFAULT 'email';
  ALTER TABLE users ADD COLUMN edition TEXT;
  ALTER TABLE users ADD COLUMN language TEXT;
  ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE totp (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    enabled_at INTEGER,
    last_step INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );
  CREATE TABLE device_keys (
    key_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT,
    environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
    sign_public_key TEXT NOT NULL,
    box_public_key TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX device_keys_user ON device_keys(user_id);
  CREATE TABLE device_certs (
    key_id TEXT NOT NULL REFERENCES device_keys(key_id) ON DELETE CASCADE,
    signer_key_id TEXT NOT NULL REFERENCES device_keys(key_id) ON DELETE CASCADE,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (key_id, signer_key_id)
  );
  ALTER TABLE environments ADD COLUMN sign_public_key TEXT;
  ALTER TABLE environments ADD COLUMN box_public_key TEXT;
  ALTER TABLE environments ADD COLUMN ai_account TEXT;
  CREATE TABLE pack_grants (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    pack_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('use', 'install')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    granted_by TEXT NOT NULL REFERENCES users(id),
    statement TEXT NOT NULL,
    signer_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX pack_grants_company ON pack_grants(company_id);
  CREATE TABLE company_settings (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    memory_url TEXT,
    memory_save INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT REFERENCES users(id),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE academy_progress (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL,
    done_at TEXT NOT NULL,
    PRIMARY KEY (company_id, user_id, lesson_id)
  );
  CREATE TABLE academy_signals (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topics TEXT NOT NULL,
    searches TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_id, user_id)
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
    share_id TEXT REFERENCES shares(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX notifications_user ON notifications(user_id, created_at);
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX audit_company ON audit_log(company_id, created_at);
  CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    login_id TEXT NOT NULL REFERENCES login_codes(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // v3: the toolchain advisories file published by the night job (one row, served publicly).
  `
  CREATE TABLE toolchain_advisories (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    body TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    published_at TEXT NOT NULL
  );
  `,
  // v4: end-to-end comments and share titles (the hub keeps ciphertext only; old plaintext rows
  // stay readable and are marked legacy), notifications with routing only (who, which share,
  // kind), and first-device approval alerts asked for by runners (one per runner and key).
  `
  ALTER TABLE comments ADD COLUMN sealed TEXT;
  ALTER TABLE comments ADD COLUMN sig TEXT;
  ALTER TABLE comments ADD COLUMN device_key_id TEXT;
  ALTER TABLE shares ADD COLUMN title_sealed TEXT;
  ALTER TABLE notifications ADD COLUMN actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  CREATE TABLE device_approval_alerts (
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    key_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (environment_id, key_id)
  );
  `,
  // v5: passkeys (WebAuthn). Credentials, the per-person user handle, and the short-lived,
  // single-use ceremony links (registration bound to a session, sign-in bound to a pending login).
  `
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    device_type TEXT NOT NULL,
    backed_up INTEGER NOT NULL DEFAULT 0,
    aaguid TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);
  CREATE TABLE passkey_users (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    handle TEXT NOT NULL UNIQUE
  );
  CREATE TABLE passkey_ceremonies (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
    token_hash TEXT NOT NULL UNIQUE,
    challenge_hash TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT REFERENCES sessions(token_hash) ON DELETE CASCADE,
    login_id TEXT REFERENCES login_codes(id) ON DELETE CASCADE,
    label TEXT,
    lang TEXT NOT NULL DEFAULT 'en',
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  `,
  // v6: company-level objects. AI staff profiles (sealed to the company's runners and signed by
  // the admin or manager who changed them; the hub keeps ciphertext, a version and who/when) and
  // company packs (pack id, version and settings signed by an admin), with each machine's install
  // status so admins see progress and errors.
  `
  CREATE TABLE company_staff (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    manager_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    sealed TEXT NOT NULL,
    statement TEXT NOT NULL,
    signer_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    updated_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (company_id, staff_id)
  );
  CREATE TABLE company_packs (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    pack_id TEXT NOT NULL,
    version TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    enterprise INTEGER NOT NULL DEFAULT 0,
    statement TEXT NOT NULL,
    signer_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    updated_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT,
    PRIMARY KEY (company_id, pack_id)
  );
  CREATE TABLE company_pack_status (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    pack_id TEXT NOT NULL,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('installing', 'installed', 'failed', 'runner-only')),
    version TEXT,
    error TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_id, pack_id, environment_id)
  );
  `,
  // v7: the web dashboard. Company details for invoicing later (legal name, CUI, registry number,
  // address, billing e-mail; one JSON object) and a daily count of requests members sent to the
  // company runner through the hub, per op (the hub already routes them; never their content).
  `
  ALTER TABLE companies ADD COLUMN details TEXT;
  CREATE TABLE company_runner_calls (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    op TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (company_id, day, op)
  );
  `,
  // v8: the community library ("Bibliotecă"). Anyone signed in publishes a pack as a submission;
  // automatic checks run on upload and a hub reviewer (hub_staff) approves, asks for changes or
  // rejects each version. Published versions are served as archives in the registry format, with
  // author credit and an install count. Free: no prices, no payouts (see library_authors).
  `
  CREATE TABLE hub_staff (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('reviewer')),
    granted_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE library_authors (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    company TEXT,
    bio TEXT,
    featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE library_packs (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('new', 'published', 'unpublished')),
    published_version_id TEXT,
    featured INTEGER NOT NULL DEFAULT 0,
    unpublished_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX library_packs_author ON library_packs(author_user_id);
  CREATE TABLE library_versions (
    id TEXT PRIMARY KEY,
    pack_ref TEXT NOT NULL REFERENCES library_packs(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'changes_requested', 'published', 'rejected', 'superseded', 'withdrawn')),
    meta TEXT NOT NULL,
    files TEXT NOT NULL,
    screenshots TEXT NOT NULL,
    workflows TEXT,
    archive BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    checks TEXT NOT NULL,
    statement TEXT NOT NULL,
    signer_key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    submitted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submitted_at TEXT NOT NULL,
    decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    decided_at TEXT,
    review_note TEXT
  );
  CREATE INDEX library_versions_pack ON library_versions(pack_ref, submitted_at);
  CREATE INDEX library_versions_status ON library_versions(status, submitted_at);
  CREATE TABLE library_reviews (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES library_versions(id) ON DELETE CASCADE,
    reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'changes', 'reject')),
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE library_reports (
    id TEXT PRIMARY KEY,
    pack_ref TEXT NOT NULL REFERENCES library_packs(id) ON DELETE CASCADE,
    reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    resolution TEXT,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX library_reports_status ON library_reports(status, created_at);
  CREATE TABLE library_installs (
    pack_ref TEXT NOT NULL REFERENCES library_packs(id) ON DELETE CASCADE,
    installer TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (pack_ref, installer)
  );
  CREATE TABLE library_previews (
    token_hash TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES library_versions(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // v9: enterprise security. Custom roles with permissions per resource and action, scoped to the
  // company or to projects / teams; one machine as the runner of several companies (each with its
  // own AI account); the daily anchors of the tamper-evident audit log (the log itself lives in a
  // separate database, auditChain.ts) and each company's SIEM webhook.
  `
  CREATE TABLE company_roles (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    builtin TEXT CHECK (builtin IN ('member', 'guest')),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    permissions TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (company_id, name)
  );
  CREATE UNIQUE INDEX company_roles_builtin ON company_roles(company_id, builtin) WHERE builtin IS NOT NULL;
  ALTER TABLE memberships ADD COLUMN custom_role_id TEXT REFERENCES company_roles(id) ON DELETE SET NULL;
  CREATE TABLE company_teams (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (company_id, name)
  );
  CREATE TABLE company_projects (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    team_id TEXT REFERENCES company_teams(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (company_id, project_id)
  );
  CREATE TABLE member_scoped_roles (
    company_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES company_roles(id) ON DELETE CASCADE,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('team', 'project')),
    scope_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (company_id, user_id, role_id, scope_kind, scope_id),
    FOREIGN KEY (company_id, user_id) REFERENCES memberships(company_id, user_id) ON DELETE CASCADE
  );
  ALTER TABLE company_staff ADD COLUMN project_id TEXT;
  CREATE TABLE environment_runners (
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    ai_account TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (environment_id, company_id)
  );
  CREATE INDEX environment_runners_company ON environment_runners(company_id);
  INSERT INTO environment_runners (environment_id, company_id, ai_account, created_at)
    SELECT id, runner_company_id, ai_account, created_at FROM environments WHERE runner_company_id IS NOT NULL;
  UPDATE environments SET runner_company_id = NULL, ai_account = NULL;
  CREATE TABLE audit_anchors (
    chain TEXT NOT NULL,
    day TEXT NOT NULL,
    head_seq INTEGER NOT NULL,
    head_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chain, day)
  );
  CREATE TRIGGER audit_anchors_no_update BEFORE UPDATE ON audit_anchors BEGIN SELECT RAISE(ABORT, 'audit anchors are append-only'); END;
  CREATE TRIGGER audit_anchors_no_delete BEFORE DELETE ON audit_anchors BEGIN SELECT RAISE(ABORT, 'audit anchors are append-only'); END;
  CREATE TABLE company_siem (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    last_status TEXT,
    last_error TEXT,
    last_at TEXT
  );
  `,
  // v10-v11: reserved (wave/security follow-ups).
  null,
  null,
  // v12: payments for the hosted plan (Stripe). One subscription per company (plan, status, seats,
  // add-ons, renewal), the Stripe events already handled (idempotency), one-off package orders,
  // and the fiscal invoices issued for each paid Stripe invoice (e-Factura through HoReCaOS).
  `
  CREATE TABLE billing_accounts (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT UNIQUE,
    plan TEXT NOT NULL DEFAULT 'none' CHECK (plan IN ('none', 'hosted')),
    status TEXT NOT NULL DEFAULT 'none',
    seats INTEGER NOT NULL DEFAULT 0,
    servers INTEGER NOT NULL DEFAULT 0,
    seat_item_id TEXT,
    server_item_id TEXT,
    trial_end INTEGER,
    current_period_end INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    past_due_since INTEGER,
    vat_country TEXT,
    vat_id TEXT,
    vat_check TEXT,
    vat_checked_at INTEGER,
    last_event_at INTEGER,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE billing_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    created INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    error TEXT
  );
  CREATE INDEX billing_events_company ON billing_events(company_id, created);
  CREATE TABLE billing_orders (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    package TEXT NOT NULL,
    amount_eur INTEGER NOT NULL,
    checkout_session_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE TABLE billing_invoices (
    stripe_invoice_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('subscription', 'package')),
    amount_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL,
    period_start INTEGER,
    period_end INTEGER,
    paid_at INTEGER NOT NULL,
    stripe_pdf_url TEXT,
    fiscal_provider TEXT,
    fiscal_ref TEXT,
    fiscal_status TEXT NOT NULL DEFAULT 'pending' CHECK (fiscal_status IN ('pending', 'issued', 'dry_run', 'failed')),
    fiscal_series TEXT,
    fiscal_number TEXT,
    fiscal_pdf_url TEXT,
    efactura_status TEXT,
    fiscal_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX billing_invoices_company ON billing_invoices(company_id, paid_at);
  `,
  // v13: hosted company memory (zen-memory). The hub provisions one memory company per hub company
  // (owner/admin "Activează") and issues one memory API key per member machine; it keeps only the
  // key ids (to revoke a machine or a removed member), never the keys themselves.
  `
  CREATE TABLE company_memory (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    memory_company_id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    activated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    activated_at TEXT NOT NULL
  );
  CREATE TABLE company_memory_keys (
    key_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    machine TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX company_memory_keys_member ON company_memory_keys(company_id, user_id, revoked_at);
  `,
  // v14: client approval links. A freelancer sends a deliverable (images, a video, a PDF, a post
  // text) to a client who has no account: the link carries a random token (only its SHA-256 is
  // kept), expires, can be revoked, and shows that one deliverable. Files live on the data volume
  // (approvalFiles.ts), counted per company against a size cap; expired links lose their files.
  `
  CREATE TABLE client_approvals (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL,
    client_color TEXT,
    language TEXT NOT NULL CHECK (language IN ('ro', 'en')),
    status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'viewed', 'approved', 'changes')),
    comment TEXT,
    decided_by_name TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    first_viewed_at TEXT,
    last_viewed_at TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    files_deleted_at TEXT,
    total_bytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX client_approvals_company ON client_approvals(company_id, created_at);
  CREATE INDEX client_approvals_creator ON client_approvals(created_by, created_at);
  CREATE INDEX client_approvals_expiry ON client_approvals(expires_at);
  CREATE TABLE client_approval_files (
    approval_id TEXT NOT NULL REFERENCES client_approvals(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('file', 'logo')),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'pdf', 'text')),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    PRIMARY KEY (approval_id, idx)
  );
  `,
  // v15: the platform admin (/app/admin). Hub staff get three roles (operator: everything; reviewer:
  // the community library only; support: support actions, no billing), so hub_staff is rebuilt
  // with the wider CHECK. Accounts and companies can be suspended (with the reason); a sign-in is
  // remembered on the account. A company's plan is set by hand for bank-transfer clients
  // (platform_subscriptions, one row per company) and every change is kept
  // (platform_subscription_history, before and after as JSON). The admin's own audit trail is the
  // "platform" chain of the tamper-evident log (auditChain.ts), not a company chain.
  `
  CREATE TABLE hub_staff_v15 (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('operator', 'reviewer', 'support')),
    granted_by TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO hub_staff_v15 (user_id, role, granted_by, created_at) SELECT user_id, role, granted_by, created_at FROM hub_staff;
  DROP TABLE hub_staff;
  ALTER TABLE hub_staff_v15 RENAME TO hub_staff;
  ALTER TABLE users ADD COLUMN suspended_at TEXT;
  ALTER TABLE users ADD COLUMN suspended_reason TEXT;
  ALTER TABLE users ADD COLUMN last_signin_at TEXT;
  ALTER TABLE companies ADD COLUMN suspended_at TEXT;
  ALTER TABLE companies ADD COLUMN suspended_reason TEXT;
  CREATE TABLE platform_subscriptions (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK (plan IN ('free', 'hosted', 'founder', 'selfhost')),
    price_eur INTEGER NOT NULL DEFAULT 0,
    seats INTEGER NOT NULL DEFAULT 0,
    period_start TEXT,
    period_end TEXT,
    status TEXT NOT NULL CHECK (status IN ('trial', 'active', 'past_due', 'cancelled')),
    trial_end TEXT,
    invoice_ref TEXT,
    note TEXT NOT NULL DEFAULT '',
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE platform_subscription_history (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    before TEXT,
    after TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX platform_subscription_history_company ON platform_subscription_history(company_id, changed_at);
  `,
  // v16: reserved (wave/perms-fine needs no migration).
  null,
  // v17: personal memory and memory zones (zen-memory v4). Each person has one personal memory
  // (bound to the user, not to a company) and one key per device for it; the hub keeps only ids.
  // A company's memory rules (decisions from company chats go up automatically; sensitive data to
  // the starter's personal memory or dropped), when the zones/access were last sent, and which
  // department/project zones are restricted (only people with a role scoped to them read them;
  // a company-wide "memorie: vede" does not count there).
  `
  CREATE TABLE user_memory (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    memory_person_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE user_memory_keys (
    key_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    machine TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX user_memory_keys_user ON user_memory_keys(user_id, revoked_at);
  ALTER TABLE company_memory ADD COLUMN auto_promote_decisions INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE company_memory ADD COLUMN sensitive_policy TEXT NOT NULL DEFAULT 'personal';
  ALTER TABLE company_memory ADD COLUMN rules_updated_by TEXT;
  ALTER TABLE company_memory ADD COLUMN access_synced_at TEXT;
  CREATE TABLE memory_zone_settings (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    zone_ref TEXT NOT NULL,
    restricted INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_id, zone_ref)
  );
  `,
  // v18: growth (src/growth.ts). Funnel events with no personal data (ids, partner code, UTM and a
  // small JSON meta), a small CRM for leads, partner referral codes (/r/<code>) and the common
  // exclusion list (an e-mail or a whole domain) every sender checks before writing to anyone.
  `
  CREATE TABLE growth_events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('signup', 'company_created', 'invite_sent', 'invite_accepted', 'approval_link_created', 'approval_link_decided', 'first_task', 'payment', 'partner_click', 'download')),
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    partner_code TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    meta TEXT
  );
  CREATE INDEX growth_events_ts ON growth_events(ts);
  CREATE INDEX growth_events_event ON growth_events(event, ts);
  CREATE TABLE growth_leads (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    email TEXT,
    name TEXT,
    company TEXT,
    country TEXT,
    source TEXT,
    stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'qualified', 'meeting', 'won', 'lost', 'opted_out')),
    seats INTEGER,
    owner TEXT,
    notes TEXT,
    next_step_at TEXT,
    consent_basis TEXT,
    last_contact_at TEXT
  );
  CREATE UNIQUE INDEX growth_leads_email ON growth_leads(email) WHERE email IS NOT NULL;
  CREATE INDEX growth_leads_stage ON growth_leads(stage, updated_at);
  CREATE TABLE growth_partner_codes (
    code TEXT PRIMARY KEY,
    partner_name TEXT NOT NULL,
    partner_email TEXT,
    commission_pct INTEGER NOT NULL DEFAULT 20 CHECK (commission_pct BETWEEN 0 AND 100),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE growth_optouts (
    value TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
    reason TEXT,
    source TEXT,
    created_at TEXT NOT NULL
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS hub_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
  const applied = new Set(
    (db.prepare("SELECT version FROM hub_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (applied.has(version) || sql === null) return;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO hub_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return db;
}
