try:
    import psycopg2
    import psycopg2.extras
    PSYCOPG2_AVAILABLE = True
except ImportError:
    psycopg2 = None
    PSYCOPG2_AVAILABLE = False

def connect(connection_string: str):
    if not PSYCOPG2_AVAILABLE:
        raise ImportError("psycopg2 is required: pip install psycopg2-binary")
    return psycopg2.connect(connection_string)

def placeholder() -> str:
    return "%s"
