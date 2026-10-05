import Foundation

extension Row {

    // Typed reads off a row.
    //
    // A cast is not enough: a `BOOL` column arrives as an `Int` from one driver and a `Bool`
    // from another, a `NUMERIC` that fits in an `Int` still arrives as a `Decimal`, and a
    // date column arrives as a `String`, a `Double` of epoch seconds, or an `NSDate`. Each
    // accessor accepts every form, so a generated model never has to know which driver is
    // underneath it.
    //
    // A missing column and a `NULL` column are different things: a lookup yields
    // `Any??`, and these flatten it so "absent" reads as `nil` rather than as a nested
    // optional the caller has to unwrap by hand.

    /// The column's value as text, or `nil` for a SQL `NULL`.
    public func string(_ column: String) -> String? {
        guard let value = self[column] ?? nil else { return nil }
        if let text = value as? String { return text }
        if let data = value as? Data { return String(data: data, encoding: .utf8) }
        return String(describing: value)
    }

    public func int(_ column: String) -> Int? {
        guard let value = self[column] ?? nil else { return nil }
        if let number = value as? NSNumber { return number.intValue }
        if let text = value as? String { return Int(text.trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    public func int64(_ column: String) -> Int64? {
        guard let value = self[column] ?? nil else { return nil }
        if let number = value as? NSNumber { return number.int64Value }
        if let text = value as? String { return Int64(text.trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    public func double(_ column: String) -> Double? {
        guard let value = self[column] ?? nil else { return nil }
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String { return Double(text.trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    /// The column's value as an exact decimal.
    ///
    /// Taken from the string form where there is one: a `Double` has already lost the digits
    /// that do not fit in a binary fraction, so `Decimal(double)` would preserve the loss.
    public func decimal(_ column: String) -> Decimal? {
        guard let value = self[column] ?? nil else { return nil }
        if let decimal = value as? Decimal { return decimal }
        if let text = value as? String { return Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) }
        if let number = value as? NSNumber { return Decimal(string: number.stringValue) }
        return nil
    }

    public func bool(_ column: String) -> Bool? {
        guard let value = self[column] ?? nil else { return nil }
        if let flag = value as? Bool { return flag }
        if let number = value as? NSNumber { return number.intValue != 0 }
        if let text = value as? String {
            switch text.lowercased() {
            case "1", "true": return true
            case "0", "false": return false
            default: return nil
            }
        }
        return nil
    }

    /// The column's value as a date, accepting the text forms the engines produce.
    ///
    /// Timestamps come back with or without a `T` separator and with an optional offset, and
    /// a driver with no date type hands back epoch seconds, so all three are read here.
    public func date(_ column: String) -> Date? {
        guard let value = self[column] ?? nil else { return nil }
        if let date = value as? Date { return date }
        if let number = value as? NSNumber { return Date(timeIntervalSince1970: number.doubleValue) }
        guard var text = value as? String else { return nil }
        text = text.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        text = text.replacingOccurrences(of: " ", with: "T")

        let withZone = DateFormatter()
        withZone.locale = Locale(identifier: "en_US_POSIX")
        withZone.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXXXX"
        if let date = withZone.date(from: text) { return date }
        if let date = withZone.date(from: text + "Z") { return date }

        let plain = DateFormatter()
        plain.locale = Locale(identifier: "en_US_POSIX")
        plain.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return plain.date(from: text)
    }

    /// The column's value as bytes, or `nil` for a text column.
    public func data(_ column: String) -> Data? {
        guard let value = self[column] ?? nil else { return nil }
        if let data = value as? Data { return data }
        if let text = value as? String { return text.data(using: .utf8) }
        return nil
    }

    /// The eager-loaded relation rows under `relation`, or an empty list.
    public func related(_ relation: String) -> [Row] {
        (self[relation] ?? nil) as? [Row] ?? []
    }

    /// The eager-loaded single relation under `relation`, or `nil`.
    public func relatedOne(_ relation: String) -> Row? {
        (self[relation] ?? nil) as? Row
    }

    /// The `_count` total for a relation, or `0`.
    public func relationCount(_ relation: String) -> Int {
        ((self["_count"] ?? nil) as? [String: Int])?[relation] ?? 0
    }
}