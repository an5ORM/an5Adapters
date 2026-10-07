package an5.adapters

/**
 * End-to-end exercise of the Kotlin runtime against a real in-memory SQLite database.
 *
 * Covers what a Java-only check cannot: that Kotlin's read-only maps reach the JDBC layer,
 * that the query block builds the filter the other adapters build, and that a column read
 * as `Long` from SQLite comes out of the typed accessors as `Int` without a cast at the
 * call site.
 */
object An5Smoke {

    private var failures = 0

    @JvmStatic
    fun main(args: Array<String>) {
        crud()
        filters()
        aggregates()
        relations()
        transactions()
        vectorFallback()
        sqliteVectorSearch()

        if (failures > 0) {
            println("kotlin smoke: $failures check(s) failed")
            kotlin.system.exitProcess(1)
        }
        println("kotlin smoke: all checks passed")
    }

    private fun crud() {
        val db = open()
        db.use {
            val users = it.table("User")
            val created = users.create(mapOf("name" to "Ada", "score" to 10))
            check("generated primary key") { created.string("id") != null }
            check("create returns the stored row") { created.string("name") == "Ada" }
            check("row accessors read a column") { created.int("score") == 10 }
            check("row accessors widen a number") { created.long("score") == 10L }
            check("missing column reads as the fallback") { created.int("nope", -1) == -1 }
            check("null column reads as the fallback") { created.string("nope") == null }

            users.create(mapOf("name" to "Grace", "score" to 20))
            users.create(mapOf("name" to "Alan", "score" to 30))

            check("count") { users.count() == 3L }
            check("ordered results") { users.findMany { orderBy("score", Sort.DESC) }.first().string("name") == "Alan" }
            check("paged results") {
                users.findMany { orderBy("score"); skip(1); take(1) }.single().string("name") == "Grace"
            }
            check("select projects columns") {
                users.findMany { select("name") }.all { it.keys == setOf("name") }
            }
            check("update") {
                users.update(mapOf("id" to created.string("id")), mapOf("score" to 99))?.int("score") == 99
            }
            check("updateMany") {
                users.updateMany(null, mapOf("score" to mapOf("increment" to 1))) == 3
            }
            check("upsert updates") {
                users.upsert(mapOf("id" to created.string("id")), mapOf("name" to "x"), mapOf("name" to "Ada L"))
                    .string("name") == "Ada L"
            }
            check("upsert creates") {
                users.upsert(mapOf("name" to "Katherine"), mapOf("name" to "Katherine"), mapOf("name" to "K"))
                    .string("name") == "Katherine"
            }
            check("delete") { users.delete(mapOf("id" to created.string("id"))) != null }
            check("deleteMany") { users.deleteMany(null) == 3 }
        }
    }

    private fun filters() {
        val db = open()
        db.use {
            val users = it.table("User")
            users.createMany(
                listOf(
                    mapOf("name" to "Ada", "score" to 10),
                    mapOf("name" to "Grace", "score" to 20),
                    mapOf("name" to "Alan", "score" to 30),
                )
            )
            check("gte") { users.findMany { where("score" gte 20) }.size == 2 }
            check("lt") { users.findMany { where("score" lt 20) }.size == 1 }
            check("eq") { users.findMany { where("name" eq "Ada") }.size == 1 }
            check("neq") { users.findMany { where("name" neq "Ada") }.size == 2 }
            check("contains") { users.findMany { where("name" contains "da") }.size == 1 }
            check("endsWith") { users.findMany { where("name" endsWith "ce") }.size == 1 }
            check("inList") { users.findMany { where("name" inList listOf("Ada", "Alan")) }.size == 2 }
            check("empty inList matches nothing") {
                users.findMany { where("name" inList emptyList<String>()) }.isEmpty()
            }
            check("empty notInList matches everything") {
                users.findMany { where("name" notInList emptyList<String>()) }.size == 3
            }
            check("orOf") { users.findMany { where(orOf("name" eq "Ada", "name" eq "Alan")) }.size == 2 }
            check("andOf") { users.findMany { where(andOf("score" gte 10, "score" lt 30)) }.size == 2 }
            check("notOf") { users.findMany { where(notOf("name" eq "Ada", "name" eq "Grace")) }.size == 1 }
            check("empty orOf matches nothing") { users.findMany { where(orOf()) }.isEmpty() }
            check("two where calls combine with AND") {
                users.findMany { where("score" gte 10); where("score" lte 20) }.size == 2
            }
            check("isNull") { users.findMany { where("nickname".isNull()) }.size == 3 }
            check("isNotNull") { users.findMany { where("name".isNotNull()) }.size == 3 }
            check("findFirst") { users.findFirst(mapOf("name" to "Ada"))?.int("score") == 10 }
            check("findFirst misses") { users.findFirst(mapOf("name" to "Nobody")) == null }
        }
    }

