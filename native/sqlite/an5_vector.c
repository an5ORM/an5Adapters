/* Portable SQLite extension for float32 vector distances. No driver callbacks.
 * BLOB inputs are little-endian float32; JSON arrays remain readable.
 * Query vectors use SQLite auxdata so parsing/copying happens once per statement.
 */
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#if defined(__SSE2__)
#include <emmintrin.h>
#endif

typedef struct {
  const unsigned char *bytes;
  float *owned;
  int count;
} Vector;

static void release_vector(void *ptr) {
  Vector *v = (Vector *)ptr;
  if (v) { sqlite3_free(v->owned); sqlite3_free(v); }
}

static int whitespace(unsigned char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

/* Validate JSON number grammar before using strtod, which otherwise accepts
 * non-JSON spellings such as NaN, Infinity and hexadecimal numbers. */
static const unsigned char *number_end(const unsigned char *p, const unsigned char *end) {
  if (p < end && *p == '-') ++p;
  if (p == end) return NULL;
  if (*p == '0') ++p;
  else {
    if (*p < '1' || *p > '9') return NULL;
    do { ++p; } while (p < end && *p >= '0' && *p <= '9');
  }
  if (p < end && *p == '.') {
    ++p;
    if (p == end || *p < '0' || *p > '9') return NULL;
    do { ++p; } while (p < end && *p >= '0' && *p <= '9');
  }
  if (p < end && (*p == 'e' || *p == 'E')) {
    ++p;
    if (p < end && (*p == '+' || *p == '-')) ++p;
    if (p == end || *p < '0' || *p > '9') return NULL;
    do { ++p; } while (p < end && *p >= '0' && *p <= '9');
  }
  return p;
}

/* 1 = vector, 0 = invalid input, -1 = allocation failure. */
static int read_vector(sqlite3_value *arg, Vector *v, int copy_blob) {
  memset(v, 0, sizeof(*v));
  if (sqlite3_value_type(arg) == SQLITE_BLOB) {
    int size = sqlite3_value_bytes(arg);
    if (!size || size % 4) return 0;
    v->count = size / 4;
    v->bytes = sqlite3_value_blob(arg);
    if (!v->bytes) return -1;
    if (copy_blob) {
      v->owned = sqlite3_malloc64((sqlite3_uint64)size);
      if (!v->owned) return -1;
      memcpy(v->owned, v->bytes, (size_t)size);
      v->bytes = (const unsigned char *)v->owned;
    }
    return 1;
  }
  if (sqlite3_value_type(arg) != SQLITE_TEXT) return 0;
  const unsigned char *p = sqlite3_value_text(arg);
  if (!p) return -1;
  const unsigned char *end = p + sqlite3_value_bytes(arg);
  while (p < end && whitespace(*p)) ++p;
  if (p == end || *p++ != '[') return 0;
  int capacity = 0;
  for (;;) {
    while (p < end && whitespace(*p)) ++p;
    const unsigned char *next = number_end(p, end);
    if (!next) goto invalid;
    char *parsed;
    double n = strtod((const char *)p, &parsed);
    if ((const unsigned char *)parsed != next || !isfinite(n) || !isfinite((float)n)) goto invalid;
    if (v->count == capacity) {
      if (capacity > 0x3fffffff) goto invalid;
      capacity = capacity ? capacity * 2 : 32;
      float *grown = sqlite3_realloc64(v->owned, (sqlite3_uint64)capacity * sizeof(float));
      if (!grown) { sqlite3_free(v->owned); v->owned = NULL; return -1; }
      v->owned = grown;
    }
    v->owned[v->count++] = (float)n;
    p = next;
    while (p < end && whitespace(*p)) ++p;
    if (p == end) goto invalid;
    if (*p == ']') { ++p; break; }
    if (*p++ != ',') goto invalid;
  }
  while (p < end && whitespace(*p)) ++p;
  if (p != end) goto invalid;
  return 1;
invalid:
  sqlite3_free(v->owned);
  v->owned = NULL;
  return 0;
}

static float element(const Vector *v, int i) {
  if (!v->bytes) return v->owned[i];
  const unsigned char *p = v->bytes + (size_t)i * 4;
  uint32_t bits = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
      ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
  float value;
  memcpy(&value, &bits, sizeof(value));
  return value;
}

static int score(const Vector *a, const Vector *b, int metric, double *out) {
  if (!a->count || a->count != b->count) return 0;
  double dot = 0, norm_a = 0, norm_b = 0, squared = 0;
  int i = 0;
#if defined(__SSE2__)
  /* SSE2 is baseline on x86-64. Accumulate pairs in double precision; element()
   * handles unaligned BLOB bytes and little-endian decoding before packing. */
  if (a->bytes && b->bytes) {
    __m128d d = _mm_setzero_pd(), na = d, nb = d, sq = d;
    for (; i + 1 < a->count; i += 2) {
      float af[2] = { element(a, i), element(a, i + 1) };
      float bf[2] = { element(b, i), element(b, i + 1) };
      if (!isfinite(af[0]) || !isfinite(af[1]) || !isfinite(bf[0]) || !isfinite(bf[1])) return 0;
      __m128d av = _mm_set_pd(af[1], af[0]), bv = _mm_set_pd(bf[1], bf[0]);
      if (metric == 1) {
        __m128d delta = _mm_sub_pd(av, bv);
        sq = _mm_add_pd(sq, _mm_mul_pd(delta, delta));
      } else {
        d = _mm_add_pd(d, _mm_mul_pd(av, bv));
        if (metric == 0) {
          na = _mm_add_pd(na, _mm_mul_pd(av, av));
          nb = _mm_add_pd(nb, _mm_mul_pd(bv, bv));
        }
      }
    }
    double lanes[2];
    _mm_storeu_pd(lanes, d); dot = lanes[0] + lanes[1];
    _mm_storeu_pd(lanes, na); norm_a = lanes[0] + lanes[1];
    _mm_storeu_pd(lanes, nb); norm_b = lanes[0] + lanes[1];
    _mm_storeu_pd(lanes, sq); squared = lanes[0] + lanes[1];
  }
#endif
  for (; i < a->count; ++i) {
    double av = element(a, i), bv = element(b, i);
    if (!isfinite(av) || !isfinite(bv)) return 0;
    if (metric == 1) { double delta = av - bv; squared += delta * delta; }
    else {
      dot += av * bv;
      if (metric == 0) { norm_a += av * av; norm_b += bv * bv; }
    }
  }
  *out = metric == 1 ? sqrt(squared) : metric == 2 ? -dot :
      norm_a && norm_b ? 1.0 - dot / (sqrt(norm_a) * sqrt(norm_b)) : 1.0;
  return 1;
}

static void distance(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  Vector left;
  int status = read_vector(argv[0], &left, 0);
  if (status != 1) { if (status < 0) sqlite3_result_error_nomem(ctx); return; }
  Vector *right = sqlite3_get_auxdata(ctx, 1);
  int fresh = !right;
  if (fresh) {
    right = sqlite3_malloc64(sizeof(*right));
    if (!right) { sqlite3_free(left.owned); sqlite3_result_error_nomem(ctx); return; }
    status = read_vector(argv[1], right, 1);
    if (status != 1) {
      release_vector(right); sqlite3_free(left.owned);
      if (status < 0) sqlite3_result_error_nomem(ctx);
      return;
    }
  }
  double value;
  if (score(&left, right, (int)(intptr_t)sqlite3_user_data(ctx), &value)) sqlite3_result_double(ctx, value);
  sqlite3_free(left.owned);
  /* set_auxdata may immediately destroy the value: nothing accesses it after this. */
  if (fresh) sqlite3_set_auxdata(ctx, 1, right, release_vector);
}

static void version(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_text(ctx, "an5-vector/1", -1, SQLITE_STATIC);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  const char *names[] = { "an5_vec_cosine", "an5_vec_l2", "an5_vec_ip" };
  int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC;
#ifdef SQLITE_INNOCUOUS
  flags |= SQLITE_INNOCUOUS;
#endif
  for (int i = 0; i < 3; ++i) {
    int rc = sqlite3_create_function_v2(db, names[i], 2, flags, (void *)(intptr_t)i, distance, NULL, NULL, NULL);
    if (rc != SQLITE_OK) return rc;
  }
  return sqlite3_create_function_v2(db, "an5_vector_version", 0, flags, NULL, version, NULL, NULL, NULL);
}
