//! Dialect detection, identifier quoting and vector math.
//!
//! Mirrors the Go `an5adapters/base` package.

/// Supported database engines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Mssql,
    Postgres,
    Sqlite,
}

impl Dialect {
    /// Detect the dialect from a connection string.
    pub fn detect(conn_str: &str) -> Self {
        let l = conn_str.trim().to_lowercase();
        if l.starts_with("postgres://")
            || l.starts_with("postgresql://")
            || l.contains("port=5432")
        {
            return Dialect::Postgres;
        }
        if l.starts_with("sqlite://")
            || l.starts_with("sqlite:")
            || l.starts_with("file:")
            || l.ends_with(".db")
            || l.ends_with(".sqlite")
            || l.ends_with(".sqlite3")
            || l == ":memory:"
        {
            return Dialect::Sqlite;
        }
        Dialect::Mssql
    }

    /// Quote a single identifier (column or table part).
    pub fn quote_identifier(&self, name: &str) -> String {
        let raw = strip_wrapping(strip_wrapping(name, "[", "]"), "\"", "\"");
        match self {
            Dialect::Postgres | Dialect::Sqlite => {
                format!("\"{}\"", raw.replace('"', "\"\""))
            }
            Dialect::Mssql => format!("[{}]", raw.replace(']', "]]")),
        }
    }

    /// Quote a possibly schema-qualified table name (`dbo.users`).
    pub fn quote_table(&self, table: &str) -> String {
        let t = table.trim();
        // Already quoted by the generator: `[dbo].[User]`.
        if t.starts_with('[') || t.starts_with('"') {
            return t.to_string();
        }
        t.split('.')
            .map(|p| self.quote_identifier(p))
            .collect::<Vec<_>>()
            .join(".")
    }

    /// Positional placeholder: `$N` for Postgres, `?` otherwise.
    pub fn placeholder(&self, n: usize) -> String {
        match self {
            Dialect::Postgres => format!("${}", n),
            _ => "?".to_string(),
        }
    }

    /// MSSQL read hint used on every SELECT.
    pub fn nolock(&self) -> &'static str {
        match self {
            Dialect::Mssql => " WITH (NOLOCK)",
            _ => "",
        }
    }

    /// Dialects that use `LIMIT` / `OFFSET` instead of `TOP` / `FETCH NEXT`.
    pub fn supports_limit_offset(&self) -> bool {
        matches!(self, Dialect::Postgres | Dialect::Sqlite)
    }
}

fn strip_wrapping<'a>(name: &'a str, left: &str, right: &str) -> &'a str {
    if name.starts_with(left) && name.ends_with(right) && name.len() >= left.len() + right.len() {
        &name[left.len()..name.len() - right.len()]
    } else {
        name
    }
}

/// Cosine similarity between two vectors (1.0 = identical direction).
pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut m1 = 0.0;
    let mut m2 = 0.0;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        m1 += a[i] * a[i];
        m2 += b[i] * b[i];
    }
    if m1 == 0.0 || m2 == 0.0 {
        return 0.0;
    }
    dot / (m1.sqrt() * m2.sqrt())
}

/// Euclidean distance between two vectors.
pub fn euclidean_distance(a: &[f64], b: &[f64]) -> f64 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f64>()
        .sqrt()
}

/// Dot product of two vectors.
pub fn dot_product(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Distance honouring the AN5 metric names (`cosine` / `euclidean` / `dot`).
pub fn vector_distance(a: &[f64], b: &[f64], metric: &str) -> f64 {
    match metric.to_lowercase().as_str() {
        "euclidean" => euclidean_distance(a, b),
        "dot" => -dot_product(a, b),
        _ => 1.0 - cosine_similarity(a, b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dialects() {
        assert_eq!(
            Dialect::detect("postgres://localhost/db"),
            Dialect::Postgres
        );
        assert_eq!(Dialect::detect("app.db"), Dialect::Sqlite);
        assert_eq!(
            Dialect::detect("Server=localhost;Database=master;"),
            Dialect::Mssql
        );
    }

    #[test]
    fn quotes_identifiers_per_dialect() {
        assert_eq!(Dialect::Mssql.quote_identifier("id"), "[id]");
        assert_eq!(Dialect::Postgres.quote_identifier("id"), "\"id\"");
    }

    #[test]
    fn keeps_generator_quoted_table() {
        assert_eq!(Dialect::Mssql.quote_table("[dbo].[User]"), "[dbo].[User]");
        assert_eq!(Dialect::Postgres.quote_table("dbo.users"), "\"dbo\".\"users\"");
    }

    #[test]
    fn placeholders_per_dialect() {
        assert_eq!(Dialect::Postgres.placeholder(2), "$2");
        assert_eq!(Dialect::Mssql.placeholder(2), "?");
    }

    #[test]
    fn cosine_identical_is_one() {
        let v = vec![1.0, 0.0];
        assert!((cosine_similarity(&v, &v) - 1.0).abs() < 1e-9);
    }
}
