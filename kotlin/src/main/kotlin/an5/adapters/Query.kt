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

/** Any of [clauses]; an empty list matches nothing. */
fun orOf(vararg clauses: Where): Where = mapOf("OR" to clauses.toList())

/** All of [clauses]; an empty list matches everything. */
fun andOf(vararg clauses: Where): Where = mapOf("AND" to clauses.toList())

/** None of [clauses]; an empty list matches everything. */
fun notOf(vararg clauses: Where): Where = mapOf("NOT" to clauses.toList())