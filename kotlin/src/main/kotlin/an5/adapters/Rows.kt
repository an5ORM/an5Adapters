package an5.adapters

import java.math.BigDecimal
import java.sql.Timestamp
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID

/**
 * Typed reads off a row.
 *
 * A column comes back from JDBC as whatever the driver decided: an `INT` may arrive as
 * `Integer`, `Long` or `BigDecimal` depending on the driver and the declared width, and a
 * `NUMERIC` column that fits in a `Long` still arrives as `BigDecimal`. These accessors
 * take any of them, so generated client code never has to cast — and never silently
 * truncates a decimal on the way.
 */

/** The column's value as a [String], or `null` when it is `NULL`. */
fun Row.string(column: String): String? = this[column]?.toString()

/** The column's value as an [Int], or [fallback] when it is `NULL`. */
fun Row.int(column: String, fallback: Int = 0): Int = number(column)?.toInt() ?: fallback

/** The column's value as a [Long], or [fallback] when it is `NULL`. */
fun Row.long(column: String, fallback: Long = 0L): Long = number(column)?.toLong() ?: fallback

/** The column's value as a [Double], or [fallback] when it is `NULL`. */
fun Row.double(column: String, fallback: Double = 0.0): Double = number(column)?.toDouble() ?: fallback

/** The column's value as a [Boolean]; `NULL` reads as [fallback]. */
fun Row.bool(column: String, fallback: Boolean = false): Boolean =
    when (val value = this[column]) {
        null -> fallback
        is Boolean -> value
        is Number -> value.toInt() != 0
        else -> value.toString().toBooleanStrictOrNull() ?: fallback
    }

/** The column's value as a [ByteArray], or `null` when it is `NULL` or not binary. */
fun Row.bytes(column: String): ByteArray? = this[column] as? ByteArray

/** The column's value boxed, or [fallback] when it is `NULL`. */
@Suppress("UNCHECKED_CAST")
fun <T : Any> Row.valueOr(column: String, fallback: T): T = (this[column] as? T) ?: fallback

/** The column's value, or `null` when it is `NULL`. */
@Suppress("UNCHECKED_CAST")
fun <T> Row.value(column: String): T? = this[column] as? T

/** The eager-loaded relation rows under [relation], or an empty list. */
@Suppress("UNCHECKED_CAST")
fun Row.related(relation: String): List<Row> = (this[relation] as? List<Row>) ?: emptyList()

/** The eager-loaded single relation under [relation], or `null`. */
@Suppress("UNCHECKED_CAST")
fun Row.relatedOne(relation: String): Row? = this[relation] as? Row

/** The `_count` totals for a query that asked for them. */
fun Row.relationCount(relation: String): Int =
    ((this["_count"] as? Map<*, *>)?.get(relation) as? Number)?.toInt() ?: 0

/**
 * Copies the row into a data class.
 *
 * ```
 * data class User(val id: String, val name: String?)
 * fun Row.toUser() = User(string("id")!!, string("name"))
 * ```
 */
inline fun <T> Row.decode(transform: Row.() -> T): T = transform()

private fun Row.number(column: String): Number? = when (val value = this[column]) {
    null -> null
    is Number -> value
    is Boolean -> if (value) 1 else 0
    else -> value.toString().trim().toDoubleOrNull()
}
// ─── Nullable reads ────────────────────────────────────────────────────────────────
//
// The `*OrNull` family, for a generated model whose column is optional: a nullable column
// that read as `0` or `""` would write the default back on the next update instead of
// leaving it alone.

/** The column's value as a [String], or `null` when it is `NULL` or missing. */
fun Row.stringOrNull(column: String): String? = this[column]?.toString()

/** The column's value as an [Int], or `null` when it is `NULL`, missing or not numeric. */
fun Row.intOrNull(column: String): Int? = asNumber(column)?.toInt()

/** The column's value as a [Long], or `null` when it is `NULL`, missing or not numeric. */
fun Row.longOrNull(column: String): Long? = asNumber(column)?.toLong()

/** The column's value as a [Double], or `null` when it is `NULL`, missing or not numeric. */
fun Row.doubleOrNull(column: String): Double? = asNumber(column)?.toDouble()

/**
 * The column's value as a [BigDecimal], or `null`.
 *
 * Goes through the string form rather than the `Double` constructor: a `DECIMAL` column read
 * as a `Double` would already have lost the digits that do not fit in a binary fraction.
 */
fun Row.decimalOrNull(column: String): BigDecimal? = when (val value = this[column]) {
    null -> null
    is BigDecimal -> value
    is java.math.BigInteger -> BigDecimal(value)
    is Number -> BigDecimal.valueOf(value.toLong())
    else -> value.toString().trim().toBigDecimalOrNull()
}

/** The column's value as a [Boolean], or `null` when it is `NULL` or not recognisable. */
fun Row.boolOrNull(column: String): Boolean? = when (val value = this[column]) {
    null -> null
    is Boolean -> value
    is Number -> value.toInt() != 0
    else -> value.toString().trim().toBooleanStrictOrNull()
}

/** The column's value as a [LocalDateTime], or `null`. */
fun Row.localDateTimeOrNull(column: String): LocalDateTime? = when (val value = this[column]) {
    null -> null
    is LocalDateTime -> value
    is Timestamp -> value.toLocalDateTime()
    is java.sql.Date -> value.toLocalDate().atStartOfDay()
    is OffsetDateTime -> value.toLocalDateTime()
    is Instant -> LocalDateTime.ofInstant(value, ZoneOffset.UTC)
    is Number -> LocalDateTime.ofInstant(Instant.ofEpochMilli(value.toLong()), ZoneOffset.UTC)
    else -> runCatching { LocalDateTime.parse(value.toString().trim().replace(' ', 'T')) }.getOrNull()
}

/** The column's value as a [LocalDate], or `null`. */
fun Row.localDateOrNull(column: String): LocalDate? = when (val value = this[column]) {
    null -> null
    is LocalDate -> value
    is java.sql.Date -> value.toLocalDate()
    else -> localDateTimeOrNull(column)?.toLocalDate()
}

/** The column's value as a [UUID], or `null`. */
fun Row.uuidOrNull(column: String): UUID? = stringOrNull(column)?.let { text ->
    runCatching { UUID.fromString(text) }.getOrNull()
}

/** The column's value as a [ByteArray], or `null`. */
fun Row.bytesOrNull(column: String): ByteArray? = this[column] as? ByteArray

/**
 * The column's value as a vector, or `null` for `NULL`.
 *
 * A `VECTOR(n)` column holds float32 bytes, but a column written before that encoding held
 * JSON text, so both are accepted; so is an array a driver has already decoded. Decoding is
 * the same code the ranking query uses, which is what keeps a column readable as the vector
 * it is stored as.
 */
fun Row.vectorOrNull(column: String): DoubleArray? =
    an5.adapters.base.SqliteVectors.decodeVector(this[column], 0)

private fun Row.asNumber(column: String): Number? = when (val value = this[column]) {
    null -> null
    is Number -> value
    is Boolean -> if (value) 1 else 0
    else -> value.toString().trim().toDoubleOrNull()
}
