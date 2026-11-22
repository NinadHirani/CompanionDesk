'use strict';

// The app is a general assistant. Student tools (syllabus import, course
// deadlines, grades) are ONE optional skill: active only when there is course
// data AND the user has not switched it off. A fresh install has no active
// skills and behaves as a plain assistant. Pure: takes the database and the
// typed settings as arguments.

const PERSONAL_COURSE = 'Personal'; // holds deadlines the user typed in, not a real course

function hasCourseData(db) {
  return db.listCourses().some((c) => c.name !== PERSONAL_COURSE);
}

// The user may switch the student tools off entirely (settings.student_module).
function studentEnabled(settings) {
  return settings.student_module !== 'off';
}

function studentActive(db, settings) {
  return studentEnabled(settings) && hasCourseData(db);
}

function activeSkills(db, settings) {
  return studentActive(db, settings) ? ['student'] : [];
}

module.exports = { PERSONAL_COURSE, hasCourseData, studentEnabled, studentActive, activeSkills };