    private fun aggregates() {
        val db = open()
        db.use {
            val users = it.table("User")
            users.createMany(
                listOf(
                    mapOf("name" to "Ada", "score" to 10),
                    mapOf("name" to "Grace", "score" to 20),
                    mapOf("name" to "Alan", "score" to 30),
                )
            )
            val totals = users.aggregate { count(); sum("score"); avg("score"); max("score") }
            check("aggregate count") { (totals["_count"] as Number).toLong() == 3L }
            check("aggregate sum") { (totals["_sum_score"] as Number).toDouble() == 60.0 }
            check("aggregate avg") { (totals["_avg_score"] as Number).toDouble() == 20.0 }
            check("aggregate max") { (totals["_max_score"] as Number).toDouble() == 30.0 }

            val filtered = users.aggregate { count(); where("score" gte 20) }
            check("aggregate where") { (filtered["_count"] as Number).toLong() == 2L }

            val groups = users.groupBy("name") { sum("score") }
            check("groupBy rows") { groups.size == 3 }
            check("groupBy counts") { groups.all { (it["_count"] as Number).toLong() == 1L } }
        }
    }

    private fun relations() {
        val db = open()
        db.use {
            val ada = it.table("User").create(mapOf("name" to "Ada", "score" to 1))
            it.table("Post").create(mapOf("title" to "first", "userId" to ada.string("id")))
            it.table("Post").create(mapOf("title" to "second", "userId" to ada.string("id")))

            val rows = it.table("User").findMany {
                include(mapOf("posts" to true, "_count" to true))
            }
            check("many relation eager-loaded") { rows.single().related("posts").size == 2 }
            check("relation count eager-loaded") { rows.single().relationCount("posts") == 2 }
            check("related rows are readable") {
                rows.single().related("posts").first().string("title") == "first"
            }
            check("missing relation reads as empty") { rows.single().related("comments").isEmpty() }
            check("missing relation count reads as zero") { rows.single().relationCount("comments") == 0 }
        }
    }

    private fun transactions() {
        val db = open()
        db.use {
            it.table("User").create(mapOf("name" to "outside"))
            val failed = runCatching {
                it.transaction { scoped ->
                    scoped.table("User").create(mapOf("name" to "inside"))
                    error("rollback")
                }
            }
            check("transaction rethrows") { failed.isFailure && failed.exceptionOrNull()?.message == "rollback" }
            check("rollback discarded the inner insert") { it.table("User").count() == 1L }

            it.transaction { scoped -> scoped.table("User").create(mapOf("name" to "committed")) }
            check("commit kept the insert") { it.table("User").count() == 2L }
        }
    }

    private fun vectorFallback() {
        val db = open()
        db.use {
            val docs = it.table("Document")
            docs.create(mapOf("title" to "far", "embedding" to "[0.0, 1.0]"))
            docs.create(mapOf("title" to "near", "embedding" to "[1.0, 0.1]"))
            docs.create(mapOf("title" to "no vector", "embedding" to null))

            val hits = docs.vectorSearch(doubleArrayOf(1.0, 0.0), take = 2)
            check("rows without a vector are skipped") { hits.size == 2 }
            check("nearest first") { hits.first().string("title") == "near" }
            check("distance reported") { hits.first().containsKey("distance") }
        }
    }

