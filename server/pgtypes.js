// Postgres type parsers. Required before any query runs.
//
// node-postgres' defaults would silently change the shapes the app has always
// used, so each of these is load-bearing:
//
//   date (1082)        -> default parses "2026-07-08" into a JS Date at LOCAL
//                         midnight. Serializing that back can land on the
//                         previous day west of UTC, so invoice/due dates would
//                         drift by one. Keep the raw "YYYY-MM-DD" string.
//   timestamptz (1184) -> default gives a Date; the app stores and compares ISO
//                         strings everywhere (updatedAt >= pdf.updatedAt, etc).
//   numeric (1700)     -> default gives a STRING to preserve arbitrary
//                         precision. Money would become "2099.00" and then
//                         "2099.00" + 5 = "2099.005". Convert to Number, which
//                         matches the previous JSON behavior exactly.
//   int8 (20)          -> count(*) returns a string; make it a number.
const types = require('pg').types;

types.setTypeParser(1082, (v) => v);                                  // date
types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString())); // timestamptz
types.setTypeParser(1114, (v) => (v === null ? null : new Date(v + 'Z').toISOString())); // timestamp
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));    // numeric
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));      // int8

module.exports = {};
