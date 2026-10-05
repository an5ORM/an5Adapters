#ifndef AN5_CSQLITE_SHIM_H
#define AN5_CSQLITE_SHIM_H

/* The system SQLite's own header. A module map needs one header to anchor the module to;
   re-declaring the handful of functions AN5 calls here would let the compiler accept a
   signature the installed library does not have. */
#include <sqlite3.h>

#endif /* AN5_CSQLITE_SHIM_H */