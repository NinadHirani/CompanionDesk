'use strict';

// Local SQLite persistence via sql.js (WASM SQLite). No native modules and no
// server: the whole database is a single file in the app's userData directory
// (Electron) or an IndexedDB record (web/mobile build), exported and written
// back with a short debounce after each write. Open without a file or storage
// for an in-memory database (used by tests).
// Dual-mode: require() in Electron/Node, plain <script> in the web build
// (window.CompanionDb). Storage is pluggable: pass { load, save } to open()
// for a non-filesystem backend.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionDb = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  let fs = null;
  let path = null;
  let initSqlJsNode = null;
  if (typeof require === 'function') {
    fs = require('fs');
    path = require('path');
    initSqlJsNode = require('sql.js');
  }

  const PERSIST_DELAY_MS = 100;

  const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  credit_hours REAL,
  term TEXT,
  source_file TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS grade_weights (
  id INTEGER PRIMARY KEY,
  course_id INTEGER REFERENCES courses(id),
  category TEXT NOT NULL,
  weight_pct REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  course_id INTEGER REFERENCES courses(id),
  title TEXT NOT NULL,
  due_date TEXT,
  date_confidence TEXT DEFAULT 'extracted',
  category TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER REFERENCES assignments(id),
  course_id INTEGER REFERENCES courses(id),
  title TEXT NOT NULL,
  due_date TEXT,
  done INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  assignment_id INTEGER,
  course_id INTEGER,
  due_date TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
  assignment_id INTEGER PRIMARY KEY,
  score_pct REAL NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendars (
  name TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  events_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, id);

-- Gate 2 agent foundation state. Additive only: every statement is
-- CREATE TABLE IF NOT EXISTS, so an existing database gains these tables on
-- the next open and no existing table or row is touched.
CREATE TABLE IF NOT EXISTS agent_grants (
  tool TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_audit (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  tool TEXT,
  decision TEXT,
  reason TEXT,
  grant_id TEXT,
  approval_id TEXT,
  detail_json TEXT,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_audit_anchor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_seq INTEGER NOT NULL,
  base_hash TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  last_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_emergency_stop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  activated_at TEXT,
  activated_by TEXT,
  reset_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  run_id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS agent_notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
-- M5 slice 1: schedules the USER set through the product surface. Fired
-- exactly once; quiet hours defer, never drop (see src/agent-scheduler.js).
CREATE TABLE IF NOT EXISTS agent_schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  deferred_to INTEGER,
  fired_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_schedule_scopes (
  scope TEXT PRIMARY KEY,
  paused INTEGER NOT NULL
);
-- Schema version stamp (agent persistence). One row, key 'version'. An
-- unversioned database is stamped additively on load; a database written by
-- a NEWER build is never read, downgraded or repaired by an older one.
CREATE TABLE IF NOT EXISTS agent_schema (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

  // Filesystem saver: the desktop default. Writes only on flush, never on
  // every query, so a failed write leaves the previous file intact.
  function fsSaver(file) {
    return {
      save(bytes) {
        // Atomic swap with a process-unique temp file, then rename over the
        // target. A crash or power loss mid-write leaves the PREVIOUS file
        // intact; the live store is only ever replaced whole. POSIX rename
        // replaces the target atomically; on Windows the same overwrite
        // semantics apply, but an antivirus or backup tool holding the file
        // can surface EPERM/EACCES, so a couple of quick retries happen.
        // If the rename still cannot replace the target, we FAIL CLOSED:
        // the previous file stays byte-for-byte intact, the temp file is
        // removed, and a sanitized persistence error is thrown. Atomicity
        // is never traded for availability: there is deliberately NO
        // in-place write of the target, because a crash during one could
        // corrupt the previously valid store and file-level verification
        // cannot resurrect a torn SQLite image. Callers treat the failure
        // as a persist failure and the runtime blocks until a verified
        // restart. Error messages carry error codes only: no paths, no
        // file contents.
        let tmp = null;
        try {
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
          } catch (err) {
            throw new Error('persist_failed_write (' + String((err && err.code) || 'write_failed') + ')');
          }
          tmp = file + '.' + process.pid + '.tmp';
          try {
            fs.writeFileSync(tmp, Buffer.from(bytes));
          } catch (err) {
            throw new Error('persist_failed_write (' + String((err && err.code) || 'write_failed') + ')');
          }
          try {
            fs.renameSync(tmp, file);
          } catch (err) {
            const code = err && err.code;
            if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') {
              throw new Error('persist_failed_write (' + String(code || 'write_failed') + ')');
            }
            let renamed = false;
            let lastCode = String(code);
            for (let i = 0; i < 2 && !renamed; i++) {
              try { fs.renameSync(tmp, file); renamed = true; } catch (err2) { lastCode = String((err2 && err2.code) || 'rename_failed'); }
            }
            if (!renamed) {
              // Fail closed: never write the target in place. The old file
              // is untouched; the caller blocks or retries.
              throw new Error('persist_failed_rename (' + lastCode + ')');
            }
          }
        } finally {
          if (tmp) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err3) { /* cleanup is best effort */ } }
        }
      },
    };
  }

  class LocalDb {
    constructor(SQL, saver) {
      this.db = new SQL.Database();
      this.saver = saver || null;
      this.db.exec(SCHEMA);
      this._persistTimer = null;
    }

    static async open({ file = null, storage = null } = {}) {
      const initSqlJs = initSqlJsNode || (typeof globalThis.initSqlJs === 'function' ? globalThis.initSqlJs : null);
      if (!initSqlJs) throw new Error('sql.js unavailable: load dist/sql-wasm.js before opening the database');
      const SQL = await initSqlJs(initSqlJsNode ? {} : {
        locateFile: (f) => (typeof location !== 'undefined' ? new URL('vendor/' + f, location.href).href : f),
      });
      let initial = null;
      let saver = null;
      if (storage) {
        saver = storage;
        initial = await storage.load();
      } else if (file) {
        if (fs && fs.existsSync(file)) initial = fs.readFileSync(file);
        saver = fsSaver(file);
      }
      const db = new LocalDb(SQL, saver);
      if (initial && initial.length) {
        db.db = new SQL.Database(new Uint8Array(initial));
        // The constructor only prepared a throwaway empty database. Apply the
        // schema to the loaded one as well so tables added in a newer app
        // version exist for people who already have a saved database. Every
        // statement is CREATE TABLE IF NOT EXISTS, so existing data is untouched.
        db.db.exec(SCHEMA);
      }
      return db;
    }

    persist() {
      if (!this.saver) return;
      if (this._persistTimer) clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => {
        try {
          this.flush();
        } catch (err) {
          // Bounded report: error code only, no paths or file contents.
          console.error('local store flush failed (' + String((err && err.code) || (err && err.message) || 'unknown') + ')');
        }
      }, PERSIST_DELAY_MS);
    }

    flush() {
      if (!this.saver) return;
      if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
      const bytes = this.db.export();
      const result = this.saver.save(bytes);
      if (result && typeof result.catch === 'function') result.catch(() => { /* async saver failure is non-fatal */ });
    }

    // Release the underlying WASM database and cancel any pending delayed
    // write. Best effort by design: after close() the instance must not be
    // used, and callers only close a store they are about to stop using
    // (app quit, or the agent runtime's fail-closed shutdown).
    close() {
      if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
      try { if (this.db && typeof this.db.close === 'function') this.db.close(); } catch (err) { /* already closed */ }
      this.db = null;
    }

    run(sql, params = []) {
      this.db.run(sql, params);
    }

    all(sql, params = []) {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }

    lastId() {
      return this.all('SELECT last_insert_rowid() AS id')[0].id;
    }

    upsertCourse({ name, code = null, credit_hours = null, term = null, source_file = null }) {
      const found = this.all(
        "SELECT id FROM courses WHERE name = ? AND IFNULL(code, '') = IFNULL(?, '')",
        [name, code]
      );
      let id;
      if (found.length) {
        id = found[0].id;
        this.run(
          'UPDATE courses SET term = IFNULL(?, term), source_file = IFNULL(?, source_file) WHERE id = ?',
          [term, source_file, id]
        );
      } else {
        this.run(
          'INSERT INTO courses (name, code, credit_hours, term, source_file) VALUES (?, ?, ?, ?, ?)',
          [name, code, credit_hours, term, source_file]
        );
        id = this.lastId();
      }
      this.persist();
      return id;
    }

    // Rename or re-code a course. Returns the updated row, or null when the
    // id does not exist. The source_file is left alone: it records where the
    // course came from, not what it is called now.
    updateCourse(id, { name, code, credit_hours, term }) {
      if (!this.all('SELECT id FROM courses WHERE id = ?', [id]).length) return null;
      this.run(
        'UPDATE courses SET name = ?, code = ?, credit_hours = ?, term = ? WHERE id = ?',
        [name, code || null, credit_hours === undefined ? null : credit_hours, term || null, id]
      );
      this.persist();
      return this.all('SELECT * FROM courses WHERE id = ?', [id])[0];
    }

    // Remove a course and everything that belongs to it: its assignments,
    // the scores on those assignments, grade weights, tasks, activity events
    // and the saved grade target. Nothing else in the store references a
    // course, so the removal is complete. Returns the counts of what was
    // removed so the UI can say what happened, or null when the id does not
    // exist. This is deliberate, user-asked deletion; the caller confirms.
    removeCourse(id) {
      if (!this.all('SELECT id FROM courses WHERE id = ?', [id]).length) return null;
      const removed = { assignments: this.all('SELECT COUNT(*) AS n FROM assignments WHERE course_id = ?', [id])[0].n };
      this.run('DELETE FROM scores WHERE assignment_id IN (SELECT id FROM assignments WHERE course_id = ?)', [id]);
      this.run('DELETE FROM tasks WHERE course_id = ?', [id]);
      this.run('DELETE FROM events WHERE course_id = ? OR assignment_id IN (SELECT id FROM assignments WHERE course_id = ?)', [id, id]);
      this.run('DELETE FROM assignments WHERE course_id = ?', [id]);
      this.run('DELETE FROM grade_weights WHERE course_id = ?', [id]);
      this.run('DELETE FROM settings WHERE key = ?', ['target_' + id]);
      this.run('DELETE FROM courses WHERE id = ?', [id]);
      this.persist();
      return removed;
    }

    setGradeWeights(courseId, weights) {
      this.run('DELETE FROM grade_weights WHERE course_id = ?', [courseId]);
      for (const w of weights) {
        this.run('INSERT INTO grade_weights (course_id, category, weight_pct) VALUES (?, ?, ?)', [
          courseId, w.category, w.weight_pct,
        ]);
      }
      this.persist();
    }

    listGradeWeights(courseId) {
      return this.all('SELECT category, weight_pct FROM grade_weights WHERE course_id = ? ORDER BY id', [courseId]);
    }

    clearAssignments(courseId) {
      this.run('DELETE FROM scores WHERE assignment_id IN (SELECT id FROM assignments WHERE course_id = ?)', [courseId]);
      this.run('DELETE FROM assignments WHERE course_id = ?', [courseId]);
      this.persist();
    }

    // Re-import refresh: sync a course's syllabus-sourced assignments with a
    // fresh extraction without touching anything the user added by hand.
    // Assignments are matched by title, case- and whitespace-insensitive: a
    // match keeps its row id (so its scores survive) and gets its date,
    // category and date confidence re-set; a title the new syllabus no
    // longer lists is removed, unless the user added that deadline by hand.
    // Returns { added, updated, removed } counts.
    refreshCourseAssignments(courseId, assignments) {
      const norm = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const rows = this.all('SELECT id, title, date_confidence FROM assignments WHERE course_id = ?', [courseId]);
      const stale = new Map();
      for (const r of rows) {
        if (r.date_confidence === 'manual') continue;
        stale.set(norm(r.title), r);
      }
      const seen = new Set();
      let added = 0, updated = 0;
      for (const a of assignments || []) {
        const key = norm(a.title);
        seen.add(key);
        const existing = stale.get(key);
        if (existing) {
          this.run('UPDATE assignments SET due_date = ?, category = ?, date_confidence = ? WHERE id = ?',
            [a.due_date || null, a.category || null, a.date_confidence || 'extracted', existing.id]);
          stale.delete(key);
          updated++;
        } else {
          this.run('INSERT INTO assignments (course_id, title, due_date, date_confidence, category) VALUES (?, ?, ?, ?, ?)',
            [courseId, a.title, a.due_date || null, a.date_confidence || 'extracted', a.category || null]);
          added++;
        }
      }
      let removed = 0;
      for (const r of stale.values()) {
        this.run('DELETE FROM scores WHERE assignment_id = ?', [r.id]);
        this.run('DELETE FROM assignments WHERE id = ?', [r.id]);
        removed++;
      }
      this.persist();
      return { added, updated, removed };
    }

    addAssignment(courseId, { title, due_date, category, date_confidence }) {
      this.run(
        "INSERT INTO assignments (course_id, title, due_date, date_confidence, category) VALUES (?, ?, ?, ?, ?)",
        [courseId, title, due_date || null, date_confidence || 'extracted', category || null]
      );
      this.persist();
      return this.lastId();
    }

    // Only deadlines the user added by hand can be removed this way; anything
    // extracted from a syllabus is left alone. Returns true when a row was removed.
    removeManualAssignment(id) {
      const rows = this.all("SELECT id FROM assignments WHERE id = ? AND date_confidence = 'manual'", [id]);
      if (!rows.length) return false;
      this.run('DELETE FROM assignments WHERE id = ?', [id]);
      this.persist();
      return true;
    }

    // Edit a deadline the user added by hand: title, date and the exam tag
    // can change. The same manual-only boundary removeManualAssignment
    // enforces applies here, so an assignment extracted from a syllabus is
    // never touched by this path. Returns the updated row, or null when the
    // id is not a hand-added deadline.
    updateManualAssignment(id, { title, due_date, category }) {
      const rows = this.all("SELECT id FROM assignments WHERE id = ? AND date_confidence = 'manual'", [id]);
      if (!rows.length) return null;
      this.run(
        'UPDATE assignments SET title = ?, due_date = ?, category = ? WHERE id = ?',
        [title, due_date || null, category || null, id]
      );
      this.persist();
      return this.getAssignment(id);
    }

    listAssignments(courseId) {
      return this.all(
        'SELECT * FROM assignments WHERE course_id = ? ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, title',
        [courseId]
      );
    }

    // "What's due": dated assignments inside the inclusive window [todayIso, horizonEndIso].
    listDue(todayIso, horizonEndIso) {
      return this.all(
        `SELECT a.id, a.title, a.due_date, a.date_confidence, a.category, c.name AS course_name
         FROM assignments a JOIN courses c ON c.id = a.course_id
         WHERE a.due_date IS NOT NULL AND a.due_date >= ? AND a.due_date <= ?
           AND IFNULL(a.status, 'pending') != 'done'
         ORDER BY a.due_date, c.name`,
        [todayIso, horizonEndIso]
      );
    }

    listCourses() {
      return this.all('SELECT * FROM courses ORDER BY name');
    }

    // Every unfinished assignment with its course, dated or not, for the daily
    // brief. The brief itself decides which rows are trustworthy.
    listBriefRows() {
      // weight_pct is only filled when the assignment's category exactly matches
      // (ignoring case) a grading category from the syllabus. No fuzzy matching:
      // a missing weight stays null rather than being guessed.
      return this.all(
        `SELECT a.id, a.course_id, a.title, a.due_date, a.date_confidence, a.category, a.status,
                c.name AS course_name,
                (SELECT g.weight_pct FROM grade_weights g
                  WHERE g.course_id = a.course_id AND a.category IS NOT NULL
                    AND lower(trim(g.category)) = lower(trim(a.category)) LIMIT 1) AS weight_pct
         FROM assignments a JOIN courses c ON c.id = a.course_id
         WHERE IFNULL(a.status, 'pending') != 'done'
         ORDER BY CASE WHEN a.due_date IS NULL THEN 1 ELSE 0 END, a.due_date, c.name, a.title`
      );
    }

    getAssignment(id) {
      const rows = this.all(
        `SELECT a.id, a.course_id, a.title, a.due_date, a.date_confidence, a.category, a.status,
                c.name AS course_name
         FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?`,
        [id]
      );
      return rows[0] || null;
    }

    // Returns the updated row, or null when the id does not exist.
    setAssignmentStatus(id, status) {
      if (status !== 'pending' && status !== 'done') throw new Error('invalid_status');
      if (!this.getAssignment(id)) return null;
      this.run('UPDATE assignments SET status = ? WHERE id = ?', [status, id]);
      this.persist();
      return this.getAssignment(id);
    }

    // ---- scores the user has entered for graded work ----------------------
    // Fix the grading category on one assignment (syllabus extraction gets
    // it wrong sometimes). Passing null puts it back to uncategorized, which
    // is how an assignment is left out of the grade. Returns the updated
    // row, or null when the id does not exist.
    setAssignmentCategory(assignmentId, category) {
      if (!this.all('SELECT id FROM assignments WHERE id = ?', [assignmentId]).length) return null;
      this.run('UPDATE assignments SET category = ? WHERE id = ?', [category || null, assignmentId]);
      this.persist();
      return this.all('SELECT * FROM assignments WHERE id = ?', [assignmentId])[0];
    }

    setScore(assignmentId, scorePct, recordedAt) {
      this.run(
        'INSERT INTO scores (assignment_id, score_pct, recorded_at) VALUES (?, ?, ?) ON CONFLICT(assignment_id) DO UPDATE SET score_pct = excluded.score_pct, recorded_at = excluded.recorded_at',
        [assignmentId, scorePct, recordedAt]
      );
      this.persist();
    }

    clearScore(assignmentId) {
      this.run('DELETE FROM scores WHERE assignment_id = ?', [assignmentId]);
      this.persist();
    }

    // { [assignmentId]: percent } for one course.
    scoresForCourse(courseId) {
      const out = {};
      for (const r of this.all(
        'SELECT s.assignment_id, s.score_pct FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE a.course_id = ?',
        [courseId]
      )) out[r.assignment_id] = r.score_pct;
      return out;
    }

    // ---- imported calendars (.ics), stored as parsed JSON -------------------
    saveCalendar(name, importedAt, events) {
      this.run(
        'INSERT INTO calendars (name, imported_at, events_json) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET imported_at = excluded.imported_at, events_json = excluded.events_json',
        [name, importedAt, JSON.stringify(events)]
      );
      this.persist();
    }

    listCalendars() {
      return this.all('SELECT name, imported_at, events_json FROM calendars ORDER BY name').map((r) => ({
        name: r.name, imported_at: r.imported_at, events: JSON.parse(r.events_json),
      }));
    }

    removeCalendar(name) {
      const had = this.all('SELECT name FROM calendars WHERE name = ?', [name]).length > 0;
      this.run('DELETE FROM calendars WHERE name = ?', [name]);
      this.persist();
      return had;
    }

    // ---- settings: small key/value strings --------------------------------
    getSetting(key, fallback = null) {
      const rows = this.all('SELECT value FROM settings WHERE key = ?', [key]);
      return rows.length ? rows[0].value : fallback;
    }

    setSetting(key, value) {
      this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
        key, String(value),
      ]);
      this.persist();
    }

    allSettings() {
      const out = {};
      for (const r of this.all('SELECT key, value FROM settings')) out[r.key] = r.value;
      return out;
    }

    // ---- activity log: what the user did, used only for local patterns ----
    addEvent({ kind, assignment_id = null, course_id = null, due_date = null, at }) {
      this.run('INSERT INTO events (kind, assignment_id, course_id, due_date, at) VALUES (?, ?, ?, ?, ?)', [
        kind, assignment_id, course_id, due_date, at,
      ]);
      this.persist();
      return this.lastId();
    }

    listEvents(kind = null) {
      return kind
        ? this.all('SELECT * FROM events WHERE kind = ? ORDER BY id', [kind])
        : this.all('SELECT * FROM events ORDER BY id');
    }

    clearEvents() {
      this.run('DELETE FROM events');
      this.persist();
    }

    // Withdraw one kind of event for one assignment (e.g. when a finished item
    // is un-marked, so it no longer counts toward patterns).
    removeEvents(kind, assignmentId) {
      this.run('DELETE FROM events WHERE kind = ? AND assignment_id = ?', [kind, assignmentId]);
      this.persist();
    }

    // ---- memory proposals: suggestions that need the user's approval -------
    addProposal({ section, text, created_at }) {
      this.run('INSERT INTO memory_proposals (section, text, created_at) VALUES (?, ?, ?)', [section, text, created_at]);
      this.persist();
      return this.lastId();
    }

    listProposals(status = 'pending') {
      return this.all('SELECT * FROM memory_proposals WHERE status = ? ORDER BY id', [status]);
    }

    getProposal(id) {
      const rows = this.all('SELECT * FROM memory_proposals WHERE id = ?', [id]);
      return rows[0] || null;
    }

    decideProposal(id, status) {
      if (status !== 'approved' && status !== 'rejected') throw new Error('invalid_status');
      this.run("UPDATE memory_proposals SET status = ? WHERE id = ? AND status = 'pending'", [status, id]);
      this.persist();
      return this.getProposal(id);
    }

    counts() {
      const c = this.all('SELECT COUNT(*) AS n FROM courses')[0].n;
      const a = this.all('SELECT COUNT(*) AS n FROM assignments')[0].n;
      return { courses: c, assignments: a };
    }
  }

  return LocalDb;
});
