package an5.adapters

/**
 * CRUD and queries for one table.
 *
 * A wrapper over the JVM table client: the schema knowledge and the SQL live there, and
 * this adds the Kotlin call shapes — a [query] block for filters, named arguments for
 * writes — without reimplementing anything.
 */
class TableClient internal constructor(
    adapter: an5.adapters.An5Adapter,
    model: String,
) {
    private val delegate: an5.adapters.An5TableClient = adapter.table(model)

    /** The model this client reads and writes. */
    val model: String get() = delegate.modelName()

    // ─── Reads ────────────────────────────────────────────────────────────────────

    /** Every row, unfiltered. */
    fun findMany(): List<Row> = delegate.findMany()

    /** The rows matching the query the block builds. */
    fun findMany(block: QueryBuilder.() -> Unit): List<Row> = delegate.findMany(query(block))

    /** The rows matching [where], with the optional refinements [block] adds. */
    fun findMany(where: Where, block: QueryBuilder.() -> Unit = {}): List<Row> =
        delegate.findMany(QueryBuilder().apply { this.where(where); block() }.build())

    /** The first matching row, or `null`. Always limited to one row server-side. */
    fun findFirst(block: QueryBuilder.() -> Unit): Row? =
        delegate.findFirst(QueryBuilder().apply(block).build())

    fun findFirst(where: Where): Row? = delegate.findFirst(where.toJavaFilter())

    /** The row [where] identifies, or `null`. */
    fun findUnique(where: Where): Row? = delegate.findUnique(where.toJavaFilter())

    /** How many rows match. */
    fun count(where: Where? = null): Long = delegate.count(where?.toJavaWhere())

    // ─── Writes ───────────────────────────────────────────────────────────────────

    /**
     * Inserts a row and returns it, re-read so server-side defaults come back with it.
     *
     * A model with an `@id` column and no value for it gets a generated identifier, which
     * is what makes a client-created row addressable without a database-side default.
     */
    fun create(data: Data): Row = delegate.create(data.toJavaData())

    fun create(data: Data, block: QueryBuilder.() -> Unit): Row =
        delegate.create(data.toJavaData(), QueryBuilder().apply(block).build())

    /**
     * Inserts many rows, one statement each.
     *
     * Row-at-a-time on purpose: a batch would share one parameter list, so a single bad
     * row would lose every good row with it.
     */
    fun createMany(rows: List<Data>, skipDuplicates: Boolean = false): Int =
        affected(delegate.createMany(rows.map { it.toJavaData() }, skipDuplicates))

    /** Updates the rows matching [where] and returns the first of them re-read. */
    fun update(where: Where, data: Data): Row? = delegate.update(where.toJavaFilter(), data.toJavaData())

    /** Updates every matching row and gives back how many changed. */
    fun updateMany(where: Where?, data: Data): Int =
        affected(delegate.updateMany(where?.toJavaWhere(), data.toJavaData()))

    /** Deletes the matching rows and returns the one that was there first. */
    fun delete(where: Where): Row? = delegate.delete(where.toJavaFilter())

    /** Deletes every matching row, or the whole table when [where] is `null`. */
    fun deleteMany(where: Where? = null): Int = affected(delegate.deleteMany(where?.toJavaWhere()))

    /** Updates the matching row when it exists, creates it otherwise. */
    fun upsert(where: Where, create: Data, update: Data): Row =
        delegate.upsert(where.toJavaFilter(), create.toJavaData(), update.toJavaData())

    // ─── Aggregation ──────────────────────────────────────────────────────────────

    /**
     * One row of aggregate values, keyed `_count`, `_sum_<field>` and so on.
     *
     * ```
     * db.table("Order").aggregate { count(); sum("total"); avg("total") }
     * ```
     */
    fun aggregate(block: AggregateBuilder.() -> Unit): Row =
        delegate.aggregate(AggregateBuilder().apply(block).build())

    /** One row per group, each carrying the group's `_count` and aggregates. */
    fun groupBy(vararg by: String, block: AggregateBuilder.() -> Unit = {}): List<Row> =
        delegate.groupBy(AggregateBuilder().apply(block).groupedBy(*by).build())

    // ─── Vector search ────────────────────────────────────────────────────────────

    /**
     * The rows nearest [vector], by the database's own vector functions where it has
     * them and in memory where it does not.
     */
    @JvmOverloads
    fun vectorSearch(
        vector: DoubleArray,
        take: Int = 10,
        where: Where? = null,
        vectorField: String = "embedding",
        metric: DistanceMetric = DistanceMetric.COSINE,
    ): List<Row> = delegate.vectorSearch(vector, take, where?.toJavaWhere(), vectorField, metric.sql)

    override fun toString(): String = "TableClient($model)"
}

/** A wrapper over the JVM view client: reads work, writes are refused. */
class ViewClient internal constructor(
    adapter: an5.adapters.An5Adapter,
    viewName: String,
) {
    private val delegate: an5.adapters.An5ViewClient = adapter.view(viewName)

    /** The view this client reads. */
    val name: String get() = delegate.viewName()

    fun findMany(): List<Row> = delegate.findMany()

    fun findMany(block: QueryBuilder.() -> Unit): List<Row> = delegate.findMany(query(block))

    fun findFirst(where: Where): Row? = delegate.findFirst(where.toJavaFilter())

    fun findUnique(where: Where): Row? = delegate.findUnique(where.toJavaFilter())

    fun count(where: Where? = null): Long = delegate.count(where?.toJavaWhere())

    fun aggregate(block: AggregateBuilder.() -> Unit): Row =
        delegate.aggregate(AggregateBuilder().apply(block).build())

    fun groupBy(vararg by: String, block: AggregateBuilder.() -> Unit = {}): List<Row> =
        delegate.groupBy(AggregateBuilder().apply(block).groupedBy(*by).build())

    @JvmOverloads
    fun vectorSearch(
        vector: DoubleArray,
        take: Int = 10,
        where: Where? = null,
        vectorField: String = "embedding",
        metric: DistanceMetric = DistanceMetric.COSINE,
    ): List<Row> = delegate.vectorSearch(vector, take, where?.toJavaWhere(), vectorField, metric.sql)

    fun create(data: Data): Row = delegate.create(data.toJavaData())

    fun update(where: Where, data: Data): Row? = delegate.update(where.toJavaFilter(), data.toJavaData())

    fun updateMany(where: Where?, data: Data): Int =
        affected(delegate.updateMany(where?.toJavaWhere(), data.toJavaData()))

    fun delete(where: Where): Row? = delegate.delete(where.toJavaFilter())

    fun deleteMany(where: Where? = null): Int = affected(delegate.deleteMany(where?.toJavaWhere()))

    fun upsert(where: Where, create: Data, update: Data): Row =
        delegate.upsert(where.toJavaFilter(), create.toJavaData(), update.toJavaData())

    override fun toString(): String = "ViewClient($name)"
}

/** The affected row count a write returned. */
private fun affected(result: Map<String, Any?>): Int = (result["count"] as? Number)?.toInt() ?: 0