import Foundation

/// The distance metrics a vector search understands, and the math behind them.
///
/// Each metric is turned into a distance before sorting, so ascending order always means
/// "closer": cosine similarity and dot product would otherwise have to be sorted descending,
/// which is the kind of detail no caller should have to remember.
public enum DistanceMetric: String, Sendable {
    case cosine
    case euclidean
    case dot

    public static func distance(_ metric: DistanceMetric, _ left: [Double], _ right: [Double]) -> Double {
        switch metric {
        case .cosine: return 1 - Vectors.cosineSimilarity(left, right)
        case .euclidean: return Vectors.euclideanDistance(left, right)
        case .dot: return -Vectors.dotProduct(left, right)
        }
    }
}

public enum Vectors {

    /// Cosine similarity in `-1...1`; `0` when the lengths differ or either side is empty.
    public static func cosineSimilarity(_ left: [Double], _ right: [Double]) -> Double {
        guard left.count == right.count, !left.isEmpty else { return 0 }
        var dot = 0.0
        var leftMagnitude = 0.0
        var rightMagnitude = 0.0
        for index in left.indices {
            dot += left[index] * right[index]
            leftMagnitude += left[index] * left[index]
            rightMagnitude += right[index] * right[index]
        }
        guard leftMagnitude != 0, rightMagnitude != 0 else { return 0 }
        return dot / (leftMagnitude.squareRoot() * rightMagnitude.squareRoot())
    }

    /// L2 distance; `0` when the lengths differ or either side is empty.
    public static func euclideanDistance(_ left: [Double], _ right: [Double]) -> Double {
        guard left.count == right.count, !left.isEmpty else { return 0 }
        var sum = 0.0
        for index in left.indices {
            let difference = left[index] - right[index]
            sum += difference * difference
        }
        return sum.squareRoot()
    }

    /// Inner product; `0` when the lengths differ.
    public static func dotProduct(_ left: [Double], _ right: [Double]) -> Double {
        guard left.count == right.count else { return 0 }
        return zip(left, right).reduce(0) { $0 + $1.0 * $1.1 }
    }

    /// Reads a stored vector back out of a cell.
    ///
    /// All three vector stores AN5 targets hand the column back as text — SQL Server's
    /// `VECTOR`, PostgreSQL's `vector`, and SQLite's JSON blob — so the in-memory fallback
    /// parses the same `[0.1, 0.2]` form. A row whose length does not match the query vector
    /// yields `nil` rather than a silently wrong score.
    ///
    /// - Parameter expectedLength: the query vector's length, or `0` to accept any length.
    public static func parse(_ value: Any?, expectedLength: Int) -> [Double]? {
        guard let value, !(value is NSNull) else { return nil }
        if let numbers = value as? [Double] {
            return expectedLength > 0 && numbers.count != expectedLength ? nil : numbers
        }
        let text = "\(value)".trimmingCharacters(in: .whitespacesAndNewlines)
        guard let open = text.firstIndex(of: "["), let close = text.lastIndex(of: "]"), close > open else {
            return nil
        }
        let body = text[text.index(after: open)..<close]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty { return nil }
        let parsed = body.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parsed.count == body.split(separator: ",").count else { return nil }
        guard !parsed.isEmpty, expectedLength == 0 || parsed.count == expectedLength else { return nil }
        return parsed
    }

    /// Renders a vector the way the vector stores expect it, as `[0.1, 0.2]`.
    public static func format(_ vector: [Double]) -> String {
        "[" + vector.map { "\($0)" }.joined(separator: ", ") + "]"
    }
}