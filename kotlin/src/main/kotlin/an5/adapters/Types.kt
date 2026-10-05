package an5.adapters

/**
 * The database dialects AN5 speaks.
 *
 * A typealias rather than a second enum: the JVM adapter already decides quoting,
 * pagination and the `WITH (NOLOCK)` hint, and a copy of the enum here would be a second
 * source of truth that could drift from the one that produces the SQL.
 */
typealias Dialect = an5.adapters.base.Dialect

/** One row, keyed by column label, in the order the query selected the columns. */
typealias Row = Map<String, Any?>

/** A filter tree: scalar values, operator maps, and nested `AND`/`OR`/`NOT` groups. */
typealias Where = Map<String, Any?>

/** A write payload: column values, plus any relation writes the metadata declares. */
typealias Data = Map<String, Any?>

/** An eager-load description: relation name to `true`, or to a nested query description. */
typealias Include = Map<String, Any?>

/** Sort direction, with the SQL each one writes. */
enum class Sort(val sql: String) {
    ASC("asc"),
    DESC("desc"),
}

/**
 * The distance metrics a vector search understands.
 *
 * Each metric is turned into a distance before sorting, so ascending order always means
 * "closer" — cosine similarity and dot product would otherwise have to be sorted
 * descending, which is the kind of detail no caller should have to remember.
 */
enum class DistanceMetric(val sql: String) {
    COSINE("cosine"),
    EUCLIDEAN("euclidean"),
    DOT("dot"),
}

/**
 * Rebuilds a Kotlin value as a plain Java one.
 *
 * Kotlin's `Map` and `List` interfaces are read-only, so they are not assignable to the
 * `java.util.Map` parameters the JVM adapter declares. Every value that crosses that
 * boundary goes through here, which is also what lets the public API use `mapOf` — the
 * literal everyone writes — instead of `mutableMapOf`.
 */
internal fun Any?.toJava(): Any? = when (this) {
    is Map<*, *> -> toJavaMap()
    is Iterable<*> -> map { it.toJava() }
    is Array<*> -> map { it.toJava() }
    is IntArray -> map { it }
    is DoubleArray -> map { it }
    is LongArray -> map { it }
    else -> this
}

/** The map as the adapter takes it: mutable, with string keys and values converted. */
internal fun Map<*, *>.toJavaMap(): MutableMap<String, Any?> {
    val target = LinkedHashMap<String, Any?>(size)
    for ((key, value) in this) {
        target[key.toString()] = value.toJava()
    }
    return target
}

/** The filter tree as the adapter takes it, or `null` when there is none. */
internal fun Where?.toJavaWhere(): MutableMap<String, Any?>? = this?.toJavaMap()

/** The filter tree as the adapter takes it; for parameters that are not optional. */
internal fun Where.toJavaFilter(): MutableMap<String, Any?> = toJavaMap()

/** The payload as the adapter takes it. */
internal fun Data.toJavaData(): MutableMap<String, Any?> = toJavaMap()