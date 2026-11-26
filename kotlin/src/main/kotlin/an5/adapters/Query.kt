package an5.adapters

/**
 * Builds a query.
 *
 * Every field has a default, so [query] with an empty block means the same thing an
 * omitted filter means in the other adapters: no filter, no order, no limit.
 *
 * ```
 * val adults = db.table("User").findMany {
 *     where("age" gte 18)
 *     orderBy("name")
 *     take(10)
 * }
 * ```
 */
class QueryBuilder {
    private val clauses = mutableListOf<Where>()
    private val order = mutableListOf<Map<String, String>>()
    private var offset = 0
    private var limit: Int? = null
    private var columns: List<String>? = null
    private val relations = mutableMapOf<String, Any?>()

    /** Restricts the rows. Repeated calls are combined with `AND`. */
    fun where(clause: Where) {
        clauses += clause
    }

    fun orderBy(column: String, direction: Sort = Sort.ASC) {
        order += mapOf(column to direction.sql)
    }

    /** Orders by several columns at once, each with its own direction. */
    fun orderBy(columns: List<Pair<String, Sort>>) {
        order.addAll(columns.map { (column, direction) -> mapOf(column to direction.sql) })
    }

    /** Skips this many rows. Negative values are treated as zero. */
    fun skip(count: Int) {
        offset = count.coerceAtLeast(0)
    }

    /** Caps the number of rows; `null` means no limit. */
    fun take(count: Int?) {
        limit = count
    }

    /** Restricts the returned columns; relations and `_count` are eager-loaded instead. */
    fun select(vararg columns: String) {
        this.columns = columns.toList()
    }

    /** Eager-loads relations. Repeated calls merge. */
    fun include(relations: Include) {
        this.relations += relations
    }

    internal fun build(): an5.adapters.An5Query {
        val query = an5.adapters.An5Query()
        if (clauses.isNotEmpty()) {
            query.where(if (clauses.size == 1) clauses[0].toJavaWhere() else andOf(*clauses.toTypedArray()).toJavaWhere())
        }
        if (order.isNotEmpty()) {
            query.orderBy(order.toList())
        }
        query.skip(offset)
        query.take(limit)
        columns?.let { query.select(*it.toTypedArray()) }
        if (relations.isNotEmpty()) {
            query.include(relations.toJavaMap())
        }
        return query
    }
}

/** Builds a query with [block], ready to hand to a table client. */
fun query(block: QueryBuilder.() -> Unit): an5.adapters.An5Query = QueryBuilder().apply(block).build()

// ─── Filter building ────────────────────────────────────────────────────────────────
// Named after the operators they produce rather than Kotlin's own vocabulary, so a filter
// reads the same in Kotlin as it does in every other AN5 client.

/** `"age" gte 18` — greater than or equal. */
infix fun String.gte(value: Any?): Where = mapOf(this to mapOf("gte" to value))

/** `"age" lte 18` — less than or equal. */
infix fun String.lte(value: Any?): Where = mapOf(this to mapOf("lte" to value))

/** `"age" gt 18` — greater than. */
infix fun String.gt(value: Any?): Where = mapOf(this to mapOf("gt" to value))

/** `"age" lt 18` — less than. */
infix fun String.lt(value: Any?): Where = mapOf(this to mapOf("lt" to value))

/** `"name" eq "Ada"` — equality. */
infix fun String.eq(value: Any?): Where = mapOf(this to mapOf("equals" to value))

/** `"name" neq "Ada"` — inequality. */
infix fun String.neq(value: Any?): Where = mapOf(this to mapOf("not" to value))

/** `"name" contains "da"` — a substring match; case sensitivity follows the dialect. */
infix fun String.contains(value: String): Where = mapOf(this to mapOf("contains" to value))

/** `"name" startsWith "Ad"`. */
infix fun String.startsWith(value: String): Where = mapOf(this to mapOf("startsWith" to value))

/** `"name" endsWith "ce"`. */
infix fun String.endsWith(value: String): Where = mapOf(this to mapOf("endsWith" to value))

/** `"id".isNull()` — the column is `NULL`. */
fun String.isNull(): Where = mapOf(this to null)

/** `"id".isNotNull()` — the column has a value. */
fun String.isNotNull(): Where = mapOf(this to mapOf("not" to null))

/** `"id" inList listOf(1, 2)` — an empty list matches nothing. */
infix fun <T> String.inList(values: List<T>): Where = mapOf(this to mapOf("in" to values))

