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
`;

  // Filesystem saver: the desktop default. Writes only on flush, never on
  // every query, so a failed write leaves the previous file intact.
  function fsSaver(file) {
    return {
      save(bytes) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(bytes));
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
      this._persistTimer = setTimeout(() => this.flush(), PERSIST_DELAY_MS);
    }

    flush() {
      if (!this.saver) return;
      if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
      const bytes = this.db.export();
      const result = this.saver.save(bytes);
      if (result && typeof result.catch === 'function') result.catch(() => { /* async saver failure is non-fatal */ });
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
