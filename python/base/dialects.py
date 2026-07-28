DIALECT_MSSQL = "mssql"
DIALECT_POSTGRES = "postgres"

def detect_dialect(connection_string: str) -> str:
    cs = connection_string.strip().lower()
    if cs.startswith("postgres://") or cs.startswith("postgresql://"):
        return DIALECT_POSTGRES
    return DIALECT_MSSQL