/** `"id" notInList listOf(1, 2)` — an empty list matches everything. */
infix fun <T> String.notInList(values: List<T>): Where = mapOf(this to mapOf("notIn" to values))

/** `"name".eq("ada", mode = "insensitive")` — equality with an explicit match mode. */
fun String.eq(value: String?, mode: String): Where = mapOf(this to mapOf("equals" to value, "mode" to mode))

/** `"name".neq("ada", mode = "insensitive")` — inequality with an explicit match mode. */
fun String.neq(value: String?, mode: String): Where = mapOf(this to mapOf("not" to value, "mode" to mode))

/** `"name".contains("da", mode = "insensitive")` — substring match with an explicit match mode. */
fun String.contains(value: String, mode: String): Where = mapOf(this to mapOf("contains" to value, "mode" to mode))

/** `"name".startsWith("ad", mode = "insensitive")` — prefix match with an explicit match mode. */
fun String.startsWith(value: String, mode: String): Where = mapOf(this to mapOf("startsWith" to value, "mode" to mode))

/** `"name".endsWith("da", mode = "insensitive")` — suffix match with an explicit match mode. */
fun String.endsWith(value: String, mode: String): Where = mapOf(this to mapOf("endsWith" to value, "mode" to mode))

/** `"name".inList(listOf("ada", "alan"), mode = "insensitive")` — list membership with an explicit match mode. */
fun String.inList(values: List<String>, mode: String): Where = mapOf(this to mapOf("in" to values, "mode" to mode))

/** `"name".notInList(listOf("ada", "alan"), mode = "insensitive")` — excluded list membership with an explicit match mode. */
fun String.notInList(values: List<String>, mode: String): Where = mapOf(this to mapOf("notIn" to values, "mode" to mode))

/** `"name" eqInsensitive "ada"` — case-insensitive equality. */
infix fun String.eqInsensitive(value: String?): Where = eq(value, "insensitive")

/** `"name" neqInsensitive "ada"` — case-insensitive inequality. */
infix fun String.neqInsensitive(value: String?): Where = neq(value, "insensitive")

/** `"name" containsInsensitive "da"` — case-insensitive substring match. */
infix fun String.containsInsensitive(value: String): Where = contains(value, "insensitive")

/** `"name" startsWithInsensitive "ad"` — case-insensitive prefix match. */
infix fun String.startsWithInsensitive(value: String): Where = startsWith(value, "insensitive")

/** `"name" endsWithInsensitive "da"` — case-insensitive suffix match. */
infix fun String.endsWithInsensitive(value: String): Where = endsWith(value, "insensitive")

/** `"name" inListInsensitive listOf("ada", "alan")` — case-insensitive `in` list match. */
infix fun String.inListInsensitive(values: List<String>): Where = inList(values, "insensitive")

/** `"name" notInListInsensitive listOf("ada", "alan")` — case-insensitive `notIn` list match. */
infix fun String.notInListInsensitive(values: List<String>): Where = notInList(values, "insensitive")

/** Any of [clauses]; an empty list matches nothing. */
fun orOf(vararg clauses: Where): Where = mapOf("OR" to clauses.toList())

/** All of [clauses]; an empty list matches everything. */
fun andOf(vararg clauses: Where): Where = mapOf("AND" to clauses.toList())

/** None of [clauses]; an empty list matches everything. */
fun notOf(vararg clauses: Where): Where = mapOf("NOT" to clauses.toList())

// ─── Relation filter building ───────────────────────────────────────────────────────

/** At least one related record matches [filter]. */
infix fun String.some(filter: Where): Where = mapOf(this to mapOf("some" to filter))

/** At least one related record exists. */
fun String.some(): Where = mapOf(this to mapOf("some" to emptyMap<String, Any?>()))

/** No related record matches [filter]. */
infix fun String.none(filter: Where): Where = mapOf(this to mapOf("none" to filter))

/** Zero related records exist. */
fun String.none(): Where = mapOf(this to mapOf("none" to emptyMap<String, Any?>()))

/** Every related record matches [filter] (vacuously true when zero related records exist). */
infix fun String.every(filter: Where): Where = mapOf(this to mapOf("every" to filter))

/** To-one related record matches [filter], or does not exist when [filter] is `null`. */
infix fun String.isRelated(filter: Where?): Where = mapOf(this to mapOf("is" to filter))

/** To-one related record does not match [filter], or exists when [filter] is `null`. */
infix fun String.isNotRelated(filter: Where?): Where = mapOf(this to mapOf("isNot" to filter))