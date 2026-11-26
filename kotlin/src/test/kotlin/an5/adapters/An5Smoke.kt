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
        insensitiveGroupByHavingAndValidation()
        relations()
        relationFiltersAndValidation()
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

    private fun insensitiveGroupByHavingAndValidation() {
        val db = open()
        db.use {
            val users = it.table("User")
            users.createMany(
                listOf(
                    mapOf("name" to "Alice", "score" to 10, "nickname" to "ally"),
                    mapOf("name" to "alice", "score" to 30, "nickname" to null),
                    mapOf("name" to "Bob", "score" to 25, "nickname" to "bobby"),
                    mapOf("name" to "charlie", "score" to 5, "nickname" to null),
                )
            )

            // Case-insensitive string matching and list filters.
            check("eqInsensitive") { users.findMany { where("name" eqInsensitive "ALICE") }.size == 2 }
            check("neqInsensitive") { users.findMany { where("name" neqInsensitive "ALICE") }.size == 2 }
            check("containsInsensitive") { users.findMany { where("name" containsInsensitive "LIC") }.size == 2 }
            check("startsWithInsensitive") { users.findMany { where("name" startsWithInsensitive "al") }.size == 2 }
            check("endsWithInsensitive") { users.findMany { where("name" endsWithInsensitive "CE") }.size == 2 }
            check("inListInsensitive") {
                users.findMany { where("name" inListInsensitive listOf("ALICE", "BOB")) }.size == 3
            }
            check("notInListInsensitive") {
                users.findMany { where("name" notInListInsensitive listOf("ALICE", "BOB")) }
                    .single().string("name") == "charlie"
            }
            check("nested not inherits mode insensitive") {
                users.findMany {
                    where(mapOf("name" to mapOf("not" to mapOf("equals" to "ALICE"), "mode" to "insensitive")))
                }.size == 2
            }
            check("invalid mode rejected") {
                runCatching {
                    users.findMany(where = mapOf("name" to mapOf("equals" to "Alice", "mode" to "bogus")))
                }.exceptionOrNull() is IllegalArgumentException
            }

            // Combined WHERE + HAVING aggregate filters, per-field _count, and offset-only pagination.
            val grouped = users.groupBy("name") {
                where("score" gte 10)
                count("_all", "nickname")
                sum("score")
                avg("score")
                min("score")
                max("score")
                having(
                    andOf(
                        mapOf("_count" to mapOf("_all" to mapOf("gte" to 1))),
                        mapOf("_sum" to mapOf("score" to mapOf("gte" to 25))),
                        orOf(
                            mapOf("_avg" to mapOf("score" to mapOf("gte" to 25))),
                            mapOf("name" to mapOf("equals" to "alice")),
                        ),
                        notOf(mapOf("_min" to mapOf("score" to mapOf("gt" to 100)))),
                        mapOf("_max" to mapOf("score" to mapOf("lte" to 30))),
                    )
                )
                orderBy(listOf("name" to Sort.ASC))
            }
            check("groupBy having matched 2 groups") { grouped.size == 2 }
            check("groupBy having ordered") {
                grouped.map { row -> row.string("name") } == listOf("Bob", "alice")
            }
            check("per-field _count counts non-null nickname") {
                grouped.first { it.string("name") == "Bob" }.long("_count_nickname") == 1L &&
                    grouped.first { it.string("name") == "alice" }.long("_count_nickname") == 0L
            }

            val builderSpec = AggregateBuilder()
                .groupedBy("name")
                .count("_all", "nickname")
                .sum("score")
            builderSpec.orderBy("name", Sort.ASC)
            builderSpec.skip(2)
            val paged = users.groupBy(builderSpec)
            check("SQLite offset-only groupBy skip(2)") {
                paged.map { row -> row.string("name") } == listOf("alice", "charlie")
            }

            // ViewClient groupBy with HAVING.
            it.executeRaw("CREATE VIEW user_view AS SELECT id, name, score, nickname FROM users")
            val viewMeta = metadata()
            @Suppress("UNCHECKED_CAST")
            (viewMeta["modelToTable"] as MutableMap<String, Any?>)["UserView"] = "user_view"
            @Suppress("UNCHECKED_CAST")
            (viewMeta["modelFields"] as MutableMap<String, Any?>)["UserView"] = listOf(
                field("id", true),
                field("name", false),
                field("score", false),
                field("nickname", false),
            )
            an5.adapters.base.Metadata.setAdapterMetadata(viewMeta)
            val viewGroups = it.view("UserView").groupBy("name") {
                having(mapOf("_sum" to mapOf("score" to mapOf("gte" to 30))))
            }
            check("ViewClient groupBy having") {
                viewGroups.single().string("name") == "alice"
            }

            // Strict validation rejections.
            check("unknown field in groupBy rejected") {
                runCatching { users.groupBy("unknownCol") { count() } }
                    .exceptionOrNull() is IllegalArgumentException
            }
            check("_all outside _count rejected") {
                runCatching { users.aggregate { sum("_all") } }
                    .exceptionOrNull() is IllegalArgumentException
            }
            check("ungrouped scalar in having rejected") {
                runCatching {
                    users.groupBy("name") {
                        having(mapOf("score" to mapOf("gte" to 10)))
                    }
                }.exceptionOrNull() is IllegalArgumentException
            }
            check("non-list OR in having rejected") {
                runCatching {
                    users.groupBy("name") {
                        having(mapOf("OR" to mapOf("name" to "Alice")))
                    }
                }.exceptionOrNull() is IllegalArgumentException
            }
            check("collection passed to scalar equals rejected") {
                runCatching { users.findMany(where = mapOf("name" to mapOf("equals" to listOf("Alice")))) }
                    .exceptionOrNull() is IllegalArgumentException
            }
            check("non-string contains operand rejected") {
                runCatching { users.findMany(where = mapOf("name" to mapOf("contains" to 123))) }
                    .exceptionOrNull() is IllegalArgumentException
            }
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

    private fun relationFiltersAndValidation() {
        val db = openRelational()
        db.use {
            val users = it.table("User")
            val posts = it.table("Post")

            check("kotlin some") {
                users.findMany { where("posts" some ("published" eq 1)) }
                    .mapNotNull { row -> row.string("name") }.sorted() == listOf("Alice", "Bob")
            }
            check("kotlin some()") {
                users.findMany { where("posts".some()) }
                    .mapNotNull { row -> row.string("name") }.sorted() == listOf("Alice", "Bob")
            }
            check("kotlin none") {
                users.findMany { where("posts" none ("published" eq 0)) }
                    .mapNotNull { row -> row.string("name") }.sorted() == listOf("Bob", "Charlie")
            }
            check("kotlin every") {
                users.findMany { where("posts" every ("published" eq 1)) }
                    .mapNotNull { row -> row.string("name") }.sorted() == listOf("Bob", "Charlie")
            }
            check("kotlin isRelated") {
                posts.findMany { where("author" isRelated ("name" eq "Alice")) }
                    .mapNotNull { row -> row.string("title") }.sorted() == listOf("Draft One", "Published One")
            }
            check("kotlin isRelated null") {
                posts.findMany { where("author" isRelated null) }
                    .mapNotNull { row -> row.string("title") } == listOf("Orphan Post")
            }
            check("kotlin isNotRelated") {
                posts.findMany { where("author" isNotRelated ("name" eq "Alice")) }
                    .mapNotNull { row -> row.string("title") }.sorted() == listOf("All Published", "Orphan Post")
            }
            check("kotlin inverse 1-to-1 isRelated & include") {
                val alice = users.findMany {
                    where("profile" isRelated ("bio" contains "Systems"))
                    include(mapOf("profile" to true))
                }
                alice.single().string("name") == "Alice" &&
                    alice.single().relatedOne("profile")?.string("bio") == "Systems engineer"
            }
            check("kotlin to-one include") {
                val p1 = posts.findMany {
                    where("id" eq "p1")
                    include(mapOf("author" to true))
                }
                p1.single().relatedOne("author")?.string("name") == "Alice"
            }
            check("kotlin strict unknown scalar op") {
                runCatching { users.findMany(where = mapOf("name" to mapOf("bogus" to "Alice"))) }
                    .exceptionOrNull() is IllegalArgumentException
            }
            check("kotlin strict mismatched relation op") {
                runCatching { users.findMany(where = "posts" isRelated emptyMap()) }
                    .exceptionOrNull() is IllegalArgumentException
            }
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

    private fun openRelational(): An5 {
        val meta = mutableMapOf<String, Any?>(
            "modelToTable" to mutableMapOf("User" to "users", "Post" to "posts", "Profile" to "profiles"),
            "modelFields" to mutableMapOf(
                "User" to listOf(field("id", true), field("name", false), field("score", false)),
                "Post" to listOf(field("id", true), field("title", false), field("published", false), field("authorId", false)),
                "Profile" to listOf(field("id", true), field("bio", false), field("userId", false)),
            ),
            "relationMap" to mutableMapOf(
                "User" to mutableMapOf(
                    "posts" to mapOf("modelName" to "Post", "relationType" to "many", "foreignKey" to "authorId", "localKey" to "id"),
                    "profile" to mapOf("modelName" to "Profile", "relationType" to "one", "foreignKey" to "userId", "localKey" to "id"),
                ),
                "Post" to mutableMapOf(
                    "author" to mapOf("modelName" to "User", "relationType" to "one", "foreignKey" to "authorId", "localKey" to "id"),
                ),
                "Profile" to mutableMapOf(
                    "user" to mapOf("modelName" to "User", "relationType" to "one", "foreignKey" to "userId", "localKey" to "id"),
                ),
            ),
        )
        an5.adapters.base.Metadata.setAdapterMetadata(meta)
        val db = An5(":memory:")
        db.executeRaw("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, score INTEGER)")
        db.executeRaw("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, published INTEGER, authorId TEXT)")
        db.executeRaw("CREATE TABLE profiles (id TEXT PRIMARY KEY, bio TEXT, userId TEXT)")

        db.table("User").create(mapOf("id" to "u1", "name" to "Alice", "score" to 100))
        db.table("User").create(mapOf("id" to "u2", "name" to "Bob", "score" to 50))
        db.table("User").create(mapOf("id" to "u3", "name" to "Charlie", "score" to 10))
        db.table("Profile").create(mapOf("id" to "pr1", "bio" to "Systems engineer", "userId" to "u1"))
        db.table("Profile").create(mapOf("id" to "pr2", "bio" to "Draft writer", "userId" to "u2"))
        db.table("Post").create(mapOf("id" to "p1", "title" to "Published One", "published" to 1, "authorId" to "u1"))
        db.table("Post").create(mapOf("id" to "p2", "title" to "Draft One", "published" to 0, "authorId" to "u1"))
        db.table("Post").create(mapOf("id" to "p3", "title" to "All Published", "published" to 1, "authorId" to "u2"))
        db.table("Post").create(mapOf("id" to "p4", "title" to "Orphan Post", "published" to 1))
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
                "User" to listOf(field("id", true), field("name", false), field("score", false), field("nickname", false)),
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