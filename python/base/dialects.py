DIALECT_MSSQL = "mssql"
DIALECT_POSTGRES = "postgres"
DIALECT_SQLITE = "sqlite"

def detect_dialect(connection_string: str) -> str:
    cs = connection_string.strip().lower()
    if cs.startswith("postgres://") or cs.startswith("postgresql://"):
        return DIALECT_POSTGRES
    if cs.startswith("sqlite://") or cs.startswith("sqlite:") or cs.startswith("file:") or cs.endswith(".db") or cs.endswith(".sqlite") or cs.endswith(".sqlite3") or cs == ":memory:":
        return DIALECT_SQLITE
    return DIALECT_MSSQL
