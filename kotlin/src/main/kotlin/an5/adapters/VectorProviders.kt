package an5.adapters

import an5.adapters.vector.VectorStoreProvider

/**
 * Kotlin facade over [VectorStoreProvider] supporting NBase, Qdrant, Chroma,
 * Pinecone, Weaviate, and Milvus via connection strings.
 */
object VectorProviders {
    @JvmStatic
    fun detect(connectionString: String): VectorStoreProvider.Kind? =
        VectorStoreProvider.detectProvider(connectionString)

    @JvmStatic
    fun isVectorConnectionString(connectionString: String): Boolean =
        VectorStoreProvider.isVectorConnectionString(connectionString)

    @JvmStatic
    fun connect(connectionString: String): VectorStoreProvider =
        VectorStoreProvider.fromConnectionString(connectionString)
}
