try:
    import pyodbc
    PYODBC_AVAILABLE = True
except ImportError:
    pyodbc = None
    PYODBC_AVAILABLE = False

def parse_connection_string(url: str) -> str:
    """Convert sqlserver:// URL to pyodbc connection string."""
    url = url.replace("sqlserver://", "")
    parts = url.split(";")
    host_part = parts[0]
    host, _, port = host_part.partition(":")
    port = port or "1433"

    config: Dict[str, str] = {"server": host, "port": port}
    for part in parts[1:]:
        if "=" not in part:
            continue
        k, _, v = part.partition("=")
        k = k.strip().lower()
        v = v.strip()
        if k in ("database",):
            config["database"] = v
        elif k in ("user", "uid"):
            config["user"] = v
        elif k in ("password", "pwd"):
            config["password"] = v
        elif k == "encrypt":
            config["encrypt"] = "yes" if v.lower() == "true" else "no"
        elif k == "trustservercertificate":
            config["trust"] = "yes" if v.lower() == "true" else "no"

    encrypt = config.get("encrypt", "yes")
    trust = config.get("trust", "yes")
    if "user" in config:
        return (
            f"DRIVER={{ODBC Driver 17 for SQL Server}};"
            f"SERVER={config['server']},{config['port']};"
            f"DATABASE={config.get('database', '')};"
            f"UID={config['user']};"
            f"PWD={config.get('password', '')};"
            f"Encrypt={encrypt};TrustServerCertificate={trust};"
        )
    # Windows auth
    return (
        f"DRIVER={{ODBC Driver 17 for SQL Server}};"
        f"SERVER={config['server']},{config['port']};"
        f"DATABASE={config.get('database', '')};"
        f"Trusted_Connection=yes;"
        f"Encrypt={encrypt};TrustServerCertificate={trust};"
    )



def connect(connection_string: str):
    if not PYODBC_AVAILABLE:
        raise ImportError("pyodbc is required: pip install pyodbc")
    return pyodbc.connect(parse_connection_string(connection_string), autocommit=True)

def placeholder() -> str:
    return "?"
