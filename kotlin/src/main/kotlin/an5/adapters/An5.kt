package an5.adapters

import java.util.UUID

/**
 * The AN5 runtime for Kotlin.
 *
 * A thin, idiomatic front door over the JVM adapter: the dialect rules, the where builder
 * and the row mapping all live in one place, so the Kotlin API can stay small enough to
 * read in a sitting while still behaving exactly like the Java one.
 *
 * ```
 * val db = An5("sqlite:///app.db")
 * val users = db.table("User")
 * users.create(mapOf("name" to "Ada", "score" to 10))
 * val adults = users.findMany { where("age" gte 18); orderBy("name"); take(10) }
 * ```
 *
 * Not thread-safe, exactly like the other AN5 runtimes: a transaction holds one open
 * connection that every statement in the block has to share.
 */
class An5 internal constructor(
    private val delegate: an5.adapters.An5Adapter,
) : AutoCloseable {

    /** Opens a runtime for a connection string. */
    constructor(connectionString: String) : this(an5.adapters.An5Adapter(connectionString))

    /** The dialect the connection string points at. */
    val dialect: Dialect get() = delegate.dialect()

    /** The table client for a model. */
    fun table(model: String): TableClient = TableClient(delegate, model)

    /**
     * Pins one SQLite vector strategy instead of probing for the fastest one available:
     * `sqlite-vec`, `udf`, `sql` or `memory`.
     *
     * SQLite has no vector type, so a `VECTOR(n)` column is ranked by the sqlite-vec
     * extension, a distance function the driver registers, `json_each` in plain SQL, or
     * in the client. `null` probes. Plain JDBC reaches `json_each` and the in-memory
     * path; the first two need a driver built for them.
     */
    fun vectorStrategy(strategy: String?) {
        delegate.setVectorStrategy(strategy ?: "")
    }

    /** A read-only client for a database view. */
    fun view(name: String): ViewClient = ViewClient(delegate, name)

    /** Runs a query and returns its rows as ordered maps keyed by column label. */
    fun queryRaw(sql: String, vararg params: Any?): List<Row> = delegate.queryRaw(sql, *params)

    /** Runs a statement that returns no rows and gives back the affected row count. */
    fun executeRaw(sql: String, vararg params: Any?): Int = delegate.executeRaw(sql, *params)

    /**
     * Calls a stored procedure and returns its rows.
     *
     * SQLite has none, and says so rather than emitting `EXEC`, which is not valid SQL.
     */
    fun queryProc(name: String, params: List<Any?> = emptyList()): List<Row> =
        delegate.queryProc(name, params)

    /** Calls a stored procedure for its effect. */
    fun executeProc(name: String, params: List<Any?> = emptyList()): Int =
        delegate.executeProc(name, params)

    /**
     * Runs [block] inside a transaction, committing on return and rolling back on failure.
     *
     * The [An5] handed to the block shares the transaction's connection, so statements
     * inside it commit or roll back together. Nesting is rejected rather than flattened:
     * an inner commit would make the outer rollback a partial save.
     */
    fun <T> transaction(block: (An5) -> T): T {
        val result = arrayOfNulls<Any?>(1)
        delegate.transaction<Unit> { scoped ->
            result[0] = block(An5(scoped))
        }
        @Suppress("UNCHECKED_CAST")
        return result[0] as T
    }

    override fun close() = delegate.close()

    override fun toString(): String = "An5(${delegate.dialect().id()})"
}

/** A generated identifier, for callers that need the value before the insert. */
fun newId(): String = UUID.randomUUID().toString()