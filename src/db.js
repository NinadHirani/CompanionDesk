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
      const SQL = await initSqlJs();
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
      if (initial && initial.length) db.db = new SQL.Database(new Uint8Array(initial));
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
         ORDER BY a.due_date, c.name`,
        [todayIso, horizonEndIso]
      );
    }

    listCourses() {
      return this.all('SELECT * FROM courses ORDER BY name');
    }

    counts() {
      const c = this.all('SELECT COUNT(*) AS n FROM courses')[0].n;
      const a = this.all('SELECT COUNT(*) AS n FROM assignments')[0].n;
      return { courses: c, assignments: a };
    }
  }

  return LocalDb;
});
