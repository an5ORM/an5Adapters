import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum VectorProviderKind: String, Sendable {
    case nbase
    case qdrant
    case chroma
    case pinecone
    case weaviate
    case milvus
}

public struct VectorRecord: Sendable {
    public let id: String
    public let vector: [Double]
    public let metadata: [String: String]?

    public init(id: String, vector: [Double], metadata: [String: String]? = nil) {
        self.id = id
        self.vector = vector
        self.metadata = metadata
    }
}

public struct VectorSearchHit: Sendable {
    public let id: String
    public let distance: Double

    public init(id: String, distance: Double) {
        self.id = id
        self.distance = distance
    }
}

public final class HttpVectorStoreClient {
    public let provider: VectorProviderKind
    public let endpoint: String
    public let collection: String
    public let namespace: String?
    public let token: String?

    public init(
        provider: VectorProviderKind,
        endpoint: String,
        collection: String = "an5",
        namespace: String? = nil,
        token: String? = nil
    ) {
        self.provider = provider
        self.endpoint = endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.collection = collection
        self.namespace = namespace
        self.token = token
    }

    public static func detectProvider(_ connStr: String) -> VectorProviderKind? {
        let lower = connStr.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for kind in [VectorProviderKind.nbase, .qdrant, .chroma, .pinecone, .weaviate, .milvus] {
            if lower.hasPrefix("\(kind.rawValue):") {
                return kind
            }
        }
        return nil
    }

    public static func isVectorConnectionString(_ connStr: String) -> Bool {
        detectProvider(connStr) != nil
    }

    public static func fromConnectionString(_ connStr: String) throws -> HttpVectorStoreClient {
        guard let kind = detectProvider(connStr) else {
            throw NSError(domain: "An5Adapters", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported vector connection string: \(connStr)"])
        }
        let raw = connStr.trimmingCharacters(in: .whitespacesAndNewlines)
        var rest = String(raw.dropFirst(kind.rawValue.count + 1))
        if rest.hasPrefix("//") { rest = String(rest.dropFirst(2)) }
        let parts = rest.split(separator: "?", maxSplits: 1).map(String.init)
        var host = parts[0].trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var pathParam: String? = nil
        if !host.isEmpty && !host.contains("://"), let slash = host.firstIndex(of: "/") {
            pathParam = String(host[host.index(after: slash)...])
            host = String(host[..<slash])
        }
        var params: [String: String] = [:]
        if parts.count > 1 {
            for pair in parts[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                if kv.count == 2 { params[kv[0]] = kv[1] }
            }
        }
        let scheme = kind == .pinecone ? "https" : "http"
        let fallback: String
        switch kind {
        case .nbase: fallback = "localhost:1307"
        case .qdrant: fallback = "localhost:6333"
        case .chroma: fallback = "localhost:8000"
        case .pinecone: fallback = "localhost"
        case .weaviate: fallback = "localhost:8080"
        case .milvus: fallback = "localhost:19530"
        }
        let endpoint = host.isEmpty ? "\(scheme)://\(fallback)" : (host.contains("://") ? host : "\(scheme)://\(host)")
        let col = params["collection"] ?? params["className"] ?? pathParam ?? (kind == .weaviate ? "An5Vector" : "an5")
        let ns = params["namespace"] ?? (kind == .pinecone ? pathParam : nil)
        let tok = params["apiKey"] ?? params["token"]
        return HttpVectorStoreClient(provider: kind, endpoint: endpoint, collection: col, namespace: ns, token: tok)
    }
}
