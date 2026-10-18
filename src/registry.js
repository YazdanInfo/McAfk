'use strict';
// Shared runtime namespace. Every module registers its top-level names here (Object.assign at its end) and reads other
// modules' names from it. S holds the few mutable variables that several modules assign (shutting down, saved-data flags...).
// Modules load in the order index.js requires them: a name from an EARLIER module is destructured at the top of a module,
// a name from a LATER one is read as R.name when it is used (late-bound, so call order never matters).
const R = { S: {} };
module.exports = R;