    /**
     * SQLite ranks a `VECTOR(n)` column inside the database, and a `DoubleArray` written
     * to one comes back as numbers.
     *
     * The docstring in the JVM adapter's `SqliteVectors` is the shared specification every
     * runtime implements; test/sqlite-vector.test.js (TypeScript) is the mirror.
     */
    private fun sqliteVectorSearch() {
        an5.adapters.base.Metadata.setAdapterMetadata(blobMetadata())
        val db = An5(":memory:")
        db.use {
            it.executeRaw("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding BLOB)")
            val vectors = listOf(
                "d1" to doubleArrayOf(1.0, 0.0, 0.0),
                "d2" to doubleArrayOf(0.8, 0.2, 0.0),
                "d3" to doubleArrayOf(0.0, 1.0, 0.0),
            )
            for ((id, vector) in vectors) {
                it.executeRaw(
                    "INSERT INTO documents (id, title, embedding) VALUES (?, ?, ?)",
                    id, id, an5.adapters.base.SqliteVectors.encodeVector(vector),
                )
            }
            // A row with another dimension must never rank against a 3-dimension query.
            it.executeRaw(
                "INSERT INTO documents (id, title, embedding) VALUES ('d4', 'd4', ?)",
                an5.adapters.base.SqliteVectors.encodeVector(doubleArrayOf(1.0, 0.0, 0.0, 1.0)),
            )

            val docs = it.table("Document")
            for (metric in DistanceMetric.entries) {
                val hits = docs.vectorSearch(doubleArrayOf(1.0, 0.0, 0.0), take = 9, metric = metric)
                check("${metric.sql}: row order") { hits.joinToString(",") { row -> row.string("title").orEmpty() } == "d1,d2,d3" }
                check("${metric.sql}: the distance is a number") { hits.first()["distance"] is Double }
                check("${metric.sql}: the vector decodes to numbers") { hits.first()["embedding"] is DoubleArray }
            }

            // `memory` pins the client-side fallback, which ranks the same rows.
            it.vectorStrategy("memory")
            val pinned = docs.vectorSearch(doubleArrayOf(1.0, 0.0, 0.0), take = 9)
            check("the memory fallback ranks correctly") {
                pinned.joinToString(",") { row -> row.string("title").orEmpty() } == "d1,d2,d3"
            }

            it.vectorStrategy(null)
            val written = docs.create(
                mapOf("id" to "d9", "title" to "written", "embedding" to doubleArrayOf(0.25, 0.5, 1.0)),
            )
            check("create writes a float32 BLOB") {
                it.queryRaw("SELECT typeof(embedding) AS t FROM documents WHERE id = 'd9'")
                    .first().string("t") == "blob"
            }
            check("create returns numbers") { written["embedding"] is DoubleArray }
            check("findMany returns numbers") {
                docs.findMany(where = mapOf("id" to "d9")).first()["embedding"] is DoubleArray
            }
            docs.update(mapOf("id" to "d1"), mapOf("embedding" to doubleArrayOf(0.5, 0.5, 0.0)))
            check("update encodes") {
                docs.findMany(where = mapOf("id" to "d1")).first()["embedding"] is DoubleArray
            }
            docs.updateMany(mapOf("id" to "d2"), mapOf("embedding" to doubleArrayOf(0.0, 0.0, 1.0)))
            check("updateMany encodes") {
                docs.findMany(where = mapOf("id" to "d2")).first()["embedding"] is DoubleArray
            }
        }
    }

    private fun blobMetadata(): MutableMap<String, Any?> {
        val metadata = metadata()
        @Suppress("UNCHECKED_CAST")
        val fields = metadata["modelFields"] as MutableMap<String, Any?>
        fields["Document"] = listOf(
            field("id", true),
            field("title", false),
            mutableMapOf<String, Any?>(
                "name" to "embedding",
                "type" to "number[] | string",
                "sql" to "VECTOR(3)",
                "isOptional" to true,
                "hasDefault" to false,
                "isId" to false,
            ),
        )
        return metadata
    }

    // ─── Harness ──────────────────────────────────────────────────────────────────

    private fun open(): An5 {
        an5.adapters.base.Metadata.setAdapterMetadata(metadata())
        val db = An5(":memory:")
        db.executeRaw("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, score INTEGER, nickname TEXT)")
        db.executeRaw("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, embedding TEXT)")
        db.executeRaw("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, userId TEXT)")
        return db
    }

    private fun metadata(): MutableMap<String, Any?> {
        val posts = mutableMapOf<String, Any?>(
            "modelName" to "Post",
            "relationType" to "many",
            "foreignKey" to "userId",
            "localKey" to "id",
        )
        return mutableMapOf(
            "modelToTable" to mutableMapOf(
                "User" to "users",
                "Post" to "posts",
                "Document" to "documents",
            ),
            "modelFields" to mutableMapOf(
                "User" to listOf(field("id", true), field("name", false), field("score", false)),
                "Post" to listOf(field("id", true), field("title", false), field("userId", false)),
                "Document" to listOf(field("id", true), field("title", false), field("embedding", false)),
            ),
            "relationMap" to mutableMapOf("User" to mutableMapOf("posts" to posts)),
        )
    }

    private fun field(name: String, id: Boolean): MutableMap<String, Any?> = mutableMapOf(
        "name" to name,
        "type" to "string",
        "sql" to "NVARCHAR(255)",
        "isOptional" to false,
        "hasDefault" to false,
        "isId" to id,
    )

    private fun check(what: String, assertion: () -> Boolean) {
        val outcome = runCatching(assertion)
        when {
            outcome.isSuccess && outcome.getOrNull() == true -> println("ok   $what")
            else -> {
                failures++
                println("FAIL $what: ${outcome.exceptionOrNull()?.message ?: "assertion returned false"}")
            }
        }
    }
}