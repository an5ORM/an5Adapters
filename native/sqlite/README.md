# AN5 native SQLite vectors

`an5_vector.c` is a loadable SQLite extension, not a language-driver callback.
It implements all three AN5 metrics in C:

| SQL function | Result (smaller is closer) |
|---|---|
| `an5_vec_cosine(left, right)` | `1 - cosine_similarity` |
| `an5_vec_l2(left, right)` | Euclidean distance |
| `an5_vec_ip(left, right)` | Negative dot product |
| `an5_vector_version()` | Extension identifier |

BLOB inputs are little-endian float32. JSON text arrays are also accepted and
converted to float32, so native results have single-precision input values even
for legacy text columns. Empty, malformed, non-finite and dimension-mismatched
inputs return SQL NULL. Zero vectors have cosine distance 1.

The BLOB path reads the stored bytes directly without allocating a row vector.
The query operand is cached using SQLite auxdata for the statement. x86-64 uses
SSE2 with double-precision accumulators; other architectures use the portable C
loop. No `-march=native`, AVX dependency or fast-math flags are required.

This is **exact scanning**, not an ANN index. A normal relational index on a
filter column can narrow the candidates before distance calculation. Only the
top results are returned to the language runtime.

## Build

In this workspace:

```sh
npm run build:sqlite:native -w an5Adapters
```

The command prints the absolute library path under `native/sqlite/build`.
Linux/macOS need a C compiler and `sqlite3ext.h`; on Debian/Ubuntu install
`build-essential` and `libsqlite3-dev`. `CC` and `SQLITE_INCLUDE_DIR` may be set
when using a different compiler or header directory.

For an installed npm package:

```sh
node node_modules/@an5/adapters/scripts/sqlite-native-build.js ./native-build
```

Windows builds through CMake and an installed C toolchain. The CMake project can
also be used directly on other platforms:

```sh
cmake -S native/sqlite -B native/sqlite/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/sqlite/build --config Release
```

Build for the target OS and architecture. No precompiled binary is downloaded
or compiled during the package's ordinary install.

## Load

The existing extension-path option accepts either sqlite-vec or this library:

```typescript
const db = createAn5Adapter({
  connectionString: 'sqlite:///app.db',
  sqliteVec: '/absolute/path/an5_vector.so', // .dylib / .dll on other platforms
});
await db.table('Document').vectorSearch({ vector: query, take: 10 });
```

```python
db = create_an5_adapter('sqlite:///app.db', sqlite_vec='/absolute/path/an5_vector.so')
```

```csharp
var db = new An5Adapter(new An5AdapterOptions {
    ConnectionString = "app.db",
    SqliteVec = "/absolute/path/an5_vector.so"
});
```

TypeScript, Python, .NET and Swift recognize `an5_vector_version()` before
registering callbacks, preserving the native functions. In the existing strategy
API this uses `udf`; **the functions execute in C**, not in the host language.
On runtimes that take an existing connection/pool, load the extension on every
SQLite connection through the driver's extension-loading API. Go, Rust and JDBC
then discover the `an5_vec_*` functions through their existing probes. Swift's
loading hook is desktop-only; mobile platforms need a statically linked SQLite
extension/build supplied by the application.

Each gate builds the extension itself and checks that the native functions are
still the ones answering: `test:sqlite:native` covers TypeScript, Python and
(optionally) .NET, while `test:swift` builds the extension and runs the same
check through the Swift driver.

## Verify and benchmark

```sh
npm run test:sqlite:native -w an5Adapters
node an5Adapters/scripts/sqlite-native-test.js --dotnet
AN5_NATIVE_SANITIZE=1 npm run test:sqlite:native -w an5Adapters
npm run bench:sqlite:native -w an5Adapters
```

The native test compiles into a disposable directory, tests the extension with
real SQLite, checks all metrics against the reference implementation, and verifies
that TypeScript and Python keep the C functions. `--dotnet` additionally tests
.NET. The sanitizer option enables UBSan on supporting Unix compilers.

`npm run test:swift -w an5Adapters` builds the extension too and asserts the
Swift driver keeps it; that case is skipped when `AN5_NATIVE_VECTOR_PATH` is
unset, as on a machine without a C compiler.

The benchmark compares the public adapter's native and JavaScript-UDF paths with
identical BLOB data and verifies equal top-10 IDs. It reports the median of seven
warmed runs over 4,000 vectors of 256 dimensions. On the development Linux x86-64
machine the native path measured about 4 ms per search versus 15–18 ms for the
JavaScript callback (roughly 4x faster). Timings are illustrative, not pass/fail
thresholds or a performance guarantee.
