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
    private val sums = mutableListOf<String>()
    private val averages = mutableListOf<String>()
    private val minimums = mutableListOf<String>()
    private val maximums = mutableListOf<String>()
    private val clauses = mutableListOf<Where>()
    private val groups = mutableListOf<String>()
    private val order = mutableListOf<Map<String, String>>()
    private var offset = 0
    private var limit: Int? = null

    /** Adds `COUNT(*)`. */
    fun count() {
        counts = true
    }

    fun sum(vararg columns: String) = apply { sums += columns }

    fun avg(vararg columns: String) = apply { averages += columns }

    fun min(vararg columns: String) = apply { minimums += columns }

    fun max(vararg columns: String) = apply { maximums += columns }

    /** Restricts the rows the aggregate runs over. */
    fun where(clause: Where) {
        clauses += clause
    }

    /** Orders the grouped rows; a flat aggregate returns one row, so it is ignored there. */
    fun orderBy(column: String, direction: Sort = Sort.ASC) {
        order += mapOf(column to direction.sql)
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
        aggregate.sum(*sums.toTypedArray())
        aggregate.avg(*averages.toTypedArray())
        aggregate.min(*minimums.toTypedArray())
        aggregate.max(*maximums.toTypedArray())
        if (clauses.isNotEmpty()) {
            val filter =
                if (clauses.size == 1) clauses[0] else andOf(*clauses.toTypedArray())
            aggregate.where(filter.toJavaWhere())
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