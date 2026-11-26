package an5.adapters

/**
 * Builds an aggregate or a grouped aggregate.
 *
 * One builder covers both because the metrics are the same; [groupedBy] is what turns a
 * flat `aggregate` into a `groupBy`.
 *
 * ```
 * db.table("Order").aggregate {
 *     count()
 *     sum("total")
 *     where("status" eq "paid")
 * }
 *
 * db.table("Order").groupBy("customerId") {
 *     sum("total")
 *     orderBy("_sum_total", Sort.DESC)
 *     take(5)
 * }
 * ```
 */
class AggregateBuilder {
    private var counts = false
    private val countColumns = mutableListOf<String>()
    private val sums = mutableListOf<String>()
    private val averages = mutableListOf<String>()
    private val minimums = mutableListOf<String>()
    private val maximums = mutableListOf<String>()
    private val clauses = mutableListOf<Where>()
    private val havingClauses = mutableListOf<Where>()
    private val groups = mutableListOf<String>()
    private val order = mutableListOf<Map<String, String>>()
    private var offset = 0
    private var limit: Int? = null

    /** Adds `COUNT(*)`. */
    fun count() {
        counts = true
    }

    /** Adds `COUNT(*)` (for `"_all"`) and per-column non-null counts. */
    fun count(vararg columns: String): AggregateBuilder = apply {
        if (columns.isEmpty()) {
            counts = true
        } else {
            for (column in columns) {
                if (column == "_all") {
                    counts = true
                } else if (column.isNotEmpty() && !countColumns.contains(column)) {
                    countColumns += column
                }
            }
        }
    }

    fun sum(vararg columns: String) = apply { sums += columns }

    fun avg(vararg columns: String) = apply { averages += columns }

    fun min(vararg columns: String) = apply { minimums += columns }

    fun max(vararg columns: String) = apply { maximums += columns }

    /** Restricts the rows the aggregate runs over. */
    fun where(clause: Where) {
        clauses += clause
    }

    /** Filters grouped rows after aggregation (`HAVING`). Repeated calls combine with `AND`. */
    fun having(clause: Where) {
        havingClauses += clause
    }

    /** Orders the grouped rows; a flat aggregate returns one row, so it is ignored there. */
    fun orderBy(column: String, direction: Sort = Sort.ASC) {
        order += mapOf(column to direction.sql)
    }

    /** Orders grouped rows by several columns at once, each with its own direction. */
    fun orderBy(columns: List<Pair<String, Sort>>) {
        order.addAll(columns.map { (column, direction) -> mapOf(column to direction.sql) })
    }

    /** Appends raw `{ column: direction }` sort entries, used by generated `OrderBy` builders. */
    @JvmName("orderByEntries")
    fun orderBy(entries: List<Map<String, String>>) {
        order.addAll(entries)
    }

    fun skip(count: Int) {
        offset = count.coerceAtLeast(0)
    }

    fun take(count: Int?) {
        limit = count
    }

    /** The `GROUP BY` columns. Empty means a flat aggregate rather than a grouped one. */
    fun groupedBy(vararg columns: String): AggregateBuilder = apply { groups += columns }

    internal fun build(): an5.adapters.An5GroupBy {
        val aggregate = an5.adapters.An5GroupBy()
        if (counts) aggregate.count()
        if (countColumns.isNotEmpty()) aggregate.count(*countColumns.toTypedArray())
        aggregate.sum(*sums.toTypedArray())
        aggregate.avg(*averages.toTypedArray())
        aggregate.min(*minimums.toTypedArray())
        aggregate.max(*maximums.toTypedArray())
        if (clauses.isNotEmpty()) {
            val filter =
                if (clauses.size == 1) clauses[0] else andOf(*clauses.toTypedArray())
            aggregate.where(filter.toJavaWhere())
        }
        if (havingClauses.isNotEmpty()) {
            val filter =
                if (havingClauses.size == 1) havingClauses[0] else andOf(*havingClauses.toTypedArray())
            aggregate.having(filter.toJavaWhere())
        }
        aggregate.by(*groups.toTypedArray())
        if (order.isNotEmpty()) {
            aggregate.orderBy(order.toList())
        }
        aggregate.skip(offset)
        aggregate.take(limit)
        return aggregate
    }
}