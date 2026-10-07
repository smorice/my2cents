from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MY2CENTS_", env_file=".env", extra="ignore")

    # Public mount point of the app behind the reverse proxy (no trailing slash).
    base_path: str = "/my2cents"
    public_url: str = "https://nayonne.ovh/my2cents"

    database_url: str = "postgresql+psycopg://my2cents:my2cents@localhost:5432/my2cents"

    # Sessions
    session_cookie: str = "m2c_session"
    session_idle_minutes: int = 60 * 12
    session_absolute_hours: int = 24 * 14
    cookie_secure: bool = True

    # Login throttling
    login_max_failures: int = 5
    login_lockout_minutes: int = 15

    # Bootstrap admin (created on first start if no admin exists)
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None

    # Registration
    allow_registration: bool = True

    # Optional SMTP for password reset mails
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "My2cents <no-reply@nayonne.ovh>"

    # Market data
    market_data_refresh_hours: int = 12

    static_dir: str = "/app/static"


@lru_cache
def get_settings() -> Settings:
    return Settings()
