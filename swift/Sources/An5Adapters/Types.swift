import Foundation

/// One row, keyed by column name.
///
/// A name-to-value dictionary rather than a positional array because a generated model
/// reads its fields by name, and because a missing column and a `NULL` column are
/// different things: the first is absent from the dictionary, the second is present with a
/// `nil` value.
public typealias Row = [String: Any?]

/// A filter tree: scalar values, operator maps, and nested `AND`/`OR`/`NOT` groups.
public typealias Where = [String: Any?]

/// A write payload: column values, plus any relation writes the metadata declares.
///
/// Named `Values` rather than `Data` because `Data` is Foundation's byte buffer, and a
/// typealias that shadows it makes every `Data(bytes:count:)` in a driver fail to compile.
public typealias Values = [String: Any?]

/// An eager-load description: relation name to `true`, or to a nested description.
public typealias Include = [String: Any?]

/// A parameter value bound into a statement.
///
/// Limited to what a SQL driver can bind. `Date`, `UUID`, `Data` and the numeric types all
/// have a defined encoding, which is what lets a generated model pass a `UUID` for an
/// `@id` column without converting it by hand.
public enum SQLValue {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)
    case bool(Bool)
    case date(Date)
    case uuid(UUID)

    /// The value to hand back as an untyped Swift value.
    ///
    /// A `NULL` becomes `nil`, and everything else the natural Swift type, so an
    /// already-encoded value can travel through the untyped `[Any?]` entry points without
    /// being encoded a second time.
    public var unwrapped: Any? {
        switch self {
        case .null: return nil
        case .bool(let value): return value
        case .integer(let value): return value
        case .real(let value): return value
        case .text(let value): return value
        case .blob(let value): return value
        case .date(let value): return value
        case .uuid(let value): return value
        }
    }

    /// Converts a Swift value into something bindable, or `nil` when there is no encoding.
    ///
    /// `Optional` is unwrapped rather than rejected so a generated model can pass a nullable
    /// column straight through; `NSNull` is accepted as an explicit null because that is
    /// what a JSON decoder produces for a missing value.
    public static func encode(_ value: Any?) -> SQLValue? {
        switch value {
        case nil, is NSNull:
            return .null
        case let already as SQLValue:
            return already
        case let bool as Bool:
            return .bool(bool)
        case let number as Int:
            return .integer(Int64(number))
        case let number as Int64:
            return .integer(number)
        case let number as Double:
            return .real(number)
        case let number as Float:
            return .real(Double(number))
        case let decimal as Decimal:
            return .real(NSDecimalNumber(decimal: decimal).doubleValue)
        case let number as NSNumber:
            // An NSNumber wraps either a floating-point or an integral value, and the only
            // portable way to tell is whether it survives the round trip through int64 —
            // CFNumberIsFloatType is not available on every platform Swift builds for.
            let whole = number.doubleValue
            return whole == Double(number.int64Value) ? .integer(number.int64Value) : .real(whole)
        case let text as String:
            return .text(text)
        case let data as Data:
            return .blob(data)
        case let date as Date:
            return .date(date)
        case let uuid as UUID:
            return .uuid(uuid)
        default:
            return nil
        }
    }
}

/// Everything the runtime can fail with.
///
/// One error type with a reason, rather than a family of types: a caller catching an AN5
/// failure almost always wants to show the message, and a switch over cases that never
/// differ in handling is noise.
public enum An5Error: Error, CustomStringConvertible {
    case unsupported(String)
    case configuration(String)
    case invalidQuery(String)
    case driver(String)
    case readOnly(String)

    public var description: String {
        switch self {
        case .unsupported(let detail):
            return "Unsupported: \(detail)"
        case .configuration(let detail):
            return "Configuration error: \(detail)"
        case .invalidQuery(let detail):
            return "Invalid query: \(detail)"
        case .driver(let detail):
            return "Database error: \(detail)"
        case .readOnly(let detail):
            return "\(detail) is read-only"
        }
    }

    public var localizedDescription: String { description }
}